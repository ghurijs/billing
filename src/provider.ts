// The provider adapter interface and the normalized objects adapters return. Syncing, models and views only see
// these shapes, so a provider is one adapter (Stripe now; Paddle and Lemon Squeezy later).
import type { CheckMessage } from '@ghuri/core'
import type { SubscriptionStatus } from './settings'

/** Fields every synced object has. */
export interface ObjectBase {
  /** The provider's id (`cus_…`, `price_…`). */
  id: string
  livemode: boolean | null
  metadata: Record<string, string>
  created: Date | null
}

export interface CustomerData extends ObjectBase {
  kind: 'customer'
  email: string
  name: string
  currency: string
  deleted: boolean
}

export interface ProductData extends ObjectBase {
  kind: 'product'
  name: string
  description: string
  active: boolean
  deleted: boolean
}

export interface PriceData extends ObjectBase {
  kind: 'price'
  /** Provider id of the product. */
  product: string
  /** The product, when the provider sent it expanded. */
  productData?: ProductData
  active: boolean
  /** ISO 4217, lowercase (`'usd'`). */
  currency: string
  /** Minor units (cents); null for tiered or metered prices. */
  unitAmount: number | null
  type: 'one_time' | 'recurring'
  recurringInterval: '' | 'day' | 'week' | 'month' | 'year'
  recurringIntervalCount: number | null
  lookupKey: string
  nickname: string
  trialPeriodDays: number | null
  deleted: boolean
}

export interface SubscriptionItemData {
  id: string
  price: PriceData
  quantity: number
}

export interface SubscriptionData extends ObjectBase {
  kind: 'subscription'
  /** Provider id of the customer. */
  customer: string
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  cancelAt: Date | null
  canceledAt: Date | null
  endedAt: Date | null
  trialStart: Date | null
  trialEnd: Date | null
  items: SubscriptionItemData[]
}

export interface InvoiceData extends ObjectBase {
  kind: 'invoice'
  customer: string
  subscription: string | null
  status: '' | 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
  currency: string
  amountDue: number
  amountPaid: number
  amountRemaining: number
  subtotal: number
  total: number
  number: string
  hostedInvoiceUrl: string
  invoicePdf: string
  periodStart: Date | null
  periodEnd: Date | null
  paidAt: Date | null
}

/** A completed checkout: links a customer to a subscriber and names the subscription it started. */
export interface CheckoutSessionData extends ObjectBase {
  kind: 'checkout_session'
  customer: string | null
  subscription: string | null
  clientReferenceId: string | null
  mode: 'payment' | 'setup' | 'subscription'
  status: string
}

export type ObjectData =
  | CustomerData
  | ProductData
  | PriceData
  | SubscriptionData
  | InvoiceData
  | CheckoutSessionData

export type ObjectKind = ObjectData['kind']
export type RetrievableKind = 'customer' | 'product' | 'price' | 'subscription' | 'invoice'

/** A verified webhook event, normalized. */
export interface ProviderEvent {
  /** The provider's event id (`evt_…`): the idempotency key. */
  id: string
  /** The provider's event type (`customer.subscription.updated`). */
  type: string
  created: Date
  livemode: boolean | null
  /** What the event is about; null for events billing does not sync (stored as `ignored`). */
  object: ObjectData | null
  /** The object was deleted (`customer.deleted`, `customer.subscription.deleted`, …). */
  deleted: boolean
  /** The raw payload (stored in `Event.data`). */
  raw: Record<string, unknown>
}

export interface LineItem {
  /** Provider price id. */
  price: string
  quantity?: number
}

export interface CheckoutOptions {
  customer: string
  lineItems: LineItem[]
  mode: 'subscription' | 'payment'
  successUrl: string
  cancelUrl: string
  /** Stored on the session (and the subscription for `mode: 'subscription'`). */
  metadata?: Record<string, string>
  clientReferenceId?: string
  trialPeriodDays?: number
  /** Extra provider parameters, merged last (`BILLING.CHECKOUT_OPTIONS`). */
  extra?: Record<string, unknown>
}

export interface CreateCustomerOptions {
  email?: string
  name?: string
  metadata: Record<string, string>
}

/** A payment provider. `stripe()` returns one; implement it for another provider. */
export interface BillingProvider {
  /** Short name stored on every row (`'stripe'`). */
  readonly name: string
  createCustomer(opts: CreateCustomerOptions): Promise<CustomerData>
  createCheckoutSession(opts: CheckoutOptions): Promise<{ id: string; url: string }>
  createPortalSession(opts: { customer: string; returnUrl: string }): Promise<{ url: string }>
  /** Verify a webhook (raw body and headers) and parse it; throws `SignatureVerificationError`. */
  constructEvent(body: string, headers: Headers): Promise<ProviderEvent>
  /** Parse a stored event payload (`Event.data`) without verifying it again. */
  parseEvent(raw: Record<string, unknown>): ProviderEvent
  retrieve(kind: 'customer', id: string): Promise<CustomerData>
  retrieve(kind: 'product', id: string): Promise<ProductData>
  retrieve(kind: 'price', id: string): Promise<PriceData>
  retrieve(kind: 'subscription', id: string): Promise<SubscriptionData>
  retrieve(kind: 'invoice', id: string): Promise<InvoiceData>
  retrieve(kind: RetrievableKind, id: string): Promise<ObjectData>
  list(kind: 'product'): AsyncIterable<ProductData>
  list(kind: 'price'): AsyncIterable<PriceData>
  list(kind: 'product' | 'price'): AsyncIterable<ProductData | PriceData>
  cancelSubscription(id: string, opts?: { atPeriodEnd?: boolean }): Promise<SubscriptionData>
  /** System check messages about this provider's configuration. */
  check(opts: { debug: boolean; deploy: boolean }): CheckMessage[]
}
