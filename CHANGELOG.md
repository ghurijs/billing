# Changelog

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
