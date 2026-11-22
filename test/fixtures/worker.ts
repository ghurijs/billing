// Billing in workerd on D1: migrations, checkout through the fake Stripe over fetch, a webhook verified with
// WebCrypto, and the access helpers.
import { createApp, defineSettings, include, path } from '@ghuri/core'
import { d1 } from '@ghuri/orm'
import { migrate } from '@ghuri/orm/migrations'
import { BillingConfig, billingUrls, getPlan, syncProductsAndPrices } from '../../src/index'
import { fakeStripe } from '../../src/testing'

const fake = fakeStripe()
const subscriber = { id: '42' }

export default createApp(
  defineSettings(() => ({
    SECRET_KEY: 'edge-secret',
    INSTALLED_APPS: [BillingConfig],
    DATABASES: { default: d1('DB') },
    BILLING: {
      PROVIDER: fake.provider(),
      SUBSCRIBER: () => subscriber,
      PLANS: { pro: { prices: ['pro_monthly'], limits: { seats: 5 } }, free: { limits: { seats: 1 } } },
      DEFAULT_PLAN: 'free',
    },
    ROOT_URLCONF: [
      path('billing/', include(billingUrls)),
      path('__setup/', async (c) => {
        await migrate({ interactive: false } as any)
        const product = fake.createProduct({ name: 'Pro' })
        fake.createPrice({ product: product.id, unit_amount: 900, lookup_key: 'pro_monthly' })
        await syncProductsAndPrices()
        return c.json({ ok: true })
      }),
      // Stands in for the customer paying on Stripe: completes the session, returns the signed webhook.
      path('__complete/', async (c) => {
        const session = fake.completeCheckout(c.req.query('id')!)
        return c.json(await fake.webhook(fake.event('checkout.session.completed', session)))
      }),
      path('__plan/', async (c) => {
        const plan = await getPlan(subscriber)
        return c.json({
          key: plan.key,
          status: plan.subscription?.status ?? null,
          runtime: navigator.userAgent,
        })
      }),
    ],
  })),
  { checks: false },
)
