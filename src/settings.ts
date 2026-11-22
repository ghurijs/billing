// The `BILLING` setting, with defaults applied.
import { ImproperlyConfigured, tryGetContext } from '@ghuri/core'
import type { Context } from 'hono'
import type { BillingProvider } from './provider'

/** Stripe's subscription statuses (also used for other providers, mapped by their adapters). */
export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'

/** A plan: what a subscriber gets. Limits and features are the project's own vocabulary. */
export interface PlanConfig {
  /** Price ids (`price_…`), price lookup keys or product ids (`prod_…`) that put a subscriber on this plan. */
  prices?: string[]
  /** Display name (default: the key). */
  name?: string
  /** Feature flags (`hasFeature(subject, 'export')`). */
  features?: string[]
  /** Limits (`{ projects: 10, agentTokens: { day: 100_000 } }`), read by `getEntitlements()` / `usageLimits()`. */
  limits?: Record<string, unknown>
  /** Free trial days for checkouts of this plan (set by the server, never by the client). */
  trialPeriodDays?: number
}

/** `BILLING` settings. Only `PROVIDER` is required. */
export interface BillingSettings {
  /** The payment provider: `stripe({ secretKey, webhookSecret })`. */
  PROVIDER?: BillingProvider
  /** Model customers belong to (`'auth.User'`, `'tenants.Tenant'`). Default `AUTH_USER_MODEL` (`'auth.User'`). */
  SUBSCRIBER_MODEL?: string
  /**
   * Who pays for this request: an instance of `SUBSCRIBER_MODEL`, or null. Default: the authenticated request user.
   * Multi-tenant apps: `(c) => currentTenant()`.
   */
  SUBSCRIBER?: (c: Context) => unknown | Promise<unknown>
  /** Plans by key. */
  PLANS?: Record<string, PlanConfig>
  /** Plan of a subscriber without an active subscription (default none: `getPlan()` returns key null). */
  DEFAULT_PLAN?: string
  /** Statuses that count as subscribed (default `['active', 'trialing']`). */
  ACTIVE_STATUSES?: SubscriptionStatus[]
  /** Where Checkout sends the customer after paying / cancelling, and where the portal returns to. */
  SUCCESS_URL?: string
  CANCEL_URL?: string
  RETURN_URL?: string
  /** Process webhooks in the `billing.processEvent` task of `@ghuri/tasks` (default false: in the request). */
  WEBHOOK_TASKS?: boolean
  /** Extra provider parameters for every Checkout Session (`{ allow_promotion_codes: true }`). */
  CHECKOUT_OPTIONS?: Record<string, unknown>
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** `@ghuri/billing` settings. */
    BILLING?: BillingSettings
  }
}

export interface ResolvedBillingSettings {
  PROVIDER?: BillingProvider
  SUBSCRIBER_MODEL: string
  SUBSCRIBER?: BillingSettings['SUBSCRIBER']
  PLANS: Record<string, PlanConfig>
  DEFAULT_PLAN?: string
  ACTIVE_STATUSES: SubscriptionStatus[]
  SUCCESS_URL: string
  CANCEL_URL: string
  RETURN_URL: string
  WEBHOOK_TASKS: boolean
  CHECKOUT_OPTIONS: Record<string, unknown>
}

export const DEFAULT_ACTIVE_STATUSES: SubscriptionStatus[] = ['active', 'trialing']

/** `BILLING` with defaults applied. */
export function billingSettings(): ResolvedBillingSettings {
  const settings = tryGetContext()?.settings
  const s = (settings?.BILLING ?? {}) as BillingSettings
  return {
    ...s,
    SUBSCRIBER_MODEL: s.SUBSCRIBER_MODEL ?? (settings?.AUTH_USER_MODEL as string | undefined) ?? 'auth.User',
    PLANS: s.PLANS ?? {},
    ACTIVE_STATUSES: s.ACTIVE_STATUSES ?? DEFAULT_ACTIVE_STATUSES,
    SUCCESS_URL: s.SUCCESS_URL ?? '/',
    CANCEL_URL: s.CANCEL_URL ?? '/',
    RETURN_URL: s.RETURN_URL ?? '/',
    WEBHOOK_TASKS: s.WEBHOOK_TASKS ?? false,
    CHECKOUT_OPTIONS: s.CHECKOUT_OPTIONS ?? {},
  }
}

/** The configured provider; `ImproperlyConfigured` without `BILLING.PROVIDER`. */
export function getProvider(): BillingProvider {
  const provider = billingSettings().PROVIDER
  if (!provider) {
    throw new ImproperlyConfigured(
      'BILLING.PROVIDER is not set: add stripe({ secretKey, webhookSecret }) from @ghuri/billing to your settings.',
    )
  }
  return provider
}
