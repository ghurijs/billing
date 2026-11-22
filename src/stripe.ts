// The Stripe adapter: the Stripe REST API over `fetch` (form-encoded bodies, Idempotency-Key on POST) and webhook
// signatures checked with WebCrypto. No SDK: it runs unchanged on Workers and Node, and `fetch` is the test seam.
import { type CheckMessage, checks } from '@ghuri/core'
import { hmacSha256Hex, randomId, timingSafeEqual } from './crypto'
import { ProviderError, SignatureVerificationError } from './errors'
import type {
  BillingProvider,
  CheckoutOptions,
  CheckoutSessionData,
  CreateCustomerOptions,
  CustomerData,
  InvoiceData,
  ObjectData,
  PriceData,
  ProductData,
  ProviderEvent,
  RetrievableKind,
  SubscriptionData,
} from './provider'
import type { SubscriptionStatus } from './settings'

export interface StripeOptions {
  /** `sk_live_…` / `sk_test_…` (or a restricted `rk_…` key). Read it from `env`, never commit it. */
  secretKey: string | undefined
  /** The webhook endpoint's signing secret (`whsec_…`), or several while rotating. */
  webhookSecret?: string | string[] | undefined
  /** `Stripe-Version` sent with every request (default: the account's API version). */
  apiVersion?: string
  /** Seconds a webhook timestamp may differ from now (default 300, as Stripe's libraries). */
  tolerance?: number
  /** Retries of a request that failed with 429, 5xx or a network error (default 2), with the same idempotency key. */
  maxNetworkRetries?: number
  /** `fetch` to use (tests pass `fakeStripe().fetch`). */
  fetch?: typeof fetch
  /** API origin (default `https://api.stripe.com`). */
  apiBase?: string
}

type Raw = Record<string, any>

const KIND_PATHS: Record<RetrievableKind, string> = {
  customer: 'customers',
  product: 'products',
  price: 'prices',
  subscription: 'subscriptions',
  invoice: 'invoices',
}

/** `application/x-www-form-urlencoded` with Stripe's bracket notation (`line_items[0][price]=…`). */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams()
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) add(`${key}[${i}]`, v)
    } else if (value instanceof Date) out.append(key, String(Math.floor(value.getTime() / 1000)))
    else if (typeof value === 'object')
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v)
    else out.append(key, String(value))
  }
  for (const [k, v] of Object.entries(params)) add(k, v)
  return out.toString()
}

const date = (v: unknown): Date | null => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const idOf = (v: unknown): string => (typeof v === 'string' ? v : str((v as Raw | null)?.id))
const meta = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out[k] = String(x)
  return out
}
const base = (o: Raw) => ({
  id: str(o.id),
  livemode: typeof o.livemode === 'boolean' ? o.livemode : null,
  metadata: meta(o.metadata),
  created: date(o.created),
})

export function stripeCustomer(o: Raw): CustomerData {
  return {
    ...base(o),
    kind: 'customer',
    email: str(o.email),
    name: str(o.name),
    currency: str(o.currency),
    deleted: o.deleted === true,
  }
}

export function stripeProduct(o: Raw): ProductData {
  return {
    ...base(o),
    kind: 'product',
    name: str(o.name),
    description: str(o.description),
    active: o.active !== false && o.deleted !== true,
    deleted: o.deleted === true,
  }
}

export function stripePrice(o: Raw): PriceData {
  const recurring = (o.recurring ?? null) as Raw | null
  return {
    ...base(o),
    kind: 'price',
    product: idOf(o.product),
    productData: o.product && typeof o.product === 'object' ? stripeProduct(o.product) : undefined,
    active: o.active !== false && o.deleted !== true,
    currency: str(o.currency),
    unitAmount: typeof o.unit_amount === 'number' ? o.unit_amount : null,
    type: o.type === 'one_time' ? 'one_time' : recurring || o.type === 'recurring' ? 'recurring' : 'one_time',
    recurringInterval: (str(recurring?.interval) as PriceData['recurringInterval']) || '',
    recurringIntervalCount: typeof recurring?.interval_count === 'number' ? recurring.interval_count : null,
    lookupKey: str(o.lookup_key),
    nickname: str(o.nickname),
    trialPeriodDays: typeof recurring?.trial_period_days === 'number' ? recurring.trial_period_days : null,
    deleted: o.deleted === true,
  }
}

export function stripeSubscription(o: Raw): SubscriptionData {
  const items = ((o.items?.data ?? []) as Raw[]).map((it) => ({
    id: str(it.id),
    price: stripePrice(it.price ?? it.plan ?? {}),
    quantity: typeof it.quantity === 'number' ? it.quantity : 1,
  }))
  // API 2025-03-31 (basil) moved the current period onto the items.
  const first = (o.items?.data?.[0] ?? {}) as Raw
  return {
    ...base(o),
    kind: 'subscription',
    customer: idOf(o.customer),
    status: (str(o.status) || 'incomplete') as SubscriptionStatus,
    currentPeriodStart: date(o.current_period_start ?? first.current_period_start),
    currentPeriodEnd: date(o.current_period_end ?? first.current_period_end),
    cancelAtPeriodEnd: o.cancel_at_period_end === true,
    cancelAt: date(o.cancel_at),
    canceledAt: date(o.canceled_at),
    endedAt: date(o.ended_at),
    trialStart: date(o.trial_start),
    trialEnd: date(o.trial_end),
    items,
  }
}

export function stripeInvoice(o: Raw): InvoiceData {
  // API 2025-03-31 (basil) moved `subscription` under `parent.subscription_details`.
  const subscription = idOf(o.subscription) || idOf(o.parent?.subscription_details?.subscription)
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    ...base(o),
    kind: 'invoice',
    customer: idOf(o.customer),
    subscription: subscription || null,
    status: (str(o.status) as InvoiceData['status']) || '',
    currency: str(o.currency),
    amountDue: num(o.amount_due),
    amountPaid: num(o.amount_paid),
    amountRemaining: num(o.amount_remaining),
    subtotal: num(o.subtotal),
    total: num(o.total),
    number: str(o.number),
    hostedInvoiceUrl: str(o.hosted_invoice_url),
    invoicePdf: str(o.invoice_pdf),
    periodStart: date(o.period_start),
    periodEnd: date(o.period_end),
    paidAt: date(o.status_transitions?.paid_at),
  }
}

export function stripeCheckoutSession(o: Raw): CheckoutSessionData {
  return {
    ...base(o),
    kind: 'checkout_session',
    customer: idOf(o.customer) || null,
    subscription: idOf(o.subscription) || null,
    clientReferenceId: typeof o.client_reference_id === 'string' ? o.client_reference_id : null,
    mode: (str(o.mode) || 'payment') as CheckoutSessionData['mode'],
    status: str(o.status),
  }
}

/** A Stripe object (by its `object` field) normalized, or null for objects billing does not sync. */
export function stripeObject(o: Raw): ObjectData | null {
  switch (o?.object) {
    case 'customer':
      return stripeCustomer(o)
    case 'product':
      return stripeProduct(o)
    case 'price':
    case 'plan':
      return stripePrice(o)
    case 'subscription':
      return stripeSubscription(o)
    case 'invoice':
      return stripeInvoice(o)
    case 'checkout.session':
      return stripeCheckoutSession(o)
    default:
      return null
  }
}

/** Parse `Stripe-Signature: t=…,v1=…,v1=…`. */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = Number.NaN
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') timestamp = Number(v)
    else if (k === 'v1') signatures.push(v)
  }
  return { timestamp, signatures }
}

/**
 * Verify a Stripe webhook signature: HMAC-SHA256 of `"<t>.<body>"` with one of `secrets` must equal one of the
 * `v1` signatures, and `t` must be within `tolerance` seconds of `now` (seconds). Throws
 * `SignatureVerificationError`.
 */
export async function verifyStripeSignature(
  body: string,
  header: string | null | undefined,
  secrets: string[],
  tolerance = 300,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!header) throw new SignatureVerificationError('No Stripe-Signature header.')
  const { timestamp, signatures } = parseSignatureHeader(header)
  if (!Number.isInteger(timestamp) || !signatures.length)
    throw new SignatureVerificationError(
      'Unable to extract timestamp and signatures from the Stripe-Signature header.',
    )
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance)
    throw new SignatureVerificationError('The webhook timestamp is outside the tolerance zone.')
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`)
    if (signatures.some((s) => timingSafeEqual(s, expected))) return
  }
  throw new SignatureVerificationError('No signatures found matching the expected signature for the payload.')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The Stripe provider. Create it with `stripe({ secretKey, webhookSecret })`. */
export class StripeProvider implements BillingProvider {
  readonly name = 'stripe'
  readonly apiVersion?: string
  readonly tolerance: number
  readonly maxNetworkRetries: number
  readonly apiBase: string
  // Private fields: never shown by inspection, JSON or the debug page.
  readonly #secretKey: string
  readonly #webhookSecrets: string[]
  readonly #fetch?: typeof fetch

  constructor(opts: StripeOptions) {
    this.#secretKey = opts.secretKey ?? ''
    const ws = opts.webhookSecret
    this.#webhookSecrets = (Array.isArray(ws) ? ws : ws ? [ws] : []).filter(Boolean)
    this.apiVersion = opts.apiVersion
    this.tolerance = opts.tolerance ?? 300
    this.maxNetworkRetries = opts.maxNetworkRetries ?? 2
    this.apiBase = (opts.apiBase ?? 'https://api.stripe.com').replace(/\/$/, '')
    this.#fetch = opts.fetch
  }

  /** `'test'`, `'live'` or null (no or malformed key), from the secret key's prefix. */
  get mode(): 'test' | 'live' | null {
    const m = /^(?:sk|rk)_(test|live)_/.exec(this.#secretKey)
    return m ? (m[1] as 'test' | 'live') : null
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, mode: this.mode, apiVersion: this.apiVersion }
  }

  /** Call the Stripe API: `request('POST', '/v1/customers', { email })`. Throws `ProviderError`. */
  async request<T = Raw>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Raw = {}): Promise<T> {
    if (!this.#secretKey) throw new ProviderError('Stripe secret key is not configured (BILLING.PROVIDER).')
    const doFetch = this.#fetch ?? globalThis.fetch
    const query = formEncode(params)
    let url = `${this.apiBase}${path}`
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#secretKey}`,
      'user-agent': 'ghuri-billing/0.1',
    }
    if (this.apiVersion) headers['stripe-version'] = this.apiVersion
    let body: string | undefined
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      headers['idempotency-key'] = randomId()
      body = query
    } else if (query) {
      url += `?${query}`
    }
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await doFetch(url, { method, headers, body })
      } catch (err) {
        if (attempt < this.maxNetworkRetries) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        throw new ProviderError(`Could not reach Stripe: ${(err as Error).message}`, { cause: err })
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxNetworkRetries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      const text = await res.text()
      let data: Raw = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const e = (data.error ?? {}) as Raw
        throw new ProviderError(`Stripe: ${str(e.message) || `HTTP ${res.status}`}`, {
          status: res.status,
          code: str(e.code) || undefined,
          type: str(e.type) || undefined,
        })
      }
      return data as T
    }
  }

  async createCustomer(opts: CreateCustomerOptions): Promise<CustomerData> {
    return stripeCustomer(
      await this.request('POST', '/v1/customers', {
        email: opts.email || undefined,
        name: opts.name || undefined,
        metadata: opts.metadata,
      }),
    )
  }

  async createCheckoutSession(opts: CheckoutOptions): Promise<{ id: string; url: string }> {
    const params: Raw = {
      customer: opts.customer,
      mode: opts.mode,
      line_items: opts.lineItems.map((li) => ({ price: li.price, quantity: li.quantity ?? 1 })),
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      client_reference_id: opts.clientReferenceId,
      metadata: opts.metadata,
    }
    if (opts.mode === 'subscription')
      params.subscription_data = { metadata: opts.metadata, trial_period_days: opts.trialPeriodDays }
    const session = await this.request('POST', '/v1/checkout/sessions', { ...params, ...opts.extra })
    return { id: str(session.id), url: str(session.url) }
  }

  async createPortalSession(opts: { customer: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.request('POST', '/v1/billing_portal/sessions', {
      customer: opts.customer,
      return_url: opts.returnUrl,
    })
    return { url: str(session.url) }
  }

  async constructEvent(body: string, headers: Headers): Promise<ProviderEvent> {
    if (!this.#webhookSecrets.length)
      throw new SignatureVerificationError('No Stripe webhook secret is configured (BILLING.PROVIDER).')
    await verifyStripeSignature(body, headers.get('stripe-signature'), this.#webhookSecrets, this.tolerance)
    let raw: Raw
    try {
      raw = JSON.parse(body)
    } catch {
      throw new SignatureVerificationError('The webhook body is not JSON.')
    }
    if (raw?.object !== 'event' || typeof raw.id !== 'string' || typeof raw.type !== 'string')
      throw new SignatureVerificationError('The webhook body is not a Stripe event.')
    return this.parseEvent(raw)
  }

  parseEvent(raw: Raw): ProviderEvent {
    const obj = (raw.data?.object ?? {}) as Raw
    const type = str(raw.type)
    return {
      id: str(raw.id),
      type,
      created: date(raw.created) ?? new Date(),
      livemode: typeof raw.livemode === 'boolean' ? raw.livemode : null,
      object: stripeObject(obj),
      deleted: type.endsWith('.deleted') || obj.deleted === true,
      raw,
    }
  }

  retrieve(kind: 'customer', id: string): Promise<CustomerData>
  retrieve(kind: 'product', id: string): Promise<ProductData>
  retrieve(kind: 'price', id: string): Promise<PriceData>
  retrieve(kind: 'subscription', id: string): Promise<SubscriptionData>
  retrieve(kind: 'invoice', id: string): Promise<InvoiceData>
  retrieve(kind: RetrievableKind, id: string): Promise<ObjectData>
  async retrieve(kind: RetrievableKind, id: string): Promise<ObjectData> {
    const params = kind === 'price' ? { expand: ['product'] } : {}
    const o = await this.request('GET', `/v1/${KIND_PATHS[kind]}/${encodeURIComponent(id)}`, params)
    return stripeObject(o) as ObjectData
  }

  list(kind: 'product'): AsyncIterable<ProductData>
  list(kind: 'price'): AsyncIterable<PriceData>
  list(kind: 'product' | 'price'): AsyncIterable<ProductData | PriceData>
  async *list(kind: 'product' | 'price'): AsyncIterable<ProductData | PriceData> {
    let startingAfter: string | undefined
    for (;;) {
      const page = await this.request('GET', `/v1/${KIND_PATHS[kind]}`, {
        limit: 100,
        starting_after: startingAfter,
      })
      const data = (page.data ?? []) as Raw[]
      for (const o of data)
        yield (kind === 'price' ? stripePrice(o) : stripeProduct(o)) as ProductData | PriceData
      if (!page.has_more || !data.length) return
      startingAfter = str(data[data.length - 1].id)
    }
  }

  async cancelSubscription(id: string, opts: { atPeriodEnd?: boolean } = {}): Promise<SubscriptionData> {
    const path = `/v1/subscriptions/${encodeURIComponent(id)}`
    const o = opts.atPeriodEnd
      ? await this.request('POST', path, { cancel_at_period_end: true })
      : await this.request('DELETE', path)
    return stripeSubscription(o)
  }

  check(opts: { debug: boolean; deploy: boolean }): CheckMessage[] {
    const out: CheckMessage[] = []
    const key = this.#secretKey
    if (!opts.deploy) {
      if (!key) {
        out.push(
          checks.error('The Stripe secret key is empty.', {
            hint: 'stripe({ secretKey: env.STRIPE_SECRET_KEY }) and set STRIPE_SECRET_KEY (wrangler secret / .dev.vars).',
            id: 'billing.E002',
            obj: 'BILLING.PROVIDER',
          }),
        )
      } else if (/^pk_/.test(key)) {
        out.push(
          checks.error('BILLING.PROVIDER has a publishable key (pk_…) where the secret key belongs.', {
            hint: 'Use the secret key (sk_…) or a restricted key (rk_…); publishable keys cannot call the API.',
            id: 'billing.E002',
            obj: 'BILLING.PROVIDER',
          }),
        )
      } else if (!this.mode) {
        out.push(
          checks.error(
            "The Stripe secret key does not look like a key (expected 'sk_test_…' or 'sk_live_…').",
            {
              id: 'billing.E002',
              obj: 'BILLING.PROVIDER',
            },
          ),
        )
      }
      if (!this.#webhookSecrets.length) {
        out.push(
          checks.error('The Stripe webhook secret is empty: every webhook will be refused.', {
            hint: "stripe({ webhookSecret: env.STRIPE_WEBHOOK_SECRET }) with the endpoint's signing secret (whsec_…).",
            id: 'billing.E003',
            obj: 'BILLING.PROVIDER',
          }),
        )
      }
    } else if (this.mode === 'test' && !opts.debug) {
      out.push(
        checks.warning('BILLING.PROVIDER uses a Stripe test key with DEBUG = false.', {
          hint: 'Use the live key (sk_live_…) in production.',
          id: 'billing.W001',
          obj: 'BILLING.PROVIDER',
        }),
      )
    }
    return out
  }
}

/** The Stripe provider for `BILLING.PROVIDER`. */
export function stripe(opts: StripeOptions): StripeProvider {
  return new StripeProvider(opts)
}
