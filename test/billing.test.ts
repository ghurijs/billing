// End to end on every backend: migrations, checkout, webhooks (sync, idempotency, ordering), portal, access helpers.
import { bufferIO, callCommand } from '@ghuri/core'
import { connections } from '@ghuri/orm'
import { MigrationLoader, makeMigrations, showMigrations } from '@ghuri/orm/migrations'
import { describe, expect, it } from 'vitest'
import {
  Customer,
  clearEntitlementsCache,
  Event,
  getCustomer,
  getEntitlements,
  getPlan,
  getSubscription,
  hasActiveSubscription,
  hasFeature,
  Invoice,
  invoicePaid,
  invoicePaymentFailed,
  Price,
  Product,
  Subscription,
  SubscriptionItem,
  stripe,
  subscriptionCancelled,
  subscriptionCreated,
  subscriptionUpdated,
  syncProductsAndPrices,
  usageLimits,
  webhookProcessed,
} from '../src/index'
import { backends, deliver, type Harness, makeUser, seedPrices, useHarness } from './helpers'

/** Sign up `user` for a plan through the checkout view and a completed-checkout webhook. */
async function subscribe(h: Harness, user: any, body: Record<string, unknown> = { plan: 'pro' }) {
  await h.client.forceLogin(user)
  const res = await h.client.post('/billing/checkout/', { json: body })
  expect(res.status).toBe(200)
  const { id } = (await res.json()) as { id: string; url: string }
  const session = h.stripe.completeCheckout(id)
  const delivered = await deliver(h, h.stripe.event('checkout.session.completed', session))
  expect(delivered.status).toBe(200)
  const sub = await Subscription.objects.get({ providerId: session.subscription })
  return { session, sub }
}

function record<T extends object>(signal: {
  connect(fn: (a: T) => void): void
  disconnect(fn: any): boolean
}) {
  const calls: T[] = []
  const fn = (a: T) => {
    calls.push(a)
  }
  signal.connect(fn)
  return { calls, stop: () => signal.disconnect(fn) }
}

for (const using of backends) {
  describe(`billing (${using})`, () => {
    const h = useHarness({ using })

    it('ships 0001_initial, applied by the test database, with no missing changes', async () => {
      const loader = await MigrationLoader.load({ connection: null })
      expect(
        loader
          .getMigration('billing', '0001_initial')
          .operations.map((o) => o.describe())
          .sort(),
      ).toEqual(
        [
          'Create model Customer',
          'Create model Event',
          'Create model Invoice',
          'Create model Price',
          'Create model Product',
          'Create model Subscription',
          'Create model SubscriptionItem',
        ].sort(),
      )
      const status = await showMigrations({ appLabels: ['billing'], connection: await connections.get() })
      expect(status.map((s) => [s.name, s.applied])).toEqual([['0001_initial', true]])
      const res = await makeMigrations({ appLabels: ['billing'], check: true, write: false })
      expect(res.migrations).toEqual([])
      expect(h.db.using).toBe(using)
    })

    it('syncs products and prices with billing_sync', async () => {
      const seeded = seedPrices(h.stripe)
      const io = bufferIO()
      await callCommand('billing_sync', {}, io)
      expect(io.out).toEqual(['Synced 3 products and 4 prices.'])
      expect(await Product.objects.count()).toBe(3)
      expect(await Price.objects.count()).toBe(4)
      const yearly = await Price.objects.get({ lookupKey: 'pro_yearly' })
      expect([
        yearly.providerId,
        Number(yearly.unitAmount),
        yearly.currency,
        yearly.recurringInterval,
      ]).toEqual([seeded.yearly.id, 12000, 'usd', 'year'])
      expect(yearly.humanReadable).toBe('120.00 USD / year')
      expect(((await yearly.product) as Product).name).toBe('Pro')
    })

    it('refuses checkout without a subscriber, and for prices outside the plans', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      expect((await h.client.post('/billing/checkout/', { json: { plan: 'pro' } })).status).toBe(401)
      await h.client.forceLogin(await makeUser())
      const bad = async (json: Record<string, unknown>) => {
        const res = await h.client.post('/billing/checkout/', { json })
        return [res.status, ((await res.json()) as any).detail ?? ''] as const
      }
      expect((await bad({ price: 'internal_free' }))[0]).toBe(400)
      expect((await bad({ plan: 'nope' }))[0]).toBe(400)
      expect((await bad({}))[0]).toBe(400)
      expect((await bad({ plan: 'pro', quantity: 0 }))[0]).toBe(400)
      expect((await bad({ plan: 'pro', successUrl: 'https://evil.test/x' }))[0]).toBe(400)
      expect((await bad({ plan: 'pro', successUrl: '//evil.test/x' }))[0]).toBe(400)
      expect((await bad({ plan: 'pro', successUrl: 'javascript:alert(1)' }))[0]).toBe(400)
      expect(h.stripe.checkoutSessions.size).toBe(0)
    })

    it('starts a Checkout Session for the plan, creating the customer once', async () => {
      const seeded = seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser('ada')
      await h.client.forceLogin(user)
      const res = await h.client.post('/billing/checkout/', { json: { plan: 'pro', interval: 'year' } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: string; url: string }
      expect(body.url).toBe(`https://checkout.stripe.test/c/pay/${body.id}`)
      const session = h.stripe.checkoutSessions.get(body.id)!
      const customer = await Customer.objects.get({ subscriberId: String(user.pk) })
      expect([customer.subscriberType, customer.email, customer.provider]).toEqual([
        'auth.user',
        'ada@example.com',
        'stripe',
      ])
      expect(session).toMatchObject({
        customer: customer.providerId,
        mode: 'subscription',
        line_items: [{ price: seeded.yearly.id, quantity: '1' }],
        success_url: 'http://testserver/billing/thanks/?session={CHECKOUT_SESSION_ID}',
        cancel_url: 'http://testserver/pricing/',
        client_reference_id: `auth.user:${user.pk}`,
        metadata: { ghuri_subscriber: `auth.user:${user.pk}`, ghuri_plan: 'pro' },
      })
      expect(h.stripe.customers.get(customer.providerId)!.metadata).toEqual({
        ghuri_subscriber: `auth.user:${user.pk}`,
      })

      // a second checkout reuses the customer; a form post is redirected; allowed hosts may be return targets
      const form = await h.client.post('/billing/checkout/', {
        form: { price: 'price_team', successUrl: 'https://app.example.com/done' },
      })
      expect(form.status).toBe(303)
      const second = [...h.stripe.checkoutSessions.values()][1]
      expect(form.headers.get('location')).toBe(second.url)
      expect(second).toMatchObject({
        success_url: 'https://app.example.com/done',
        subscription_data: { trial_period_days: '14' },
      })
      expect(await Customer.objects.count()).toBe(1)
      const posts = h.stripe.requests.filter((r) => r.method === 'POST')
      expect(posts.every((r) => typeof r.headers['idempotency-key'] === 'string')).toBe(true)
    })

    it('syncs the subscription from a completed checkout and answers access questions', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser()
      const other = await makeUser()
      const created = record(subscriptionCreated)
      try {
        const { sub } = await subscribe(h, user)
        expect(created.calls.map((c) => c.subscription.providerId)).toEqual([sub.providerId])
        expect(sub.status).toBe('active')
        expect(sub.currentPeriodEnd).toBeInstanceOf(Date)
        const items = (await SubscriptionItem.objects.filter({ subscription: sub })) as SubscriptionItem[]
        expect(items.length).toBe(1)
        expect(((await getSubscription(user)) as Subscription).providerId).toBe(sub.providerId)
        expect(await getSubscription(other)).toBeNull()
        expect(await getSubscription(null)).toBeNull()
        expect(await hasActiveSubscription(user)).toBe(true)
        expect(await hasActiveSubscription(user, { plans: ['team'] })).toBe(false)
        expect((await getPlan(user)).key).toBe('pro')
        expect((await getPlan(other)).key).toBe('free')
        expect(await hasFeature(user, 'export')).toBe(true)
        expect(await hasFeature(other, 'export')).toBe(false)
        const e = await getEntitlements({ id: user.pk })
        expect([e.plan, e.limits.projects, e.active]).toEqual(['pro', 10, true])
        const customer = (await getCustomer(user))!
        expect(((await getSubscription(customer)) as Subscription).pk).toBe(sub.pk)
        expect(((await customer.getSubscriber()) as any).pk).toBe(user.pk)

        const limits = usageLimits('agentTokens')
        expect(await limits({ scope: 'user', key: String(user.pk), user })).toEqual({
          day: 100_000,
          month: 1_000_000,
        })
        expect(await limits({ scope: 'user', key: String(other.pk), user: other })).toEqual({ day: 1_000 })
        expect(await limits({ scope: 'anon', key: '*', user: null })).toBeNull()
        expect(
          await usageLimits('agentTokens', { otherwise: { day: 5 } })({ scope: 'tenant', key: '1' }),
        ).toEqual({
          day: 5,
        })
        expect(await usageLimits((ent) => (ent.plan === 'pro' ? { day: 1 } : null))(user)).toEqual({ day: 1 })
      } finally {
        created.stop()
      }
    })

    it('caches entitlements for usage limits until a subscription changes', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser()
      const subject = { scope: 'user', key: String(user.pk), user }
      const limits = usageLimits('agentTokens')
      const uncached = usageLimits('agentTokens', { cacheSeconds: 0 })
      expect(await limits(subject)).toEqual({ day: 1_000 })
      const { sub } = await subscribe(h, user) // subscriptionCreated clears the cache
      expect(await limits(subject)).toEqual({ day: 100_000, month: 1_000_000 })
      // a change made behind billing's back (no signal) is seen after the TTL, or at once without a cache
      await Subscription.objects.filter({ pk: sub.pk }).update({ status: 'canceled' })
      expect(await limits(subject)).toEqual({ day: 100_000, month: 1_000_000 })
      expect(await uncached(subject)).toEqual({ day: 1_000 })
      clearEntitlementsCache()
      expect(await limits(subject)).toEqual({ day: 1_000 })
    })

    it('handles a webhook once: duplicates are acknowledged without processing again', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser()
      const processed = record(webhookProcessed)
      try {
        const { session } = await subscribe(h, user)
        const event = h.stripe.event('checkout.session.completed', session, { id: 'evt_dup' })
        const first = await deliver(h, event)
        expect(((await first.json()) as any).result).toBe('processed')
        const again = await deliver(h, event)
        expect(again.status).toBe(200)
        expect(((await again.json()) as any).result).toBe('duplicate')
        const row = await Event.objects.get({ providerId: 'evt_dup' })
        expect([row.status, row.attempts, row.type]).toEqual(['processed', 1, 'checkout.session.completed'])
        expect(processed.calls.filter((c) => c.event.providerId === 'evt_dup').length).toBe(1)
      } finally {
        processed.stop()
      }
    })

    it('follows subscription changes, skips stale events, and signals cancellation', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser()
      const { sub } = await subscribe(h, user)
      const updated = record(subscriptionUpdated)
      const cancelled = record(subscriptionCancelled)
      try {
        const t0 = Math.floor(Date.now() / 1000)
        const pastDue = h.stripe.updateSubscription(sub.providerId, { status: 'past_due' })
        await deliver(h, h.stripe.event('customer.subscription.updated', pastDue, { created: t0 + 10 }))
        expect((await Subscription.objects.get({ pk: sub.pk })).status).toBe('past_due')
        expect(updated.calls.map((c) => c.previousStatus)).toEqual(['active'])
        expect(await hasActiveSubscription(user)).toBe(false)
        expect((await getPlan(user)).key).toBe('free')

        // an older event delivered late does not undo the newer state
        const stale = { ...structuredClone(pastDue), status: 'active' }
        const res = await deliver(
          h,
          h.stripe.event('customer.subscription.updated', stale, { created: t0 + 5 }),
        )
        expect(res.status).toBe(200)
        expect((await Subscription.objects.get({ pk: sub.pk })).status).toBe('past_due')

        const gone = h.stripe.cancelSubscription(sub.providerId)
        await deliver(h, h.stripe.event('customer.subscription.deleted', gone, { created: t0 + 20 }))
        const final = await Subscription.objects.get({ pk: sub.pk })
        expect([final.status, final.canceledAt instanceof Date]).toEqual(['canceled', true])
        expect(cancelled.calls.map((c) => [c.subscription.providerId, c.previousStatus])).toEqual([
          [sub.providerId, 'past_due'],
        ])
        expect(((await getSubscription(user)) as Subscription).status).toBe('canceled')
      } finally {
        updated.stop()
        cancelled.stop()
      }
    })

    it('mirrors invoices and signals paid and failed payments', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const user = await makeUser()
      const { sub } = await subscribe(h, user)
      const paid = record(invoicePaid)
      const failed = record(invoicePaymentFailed)
      try {
        const inv = h.stripe.createInvoice({ subscription: sub.providerId })
        await deliver(h, h.stripe.event('invoice.paid', inv))
        const row = await Invoice.objects.get({ providerId: inv.id })
        expect([Number(row.amountPaid), Number(row.total), row.currency, row.status, row.number]).toEqual([
          1200,
          1200,
          'usd',
          'paid',
          inv.number,
        ])
        expect(((await row.subscription) as Subscription).pk).toBe(sub.pk)
        expect(paid.calls.length).toBe(1)
        const open = h.stripe.createInvoice({ subscription: sub.providerId, status: 'open' })
        await deliver(h, h.stripe.event('invoice.payment_failed', open))
        expect(failed.calls.map((c) => c.invoice.providerId)).toEqual([open.id])
        expect(Number((await Invoice.objects.get({ providerId: open.id })).amountRemaining)).toBe(1200)
      } finally {
        paid.stop()
        failed.stop()
      }
    })

    it('updates products, prices and customers from their events, and ignores other events', async () => {
      const seeded = seedPrices(h.stripe)
      await syncProductsAndPrices()
      await deliver(h, h.stripe.event('product.updated', { ...seeded.pro, name: 'Pro+' }))
      expect((await Product.objects.get({ providerId: seeded.pro.id })).name).toBe('Pro+')
      await deliver(h, h.stripe.event('price.deleted', { ...seeded.monthly, deleted: true }))
      expect((await Price.objects.get({ providerId: seeded.monthly.id })).active).toBe(false)
      // a price whose product was never synced: the product is fetched
      const fresh = h.stripe.createProduct({ name: 'Fresh' })
      const p = h.stripe.createPrice({ product: fresh.id, unit_amount: 500, currency: 'eur' })
      await deliver(h, h.stripe.event('price.created', p))
      expect((await Product.objects.get({ providerId: fresh.id })).name).toBe('Fresh')

      const user = await makeUser()
      const customer = (await getCustomer(user, { create: true }))!
      await deliver(
        h,
        h.stripe.event('customer.updated', {
          ...h.stripe.customers.get(customer.providerId)!,
          email: 'new@example.com',
        }),
      )
      expect((await Customer.objects.get({ pk: customer.pk })).email).toBe('new@example.com')
      await deliver(
        h,
        h.stripe.event('customer.deleted', { id: customer.providerId, object: 'customer', deleted: true }),
      )
      expect((await Customer.objects.get({ pk: customer.pk })).deleted).toBe(true)
      expect(await getCustomer(user)).toBeNull()
      const replacement = (await getCustomer(user, { create: true }))!
      expect(replacement.providerId).not.toBe(customer.providerId)

      const res = await deliver(
        h,
        h.stripe.event('payment_intent.succeeded', { id: 'pi_1', object: 'payment_intent' }),
      )
      expect(((await res.json()) as any).result).toBe('ignored')
      expect((await Event.objects.get({ type: 'payment_intent.succeeded' })).status).toBe('ignored')
    })

    it('refuses unsigned, forged and stale webhooks', async () => {
      const event = h.stripe.event('product.created', h.stripe.createProduct())
      const body = JSON.stringify(event)
      const post = (headers: Record<string, string>) =>
        h.client.post('/billing/webhook/', {
          body,
          headers: { 'content-type': 'application/json', ...headers },
          csrf: false,
        } as any)
      expect((await post({})).status).toBe(400)
      expect((await post({ 'stripe-signature': 't=1,v1=00' })).status).toBe(400)
      expect((await deliver(h, event, { secret: 'whsec_wrong' })).status).toBe(400)
      expect((await deliver(h, event, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400)
      expect(await Event.objects.count()).toBe(0)
      expect((await h.client.get('/billing/webhook/')).status).toBe(405)
      // rotation: either secret verifies
      h.billing.PROVIDER = stripe({
        secretKey: h.stripe.secretKey,
        webhookSecret: ['whsec_new', h.stripe.webhookSecret],
        fetch: h.stripe.fetch,
      })
      expect((await deliver(h, event)).status).toBe(200)
      expect((await deliver(h, event, { secret: 'whsec_new' })).status).toBe(200)
      expect(await Event.objects.count()).toBe(1)
    })

    it('answers 500 when processing fails, stores the error, and succeeds on redelivery', async () => {
      const price = h.stripe.createPrice({ unit_amount: 700 })
      const customer = h.stripe.createCustomer({ email: 'late@example.com' })
      const sub = h.stripe.createSubscription({ customer: customer.id, price: price.id })
      h.stripe.customers.delete(customer.id) // the customer cannot be fetched
      const event = h.stripe.event('customer.subscription.created', sub)
      const errors = console.error
      console.error = () => {}
      try {
        expect((await deliver(h, event)).status).toBe(500)
      } finally {
        console.error = errors
      }
      const row = await Event.objects.get({ providerId: event.id })
      expect([row.status, row.attempts]).toEqual(['failed', 1])
      expect(row.error).toContain('No such customer')
      h.stripe.customers.set(customer.id, customer)
      if (using === 'sqlite') {
        // replayed by the command instead of a redelivery
        const io = bufferIO()
        await callCommand('billing_process_events', {}, io)
        expect(io.out).toEqual(['Processed 1 events, 0 failed.'])
        expect((await Event.objects.get({ providerId: event.id })).status).toBe('processed')
        expect(((await (await deliver(h, event)).json()) as any).result).toBe('duplicate')
        return
      }
      const retry = await deliver(h, event)
      expect(retry.status).toBe(200)
      const after = await Event.objects.get({ providerId: event.id })
      expect([after.status, after.attempts, after.error]).toEqual(['processed', 2, ''])
      expect((await Subscription.objects.get({ providerId: sub.id })).status).toBe('active')
      // unlinked customer (created outside the app): no subscriber
      expect((await Customer.objects.get({ providerId: customer.id })).subscriberId).toBeNull()
    })

    it('opens the customer portal', async () => {
      const user = await makeUser()
      expect((await h.client.post('/billing/portal/', { json: {} })).status).toBe(401)
      await h.client.forceLogin(user)
      const res = await h.client.post('/billing/portal/', { json: {} })
      expect(res.status).toBe(200)
      const { url } = (await res.json()) as { url: string }
      expect(url).toMatch(/^https:\/\/billing\.stripe\.test\//)
      const customer = (await getCustomer(user))!
      expect(h.stripe.portalSessions[0]).toMatchObject({
        customer: customer.providerId,
        return_url: 'http://testserver/account/',
      })
    })
  })
}
