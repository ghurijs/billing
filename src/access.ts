// What a subscriber has: their customer, current subscription, plan, features and limits.
import { PermissionDenied, redirect, tryGetContext, type ViewFunction } from '@ghuri/core'
import { IntegrityError } from '@ghuri/orm'
import type { Context } from 'hono'
import { NoSubscriber } from './errors'
import { Customer, Subscription, SubscriptionItem } from './models'
import { billingSettings, getProvider, type PlanConfig } from './settings'
import { subscriptionCancelled, subscriptionCreated, subscriptionUpdated } from './signals'
import {
  isContext,
  requestSubscriber,
  resolveSubject,
  type Subject,
  type SubscriberRef,
  subscriberKey,
  subscriberType,
} from './subscriber'
import { SUBSCRIBER_METADATA_KEY } from './sync'

function nameOf(subscriber: any): string {
  if (!subscriber) return ''
  const full = typeof subscriber.getFullName === 'function' ? subscriber.getFullName() : ''
  return String(full || subscriber.name || subscriber.username || '').slice(0, 255)
}

/**
 * The subject's live customer. With `create: true`, one is created at the provider (with the subscriber's email and
 * name, and `metadata.ghuri_subscriber`) when there is none. Null for no subject or no customer.
 */
export async function getCustomer(
  subject: Subject,
  opts: { create?: boolean } = {},
): Promise<Customer | null> {
  const instance = isContext(subject) ? await requestSubscriber(subject) : subject
  const ref = await resolveSubject(instance as Subject)
  if (!ref) return null
  if (ref instanceof Customer) return ref
  const found = await Customer.objects
    .filter({ subscriberType: ref.type, subscriberId: ref.id, deleted: false })
    .first()
  if (found || !opts.create) return found ?? null
  const provider = getProvider()
  const sub = instance && typeof instance === 'object' && !('type' in instance) ? (instance as any) : null
  const data = await provider.createCustomer({
    email: typeof sub?.email === 'string' && sub.email ? sub.email : undefined,
    name: nameOf(sub) || undefined,
    metadata: { [SUBSCRIBER_METADATA_KEY]: subscriberKey(ref) },
  })
  try {
    return await Customer.objects.create({
      provider: provider.name,
      providerId: data.id,
      livemode: data.livemode,
      metadata: data.metadata,
      created: data.created,
      email: data.email,
      name: data.name,
      currency: data.currency,
      subscriberType: ref.type,
      subscriberId: ref.id,
    } as any)
  } catch (err) {
    // A concurrent request created one first: use it (the extra provider customer is left unused).
    if (err instanceof IntegrityError) {
      const winner = await Customer.objects
        .filter({ subscriberType: ref.type, subscriberId: ref.id, deleted: false })
        .first()
      if (winner) return winner
    }
    throw err
  }
}

/** Is the subscription's status one of `BILLING.ACTIVE_STATUSES`? */
export function isActive(subscription: Subscription | null | undefined): boolean {
  return !!subscription && (billingSettings().ACTIVE_STATUSES as string[]).includes(subscription.status)
}

async function subscriptionsOf(ref: Customer | SubscriberRef): Promise<Subscription[]> {
  const filter =
    ref instanceof Customer
      ? { customer: ref }
      : { customer__subscriberType: ref.type, customer__subscriberId: ref.id }
  return (await Subscription.objects.filter(filter as any).orderBy('-created', '-id')) as Subscription[]
}

/**
 * The subject's current subscription: an active one (`ACTIVE_STATUSES`; the latest period end first), else the
 * most recent one of any status. Null without a subscriber or subscriptions.
 */
export async function getSubscription(subject: Subject): Promise<Subscription | null> {
  const ref = await resolveSubject(subject)
  if (!ref) return null
  const subs = await subscriptionsOf(ref)
  const active = subs.filter(isActive)
  if (active.length) {
    const end = (s: Subscription) => (s.currentPeriodEnd ? new Date(s.currentPeriodEnd).getTime() : 0)
    return active.sort((a, b) => end(b) - end(a))[0]
  }
  return subs[0] ?? null
}

/** Has the subject an active subscription (on one of `plans`, when given)? */
export async function hasActiveSubscription(
  subject: Subject,
  opts: { plans?: string[] } = {},
): Promise<boolean> {
  const sub = await getSubscription(subject)
  if (!isActive(sub)) return false
  if (!opts.plans?.length) return true
  const key = await planKeyOf(sub!)
  return key !== null && opts.plans.includes(key)
}

/** The `BILLING.PLANS` key a subscription is on (first plan matching an item's price id, lookup key or product). */
export async function planKeyOf(subscription: Subscription): Promise<string | null> {
  const plans = billingSettings().PLANS
  const items = (await SubscriptionItem.objects
    .filter({ subscription })
    .selectRelated('price', 'price__product')) as SubscriptionItem[]
  const ids = new Set<string>()
  for (const item of items) {
    const price = (await (item as any).price) as any
    ids.add(price.providerId)
    if (price.lookupKey) ids.add(price.lookupKey)
    const product = await price.product
    if (product?.providerId) ids.add(product.providerId)
  }
  for (const [key, plan] of Object.entries(plans)) if ((plan.prices ?? []).some((p) => ids.has(p))) return key
  return null
}

export interface PlanInfo {
  /** The plan key: the subscription's plan, `DEFAULT_PLAN` without an active subscription, or null. */
  key: string | null
  plan: PlanConfig | null
  /** The current subscription (any status), or null. */
  subscription: Subscription | null
  /** Whether `subscription` is active. */
  active: boolean
}

/** The subject's plan. */
export async function getPlan(subject: Subject): Promise<PlanInfo> {
  const s = billingSettings()
  const subscription = await getSubscription(subject)
  const active = isActive(subscription)
  let key = active ? await planKeyOf(subscription!) : null
  if (!active) key = s.DEFAULT_PLAN ?? null
  return { key, plan: key ? (s.PLANS[key] ?? null) : null, subscription, active }
}

export interface Entitlements {
  plan: string | null
  features: string[]
  limits: Record<string, unknown>
  active: boolean
  subscription: Subscription | null
}

/** Features and limits of the subject's plan (empty when the plan is unknown). */
export async function getEntitlements(subject: Subject): Promise<Entitlements> {
  const info = await getPlan(subject)
  return {
    plan: info.key,
    features: [...(info.plan?.features ?? [])],
    limits: { ...(info.plan?.limits ?? {}) },
    active: info.active,
    subscription: info.subscription,
  }
}

/** Does the subject's plan list `feature`? */
export async function hasFeature(subject: Subject, feature: string): Promise<boolean> {
  return (await getEntitlements(subject)).features.includes(feature)
}

/** What `AGENTS.USAGE_LIMITS` passes a limit function (§22): structural, billing does not import agents. */
export interface UsageSubjectLike {
  scope: string
  key: string
  user?: unknown
}

export interface UsageLimitsOptions {
  /** Scope whose `key` is a subscriber pk (default `'tenant'` when `SUBSCRIBER_MODEL` is not the user model, else `'user'`). */
  scope?: string
  /** Result for every other scope (default null: no limit). */
  otherwise?: unknown
  /**
   * Seconds to keep a subscriber's entitlements in memory (default 60; 0 turns caching off). Agents call the limit
   * function before every run. Subscription signals clear the cache in this process; other isolates or processes
   * see a plan change within this many seconds.
   */
  cacheSeconds?: number
}

const entitlementsCache = new Map<string, { value: Entitlements; expires: number }>()

/** Forget cached entitlements (all, or one subscriber `'auth.user:42'`). Subscription signals call it. */
export function clearEntitlementsCache(key?: string): void {
  if (key === undefined) entitlementsCache.clear()
  else entitlementsCache.delete(key)
}

async function cachedEntitlements(ref: SubscriberRef, seconds: number): Promise<Entitlements> {
  if (seconds <= 0) return getEntitlements(ref)
  const key = subscriberKey(ref)
  const hit = entitlementsCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = await getEntitlements(ref)
  if (entitlementsCache.size > 10_000) entitlementsCache.clear()
  entitlementsCache.set(key, { value, expires: Date.now() + seconds * 1000 })
  return value
}

const CACHE_HOOK = Symbol.for('ghuri.billing.entitlementsCacheHook')
if (!(globalThis as Record<symbol, unknown>)[CACHE_HOOK]) {
  ;(globalThis as Record<symbol, unknown>)[CACHE_HOOK] = true
  const clear = () => clearEntitlementsCache()
  for (const signal of [subscriptionCreated, subscriptionUpdated, subscriptionCancelled])
    signal.connect(clear, { uid: 'billing.clearEntitlementsCache' })
}

/**
 * A limit function for `AGENTS.USAGE_LIMITS` (or any `(subject) => limits`): the subscriber's plan limit named
 * `limit` (`PLANS[plan].limits[limit]`), or what `limit(entitlements)` returns. Accepts §22's `{ scope, key, user }`
 * or any billing subject. Null when the plan sets no such limit. Entitlements of §22 subjects are cached for
 * `cacheSeconds` (60).
 *
 *   AGENTS: { USAGE_LIMITS: { tenant: usageLimits('agentTokens') } }
 */
export function usageLimits<L = any>(
  limit: string | ((entitlements: Entitlements) => L | null | undefined),
  opts: UsageLimitsOptions = {},
): (subject: UsageSubjectLike | Subject) => Promise<L | null> {
  const pick = (e: Entitlements): L | null =>
    ((typeof limit === 'function' ? limit(e) : e.limits[limit]) ?? null) as L | null
  const seconds = opts.cacheSeconds ?? 60
  return async (subject) => {
    const s = subject as Partial<UsageSubjectLike> | null
    if (s && typeof s.scope === 'string' && typeof s.key === 'string') {
      const type = subscriberType()
      const userModel = String(tryGetContext()?.settings.AUTH_USER_MODEL ?? 'auth.User').toLowerCase()
      const scope = opts.scope ?? (type === userModel ? 'user' : 'tenant')
      if (s.scope !== scope) return (opts.otherwise ?? null) as L | null
      return pick(await cachedEntitlements({ type, id: s.key }, seconds))
    }
    return pick(await getEntitlements(subject as Subject))
  }
}

/**
 * Decorator for plain views: 403 (or a redirect to `redirectTo`, e.g. the pricing page) unless the request's
 * subscriber has an active subscription, on one of `plans` when given.
 */
export function subscriptionRequired(
  opts: { plans?: string[]; redirectTo?: string } = {},
): (view: ViewFunction) => ViewFunction {
  return (view) => async (c: Context) => {
    const subscriber = await requestSubscriber(c)
    if (subscriber && (await hasActiveSubscription(subscriber as Subject, { plans: opts.plans })))
      return view(c)
    if (opts.redirectTo) return redirect(c, opts.redirectTo)
    throw new PermissionDenied(
      subscriber ? 'An active subscription is required.' : 'Authentication required.',
    )
  }
}

/** The request's subscriber, or `NoSubscriber`. */
export async function requireSubscriber(c: Context): Promise<unknown> {
  const subscriber = await requestSubscriber(c)
  if (!subscriber) throw new NoSubscriber('This request has no subscriber (log in, or select a tenant).')
  return subscriber
}
