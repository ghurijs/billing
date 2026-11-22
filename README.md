# @ghuri/billing

Subscriptions for [Ghuri](https://github.com/ghurijs/ghuri) SaaS apps, in the spirit of
[dj-stripe](https://dj-stripe.dev): Stripe Checkout, the customer portal, verified and idempotent webhooks, local
models that mirror customers, prices, subscriptions and invoices, and one call in app code to ask what a subscriber
may do. It runs on Cloudflare Workers and Node (`fetch` and WebCrypto, no Stripe SDK), bills users or tenants, and
keeps the provider behind an adapter so Paddle or Lemon Squeezy can follow.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```sh
npm install @ghuri/billing@next
```

## Contents

1. [Quick start](#1-quick-start)
2. [Plans and entitlements](#2-plans-and-entitlements)
3. [Checkout and the portal](#3-checkout-and-the-portal)
4. [Webhooks](#4-webhooks)
5. [Billing tenants instead of users](#5-billing-tenants-instead-of-users)
6. [Usage limits for agents](#6-usage-limits-for-agents)
7. [Signals, admin, commands and checks](#7-signals-admin-commands-and-checks)
8. [Testing](#8-testing)
9. [Differences from dj-stripe](#9-differences-from-dj-stripe)

## 1. Quick start

```ts
// src/settings.ts
import { BillingConfig, stripe } from '@ghuri/billing'

export default defineSettings((env) => ({
  INSTALLED_APPS: [ContentTypesConfig, AuthConfig, SessionsConfig, BillingConfig /* , … */],
  BILLING: {
    // Secrets come from the environment (wrangler secret / .dev.vars), never from code.
    PROVIDER: stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }),
    PLANS: {
      free: { features: [], limits: { projects: 1 } },
      pro: { prices: ['pro_monthly', 'pro_yearly'], features: ['export'], limits: { projects: 50 } },
    },
    DEFAULT_PLAN: 'free',
    SUCCESS_URL: '/billing/thanks/?session={CHECKOUT_SESSION_ID}',
    CANCEL_URL: '/pricing/',
    RETURN_URL: '/account/',
  },
}))

// src/urls.ts
import { billingUrls } from '@ghuri/billing'
export default [path('billing/', include(billingUrls))]      // checkout/, portal/, webhook/
```

```sh
npx ghuri migrate
npx ghuri billing_sync                  # import products and prices
stripe listen --forward-to localhost:8787/billing/webhook/   # local webhooks (Stripe CLI)
```

In Stripe, point a webhook endpoint at `https://<your app>/billing/webhook/` with at least `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `customer.*`, `customer.subscription.*`, `product.*`, `price.*` and
`invoice.*`.

```ts
// a plain view (in an APIView, use this.request.user)
import { getUser } from '@ghuri/core'
import { getSubscription, hasFeature, getEntitlements } from '@ghuri/billing'

const user = getUser(c)
const sub = await getSubscription(user)                // Subscription | null
if (await hasFeature(user, 'export')) { … }
const { plan, limits } = await getEntitlements(user)
```

## 2. Plans and entitlements

`BILLING.PLANS` maps your plan keys to the prices that put a subscriber on them (price ids, lookup keys or product
ids) and to what the plan grants: `features` (a list of flags) and `limits` (any object). A subscriber with no active
subscription is on `DEFAULT_PLAN`.

| Function | Returns |
|---|---|
| `getCustomer(subject, { create? })` | the live `Customer`, created at the provider with `create: true` |
| `getSubscription(subject)` | the current `Subscription` (an active one first, else the latest), or null |
| `hasActiveSubscription(subject, { plans? })` | true when the status is in `ACTIVE_STATUSES` (`active`, `trialing`) |
| `getPlan(subject)` | `{ key, plan, subscription, active }` |
| `getEntitlements(subject)` | `{ plan, features, limits, active, subscription }` |
| `hasFeature(subject, feature)` | whether the plan lists the feature |

A `subject` is a user or tenant instance, a `Customer`, a reference `{ type?, id }` or a Hono context. To keep access
during dunning, add `'past_due'` to `ACTIVE_STATUSES`. `requireSubscriber(c)` returns the request's subscriber or
throws `NoSubscriber`, an HTTP error that answers 401.

REST views use the permission classes in `@ghuri/billing/rest`; plain views use the decorator:

```ts
import { HasActiveSubscription, HasFeature } from '@ghuri/billing/rest'

class ExportView extends APIView {
  permissionClasses = [IsAuthenticated, HasActiveSubscription]   // `static requiredPlans = ['pro']` narrows it
}
class SsoView extends APIView { permissionClasses = [HasFeature('sso')] }

const dashboard = subscriptionRequired({ redirectTo: '/pricing/' })(async (c) => render(c, <Dashboard />))
```

## 3. Checkout and the portal

`POST billing/checkout/` with `{ plan: 'pro', interval?: 'year' }` or `{ price: 'pro_monthly' }` (JSON or a form)
creates a Checkout Session for the request's subscriber and answers `{ id, url }` (JSON) or `303` to Stripe (form).
The customer is created on first use with `metadata.ghuri_subscriber`. When `PLANS` lists prices, only those can be
bought. `successUrl` / `cancelUrl` may be relative or on `ALLOWED_HOSTS`. `PLANS[key].trialPeriodDays` adds a trial;
`CHECKOUT_OPTIONS` adds Stripe parameters (`{ allow_promotion_codes: true }`).

`POST billing/portal/` (optional `returnUrl`) opens the Stripe customer portal, where customers change plans, update
cards and cancel.

Both views authenticate like REST API views, so a single-page app calls them with the credentials it uses for the
rest of its API: they are CSRF-exempt and run `BILLING.AUTHENTICATION_CLASSES` (default
`REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`). Token and JWT requests need no CSRF token; session requests must pass
the CSRF check, as with DRF's `SessionAuthentication`. Without either setting, the session user of
`AuthenticationMiddleware` is used, CSRF checked. A request with no subscriber gets 401 (with `WWW-Authenticate` when
the first authentication class has a scheme). `BILLING.SUBSCRIBER` runs afterwards, so `getUser(c)` in it is the
authenticated user.

```ts
REST_FRAMEWORK: { DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, JWTAuthentication] },
// or for billing only:
BILLING: { AUTHENTICATION_CLASSES: [JWTAuthentication], … },
```

```ts
// SPA
await fetch('/billing/checkout/', {
  method: 'POST',
  headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
  body: JSON.stringify({ plan: 'pro' }),
}).then((r) => r.json())                      // { id, url } → location.href = url
```

```html
<form method="post" action="/billing/checkout/">
  <input type="hidden" name="csrfmiddlewaretoken" value="…">
  <input type="hidden" name="plan" value="pro">
  <button>Upgrade to Pro</button>
</form>
```

## 4. Webhooks

`POST billing/webhook/` is CSRF-exempt and authenticated by its signature (`Stripe-Signature`, HMAC-SHA256,
timestamps within 300 s; `webhookSecret` may be a list while rotating). Each event is stored in `Event` by its id
before processing, so a repeated delivery is acknowledged without running again. Processing upserts customers,
products, prices, subscriptions (with their items) and invoices; a completed checkout (`checkout.session.completed`,
or `checkout.session.async_payment_succeeded` for delayed payment methods) links the customer and fetches its
subscription. A subscription event older than the newest one applied is skipped. A failing event answers 500
(Stripe retries) and keeps the error; `ghuri billing_process_events` or the admin action runs it again.

With `@ghuri/tasks` installed, `BILLING.WEBHOOK_TASKS: true` answers at once and processes the event in the task
`billing.processEvent` (billing finds tasks through its interop object; there is no dependency).

## 5. Billing tenants instead of users

```ts
import { currentTenant } from '@ghuri/tenants'

BILLING: {
  PROVIDER: stripe({ … }),
  SUBSCRIBER_MODEL: 'tenants.Tenant',
  SUBSCRIBER: () => currentTenant(),         // who pays for this request
}
```

Customers reference their subscriber generically (`subscriberType` = model label, `subscriberId` = pk), so billing
never imports `@ghuri/tenants` and the subscriber model needs no foreign key.

Stripe's webhook carries no tenant. The webhook view is marked with `@ghuri/tenants`' `tenantNotRequired()` marker, so
it is processed under `TENANTS.REQUIRED: true` (other requests without a tenant still answer 404; this needs a
`@ghuri/tenants` with `tenantNotRequired()`, newer than 0.1.0-alpha.3). It runs with no tenant, which is fine for billing's own tables; a signal
receiver that touches tenant-scoped models activates the subscriber's tenant itself:

```ts
subscriptionCreated.connect(async ({ subscription }) => {
  const customer = await subscription.customer
  const tenant = await Tenant.objects.get({ pk: customer.subscriberId })
  await runAsTenant(tenant, () => Project.objects.filter({ archived: true }).update({ archived: false }))
})
```

## 6. Usage limits for agents

`usageLimits()` returns a function for `AGENTS.USAGE_LIMITS` (`(subject: { scope, key, user }) => limits | null`): for
the scope that matches `SUBSCRIBER_MODEL` (`tenant`, or `user` when users pay) it returns the plan's limit. Agents call
it before every run, so entitlements are cached for `cacheSeconds` (default 60); subscription changes clear the cache
in the process that receives the webhook.

```ts
PLANS: { pro: { prices: ['pro_monthly'], limits: { agentTokens: { day: 500_000, month: 5_000_000 } } }, … },
AGENTS: { USAGE_LIMITS: { tenant: usageLimits('agentTokens') } },
```

## 7. Signals, admin, commands and checks

- Signals: `subscriptionCreated`, `subscriptionUpdated` and `subscriptionCancelled` (`{ subscription, previousStatus }`),
  `invoicePaid`, `invoicePaymentFailed` (`{ invoice }`), `webhookProcessed` (`{ event, type }`, every event).
- `import '@ghuri/billing/admin'` registers read-only admins; events get "Process selected events again".
- `ghuri billing_sync [--kinds products,prices]`, `ghuri billing_process_events [--status failed|pending|all]`.
- Checks: `billing.E001` no provider, `E002` bad secret key (a `pk_` key, empty), `E003` no webhook secret, `E004`
  unknown `SUBSCRIBER_MODEL`, `E005` bad `PLANS` / `DEFAULT_PLAN`, `W001` (deploy) a test key with `DEBUG = false`,
  `W002` `WEBHOOK_TASKS` without `@ghuri/tasks`.

## 8. Testing

`@ghuri/billing/testing` has an in-memory Stripe API. No network, no keys.

```ts
import { fakeStripe } from '@ghuri/billing/testing'

const stripe = fakeStripe()
settings.BILLING.PROVIDER = stripe.provider()
const price = stripe.createPrice({ lookup_key: 'pro_monthly', unit_amount: 1200 })
// … POST billing/checkout/, then:
const session = stripe.completeCheckout(sessionId)
const { body, headers } = await stripe.webhook(stripe.event('checkout.session.completed', session))
await client.post('/billing/webhook/', { body, headers, csrf: false })
```

## 9. Differences from dj-stripe

- One provider adapter interface; Stripe is the first adapter, and the REST API is used directly (no SDK).
- Local auto pks with the provider id in `providerId` (dj-stripe: `djstripe_id` and `id`).
- The subscriber is a generic reference, not a swappable foreign key (`DJSTRIPE_SUBSCRIBER_MODEL`).
- Objects are not re-fetched on every event; stale subscription events are skipped by `lastEventAt`.
- Payment intents, charges, payment methods and coupons are not mirrored in 0.1.

## License

MIT
