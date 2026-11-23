import {
  AuthConfig,
  AuthenticationMiddleware,
  ContentType,
  ContentTypesConfig,
  PBKDF2PasswordHasher,
  SessionMiddleware,
  SessionsConfig,
  User,
} from '@ghuri/auth'
import {
  CsrfMiddleware,
  createApp,
  defineSettings,
  type GhuriApp,
  type GhuriSettings,
  include,
  path,
  type UrlEntry,
} from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { BillingConfig, type BillingSettings, billingUrls, clearEntitlementsCache } from '../src/index'
import { type FakeStripe, fakeStripe } from '../src/testing'
import { DemoConfig } from './demo'

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite', 'd1']

export const PLANS = {
  free: { features: [], limits: { projects: 1, agentTokens: { day: 1_000 } } },
  pro: {
    name: 'Pro',
    prices: ['pro_monthly', 'pro_yearly'],
    features: ['export'],
    limits: { projects: 10, agentTokens: { day: 100_000, month: 1_000_000 } },
  },
  team: {
    prices: ['price_team'],
    features: ['export', 'sso'],
    trialPeriodDays: 14,
    limits: { projects: 100 },
  },
}

export interface Harness {
  app: GhuriApp
  db: TestDatabase
  stripe: FakeStripe
  /** Mutable BILLING settings (reset before each test). */
  billing: BillingSettings
  client: TestClient
  /** Mutable extra settings (reset before each test). */
  settings: Partial<GhuriSettings> & Record<string, unknown>
}

export interface HarnessOptions {
  using?: TestBackend
  billing?: (h: Harness) => Partial<BillingSettings>
  urls?: () => UrlEntry[]
  apps?: any[]
  /** Replaces the default `[SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware]`. */
  middleware?: () => any[]
  /** Extra settings (`TENANTS`, `REST_FRAMEWORK`, `LOGIN_URL`, …). */
  settings?: () => Record<string, unknown>
}

export function useHarness(opts: HarnessOptions = {}): Harness {
  const env: Record<string, unknown> = {}
  const h = { billing: {}, settings: {}, stripe: fakeStripe() } as Harness
  const reset = () => {
    for (const k of Object.keys(h.billing)) delete (h.billing as any)[k]
    Object.assign(h.billing, {
      PROVIDER: h.stripe.provider(),
      PLANS,
      DEFAULT_PLAN: 'free',
      SUCCESS_URL: '/billing/thanks/?session={CHECKOUT_SESSION_ID}',
      CANCEL_URL: '/pricing/',
      RETURN_URL: '/account/',
      ...(opts.billing?.(h) ?? {}),
    })
  }
  beforeAll(async () => {
    reset()
    h.app = createApp(
      defineSettings(() => ({
        SECRET_KEY: 'billing-tests',
        DEBUG: true,
        ALLOWED_HOSTS: ['testserver', '.example.com'],
        INSTALLED_APPS: [
          ContentTypesConfig,
          AuthConfig,
          SessionsConfig,
          BillingConfig,
          DemoConfig,
          ...(opts.apps ?? []),
        ],
        MIDDLEWARE: opts.middleware?.() ?? [SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware],
        ROOT_URLCONF: [path('billing/', include(billingUrls)), ...(opts.urls?.() ?? [])],
        PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })],
        BILLING: h.billing,
        ...(opts.settings?.() ?? {}),
        ...h.settings,
      })) as any,
      { checks: false },
    )
    await h.app.setup(env)
    h.db = await setupTestDatabase({ using: opts.using ?? 'sqlite' })
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    ContentType.objects.clearCache()
    await h.db.flush()
    ContentType.objects.clearCache()
    h.stripe.reset()
    clearEntitlementsCache()
    reset()
    h.client = createTestClient(h.app, { env })
  })
  return h
}

let n = 0
export async function makeUser(username = `user${++n}`): Promise<User> {
  return (await User.objects.createUser({
    username,
    email: `${username}@example.com`,
    password: 'pw',
  } as any)) as User
}

/** Prices the default PLANS point at: `pro_monthly` / `pro_yearly` lookup keys and `price_team`. */
export function seedPrices(stripe: FakeStripe) {
  const pro = stripe.createProduct({ name: 'Pro' })
  const monthly = stripe.createPrice({ product: pro.id, unit_amount: 1200, lookup_key: 'pro_monthly' })
  const yearly = stripe.createPrice({
    product: pro.id,
    unit_amount: 12000,
    lookup_key: 'pro_yearly',
    recurring: { interval: 'year' },
  })
  const teamProduct = stripe.createProduct({ name: 'Team' })
  const team = stripe.createPrice({ id: 'price_team', product: teamProduct.id, unit_amount: 5000 })
  const hiddenProduct = stripe.createProduct({ name: 'Internal' })
  const hidden = stripe.createPrice({
    product: hiddenProduct.id,
    unit_amount: 0,
    lookup_key: 'internal_free',
  })
  return { pro, monthly, yearly, teamProduct, team, hiddenProduct, hidden }
}

/** POST a signed event to the webhook view. */
export async function deliver(
  h: Harness,
  event: Record<string, any>,
  opts: { secret?: string; timestamp?: number } = {},
) {
  const { body, headers } = await h.stripe.webhook(event, opts)
  return h.client.post('/billing/webhook/', { body, headers, csrf: false } as any)
}
