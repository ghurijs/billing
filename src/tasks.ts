// Webhook processing on @ghuri/tasks, without depending on it: @ghuri/tasks publishes `task()` / `getTask()` on
// `globalThis[Symbol.for('ghuri.tasks.interop')]`. On Workers a dynamic import of a missing package breaks the
// bundle, so there is no import (the same approach as @ghuri/agents).
import { apps } from '@ghuri/core'

/** Name of the task that processes a stored webhook event. */
export const PROCESS_EVENT_TASK_NAME = 'billing.processEvent'
/** Attempts before the task result is `FAILED` (the event stays `failed`; `billing_process_events` replays it). */
export const PROCESS_EVENT_MAX_ATTEMPTS = 3

export interface BillingTaskLike {
  modulePath: string
  enqueue(eventId: string): Promise<{ id: string }>
}

interface TasksInterop {
  version: 1
  task(fn: (eventId: string) => Promise<unknown>, options: Record<string, unknown>): BillingTaskLike
  getTask(name: string): BillingTaskLike | undefined
}

/** `@ghuri/tasks`' interop object when it is loaded in this process, else undefined. */
export function tasksInterop(): TasksInterop | undefined {
  const interop = (globalThis as Record<symbol, unknown>)[Symbol.for('ghuri.tasks.interop')] as
    | TasksInterop
    | undefined
  return interop?.version === 1 ? interop : undefined
}

/** The `billing.processEvent` task, defined on first use; undefined when `@ghuri/tasks` is not loaded. */
export function processEventTask(): BillingTaskLike | undefined {
  const interop = tasksInterop()
  if (!interop) return undefined
  return (
    interop.getTask(PROCESS_EVENT_TASK_NAME) ??
    interop.task(
      async (eventId: string) => {
        const { processEventById } = await import('./webhooks')
        return { status: await processEventById(eventId) }
      },
      { name: PROCESS_EVENT_TASK_NAME, maxAttempts: PROCESS_EVENT_MAX_ATTEMPTS },
    )
  )
}

// Define the task when apps load, so a worker knows `billing.processEvent` before the first message arrives.
const HOOK_KEY = Symbol.for('ghuri.billing.taskHook')
if (!(globalThis as Record<symbol, unknown>)[HOOK_KEY]) {
  ;(globalThis as Record<symbol, unknown>)[HOOK_KEY] = true
  apps.onPopulate(() => {
    processEventTask()
  })
}
