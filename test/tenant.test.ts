// Billing per tenant: SUBSCRIBER_MODEL is a team model and SUBSCRIBER picks the team of the request (as
// `currentTenant()` would with @ghuri/tenants, which billing does not import).
import { describe, expect, it } from 'vitest'
import {
  Customer,
  getEntitlements,
  getSubscription,
  hasActiveSubscription,
  type Subscription,
  syncProductsAndPrices,
  usageLimits,
} from '../src/index'
import { Team } from './demo'
import { backends, deliver, makeUser, seedPrices, useHarness } from './helpers'

for (const using of backends) {
  describe(`per-tenant billing (${using})`, () => {
    const h = useHarness({
      using,
      billing: () => ({
        SUBSCRIBER_MODEL: 'demo.Team',
        SUBSCRIBER: async (c) => {
          const id = c.req.header('x-team')
          return id ? await Team.objects.filter({ pk: Number(id) }).first() : null
        },
      }),
    })

    it('bills the team of the request and exposes its limits to agents', async () => {
      seedPrices(h.stripe)
      await syncProductsAndPrices()
      const team = await Team.objects.create({ name: 'Acme' } as any)
      const other = await Team.objects.create({ name: 'Other' } as any)
      const user = await makeUser()
      await h.client.forceLogin(user)
      expect((await h.client.post('/billing/checkout/', { json: { plan: 'pro' } })).status).toBe(401)
      const res = await h.client.post('/billing/checkout/', {
        json: { plan: 'pro' },
        headers: { 'x-team': String(team.pk) },
      })
      expect(res.status).toBe(200)
      const { id } = (await res.json()) as { id: string }
      const customer = await Customer.objects.get({ subscriberType: 'demo.team' })
      expect([customer.subscriberId, customer.name]).toEqual([String(team.pk), 'Acme'])
      expect(h.stripe.checkoutSessions.get(id)!.client_reference_id).toBe(`demo.team:${team.pk}`)
      await deliver(h, h.stripe.event('checkout.session.completed', h.stripe.completeCheckout(id)))

      expect(((await getSubscription(team)) as Subscription).status).toBe('active')
      expect(await getSubscription(user)).toBeNull()
      expect(await hasActiveSubscription(other)).toBe(false)
      expect(await hasActiveSubscription({ id: team.pk })).toBe(true)
      expect((await getEntitlements(team)).plan).toBe('pro')

      // AGENTS.USAGE_LIMITS: { tenant: usageLimits('agentTokens') } — §22's subject is { scope, key, user }
      const limits = usageLimits('agentTokens')
      expect(await limits({ scope: 'tenant', key: String(team.pk), user })).toEqual({
        day: 100_000,
        month: 1_000_000,
      })
      expect(await limits({ scope: 'tenant', key: String(other.pk), user })).toEqual({ day: 1_000 })
      expect(await limits({ scope: 'user', key: String(user.pk), user })).toBeNull()
    })
  })
}
