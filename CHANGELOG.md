# Changelog

## Unreleased

- **Fix:** the webhook view answered 404 in multi-tenant apps with `TENANTS.REQUIRED: true`, since Stripe's request
  carries no tenant. It now carries `@ghuri/tenants`' `tenantNotRequired()` marker (`Symbol.for`, no import), so it
  runs with no tenant there while other tenant-less requests still answer 404. Needs a `@ghuri/tenants` with
  `tenantNotRequired()` (newer than 0.1.0-alpha.3); older versions ignore the marker.
- **Fix:** `requireSubscriber()` gave a 500: `NoSubscriber` is now an `HttpError` with status 401 (`{ detail }`) in
  plain views and API views. It no longer extends `BillingError`.
- **Fix:** `checkout/` and `portal/` answered 401 (or 403 from `CsrfMiddleware`) to single-page apps that authenticate
  with a token or JWT. They now authenticate like REST API views: CSRF-exempt, running the new
  `BILLING.AUTHENTICATION_CLASSES` (default `REST_FRAMEWORK.DEFAULT_AUTHENTICATION_CLASSES`), where session classes
  enforce CSRF and token / JWT classes do not; without either setting, the session user with CSRF enforced, as
  before. When classes are set and none matches, the request is anonymous (an ambient session is not used).
  A 401 carries `WWW-Authenticate` from the first class. Also exported: the `BillingAuthenticationClass` type.
- Removed the unreachable `LOGIN_URL` redirect from the checkout / portal 401 (both views only accept POST).
- README: `checkout.session.async_payment_succeeded` in the webhook events to send, `getUser(c)` in plain-view
  snippets, authentication for SPAs, webhooks under `TENANTS.REQUIRED`.

## Unreleased (0.1.0-alpha.0)

- First release: dj-stripe style subscriptions for Ghuri. The `BILLING` setting with a provider adapter;
  `stripe({ secretKey, webhookSecret })` talks to the Stripe REST API over `fetch` and verifies webhooks with
  WebCrypto (`Stripe-Signature`, HMAC-SHA256, 300 s tolerance, rotated secrets), on Workers and Node, with no SDK.
- The `billing` app: `Customer`, `Product`, `Price`, `Subscription`, `SubscriptionItem`, `Invoice` and `Event`
  (`billing_*` tables). Customers belong to a subscriber of `BILLING.SUBSCRIBER_MODEL` (a user or a tenant) through
  a generic reference. Amounts are integers in minor units, next to their currency.
- Views (`billingUrls`): `checkout/` (Checkout Session for a plan or price, customer created on first use, only
  plan prices can be bought, open-redirect guard), `portal/` (customer portal) and `webhook/` (verified, stored once
  by event id, processed idempotently; out-of-order subscription events are skipped).
- Webhooks can run in the `billing.processEvent` task of `@ghuri/tasks` (`BILLING.WEBHOOK_TASKS`), found through
  its interop object without a dependency.
- Access: `getCustomer`, `getSubscription`, `hasActiveSubscription`, `getPlan`, `getEntitlements`, `hasFeature`,
  `usageLimits()` (fits `AGENTS.USAGE_LIMITS`, with a 60 s entitlements cache), `subscriptionRequired()`; `@ghuri/billing/rest` adds
  `HasActiveSubscription` and `HasFeature()`.
- Signals `subscriptionCreated`, `subscriptionUpdated`, `subscriptionCancelled`, `invoicePaid`,
  `invoicePaymentFailed`, `webhookProcessed`; `@ghuri/billing/admin` (read-only mirrors, "Process again" on
  events); `ghuri billing_sync` and `ghuri billing_process_events`; system checks `billing.*`.
- `@ghuri/billing/testing`: `fakeStripe()` (an in-memory Stripe API), `signPayload()`.
