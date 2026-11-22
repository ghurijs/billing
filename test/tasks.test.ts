// Webhooks processed in the `billing.processEvent` task when @ghuri/tasks is loaded (through its interop object).
import '@ghuri/tasks'
import { dummy, useTaskBackend } from '@ghuri/tasks/testing'
import { describe, expect, it } from 'vitest'
import { Event, PROCESS_EVENT_TASK_NAME, Product, processEventTask } from '../src/index'
import { deliver, useHarness } from './helpers'

describe('webhooks on @ghuri/tasks', () => {
  const h = useHarness({ billing: () => ({ WEBHOOK_TASKS: true }) })

  it('defines billing.processEvent when apps load', () => {
    expect(processEventTask()?.modulePath).toBe(PROCESS_EVENT_TASK_NAME)
  })

  it('stores the event, answers at once and processes it in the task', async () => {
    const { backend, restore } = useTaskBackend(dummy())
    try {
      const product = h.stripe.createProduct({ name: 'Queued' })
      const event = h.stripe.event('product.created', product)
      const res = await deliver(h, event)
      expect(res.status).toBe(200)
      expect(((await res.json()) as any).result).toBe('queued')
      expect((await Event.objects.get({ providerId: event.id })).status).toBe('pending')
      expect(await Product.objects.count()).toBe(0)
      expect(backend.results.map((r: any) => [r.task.modulePath, r.args])).toEqual([
        [PROCESS_EVENT_TASK_NAME, [event.id]],
      ])
      await backend.runPending()
      expect((await Event.objects.get({ providerId: event.id })).status).toBe('processed')
      expect((await Product.objects.get({ providerId: product.id })).name).toBe('Queued')
      expect(((await (await deliver(h, event)).json()) as any).result).toBe('duplicate')
    } finally {
      restore()
    }
  })

  it('runs inline on the immediate backend', async () => {
    const product = h.stripe.createProduct({ name: 'Now' })
    const res = await deliver(h, h.stripe.event('product.created', product))
    expect(((await res.json()) as any).result).toBe('queued')
    expect((await Product.objects.get({ providerId: product.id })).name).toBe('Now')
  })
})
