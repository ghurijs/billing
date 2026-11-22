// Views: start a Checkout Session, open the customer portal, receive webhooks. Mount `billingUrls` under a prefix:
// `path('billing/', include(billingUrls))`.
import {
  BadRequest,
  csrfExempt,
  getHost,
  isAllowedHost,
  path,
  tryGetContext,
  urlpatterns,
  type ViewFunction,
  wantsJson,
} from '@ghuri/core'
import type { Context } from 'hono'
import { getCustomer } from './access'
import { ProviderError, SignatureVerificationError } from './errors'
import { Price } from './models'
import { billingSettings, getProvider } from './settings'
import { requestSubscriber, resolveSubject, type SubscriberRef, subscriberKey } from './subscriber'
import { SUBSCRIBER_METADATA_KEY } from './sync'
import { handleWebhook } from './webhooks'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function readBody(c: Context): Promise<Record<string, string>> {
  const type = (c.req.header('content-type') ?? '').toLowerCase()
  if (type.includes('application/json')) {
    let data: unknown
    try {
      data = await c.req.json()
    } catch {
      throw new BadRequest('The request body is not valid JSON.')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = String(v)
    return out
  }
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await c.req.parseBody()
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(form)) if (typeof v === 'string') out[k] = v
    return out
  }
  return {}
}

/** Respond with `{ id?, url }` as JSON, or `303` to `url` for a browser form post. */
function respond(c: Context, data: { id?: string; url: string }): Response {
  const accept = c.req.header('accept') ?? ''
  const isForm = /application\/x-www-form-urlencoded|multipart\/form-data/i.test(
    c.req.header('content-type') ?? '',
  )
  if (isForm && !accept.includes('application/json'))
    return new Response(null, { status: 303, headers: { location: data.url } })
  return jsonResponse(data)
}

/**
 * An absolute URL for `value` (default `fallback`): relative paths resolve against the request, absolute URLs must be
 * on the request's host or a host in `ALLOWED_HOSTS` (not `'*'`). Stripe's `{CHECKOUT_SESSION_ID}` is kept.
 */
export function safeRedirectUrl(c: Context, value: string | undefined, fallback: string): string {
  const raw = (value || fallback || '/').trim()
  const origin = new URL(c.req.url).origin
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return `${origin}${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BadRequest(`Not a valid redirect URL: '${raw}'.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new BadRequest('Redirect URLs must be http(s).')
  const allowed = ((tryGetContext()?.settings.ALLOWED_HOSTS as string[] | undefined) ?? []).filter(
    (h) => h !== '*',
  )
  const requestHost = getHost(c).replace(/:\d+$/, '')
  if (url.hostname !== requestHost && !isAllowedHost(url.host, allowed))
    throw new BadRequest(`Redirects to '${url.host}' are not allowed (add it to ALLOWED_HOSTS).`)
  return raw
}

function unauthenticated(c: Context): Response {
  const login = tryGetContext()?.settings.LOGIN_URL as string | undefined
  if (!wantsJson(c) && login && c.req.method === 'GET')
    return c.redirect(`${login}?next=${encodeURIComponent(new URL(c.req.url).pathname)}`)
  return jsonResponse({ detail: 'Authentication credentials were not provided.' }, 401)
}

export interface ResolvedPrice {
  /** Provider price id. */
  price: string
  mode: 'subscription' | 'payment'
  plan: string | null
  trialPeriodDays?: number
}

async function localPrice(value: string, interval?: string): Promise<Price | null> {
  const filter: Record<string, unknown> = { active: true, product__active: true }
  if (interval) filter.recurringInterval = interval
  const qs = Price.objects.filter(filter as any)
  return (
    ((await qs.filter({ providerId: value }).first()) as Price | null) ??
    ((await qs.filter({ lookupKey: value }).orderBy('-created').first()) as Price | null) ??
    ((await qs
      .filter({ product__providerId: value } as any)
      .orderBy('-created')
      .first()) as Price | null)
  )
}

/**
 * Which price a checkout may use: a plan key (`{ plan: 'pro', interval: 'year' }`), or a price id / lookup key. When
 * `BILLING.PLANS` lists prices, only those (or prices of products they list) can be bought; without plans, any
 * active local price of an active product. Anything else is refused, so a client cannot buy an internal price.
 */
export async function resolveCheckoutPrice(input: {
  plan?: string
  price?: string
  interval?: string
}): Promise<ResolvedPrice> {
  const { PLANS } = billingSettings()
  const planFor = (v: string) =>
    Object.entries(PLANS).find(([, p]) => (p.prices ?? []).includes(v))?.[0] ?? null
  const finish = (local: Price | null, id: string, plan: string | null): ResolvedPrice => ({
    price: local?.providerId ?? id,
    mode: local?.type === 'one_time' ? 'payment' : 'subscription',
    plan,
    trialPeriodDays: plan ? PLANS[plan]?.trialPeriodDays : undefined,
  })
  if (input.plan) {
    const plan = PLANS[input.plan]
    if (!plan?.prices?.length) throw new BadRequest(`Unknown plan '${input.plan}'.`)
    for (const candidate of plan.prices) {
      const local = await localPrice(candidate, input.interval)
      if (local) return finish(local, candidate, input.plan)
    }
    const direct = plan.prices.find((p) => p.startsWith('price_'))
    if (direct && !input.interval) return finish(null, direct, input.plan)
    throw new BadRequest(
      `Plan '${input.plan}' has no active price${input.interval ? ` per ${input.interval}` : ''}.`,
    )
  }
  if (!input.price) throw new BadRequest("Send 'price' or 'plan'.")
  const local = await localPrice(input.price, input.interval)
  const product = local ? ((await local.product) as { providerId?: string } | null) : null
  const plan =
    planFor(input.price) ??
    (local
      ? (planFor(local.providerId) ?? planFor(local.lookupKey) ?? planFor(product?.providerId ?? ''))
      : null)
  // When plans list prices, only those can be bought; otherwise any active price of an active product.
  const restricted = Object.values(PLANS).some((p) => p.prices?.length)
  if (restricted && !plan) throw new BadRequest(`The price '${input.price}' is not in any plan.`)
  if (local) return finish(local, input.price, plan)
  if (plan && input.price.startsWith('price_')) return finish(null, input.price, plan)
  throw new BadRequest(`Unknown or inactive price '${input.price}'.`)
}

/** `POST checkout/`: a Checkout Session for the request's subscriber. */
export const checkoutView: ViewFunction = async (c: Context) => {
  if (c.req.method !== 'POST') return jsonResponse({ detail: `Method "${c.req.method}" not allowed.` }, 405)
  const subscriber = await requestSubscriber(c)
  const ref = (await resolveSubject(subscriber as object)) as SubscriberRef | null
  if (!subscriber || !ref) return unauthenticated(c)
  const body = await readBody(c)
  const s = billingSettings()
  const resolved = await resolveCheckoutPrice({ plan: body.plan, price: body.price, interval: body.interval })
  const quantity = body.quantity ? Number(body.quantity) : 1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000)
    throw new BadRequest('Invalid quantity.')
  const customer = await getCustomer(subscriber as object, { create: true })
  const key = subscriberKey(ref)
  try {
    const session = await getProvider().createCheckoutSession({
      customer: customer!.providerId,
      lineItems: [{ price: resolved.price, quantity }],
      mode: resolved.mode,
      successUrl: safeRedirectUrl(c, body.successUrl ?? body.success_url, s.SUCCESS_URL),
      cancelUrl: safeRedirectUrl(c, body.cancelUrl ?? body.cancel_url, s.CANCEL_URL),
      clientReferenceId: key,
      metadata: { [SUBSCRIBER_METADATA_KEY]: key, ...(resolved.plan ? { ghuri_plan: resolved.plan } : {}) },
      trialPeriodDays: resolved.trialPeriodDays,
      extra: s.CHECKOUT_OPTIONS,
    })
    return respond(c, session)
  } catch (err) {
    if (err instanceof ProviderError)
      return jsonResponse({ detail: err.message, code: err.code ?? null }, 502)
    throw err
  }
}

/** `POST portal/`: a customer portal session for the request's subscriber. */
export const portalView: ViewFunction = async (c: Context) => {
  if (c.req.method !== 'POST') return jsonResponse({ detail: `Method "${c.req.method}" not allowed.` }, 405)
  const subscriber = await requestSubscriber(c)
  if (!subscriber || !(await resolveSubject(subscriber as object))) return unauthenticated(c)
  const body = await readBody(c)
  const customer = await getCustomer(subscriber as object, { create: true })
  try {
    const session = await getProvider().createPortalSession({
      customer: customer!.providerId,
      returnUrl: safeRedirectUrl(c, body.returnUrl ?? body.return_url, billingSettings().RETURN_URL),
    })
    return respond(c, session)
  } catch (err) {
    if (err instanceof ProviderError)
      return jsonResponse({ detail: err.message, code: err.code ?? null }, 502)
    throw err
  }
}

/** `POST webhook/`: verify, store and process a provider event. CSRF-exempt (the signature authenticates it). */
export const webhookView: ViewFunction = csrfExempt(async (c: Context) => {
  if (c.req.method !== 'POST') return jsonResponse({ detail: `Method "${c.req.method}" not allowed.` }, 405)
  const body = await c.req.text()
  try {
    const outcome = await handleWebhook(body, c.req.raw.headers)
    return jsonResponse({ received: true, ...outcome })
  } catch (err) {
    if (err instanceof SignatureVerificationError) return jsonResponse({ error: err.message }, 400)
    console.error('[billing] webhook processing failed:', err)
    return jsonResponse({ error: 'Webhook processing failed.' }, 500)
  }
})

/** `checkout/`, `portal/` and `webhook/` in the `billing` namespace. */
export const billingUrls = urlpatterns('billing', [
  path('checkout/', checkoutView, { name: 'checkout' }),
  path('portal/', portalView, { name: 'portal' }),
  path('webhook/', webhookView, { name: 'webhook' }),
])
