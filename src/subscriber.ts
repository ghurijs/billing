// Who a billing call is about. A subject is a subscriber instance (user, tenant), a `Customer`, a reference
// `{ type?, id }` or a Hono context (resolved with `BILLING.SUBSCRIBER`, default the authenticated user).
import { getUser } from '@ghuri/core'
import type { Context } from 'hono'
import { Customer } from './models'
import { billingSettings } from './settings'

/** A subscriber by model label (lowercase) and pk. */
export interface SubscriberRef {
  type: string
  id: string
}

export type Subject =
  | Customer
  | SubscriberRef
  | { type?: string; id: unknown }
  | Context
  | object
  | null
  | undefined

/** Lowercase label of `BILLING.SUBSCRIBER_MODEL` (`'auth.user'`). */
export function subscriberType(): string {
  return billingSettings().SUBSCRIBER_MODEL.toLowerCase()
}

/** `'auth.user:42'`: stored in provider metadata and `client_reference_id` to find the subscriber again. */
export function subscriberKey(ref: SubscriberRef): string {
  return `${ref.type}:${ref.id}`
}

/** Parse `subscriberKey()` output; null when `value` is not one. */
export function parseSubscriberKey(value: unknown): SubscriberRef | null {
  if (typeof value !== 'string') return null
  const m = /^([a-z0-9_]+\.[a-z0-9_]+):(.+)$/.exec(value)
  return m ? { type: m[1], id: m[2] } : null
}

export function isContext(value: unknown): value is Context {
  const v = value as { req?: { raw?: unknown; header?: unknown }; get?: unknown }
  return (
    !!v &&
    typeof v === 'object' &&
    !!v.req &&
    typeof v.req.header === 'function' &&
    typeof v.get === 'function'
  )
}

/** The request's subscriber instance (`BILLING.SUBSCRIBER(c)`, default the authenticated user), or null. */
export async function requestSubscriber(c: Context, user?: unknown): Promise<unknown> {
  const fn = billingSettings().SUBSCRIBER
  if (fn) return (await fn(c)) ?? null
  const u = (user ?? getUser(c)) as { isAuthenticated?: boolean } | null
  return u && u.isAuthenticated !== false ? u : null
}

/** The subject as a `Customer` or a subscriber reference, or null (anonymous, no tenant). */
export async function resolveSubject(subject: Subject): Promise<Customer | SubscriberRef | null> {
  if (subject === null || subject === undefined) return null
  if (subject instanceof Customer) return subject
  if (isContext(subject)) return resolveSubject((await requestSubscriber(subject)) as Subject)
  const s = subject as Record<string, any>
  if (s.isAuthenticated === false || s.isAnonymous === true) return null
  const meta = (s.constructor as { _meta?: unknown } | undefined)?._meta as
    | { labelLower?: string }
    | undefined
  if (meta?.labelLower && s.pk !== undefined && s.pk !== null)
    return { type: meta.labelLower, id: String(s.pk) }
  if ('id' in s && s.id !== undefined && s.id !== null && !('pk' in s))
    return { type: String(s.type ?? subscriberType()).toLowerCase(), id: String(s.id) }
  if (s.pk !== undefined && s.pk !== null) return { type: subscriberType(), id: String(s.pk) }
  return null
}
