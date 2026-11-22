// Upsert normalized provider objects into the local models. Every function is idempotent.
import { Customer, Invoice, Price, Product, Subscription, SubscriptionItem } from './models'
import type {
  CheckoutSessionData,
  CustomerData,
  InvoiceData,
  PriceData,
  ProductData,
  SubscriptionData,
} from './provider'
import { getProvider } from './settings'
import { subscriptionCancelled, subscriptionCreated, subscriptionUpdated } from './signals'
import { parseSubscriberKey, type SubscriberRef } from './subscriber'

/** Metadata key holding the subscriber (`'auth.user:42'`) on provider customers. */
export const SUBSCRIBER_METADATA_KEY = 'ghuri_subscriber'

const common = (d: { livemode: boolean | null; metadata: Record<string, string>; created: Date | null }) => ({
  provider: getProvider().name,
  livemode: d.livemode,
  metadata: d.metadata,
  created: d.created,
})

async function byProviderId<T>(model: { objects: any }, providerId: string): Promise<T | null> {
  return ((await model.objects.filter({ providerId }).first()) ?? null) as T | null
}

/** Link `customer` to `ref` unless it already has a subscriber or the subscriber has another live customer. */
async function linkSubscriber(customer: Customer, ref: SubscriberRef | null): Promise<void> {
  if (!ref || customer.subscriberId || customer.deleted) return
  const taken = await Customer.objects
    .filter({ subscriberType: ref.type, subscriberId: ref.id, deleted: false })
    .exclude({ pk: customer.pk })
    .exists()
  if (taken) return
  customer.subscriberType = ref.type
  customer.subscriberId = ref.id
  await customer.save({ updateFields: ['subscriberType', 'subscriberId'] })
}

export async function syncCustomer(
  data: CustomerData,
  opts: { subscriber?: SubscriberRef } = {},
): Promise<Customer> {
  const existing = await byProviderId<Customer>(Customer, data.id)
  if (data.deleted) {
    // A deleted customer's payload has only `id` and `deleted`: keep the rest.
    if (existing) {
      existing.deleted = true
      await existing.save({ updateFields: ['deleted'] })
      return existing
    }
    return Customer.objects.create({
      provider: getProvider().name,
      providerId: data.id,
      deleted: true,
    } as any)
  }
  const [customer] = await Customer.objects.updateOrCreate(
    { providerId: data.id },
    {
      defaults: {
        ...common(data),
        email: data.email,
        name: data.name,
        currency: data.currency,
        deleted: false,
      },
    },
  )
  await linkSubscriber(
    customer,
    opts.subscriber ?? parseSubscriberKey(data.metadata[SUBSCRIBER_METADATA_KEY]),
  )
  return customer
}

/** The local customer for a provider id, fetched from the provider when it is not synced yet. */
export async function ensureCustomer(providerId: string): Promise<Customer> {
  return (
    (await byProviderId<Customer>(Customer, providerId)) ??
    syncCustomer(await getProvider().retrieve('customer', providerId))
  )
}

export async function syncProduct(data: ProductData): Promise<Product> {
  const existing = await byProviderId<Product>(Product, data.id)
  if (data.deleted) {
    if (existing) {
      existing.active = false
      await existing.save({ updateFields: ['active'] })
      return existing
    }
    return Product.objects.create({ provider: getProvider().name, providerId: data.id, active: false } as any)
  }
  const [product] = await Product.objects.updateOrCreate(
    { providerId: data.id },
    { defaults: { ...common(data), name: data.name, description: data.description, active: data.active } },
  )
  return product
}

async function ensureProduct(data: PriceData): Promise<Product> {
  const existing = await byProviderId<Product>(Product, data.product)
  if (existing) return existing
  if (data.productData) return syncProduct(data.productData)
  return syncProduct(await getProvider().retrieve('product', data.product))
}

export async function syncPrice(data: PriceData): Promise<Price> {
  const existing = await byProviderId<Price>(Price, data.id)
  if (data.deleted) {
    if (existing) {
      existing.active = false
      await existing.save({ updateFields: ['active'] })
      return existing
    }
    data = await getProvider()
      .retrieve('price', data.id)
      .catch(() => ({ ...data, active: false }))
  }
  const product = await ensureProduct(data)
  const [price] = await Price.objects.updateOrCreate(
    { providerId: data.id },
    {
      defaults: {
        ...common(data),
        product,
        active: data.active && !data.deleted,
        currency: data.currency,
        unitAmount: data.unitAmount,
        type: data.type,
        recurringInterval: data.recurringInterval,
        recurringIntervalCount: data.recurringIntervalCount,
        lookupKey: data.lookupKey,
        nickname: data.nickname,
        trialPeriodDays: data.trialPeriodDays,
      },
    },
  )
  return price
}

export interface SyncSubscriptionResult {
  subscription: Subscription
  created: boolean
  /** The data was older than what is stored (`lastEventAt`) and was not applied. */
  skipped: boolean
}

/**
 * Upsert a subscription and its items (prices and products are synced or fetched as needed). With `eventCreated`,
 * data older than the subscription's `lastEventAt` is skipped. Sends `subscriptionCreated`, `subscriptionUpdated`
 * or `subscriptionCancelled`.
 */
export async function syncSubscription(
  data: SubscriptionData,
  opts: { eventCreated?: Date } = {},
): Promise<SyncSubscriptionResult> {
  const existing = await byProviderId<Subscription>(Subscription, data.id)
  const stamp = opts.eventCreated ?? null
  if (existing && stamp && existing.lastEventAt && stamp.getTime() < new Date(existing.lastEventAt).getTime())
    return { subscription: existing, created: false, skipped: true }

  const customer = await ensureCustomer(data.customer)
  const previousStatus = existing ? existing.status : null
  const lastEventAt =
    stamp && (!existing?.lastEventAt || stamp > new Date(existing.lastEventAt))
      ? stamp
      : (existing?.lastEventAt ?? null)
  const [subscription, created] = await Subscription.objects.updateOrCreate(
    { providerId: data.id },
    {
      defaults: {
        ...common(data),
        customer,
        status: data.status,
        currentPeriodStart: data.currentPeriodStart,
        currentPeriodEnd: data.currentPeriodEnd,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd,
        cancelAt: data.cancelAt,
        canceledAt: data.canceledAt,
        endedAt: data.endedAt,
        trialStart: data.trialStart,
        trialEnd: data.trialEnd,
        lastEventAt,
      },
    },
  )

  const keep: string[] = []
  for (const item of data.items) {
    const price = await syncPrice(item.price)
    await SubscriptionItem.objects.updateOrCreate(
      { providerId: item.id },
      { defaults: { provider: getProvider().name, subscription, price, quantity: item.quantity } },
    )
    keep.push(item.id)
  }
  await SubscriptionItem.objects.filter({ subscription }).exclude({ providerId__in: keep }).delete()

  const sender = getProvider()
  if (created) await subscriptionCreated.send(sender, { subscription })
  if (subscription.status === 'canceled' && previousStatus !== 'canceled')
    await subscriptionCancelled.send(sender, { subscription, previousStatus })
  else if (!created) await subscriptionUpdated.send(sender, { subscription, previousStatus })
  return { subscription, created, skipped: false }
}

export async function syncInvoice(data: InvoiceData): Promise<Invoice> {
  const customer = await ensureCustomer(data.customer)
  let subscription: Subscription | null = null
  if (data.subscription) {
    subscription =
      (await byProviderId<Subscription>(Subscription, data.subscription)) ??
      (await syncSubscription(await getProvider().retrieve('subscription', data.subscription))).subscription
  }
  const [invoice] = await Invoice.objects.updateOrCreate(
    { providerId: data.id },
    {
      defaults: {
        ...common(data),
        customer,
        subscription,
        status: data.status,
        currency: data.currency,
        amountDue: data.amountDue,
        amountPaid: data.amountPaid,
        amountRemaining: data.amountRemaining,
        subtotal: data.subtotal,
        total: data.total,
        number: data.number,
        hostedInvoiceUrl: data.hostedInvoiceUrl,
        invoicePdf: data.invoicePdf,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        paidAt: data.paidAt,
      },
    },
  )
  return invoice
}

/** A completed checkout: link its customer to the subscriber in `client_reference_id`, sync its subscription. */
export async function syncCheckoutSession(
  data: CheckoutSessionData,
): Promise<{ customer: Customer | null; subscription: Subscription | null }> {
  if (!data.customer) return { customer: null, subscription: null }
  const customer = await ensureCustomer(data.customer)
  await linkSubscriber(customer, parseSubscriberKey(data.clientReferenceId))
  let subscription: Subscription | null = null
  if (data.subscription) {
    // Fetched now, so it is current: no staleness check.
    const sub = await getProvider().retrieve('subscription', data.subscription)
    subscription = (await syncSubscription(sub)).subscription
  }
  return { customer, subscription }
}

/** Pull products and prices from the provider (`ghuri billing_sync`). */
export async function syncProductsAndPrices(
  kinds: Array<'product' | 'price'> = ['product', 'price'],
): Promise<{ products: number; prices: number }> {
  const provider = getProvider()
  const n = { products: 0, prices: 0 }
  if (kinds.includes('product'))
    for await (const p of provider.list('product')) {
      await syncProduct(p)
      n.products++
    }
  if (kinds.includes('price'))
    for await (const p of provider.list('price')) {
      await syncPrice(p)
      n.prices++
    }
  return n
}
