import { Signal } from '@ghuri/core'
import type { Event, Invoice, Subscription } from './models'

/** A subscription was seen for the first time (sender: the provider). */
export const subscriptionCreated = new Signal<{ subscription: Subscription }>('subscriptionCreated')
/** A known subscription changed (status, period, items…). `previousStatus` is the status before the change. */
export const subscriptionUpdated = new Signal<{ subscription: Subscription; previousStatus: string | null }>(
  'subscriptionUpdated',
)
/** A subscription became `canceled` (or was deleted at the provider). Sent instead of `subscriptionUpdated`. */
export const subscriptionCancelled = new Signal<{
  subscription: Subscription
  previousStatus: string | null
}>('subscriptionCancelled')
/** An invoice was paid (`invoice.paid`). */
export const invoicePaid = new Signal<{ invoice: Invoice }>('invoicePaid')
/** Collecting an invoice failed (`invoice.payment_failed`): tell the customer, start dunning. */
export const invoicePaymentFailed = new Signal<{ invoice: Invoice }>('invoicePaymentFailed')
/** Every processed (or ignored) webhook event, after syncing: handle any event type here (dj-stripe's signals). */
export const webhookProcessed = new Signal<{ event: Event; type: string }>('webhookProcessed')
