// The Stripe adapter without a database: encoding, signatures, normalizing both API shapes, errors and retries.
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formEncode,
  ProviderError,
  SignatureVerificationError,
  stripe,
  stripeObject,
  verifyStripeSignature,
} from '../src/index'
import { fakeStripe, parseForm, signPayload } from '../src/testing'

describe('formEncode', () => {
  it("uses Stripe's bracket notation and skips empty values", () => {
    const body = formEncode({
      customer: 'cus_1',
      line_items: [{ price: 'price_1', quantity: 2 }],
      metadata: { a: 'b' },
      expand: ['product'],
      skipped: undefined,
      nothing: null,
      flag: true,
    })
    expect(decodeURIComponent(body)).toBe(
      'customer=cus_1&line_items[0][price]=price_1&line_items[0][quantity]=2&metadata[a]=b&expand[0]=product&flag=true',
    )
    expect(parseForm(body)).toEqual({
      customer: 'cus_1',
      line_items: [{ price: 'price_1', quantity: '2' }],
      metadata: { a: 'b' },
      expand: ['product'],
      flag: 'true',
    })
  })
})

describe('verifyStripeSignature', () => {
  const secret = 'whsec_unit'
  const body = '{"id":"evt_1","object":"event"}'
  const now = 1_800_000_000

  it('accepts a valid signature, also among several v1 values and secrets', async () => {
    const header = await signPayload(body, secret, now)
    await expect(verifyStripeSignature(body, header, [secret], 300, now)).resolves.toBeUndefined()
    await expect(
      verifyStripeSignature(body, `${header},v1=deadbeef,v0=abc`, ['whsec_old', secret], 300, now + 299),
    ).resolves.toBeUndefined()
  })

  it('refuses missing, malformed, forged, tampered and stale signatures', async () => {
    const header = await signPayload(body, secret, now)
    const fails = (b: string, h: string | null, s = [secret], at = now) =>
      expect(verifyStripeSignature(b, h, s, 300, at)).rejects.toThrow(SignatureVerificationError)
    await fails(body, null)
    await fails(body, '')
    await fails(body, 'v1=abc')
    await fails(body, `t=${now}`)
    await fails(body, header, ['whsec_other'])
    await fails(`${body} `, header)
    await fails(body, header, [secret], now + 301)
    await fails(body, header, [secret], now - 301)
    await fails(body, header, [])
  })

  it('maps to a 400', () => {
    expect(new SignatureVerificationError().status).toBe(400)
  })
})

describe('normalizing Stripe objects', () => {
  it('reads the current period from the subscription (old API) or its items (2025-03-31 and later)', () => {
    const price = {
      id: 'price_1',
      object: 'price',
      product: 'prod_1',
      currency: 'usd',
      unit_amount: 999,
      recurring: { interval: 'month', interval_count: 1 },
    }
    const legacy = stripeObject({
      id: 'sub_1',
      object: 'subscription',
      customer: { id: 'cus_1', object: 'customer' },
      status: 'trialing',
      current_period_start: 100,
      current_period_end: 200,
      items: { data: [{ id: 'si_1', price, quantity: 3 }] },
    }) as any
    expect([
      legacy.customer,
      legacy.status,
      legacy.currentPeriodEnd.getTime(),
      legacy.items[0].quantity,
    ]).toEqual(['cus_1', 'trialing', 200_000, 3])
    const basil = stripeObject({
      id: 'sub_2',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      items: { data: [{ id: 'si_2', price, current_period_start: 300, current_period_end: 400 }] },
    }) as any
    expect([
      basil.currentPeriodStart.getTime(),
      basil.currentPeriodEnd.getTime(),
      basil.items[0].price.unitAmount,
    ]).toEqual([300_000, 400_000, 999])
  })

  it("reads an invoice's subscription from either shape, and keeps amounts as integers", () => {
    const old = stripeObject({
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_1',
      subscription: 'sub_1',
      amount_due: 1050,
      currency: 'eur',
    }) as any
    const basil = stripeObject({
      id: 'in_2',
      object: 'invoice',
      customer: 'cus_1',
      parent: { subscription_details: { subscription: 'sub_2' } },
      amount_paid: 1050,
    }) as any
    expect([old.subscription, old.amountDue, basil.subscription, basil.amountPaid]).toEqual([
      'sub_1',
      1050,
      'sub_2',
      1050,
    ])
    expect(stripeObject({ object: 'payment_intent', id: 'pi_1' })).toBeNull()
    const oneTime = stripeObject({
      id: 'price_2',
      object: 'price',
      product: { id: 'prod_2', object: 'product', name: 'X' },
      type: 'one_time',
      unit_amount: 500,
      currency: 'jpy',
    }) as any
    expect([oneTime.type, oneTime.recurringInterval, oneTime.product, oneTime.productData.name]).toEqual([
      'one_time',
      '',
      'prod_2',
      'X',
    ])
  })

  it('formats minor units', () => {
    expect([formatAmount(1250, 'usd'), formatAmount(500, 'JPY'), formatAmount(5, 'eur')]).toEqual([
      '12.50 USD',
      '500 JPY',
      '0.05 EUR',
    ])
  })
})

describe('the Stripe client', () => {
  it('raises ProviderError with the status and code Stripe returns', async () => {
    const fake = fakeStripe()
    const provider = fake.provider()
    await expect(provider.retrieve('customer', 'cus_missing')).rejects.toMatchObject({
      constructor: ProviderError,
      status: 400,
    })
    const wrongKey = stripe({ secretKey: 'sk_test_other', fetch: fake.fetch, maxNetworkRetries: 0 })
    await expect(wrongKey.retrieve('customer', 'cus_x')).rejects.toMatchObject({ status: 401 })
    await expect(stripe({ secretKey: '' }).retrieve('customer', 'cus_x')).rejects.toThrow(ProviderError)
  })

  it('retries 5xx with the same idempotency key, then gives up', async () => {
    const fake = fakeStripe()
    const provider = stripe({ secretKey: fake.secretKey, fetch: fake.fetch, maxNetworkRetries: 1 })
    fake.failNext = [500]
    const c = await provider.createCustomer({ email: 'a@example.com', metadata: {} })
    expect(c.email).toBe('a@example.com')
    const [first, second] = fake.requests
    expect(first.headers['idempotency-key']).toBe(second.headers['idempotency-key'])
    fake.failNext = [500, 500]
    await expect(provider.createCustomer({ metadata: {} })).rejects.toMatchObject({ status: 500 })
  })

  it('sends Stripe-Version when pinned, lists with pagination, cancels subscriptions', async () => {
    const fake = fakeStripe()
    const provider = stripe({ secretKey: fake.secretKey, fetch: fake.fetch, apiVersion: '2025-03-31.basil' })
    for (let i = 0; i < 150; i++) fake.createProduct({ name: `P${i}` })
    const names: string[] = []
    for await (const p of provider.list('product')) names.push(p.name)
    expect(names.length).toBe(150)
    expect(fake.requests.filter((r) => r.path === '/v1/products').length).toBe(2)
    expect(fake.requests[0].headers['stripe-version']).toBe('2025-03-31.basil')
    const price = fake.createPrice()
    const customer = fake.createCustomer()
    const sub = fake.createSubscription({ customer: customer.id, price: price.id })
    expect((await provider.cancelSubscription(sub.id, { atPeriodEnd: true })).cancelAtPeriodEnd).toBe(true)
    expect((await provider.cancelSubscription(sub.id)).status).toBe('canceled')
  })

  it('never exposes its secrets', () => {
    const provider = stripe({ secretKey: 'sk_test_not_a_real_key', webhookSecret: 'whsec_not_real' })
    const shown = `${JSON.stringify(provider)} ${inspect(provider, { depth: 5 })} ${String(provider)}`
    expect(shown).not.toContain('sk_test_not_a_real_key')
    expect(shown).not.toContain('whsec_not_real')
    expect(provider.mode).toBe('test')
  })

  it('constructs events only from verified bodies', async () => {
    const fake = fakeStripe()
    const provider = fake.provider()
    const event = fake.event('customer.deleted', { id: 'cus_9', object: 'customer', deleted: true })
    const { body, headers } = await fake.webhook(event)
    const parsed = await provider.constructEvent(body, new Headers(headers))
    expect([parsed.id, parsed.type, parsed.deleted, parsed.object?.kind]).toEqual([
      event.id,
      'customer.deleted',
      true,
      'customer',
    ])
    const notEvent = await fake.webhook({ id: 'x', object: 'customer' } as any)
    await expect(provider.constructEvent(notEvent.body, new Headers(notEvent.headers))).rejects.toThrow(
      SignatureVerificationError,
    )
    const noSecret = stripe({ secretKey: fake.secretKey })
    await expect(noSecret.constructEvent(body, new Headers(headers))).rejects.toThrow(/webhook secret/)
  })
})
