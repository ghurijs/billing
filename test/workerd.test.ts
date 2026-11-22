// The billing bundle on workerd with D1: fetch to the (fake) Stripe API, WebCrypto webhook signatures.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('billing on workerd', () => {
  let mf: Miniflare
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'browser', 'import'],
      external: ['node:*', 'cloudflare:*', 'postgres'],
      write: false,
      logLevel: 'silent',
    })
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0].text,
      compatibilityDate: '2025-06-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `billing-${crypto.randomUUID()}` },
    })
  }, 60_000)
  afterAll(async () => {
    await mf?.dispose()
  })

  it('checks out, verifies the webhook and answers the plan', async () => {
    expect((await mf.dispatchFetch('https://example.com/__setup/')).status).toBe(200)
    const before = (await (await mf.dispatchFetch('https://example.com/__plan/')).json()) as any
    expect([before.key, before.runtime]).toEqual(['free', 'Cloudflare-Workers'])
    const checkout = await mf.dispatchFetch('https://example.com/billing/checkout/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    })
    expect(checkout.status).toBe(200)
    const { id } = (await checkout.json()) as any
    const hook = (await (await mf.dispatchFetch(`https://example.com/__complete/?id=${id}`)).json()) as any
    const forged = await mf.dispatchFetch('https://example.com/billing/webhook/', {
      method: 'POST',
      headers: {
        ...hook.headers,
        'stripe-signature': hook.headers['stripe-signature'].replace(/v1=[0-9a-f]+/, `v1=${'0'.repeat(64)}`),
      },
      body: hook.body,
    })
    expect(forged.status).toBe(400)
    const res = await mf.dispatchFetch('https://example.com/billing/webhook/', {
      method: 'POST',
      headers: hook.headers,
      body: hook.body,
    })
    expect(((await res.json()) as any).result).toBe('processed')
    const after = (await (await mf.dispatchFetch('https://example.com/__plan/')).json()) as any
    expect([after.key, after.status]).toEqual(['pro', 'active'])
  })
})
