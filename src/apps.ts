import { AppConfig } from '@ghuri/core'
import { BillingProcessEventsCommand, BillingSyncCommand } from './commands'
import * as billingMigrations from './migrations/index'
import { Customer, Event, Invoice, Price, Product, Subscription, SubscriptionItem } from './models'

/** `path` when running from the TypeScript sources (makemigrations), undefined in dist / on Workers. */
function appPath(): string | undefined {
  const meta = import.meta as ImportMeta & { dirname?: string; filename?: string }
  if (!meta.dirname || !/[\\/]src$/.test(meta.dirname) || !/\.[cm]?ts$/.test(meta.filename ?? ''))
    return undefined
  return meta.dirname
}

/**
 * The `billing` app: customers, products, prices, subscriptions, invoices and webhook events mirrored from the
 * payment provider, and the `billing_sync` / `billing_process_events` commands. Add it to `INSTALLED_APPS` and run
 * `ghuri migrate`.
 */
export class BillingConfig extends AppConfig {
  name = '@ghuri/billing'
  override label = 'billing'
  override verboseName = 'Billing'
  override path = appPath()
  override migrations = billingMigrations
  override models = { Customer, Product, Price, Subscription, SubscriptionItem, Invoice, Event }
  override commands = {
    billing_sync: BillingSyncCommand,
    billing_process_events: BillingProcessEventsCommand,
  }
}
