// REST permission classes, the plain-view decorator and system checks.
import { checks, path, runChecks } from '@ghuri/core'
import { APIResponse, APIView, IsAuthenticated } from '@ghuri/rest'
import { describe, expect, it } from 'vitest'
import {
  checkBilling,
  checkBillingDeploy,
  stripe,
  subscriptionRequired,
  syncProductsAndPrices,
} from '../src/index'
import { HasActiveSubscription, HasFeature } from '../src/rest'
import { deliver, type Harness, makeUser, seedPrices, useHarness } from './helpers'

class ExportView extends APIView {
  override permissionClasses = [IsAuthenticated, HasActiveSubscription]
  async get() {
    return new APIResponse({ ok: true })
  }
}

class TeamOnlyView extends APIView {
  static requiredPlans = ['team']
  override permissionClasses = [HasActiveSubscription]
  async get() {
    return new APIResponse({ ok: true })
  }
}

class SsoView extends APIView {
  override permissionClasses = [HasFeature('sso')]
  async get() {
    return new APIResponse({ ok: true })
  }
}

const premium = subscriptionRequired()(async (c) => c.text('premium'))
const premiumOrPricing = subscriptionRequired({ redirectTo: '/pricing/', plans: ['team'] })(async (c) =>
  c.text('team'),
)

async function subscribePro(h: Harness, user: any) {
  seedPrices(h.stripe)
  await syncProductsAndPrices()
  await h.client.forceLogin(user)
  const res = await h.client.post('/billing/checkout/', { json: { plan: 'pro' } })
  const { id } = (await res.json()) as { id: string }
  await deliver(h, h.stripe.event('checkout.session.completed', h.stripe.completeCheckout(id)))
}

describe('access control', () => {
  const h = useHarness({
    urls: () => [
      path('api/export/', ExportView.asView()),
      path('api/team/', TeamOnlyView.asView()),
      path('api/sso/', SsoView.asView()),
      path('premium/', premium),
      path('team/', premiumOrPricing),
    ],
  })

  it('HasActiveSubscription, requiredPlans and HasFeature', async () => {
    const res = await h.client.get('/api/export/')
    expect([401, 403]).toContain(res.status)
    const user = await makeUser()
    await h.client.forceLogin(user)
    const denied = await h.client.get('/api/export/')
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as any).detail).toBe('An active subscription is required.')
    await subscribePro(h, user)
    expect((await h.client.get('/api/export/')).status).toBe(200)
    expect((await h.client.get('/api/team/')).status).toBe(403)
    const sso = await h.client.get('/api/sso/')
    expect(sso.status).toBe(403)
    expect(((await sso.json()) as any).detail).toBe("Your plan does not include 'sso'.")
  })

  it('subscriptionRequired() for plain views', async () => {
    expect((await h.client.get('/premium/')).status).toBe(403)
    const user = await makeUser()
    await h.client.forceLogin(user)
    expect((await h.client.get('/premium/')).status).toBe(403)
    const team = await h.client.get('/team/')
    expect([team.status, team.headers.get('location')]).toEqual([302, '/pricing/'])
    await subscribePro(h, user)
    const ok = await h.client.get('/premium/')
    expect([ok.status, await ok.text()]).toEqual([200, 'premium'])
    expect((await h.client.get('/team/')).status).toBe(302)
  })

  it('checks the provider, subscriber model and plans', async () => {
    const ids = async (deploy = false) =>
      (await runChecks({ tags: ['billing'], deploy })).map((m) => m.id).sort()
    expect(await ids()).toEqual([])
    h.billing.PROVIDER = undefined
    expect(await ids()).toEqual(['billing.E001'])
    h.billing.PROVIDER = stripe({ secretKey: '', webhookSecret: '' })
    expect(await ids()).toEqual(['billing.E002', 'billing.E003'])
    h.billing.PROVIDER = stripe({ secretKey: 'pk_test_123', webhookSecret: 'whsec_x' })
    expect(await ids()).toEqual(['billing.E002'])
    h.billing.PROVIDER = stripe({ secretKey: 'not-a-key', webhookSecret: 'whsec_x' })
    expect(await ids()).toEqual(['billing.E002'])
    h.billing.PROVIDER = h.stripe.provider()
    h.billing.SUBSCRIBER_MODEL = 'nope.Model'
    h.billing.DEFAULT_PLAN = 'missing'
    h.billing.PLANS = { pro: { prices: ['price_1', 3 as any] } }
    h.billing.WEBHOOK_TASKS = true
    expect(await ids()).toEqual(['billing.E004', 'billing.E005', 'billing.E005', 'billing.W002'])
  })

  it('warns about a test key in production (deploy)', async () => {
    const ctx = (debug: boolean) => ({
      settings: { DEBUG: debug, BILLING: h.billing } as any,
      appConfigs: [],
      deploy: true,
    })
    expect(checkBillingDeploy(ctx(false)).map((m) => m.id)).toEqual(['billing.W001'])
    expect(checkBillingDeploy(ctx(true))).toEqual([])
    h.billing.PROVIDER = stripe({ secretKey: 'sk_live_123', webhookSecret: 'whsec_x' })
    expect(checkBillingDeploy(ctx(false))).toEqual([])
    expect(checkBilling(ctx(false)).length).toBe(0)
    expect(checks.all().some((r) => r.fn === checkBilling)).toBe(true)
  })
})
