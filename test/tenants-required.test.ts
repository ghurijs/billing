// A multi-tenant app with TENANTS.REQUIRED: Stripe's webhook carries no tenant, and must still be processed.
import { AuthenticationMiddleware, SessionMiddleware } from '@ghuri/auth'
import { CsrfMiddleware } from '@ghuri/core'
import { currentTenant, HeaderResolver, TenantMiddleware } from '@ghuri/tenants'
import { describe, expect, it } from 'vitest'
import { getSubscription, type Subscription, syncProductsAndPrices } from '../src/index'
import { Team } from './demo'
import { backends, deliver, makeUser, seedPrices, useHarness } from './helpers'

for (const using of backends) {
  describe(`TENANTS.REQUIRED (${using})`, () => {
    const h = useHarness({
      using,
      middleware: () => [SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware, TenantMiddleware],
      settings: () => ({
        TENANTS: {
          MODEL: 'demo.Team',
          REQUIRED: true,
          RESOLVERS: [new HeaderResolver({ header: 'x-team', field: 'pk' })],
        },
      }),
      billing: () => ({ SUBSCRIBER_MODEL: 'demo.Team', SUBSCRIBER: () => currentTenant() }),
    })

    it('processes webhooks, which carry no tenant, while other requests still need one', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const team = await Team.objects.create({ name: 'Acme' } as any)
      await h.client.forceLogin(await makeUser())
      expect((await h.client.post('/billing/checkout/', { json: { plan: 'pro' } })).status).toBe(404)
      const res = await h.client.post('/billing/checkout/', {
        json: { plan: 'pro' },
        headers: { 'x-team': String(team.pk) },
      })
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }

      const delivered = await deliver(
        h,
        h.stripe.event('checkout.session.completed', h.stripe.completeCheckout(id)),
      )
      expect(delivered.status).toBe(200)
      expect(await delivered.json()).toMatchObject({ received: true, result: 'processed' })
      expect(((await getSubscription(team)) as Subscription).status).toBe('active')
      // An unknown tenant is still a 404, on the webhook too.
      const unknown = await h.stripe.webhook(h.stripe.event('customer.updated', { id: 'cus_x' }))
      const res404 = await h.client.post('/billing/webhook/', {
        body: unknown.body,
        headers: { ...unknown.headers, 'x-team': '999999' },
        csrf: false,
      } as any)
      expect(res404.status).toBe(404)
    })
  })
}
