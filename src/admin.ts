// @ghuri/billing/admin — import from your project's admin module to see billing data in the admin:
//   import '@ghuri/billing/admin'
// Rows mirror the payment provider, so they are read-only here: change them at the provider (its dashboard or the
// customer portal) and the webhook brings the change back.
import { action, ModelAdmin, site } from '@ghuri/admin'
import type { BaseModel } from '@ghuri/orm'
import type { Context } from 'hono'
import { Customer, Event, Invoice, Price, Product, Subscription, SubscriptionItem } from './models'
import { processEvent } from './webhooks'

/** Process the selected events again (failed or pending ones; processed events are skipped). */
export const processAgain = action(
  { name: 'process_again', description: 'Process selected events again', permissions: ['change'] },
  async (admin: ModelAdmin<Event>, c: Context, queryset: any) => {
    let ok = 0
    let failed = 0
    for (const row of (await queryset.filter({ status__in: ['pending', 'failed'] })) as Event[]) {
      try {
        await processEvent(row)
        ok++
      } catch {
        failed++
      }
    }
    await admin.messageUser(
      c,
      `Processed ${ok} event(s)${failed ? `; ${failed} failed again` : ''}.`,
      failed ? 'warning' : 'success',
    )
  },
)

/** A mirror of provider data: no add or delete; every field read-only. */
class MirrorAdmin<T extends BaseModel> extends ModelAdmin<T> {
  override async hasAddPermission(_c: Context): Promise<boolean> {
    return false
  }

  override async hasDeletePermission(_c: Context, _obj?: unknown): Promise<boolean> {
    return false
  }
}

export class CustomerAdmin extends MirrorAdmin<Customer> {
  override listDisplay = [
    'providerId',
    'email',
    'name',
    'subscriberType',
    'subscriberId',
    'deleted',
    'created',
  ]
  override listFilter = ['deleted', 'livemode', 'subscriberType']
  override searchFields = ['providerId', 'email', 'name', 'subscriberId']
  override readonlyFields = [
    'provider',
    'providerId',
    'livemode',
    'metadata',
    'created',
    'subscriberType',
    'subscriberId',
    'email',
    'name',
    'currency',
    'deleted',
  ]
}

export class ProductAdmin extends MirrorAdmin<Product> {
  override listDisplay = ['name', 'providerId', 'active', 'created']
  override listFilter = ['active', 'livemode']
  override searchFields = ['name', 'providerId']
  override readonlyFields = [
    'provider',
    'providerId',
    'livemode',
    'metadata',
    'created',
    'name',
    'description',
    'active',
  ]
}

export class PriceAdmin extends MirrorAdmin<Price> {
  override listDisplay = [
    'providerId',
    'product',
    'nickname',
    'lookupKey',
    'unitAmount',
    'currency',
    'recurringInterval',
    'active',
  ]
  override listFilter = ['active', 'type', 'recurringInterval', 'currency']
  override searchFields = ['providerId', 'lookupKey', 'nickname']
  override readonlyFields = [
    'provider',
    'providerId',
    'livemode',
    'metadata',
    'created',
    'product',
    'active',
    'currency',
    'unitAmount',
    'type',
    'recurringInterval',
    'recurringIntervalCount',
    'lookupKey',
    'nickname',
    'trialPeriodDays',
  ]
}

export class SubscriptionAdmin extends MirrorAdmin<Subscription> {
  override listDisplay = [
    'providerId',
    'customer',
    'status',
    'currentPeriodEnd',
    'cancelAtPeriodEnd',
    'created',
  ]
  override listFilter = ['status', 'cancelAtPeriodEnd', 'livemode']
  override searchFields = ['providerId', 'customer__email', 'customer__providerId']
  override readonlyFields = [
    'provider',
    'providerId',
    'livemode',
    'metadata',
    'created',
    'customer',
    'status',
    'currentPeriodStart',
    'currentPeriodEnd',
    'cancelAtPeriodEnd',
    'cancelAt',
    'canceledAt',
    'endedAt',
    'trialStart',
    'trialEnd',
    'lastEventAt',
  ]
}

export class SubscriptionItemAdmin extends MirrorAdmin<SubscriptionItem> {
  override listDisplay = ['providerId', 'subscription', 'price', 'quantity']
  override searchFields = ['providerId']
  override readonlyFields = ['provider', 'providerId', 'subscription', 'price', 'quantity']
}

export class InvoiceAdmin extends MirrorAdmin<Invoice> {
  override listDisplay = ['number', 'providerId', 'customer', 'status', 'total', 'currency', 'created']
  override listFilter = ['status', 'currency', 'livemode']
  override searchFields = ['number', 'providerId', 'customer__email']
  override readonlyFields = [
    'provider',
    'providerId',
    'livemode',
    'metadata',
    'created',
    'customer',
    'subscription',
    'status',
    'currency',
    'amountDue',
    'amountPaid',
    'amountRemaining',
    'subtotal',
    'total',
    'number',
    'hostedInvoiceUrl',
    'invoicePdf',
    'periodStart',
    'periodEnd',
    'paidAt',
  ]
}

export class EventAdmin extends MirrorAdmin<Event> {
  override listDisplay = ['providerId', 'type', 'status', 'attempts', 'created', 'processedAt']
  override listFilter = ['status', 'type', 'livemode']
  override searchFields = ['providerId', 'type']
  override readonlyFields = [
    'provider',
    'providerId',
    'type',
    'livemode',
    'data',
    'status',
    'attempts',
    'error',
    'created',
    'receivedAt',
    'processedAt',
  ]
  override actions = [processAgain]
}

site.register(Customer, CustomerAdmin)
site.register(Product, ProductAdmin)
site.register(Price, PriceAdmin)
site.register(Subscription, SubscriptionAdmin)
site.register(SubscriptionItem, SubscriptionItemAdmin)
site.register(Invoice, InvoiceAdmin)
site.register(Event, EventAdmin)
