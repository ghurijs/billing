import { apps, type CheckContext, type CheckMessage, checks } from '@ghuri/core'
import type { BillingSettings } from './settings'
import { tasksInterop } from './tasks'

function setting(ctx: CheckContext): BillingSettings | undefined {
  return ctx.settings.BILLING as BillingSettings | undefined
}

/** `billing.*` system checks (only when the `billing` app is installed). */
export function checkBilling(ctx: CheckContext): CheckMessage[] {
  if (!apps.isInstalled('billing')) return []
  const s = setting(ctx)
  const out: CheckMessage[] = []
  if (!s?.PROVIDER) {
    return [
      checks.error('BILLING.PROVIDER is not set.', {
        hint: 'Add BILLING: { PROVIDER: stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }) }.',
        id: 'billing.E001',
      }),
    ]
  }
  if (typeof s.PROVIDER.check === 'function')
    out.push(...s.PROVIDER.check({ debug: !!ctx.settings.DEBUG, deploy: false }))

  const label = s.SUBSCRIBER_MODEL ?? (ctx.settings.AUTH_USER_MODEL as string | undefined) ?? 'auth.User'
  try {
    apps.getModel(label)
  } catch {
    out.push(
      checks.error(`BILLING.SUBSCRIBER_MODEL refers to '${label}', which is not an installed model.`, {
        hint: "Use 'app_label.ModelName' of an installed app ('auth.User', 'tenants.Tenant').",
        id: 'billing.E004',
        obj: 'BILLING.SUBSCRIBER_MODEL',
      }),
    )
  }

  const plans = s.PLANS ?? {}
  if (typeof plans !== 'object' || plans === null || Array.isArray(plans)) {
    out.push(
      checks.error('BILLING.PLANS must be an object of plans.', { id: 'billing.E005', obj: 'BILLING.PLANS' }),
    )
  } else {
    for (const [key, plan] of Object.entries(plans)) {
      const prices = (plan as { prices?: unknown }).prices
      if (
        prices !== undefined &&
        (!Array.isArray(prices) || prices.some((p) => typeof p !== 'string' || !p))
      ) {
        out.push(
          checks.error(
            `BILLING.PLANS['${key}'].prices must be a list of price ids, lookup keys or product ids.`,
            {
              id: 'billing.E005',
              obj: `BILLING.PLANS['${key}']`,
            },
          ),
        )
      }
    }
    if (s.DEFAULT_PLAN !== undefined && !(s.DEFAULT_PLAN in plans)) {
      out.push(
        checks.error(`BILLING.DEFAULT_PLAN '${s.DEFAULT_PLAN}' is not a key of BILLING.PLANS.`, {
          id: 'billing.E005',
          obj: 'BILLING.DEFAULT_PLAN',
        }),
      )
    }
  }

  if (s.WEBHOOK_TASKS && !tasksInterop()) {
    out.push(
      checks.warning(
        'BILLING.WEBHOOK_TASKS is on, but @ghuri/tasks is not loaded: webhooks are processed inline.',
        {
          hint: 'Install @ghuri/tasks and add TasksConfig to INSTALLED_APPS.',
          id: 'billing.W002',
          obj: 'BILLING.WEBHOOK_TASKS',
        },
      ),
    )
  }
  return out
}

/** `billing.W001` (deploy): a test key in production. */
export function checkBillingDeploy(ctx: CheckContext): CheckMessage[] {
  if (!apps.isInstalled('billing')) return []
  const provider = setting(ctx)?.PROVIDER
  if (!provider || typeof provider.check !== 'function') return []
  return provider.check({ debug: !!ctx.settings.DEBUG, deploy: true })
}

checks.register(checkBilling, { tags: ['billing'] })
checks.register(checkBillingDeploy, { tags: ['billing'], deploy: true })
