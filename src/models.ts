// Local mirrors of the provider's objects (dj-stripe's models). A local auto pk, the provider's id in `providerId`.
// Amounts are integers in the currency's minor unit (cents), always next to `currency`.
import { apps } from '@ghuri/core'
import {
  BigIntegerField,
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  ForeignKey,
  JSONField,
  type Manager,
  Model,
  type ModelClass,
  PositiveIntegerField,
  PROTECT,
  SET_NULL,
  TextField,
} from '@ghuri/orm'

/** Default of the JSON fields (a named function, so migrations can reference it). */
export function emptyDict(): Record<string, unknown> {
  return {}
}

const pairs = (values: readonly string[], labels: Record<string, string> = {}): Array<[string, string]> =>
  values.map((v) => [v, labels[v] ?? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())])

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const
export const PRICE_TYPES = ['one_time', 'recurring'] as const
export const PRICE_INTERVALS = ['day', 'week', 'month', 'year'] as const
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const
export const EVENT_STATUSES = ['pending', 'processed', 'failed', 'ignored'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

/** Fields of every mirrored object. */
function providerFields() {
  return {
    provider: new CharField({ maxLength: 20, default: 'stripe' }),
    /** The provider's id (`cus_…`, `prod_…`, `price_…`). */
    providerId: new CharField({ maxLength: 255, unique: true, verboseName: 'provider id' }),
    livemode: new BooleanField({ null: true, blank: true }),
    metadata: new JSONField({ default: emptyDict, blank: true }),
    /** When the provider created the object. */
    created: new DateTimeField({ null: true, blank: true }),
  }
}

/**
 * A customer of the provider, owned by a subscriber: an instance of `BILLING.SUBSCRIBER_MODEL` stored as a generic
 * reference (`subscriberType` = model label, `subscriberId` = its pk), so the subscriber can be a user or a tenant.
 */
export class Customer extends Model({
  ...providerFields(),
  /** Lowercase model label of the subscriber (`'auth.user'`, `'tenants.tenant'`). */
  subscriberType: new CharField({ maxLength: 100, blank: true, default: '', dbIndex: true }),
  /** The subscriber's pk as a string; null for customers created outside the app and not linked yet. */
  subscriberId: new CharField({ maxLength: 255, null: true, blank: true }),
  email: new CharField({ maxLength: 254, blank: true, default: '' }),
  name: new CharField({ maxLength: 255, blank: true, default: '' }),
  /** Default currency (ISO 4217, lowercase); empty until the provider sets one. */
  currency: new CharField({ maxLength: 3, blank: true, default: '' }),
  /** Deleted at the provider: kept for history, no longer used for new checkouts. */
  deleted: new BooleanField({ default: false }),
}) {
  declare static objects: Manager<Customer>
  static Meta = {
    appLabel: 'billing',
    ordering: ['-created'],
    constraints: [
      {
        type: 'unique' as const,
        fields: ['subscriberType', 'subscriberId'],
        name: 'billing_customer_subscriber_uniq',
        condition: 'NOT deleted',
      },
    ],
  }

  /** The subscriber instance, or null. */
  async getSubscriber<T = unknown>(): Promise<T | null> {
    if (!this.subscriberType || this.subscriberId === null || this.subscriberId === undefined) return null
    const model = apps.getModel(this.subscriberType) as unknown as ModelClass
    return ((await (model as any).objects.filter({ pk: this.subscriberId }).first()) ?? null) as T | null
  }

  toString(): string {
    return this.email || this.name || this.providerId
  }
}

export class Product extends Model({
  ...providerFields(),
  name: new CharField({ maxLength: 255, blank: true, default: '' }),
  description: new TextField({ blank: true, default: '' }),
  active: new BooleanField({ default: true }),
}) {
  declare static objects: Manager<Product>
  static Meta = { appLabel: 'billing', ordering: ['name'] }

  toString(): string {
    return this.name || this.providerId
  }
}

export class Price extends Model({
  ...providerFields(),
  product: new ForeignKey(() => Product, { onDelete: CASCADE, relatedName: 'prices' }),
  active: new BooleanField({ default: true }),
  /** ISO 4217, lowercase (`'usd'`). */
  currency: new CharField({ maxLength: 3 }),
  /** Minor units (cents); null for tiered or metered prices. */
  unitAmount: new BigIntegerField({ null: true, blank: true }),
  type: new CharField({ maxLength: 20, choices: pairs(PRICE_TYPES), default: 'recurring' }),
  recurringInterval: new CharField({
    maxLength: 10,
    choices: pairs(PRICE_INTERVALS),
    blank: true,
    default: '',
  }),
  recurringIntervalCount: new PositiveIntegerField({ null: true, blank: true }),
  lookupKey: new CharField({ maxLength: 255, blank: true, default: '', dbIndex: true }),
  nickname: new CharField({ maxLength: 255, blank: true, default: '' }),
  trialPeriodDays: new PositiveIntegerField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Price>
  static Meta = { appLabel: 'billing', ordering: ['unitAmount'] }

  /** `'12.00 USD / month'` (two decimals; currencies without minor units show as such). */
  get humanReadable(): string {
    const amount = this.unitAmount === null ? 'custom' : formatAmount(Number(this.unitAmount), this.currency)
    const every =
      this.type === 'recurring' && this.recurringInterval
        ? ` / ${(this.recurringIntervalCount ?? 1) > 1 ? `${this.recurringIntervalCount} ` : ''}${this.recurringInterval}`
        : ''
    return `${amount}${every}`
  }

  toString(): string {
    return this.nickname || this.lookupKey || this.providerId
  }
}

/** Currencies with no minor unit (Stripe's zero-decimal list). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
])

/** `formatAmount(1250, 'usd')` → `'12.50 USD'`; `formatAmount(500, 'jpy')` → `'500 JPY'`. */
export function formatAmount(minor: number, currency: string): string {
  const zero = ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())
  return `${zero ? String(minor) : (minor / 100).toFixed(2)} ${currency.toUpperCase()}`
}

export class Subscription extends Model({
  ...providerFields(),
  customer: new ForeignKey(() => Customer, { onDelete: CASCADE, relatedName: 'subscriptions' }),
  status: new CharField({ maxLength: 20, choices: pairs(SUBSCRIPTION_STATUSES), dbIndex: true }),
  currentPeriodStart: new DateTimeField({ null: true, blank: true }),
  currentPeriodEnd: new DateTimeField({ null: true, blank: true }),
  cancelAtPeriodEnd: new BooleanField({ default: false }),
  cancelAt: new DateTimeField({ null: true, blank: true }),
  canceledAt: new DateTimeField({ null: true, blank: true }),
  endedAt: new DateTimeField({ null: true, blank: true }),
  trialStart: new DateTimeField({ null: true, blank: true }),
  trialEnd: new DateTimeField({ null: true, blank: true }),
  /** `created` of the newest event applied; older events for this subscription are skipped (out-of-order delivery). */
  lastEventAt: new DateTimeField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Subscription>
  static Meta = { appLabel: 'billing', ordering: ['-created'] }

  toString(): string {
    return `${this.providerId} (${this.status})`
  }
}

export class SubscriptionItem extends Model({
  provider: new CharField({ maxLength: 20, default: 'stripe' }),
  providerId: new CharField({ maxLength: 255, unique: true, verboseName: 'provider id' }),
  subscription: new ForeignKey(() => Subscription, { onDelete: CASCADE, relatedName: 'items' }),
  price: new ForeignKey(() => Price, { onDelete: PROTECT, relatedName: 'subscriptionItems' }),
  quantity: new PositiveIntegerField({ default: 1 }),
}) {
  declare static objects: Manager<SubscriptionItem>
  static Meta = { appLabel: 'billing', verboseName: 'subscription item' }

  toString(): string {
    return this.providerId
  }
}

export class Invoice extends Model({
  ...providerFields(),
  customer: new ForeignKey(() => Customer, { onDelete: CASCADE, relatedName: 'invoices' }),
  subscription: new ForeignKey(() => Subscription, {
    onDelete: SET_NULL,
    null: true,
    blank: true,
    relatedName: 'invoices',
  }),
  status: new CharField({ maxLength: 20, choices: pairs(INVOICE_STATUSES), blank: true, default: '' }),
  currency: new CharField({ maxLength: 3 }),
  amountDue: new BigIntegerField({ default: 0 }),
  amountPaid: new BigIntegerField({ default: 0 }),
  amountRemaining: new BigIntegerField({ default: 0 }),
  subtotal: new BigIntegerField({ default: 0 }),
  total: new BigIntegerField({ default: 0 }),
  number: new CharField({ maxLength: 64, blank: true, default: '' }),
  hostedInvoiceUrl: new CharField({ maxLength: 2000, blank: true, default: '' }),
  invoicePdf: new CharField({ maxLength: 2000, blank: true, default: '' }),
  periodStart: new DateTimeField({ null: true, blank: true }),
  periodEnd: new DateTimeField({ null: true, blank: true }),
  paidAt: new DateTimeField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Invoice>
  static Meta = { appLabel: 'billing', ordering: ['-created'] }

  toString(): string {
    return this.number || this.providerId
  }
}

/** A received webhook event. Its provider id makes processing idempotent. */
export class Event extends Model({
  provider: new CharField({ maxLength: 20, default: 'stripe' }),
  providerId: new CharField({ maxLength: 255, unique: true, verboseName: 'provider id' }),
  type: new CharField({ maxLength: 255, dbIndex: true }),
  livemode: new BooleanField({ null: true, blank: true }),
  /** The raw payload. */
  data: new JSONField({ default: emptyDict, blank: true }),
  status: new CharField({ maxLength: 20, choices: pairs(EVENT_STATUSES), default: 'pending', dbIndex: true }),
  attempts: new PositiveIntegerField({ default: 0 }),
  error: new TextField({ blank: true, default: '' }),
  /** When the provider created the event. */
  created: new DateTimeField({ null: true, blank: true }),
  receivedAt: new DateTimeField({ autoNowAdd: true }),
  processedAt: new DateTimeField({ null: true, blank: true }),
}) {
  declare static objects: Manager<Event>
  static Meta = { appLabel: 'billing', ordering: ['-receivedAt'] }

  toString(): string {
    return `${this.type} (${this.providerId})`
  }
}
