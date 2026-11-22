// `ghuri billing_sync` (dj-stripe's djstripe_sync_models) and `ghuri billing_process_events`.
import { type ArgumentParser, BaseCommand, CommandError, type CommandIO } from '@ghuri/core'
import { Event } from './models'
import { syncProductsAndPrices } from './sync'
import { processEvent } from './webhooks'

/** `ghuri billing_sync [--kinds products,prices]`: pull products and prices from the provider. */
export class BillingSyncCommand extends BaseCommand {
  static override help = 'Sync products and prices from the payment provider.'

  override addArguments(parser: ArgumentParser): void {
    parser.option('--kinds <kinds>', { help: "Comma-separated: 'products', 'prices' (default both)." })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<void> {
    const kinds = String(args.kinds ?? 'products,prices')
      .split(',')
      .map((k) => k.trim().replace(/s$/, ''))
      .filter(Boolean)
    for (const k of kinds)
      if (k !== 'product' && k !== 'price') throw new CommandError(`Unknown kind '${k}'.`)
    const n = await syncProductsAndPrices(kinds as Array<'product' | 'price'>)
    io.stdout(`Synced ${n.products} products and ${n.prices} prices.`)
  }
}

/** `ghuri billing_process_events [--status failed] [--limit 100]`: process stored events again. */
export class BillingProcessEventsCommand extends BaseCommand {
  static override help = 'Process stored webhook events that are pending or failed.'

  override addArguments(parser: ArgumentParser): void {
    parser
      .option('--status <status>', {
        help: "'failed' (default), 'pending' or 'all' (both).",
        default: 'failed',
      })
      .option('--limit <n>', { help: 'At most this many events (default 100).', default: 100 })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<void> {
    const status = String(args.status ?? 'failed')
    const statuses = status === 'all' ? ['pending', 'failed'] : [status]
    if (statuses.some((s) => s !== 'pending' && s !== 'failed'))
      throw new CommandError("--status must be 'failed', 'pending' or 'all'.")
    const limit = Number(args.limit ?? 100)
    const rows = (await Event.objects
      .filter({ status__in: statuses })
      .orderBy('created', 'id')
      .slice(0, limit)) as Event[]
    let ok = 0
    let failed = 0
    for (const row of rows) {
      try {
        await processEvent(row)
        ok++
      } catch (err) {
        failed++
        io.stderr(`${row.providerId} (${row.type}): ${(err as Error).message}`)
      }
    }
    io.stdout(`Processed ${ok} events, ${failed} failed.`)
  }
}
