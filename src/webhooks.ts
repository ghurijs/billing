// Webhook handling: verify, store the event once (its provider id is the idempotency key), then process it inline
// or in the `billing.processEvent` task.
import { IntegrityError } from '@ghuri/orm'
import { Event, type EventStatus, Invoice } from './models'
import type { ProviderEvent } from './provider'
import { billingSettings, getProvider } from './settings'
import { invoicePaid, invoicePaymentFailed, webhookProcessed } from './signals'
import {
  syncCheckoutSession,
  syncCustomer,
  syncInvoice,
  syncPrice,
  syncProduct,
  syncSubscription,
} from './sync'
import { processEventTask } from './tasks'

/** Outcome of `handleWebhook()`. */
export interface WebhookOutcome {
  eventId: string
  type: string
  /** `processed` / `ignored`: done now; `duplicate`: already done earlier; `queued`: handed to a task; `busy`:
   *  another delivery is processing it right now. */
  result: 'processed' | 'ignored' | 'duplicate' | 'queued' | 'busy'
}

/** Sync what one event is about. Returns false when billing does not handle the event's object. */
async function applyEvent(event: ProviderEvent): Promise<boolean> {
  const obj = event.object
  if (!obj) return false
  switch (obj.kind) {
    case 'customer':
      await syncCustomer({ ...obj, deleted: obj.deleted || event.deleted })
      return true
    case 'product':
      await syncProduct({ ...obj, deleted: obj.deleted || event.deleted })
      return true
    case 'price':
      await syncPrice({ ...obj, deleted: obj.deleted || event.deleted })
      return true
    case 'subscription':
      await syncSubscription(obj, { eventCreated: event.created })
      return true
    case 'invoice': {
      if (event.deleted) {
        await Invoice.objects.filter({ providerId: obj.id }).delete()
        return true
      }
      const invoice = await syncInvoice(obj)
      const sender = getProvider()
      if (event.type === 'invoice.paid') await invoicePaid.send(sender, { invoice })
      if (event.type === 'invoice.payment_failed') await invoicePaymentFailed.send(sender, { invoice })
      return true
    }
    case 'checkout_session':
      if (
        event.type !== 'checkout.session.completed' &&
        event.type !== 'checkout.session.async_payment_succeeded'
      )
        return false
      await syncCheckoutSession(obj)
      return true
  }
}

/**
 * Process a stored event. Claims it first (compare-and-set on `attempts`), so two deliveries of one event never
 * run at once. Sets `processed` / `ignored`, or `failed` with the error (and rethrows).
 */
export async function processEvent(row: Event): Promise<'processed' | 'ignored' | 'duplicate' | 'busy'> {
  if (row.status === 'processed' || row.status === 'ignored') return 'duplicate'
  const claimed = await Event.objects
    .filter({ pk: row.pk, attempts: row.attempts, status__in: ['pending', 'failed'] })
    .update({ attempts: row.attempts + 1 })
  if (!claimed) return 'busy'
  row.attempts += 1
  const provider = getProvider()
  try {
    const event = provider.parseEvent(row.data as Record<string, unknown>)
    const handled = await applyEvent(event)
    const status: EventStatus = handled ? 'processed' : 'ignored'
    row.status = status
    row.error = ''
    row.processedAt = new Date()
    await row.save({ updateFields: ['status', 'error', 'processedAt'] })
    await webhookProcessed.send(provider, { event: row, type: row.type })
    return status
  } catch (err) {
    row.status = 'failed'
    row.error = String((err as Error)?.stack ?? err).slice(0, 4000)
    await row.save({ updateFields: ['status', 'error'] })
    throw err
  }
}

/** Process the stored event with this provider id (the body of the `billing.processEvent` task). */
export async function processEventById(
  providerId: string,
): Promise<'processed' | 'ignored' | 'duplicate' | 'busy'> {
  return processEvent(await Event.objects.get({ providerId }))
}

/** Store a verified event once; returns the row (an existing one for a repeated delivery). */
export async function storeEvent(event: ProviderEvent): Promise<Event> {
  const existing = await Event.objects.filter({ providerId: event.id }).first()
  if (existing) return existing
  try {
    return await Event.objects.create({
      provider: getProvider().name,
      providerId: event.id,
      type: event.type,
      livemode: event.livemode,
      data: event.raw,
      created: event.created,
      status: 'pending',
    } as any)
  } catch (err) {
    if (err instanceof IntegrityError) return Event.objects.get({ providerId: event.id })
    throw err
  }
}

/**
 * Handle a webhook request body: verify its signature (`SignatureVerificationError` otherwise), store the event,
 * then process it now or, with `BILLING.WEBHOOK_TASKS` and `@ghuri/tasks` loaded, in `billing.processEvent`.
 * Processing errors propagate (the view answers 500 so the provider retries).
 */
export async function handleWebhook(body: string, headers: Headers): Promise<WebhookOutcome> {
  const event = await getProvider().constructEvent(body, headers)
  const row = await storeEvent(event)
  const out = (result: WebhookOutcome['result']): WebhookOutcome => ({
    eventId: event.id,
    type: event.type,
    result,
  })
  if (row.status === 'processed' || row.status === 'ignored') return out('duplicate')
  if (billingSettings().WEBHOOK_TASKS) {
    const t = processEventTask()
    if (t) {
      await t.enqueue(event.id)
      return out('queued')
    }
  }
  return out(await processEvent(row))
}
