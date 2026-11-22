// @ghuri/billing/testing — an in-memory Stripe for tests: no network, no keys. Pass `fake.fetch` to `stripe()` (or use
// `fake.provider()`), drive subscriptions with the helpers, and post signed events to the webhook view.
import { hmacSha256Hex } from './crypto'
import { type StripeProvider, stripe } from './stripe'

type Raw = Record<string, any>

/** `Stripe-Signature` header for `body`, signed with `secret` at `timestamp` (seconds, default now). */
export async function signPayload(
  body: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`
}

/** Parse Stripe-style form parameters (`a[b][0][c]=v`) into nested objects and arrays. */
export function parseForm(text: string): Raw {
  const root: Raw = {}
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.replace(/\]/g, '').split('[')
    let node: Raw = root
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value
      else node = node[part] ??= {}
    })
  }
  const arrays = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v
    const o = v as Raw
    const keys = Object.keys(o)
    if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => arrays(o[k]))
    for (const k of keys) o[k] = arrays(o[k])
    return o
  }
  return arrays(root) as Raw
}

export interface FakeStripeOptions {
  /** The key the fake accepts (default `'sk_test_fake'`; never a real key). */
  secretKey?: string
  /** The webhook secret events are signed with (default `'whsec_fake'`). */
  webhookSecret?: string
}

export interface RecordedRequest {
  method: string
  path: string
  params: Raw
  headers: Record<string, string>
}

const now = () => Math.floor(Date.now() / 1000)
const DAY = 86_400
const INTERVAL_SECONDS: Record<string, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }

function stripeError(status: number, message: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message, code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** An in-memory Stripe REST API. */
export class FakeStripe {
  readonly secretKey: string
  readonly webhookSecret: string
  readonly customers = new Map<string, Raw>()
  readonly products = new Map<string, Raw>()
  readonly prices = new Map<string, Raw>()
  readonly subscriptions = new Map<string, Raw>()
  readonly invoices = new Map<string, Raw>()
  readonly checkoutSessions = new Map<string, Raw>()
  readonly portalSessions: Raw[] = []
  readonly requests: RecordedRequest[] = []
  /** Set to make the next requests fail with this status (e.g. 500), consumed one per request. */
  failNext: number[] = []
  private seq = 0

  constructor(opts: FakeStripeOptions = {}) {
    this.secretKey = opts.secretKey ?? 'sk_test_fake'
    this.webhookSecret = opts.webhookSecret ?? 'whsec_fake'
  }

  /** `fetch` implementing the Stripe API against this fake. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const params = method === 'POST' ? parseForm(String(init?.body ?? '')) : parseForm(url.search.slice(1))
    this.requests.push({ method, path: url.pathname, params, headers })
    const fail = this.failNext.shift()
    if (fail) return stripeError(fail, 'Injected failure.')
    if (headers.authorization !== `Bearer ${this.secretKey}`)
      return stripeError(401, 'Invalid API Key provided.')
    try {
      const body = this.route(method, url.pathname, params)
      if (body instanceof Response) return body
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      return stripeError(400, (err as Error).message)
    }
  }

  /** A `stripe()` provider wired to this fake. */
  provider(opts: { apiVersion?: string; tolerance?: number } = {}): StripeProvider {
    return stripe({
      secretKey: this.secretKey,
      webhookSecret: this.webhookSecret,
      fetch: this.fetch,
      maxNetworkRetries: 0,
      ...opts,
    })
  }

  id(prefix: string): string {
    this.seq += 1
    return `${prefix}_fake${String(this.seq).padStart(6, '0')}`
  }

  /** Forget everything (between tests). */
  reset(): void {
    for (const m of [
      this.customers,
      this.products,
      this.prices,
      this.subscriptions,
      this.invoices,
      this.checkoutSessions,
    ])
      m.clear()
    this.portalSessions.length = 0
    this.requests.length = 0
    this.failNext = []
  }

  // ---- objects ----

  createCustomer(data: Raw = {}): Raw {
    const c = {
      id: data.id ?? this.id('cus'),
      object: 'customer',
      email: data.email ?? null,
      name: data.name ?? null,
      currency: data.currency ?? null,
      metadata: data.metadata ?? {},
      created: now(),
      livemode: false,
    }
    this.customers.set(c.id, c)
    return c
  }

  createProduct(data: Raw = {}): Raw {
    const p = {
      id: data.id ?? this.id('prod'),
      object: 'product',
      name: data.name ?? 'Product',
      description: data.description ?? null,
      active: data.active ?? true,
      metadata: data.metadata ?? {},
      created: now(),
      livemode: false,
    }
    this.products.set(p.id, p)
    return p
  }

  /** A price: `{ product, unit_amount, currency, recurring: { interval }, lookup_key }`. */
  createPrice(data: Raw = {}): Raw {
    const product = data.product ?? this.createProduct().id
    const recurring =
      data.recurring === null ? null : { interval: 'month', interval_count: 1, ...(data.recurring ?? {}) }
    const p = {
      id: data.id ?? this.id('price'),
      object: 'price',
      product,
      active: data.active ?? true,
      currency: data.currency ?? 'usd',
      unit_amount: data.unit_amount === undefined ? 1000 : Number(data.unit_amount),
      type: recurring ? 'recurring' : 'one_time',
      recurring: recurring
        ? {
            interval: recurring.interval,
            interval_count: Number(recurring.interval_count ?? 1),
            trial_period_days: recurring.trial_period_days ?? null,
          }
        : null,
      lookup_key: data.lookup_key ?? null,
      nickname: data.nickname ?? null,
      metadata: data.metadata ?? {},
      created: now(),
      livemode: false,
    }
    this.prices.set(p.id, p)
    return p
  }

  /** A subscription of `customer` to `price` (`status` default `'active'`), with one item. */
  createSubscription(data: {
    customer: string
    price: string
    quantity?: number
    status?: string
    trialDays?: number
    metadata?: Raw
  }): Raw {
    const price = this.prices.get(data.price)
    if (!price) throw new Error(`No such price: '${data.price}'`)
    const start = now()
    const length =
      INTERVAL_SECONDS[price.recurring?.interval ?? 'month'] * (price.recurring?.interval_count ?? 1)
    const s: Raw = {
      id: this.id('sub'),
      object: 'subscription',
      customer: data.customer,
      status: data.status ?? (data.trialDays ? 'trialing' : 'active'),
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      trial_start: data.trialDays ? start : null,
      trial_end: data.trialDays ? start + data.trialDays * DAY : null,
      metadata: data.metadata ?? {},
      created: start,
      livemode: false,
      items: {
        object: 'list',
        data: [
          {
            id: this.id('si'),
            object: 'subscription_item',
            price,
            quantity: data.quantity ?? 1,
            current_period_start: start,
            current_period_end: start + length,
          },
        ],
      },
    }
    this.subscriptions.set(s.id, s)
    return s
  }

  /** Change a subscription (`{ status: 'past_due' }`, `{ cancel_at_period_end: true }`) and return it. */
  updateSubscription(id: string, patch: Raw): Raw {
    const s = this.subscriptions.get(id)
    if (!s) throw new Error(`No such subscription: '${id}'`)
    Object.assign(s, patch)
    return s
  }

  /** Cancel a subscription now. */
  cancelSubscription(id: string): Raw {
    return this.updateSubscription(id, { status: 'canceled', canceled_at: now(), ended_at: now() })
  }

  /** An invoice for a subscription (`status` default `'paid'`). */
  createInvoice(data: { subscription: string; status?: string; amount?: number }): Raw {
    const sub = this.subscriptions.get(data.subscription)
    if (!sub) throw new Error(`No such subscription: '${data.subscription}'`)
    const price = sub.items.data[0].price
    const amount = data.amount ?? price.unit_amount * sub.items.data[0].quantity
    const status = data.status ?? 'paid'
    const inv = {
      id: this.id('in'),
      object: 'invoice',
      customer: sub.customer,
      parent: { type: 'subscription_details', subscription_details: { subscription: sub.id } },
      status,
      currency: price.currency,
      amount_due: amount,
      amount_paid: status === 'paid' ? amount : 0,
      amount_remaining: status === 'paid' ? 0 : amount,
      subtotal: amount,
      total: amount,
      number: `FAKE-${String(this.invoices.size + 1).padStart(4, '0')}`,
      hosted_invoice_url: 'https://invoice.stripe.test/i/fake',
      invoice_pdf: 'https://invoice.stripe.test/i/fake/pdf',
      period_start: sub.items.data[0].current_period_start,
      period_end: sub.items.data[0].current_period_end,
      status_transitions: { paid_at: status === 'paid' ? now() : null },
      metadata: {},
      created: now(),
      livemode: false,
    }
    this.invoices.set(inv.id, inv)
    return inv
  }

  /**
   * Complete a Checkout Session as the customer would: creates the subscription for its line item and returns the
   * session (now `complete`, with `subscription` set). Post `event('checkout.session.completed', session)`.
   */
  completeCheckout(sessionId: string): Raw {
    const session = this.checkoutSessions.get(sessionId)
    if (!session) throw new Error(`No such checkout session: '${sessionId}'`)
    const item = session.line_items?.[0] ?? {}
    if (session.mode === 'subscription') {
      const sub = this.createSubscription({
        customer: session.customer,
        price: item.price,
        quantity: Number(item.quantity ?? 1),
        trialDays: session.subscription_data?.trial_period_days
          ? Number(session.subscription_data.trial_period_days)
          : undefined,
        metadata: session.subscription_data?.metadata,
      })
      session.subscription = sub.id
    }
    session.status = 'complete'
    return session
  }

  // ---- events ----

  /** A Stripe event about `object` (a copy is taken). */
  event(
    type: string,
    object: Raw,
    opts: { id?: string; created?: number; previousAttributes?: Raw } = {},
  ): Raw {
    return {
      id: opts.id ?? this.id('evt'),
      object: 'event',
      api_version: '2025-03-31.basil',
      type,
      created: opts.created ?? now(),
      livemode: false,
      pending_webhooks: 1,
      data: {
        object: structuredClone(object),
        ...(opts.previousAttributes ? { previous_attributes: opts.previousAttributes } : {}),
      },
    }
  }

  /** A signed webhook delivery for `event`: `{ body, headers }` ready to POST to the webhook view. */
  async webhook(
    event: Raw,
    opts: { secret?: string; timestamp?: number } = {},
  ): Promise<{ body: string; headers: Record<string, string> }> {
    const body = JSON.stringify(event)
    return {
      body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': await signPayload(body, opts.secret ?? this.webhookSecret, opts.timestamp),
      },
    }
  }

  // ---- REST routes ----

  private get(map: Map<string, Raw>, id: string, what: string): Raw {
    const o = map.get(id)
    if (!o) throw new Error(`No such ${what}: '${id}'`)
    return o
  }

  private list(map: Map<string, Raw>, params: Raw): Raw {
    const all = [...map.values()]
    const start = params.starting_after ? all.findIndex((o) => o.id === params.starting_after) + 1 : 0
    const limit = Number(params.limit ?? 10)
    const data = all.slice(start, start + limit)
    return { object: 'list', data, has_more: start + limit < all.length, url: '' }
  }

  private route(method: string, path: string, p: Raw): Raw | Response {
    const seg = path.split('/').filter(Boolean) // ['v1', 'customers', 'cus_…'] or ['v1', 'checkout', 'sessions']
    const nested = seg[1] === 'checkout' || seg[1] === 'billing_portal'
    const resource = nested ? `${seg[1]}/${seg[2]}` : seg[1]
    const id = seg[nested ? 3 : 2]
    const key = `${method} ${resource}${id ? '/:id' : ''}`
    switch (key) {
      case 'POST customers':
        return this.createCustomer(p)
      case 'GET customers/:id':
        return this.get(this.customers, id, 'customer')
      case 'POST products':
        return this.createProduct(p)
      case 'GET products':
        return this.list(this.products, p)
      case 'GET products/:id':
        return this.get(this.products, id, 'product')
      case 'POST prices':
        return this.createPrice(p)
      case 'GET prices':
        return this.list(this.prices, p)
      case 'GET prices/:id': {
        const price = this.get(this.prices, id, 'price')
        const expand: string[] = p.expand ?? []
        return expand.includes('product')
          ? { ...price, product: this.products.get(price.product) ?? price.product }
          : price
      }
      case 'GET subscriptions/:id':
        return this.get(this.subscriptions, id, 'subscription')
      case 'POST subscriptions/:id':
        this.get(this.subscriptions, id, 'subscription')
        return this.updateSubscription(id, { cancel_at_period_end: p.cancel_at_period_end === 'true' })
      case 'DELETE subscriptions/:id':
        this.get(this.subscriptions, id, 'subscription')
        return this.cancelSubscription(id)
      case 'GET invoices/:id':
        return this.get(this.invoices, id, 'invoice')
      case 'POST checkout/sessions': {
        if (!p.customer || !this.customers.has(p.customer))
          throw new Error(`No such customer: '${p.customer}'`)
        for (const li of p.line_items ?? [])
          if (!this.prices.has(li.price)) throw new Error(`No such price: '${li.price}'`)
        const s = {
          id: this.id('cs'),
          object: 'checkout.session',
          url: '',
          status: 'open',
          subscription: null,
          created: now(),
          livemode: false,
          ...p,
        }
        s.url = `https://checkout.stripe.test/c/pay/${s.id}`
        this.checkoutSessions.set(s.id, s)
        return s
      }
      case 'POST billing_portal/sessions': {
        if (!p.customer || !this.customers.has(p.customer))
          throw new Error(`No such customer: '${p.customer}'`)
        const s = {
          id: this.id('bps'),
          object: 'billing_portal.session',
          url: `https://billing.stripe.test/p/session/${this.seq}`,
          ...p,
        }
        this.portalSessions.push(s)
        return s
      }
      default:
        return stripeError(404, `Unrecognized request URL (${method}: ${path}).`)
    }
  }
}

/** A fresh in-memory Stripe. */
export function fakeStripe(opts: FakeStripeOptions = {}): FakeStripe {
  return new FakeStripe(opts)
}
