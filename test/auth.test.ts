// Who may call checkout/portal: API-style authentication (session with CSRF, token / JWT without), and
// requireSubscriber() as an HTTP error.
import { AccessToken } from '@ghuri/auth'
import { JWTAuthentication, SessionAuthentication } from '@ghuri/auth/rest'
import { path } from '@ghuri/core'
import { APIResponse, APIView } from '@ghuri/rest'
import { describe, expect, it } from 'vitest'
import { NoSubscriber, requireSubscriber, syncProductsAndPrices } from '../src/index'
import { makeUser, seedPrices, useHarness } from './helpers'

class MeView extends APIView {
  async get() {
    await requireSubscriber(this.request.c)
    return new APIResponse({ ok: true })
  }
}

const urls = () => [
  path('need-subscriber/', async (c) => {
    await requireSubscriber(c)
    return c.json({ ok: true })
  }),
  path('api/me/', MeView.asView()),
]

async function bearer(user: any): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await (await AccessToken.forUser(user)).encode()}` }
}

describe('requireSubscriber()', () => {
  const h = useHarness({ urls })

  it('answers 401, not 500, in plain views and API views', async () => {
    expect(new NoSubscriber()).toMatchObject({ status: 401 })
    const plain = await h.client.get('/need-subscriber/', { headers: { accept: 'application/json' } })
    expect(plain.status).toBe(401)
    expect(((await plain.json()) as any).detail).toMatch(/no subscriber/)
    expect((await h.client.get('/api/me/')).status).toBe(401)
    await h.client.forceLogin(await makeUser())
    expect((await h.client.get('/need-subscriber/')).status).toBe(200)
    expect((await h.client.get('/api/me/')).status).toBe(200)
  })
})

describe('checkout and portal without REST settings (session user)', () => {
  const h = useHarness({ urls, settings: () => ({ LOGIN_URL: '/accounts/login/' }) })

  it('still enforces CSRF for session users although the views are CSRF-exempt', async () => {
    seedPrices(h.stripe)
    await syncProductsAndPrices()
    await h.client.forceLogin(await makeUser())
    const post = (url: string, csrf: boolean) => h.client.post(url, { json: { plan: 'pro' }, csrf } as any)
    expect((await post('/billing/checkout/', false)).status).toBe(403)
    expect((await post('/billing/portal/', false)).status).toBe(403)
    expect((await post('/billing/checkout/', true)).status).toBe(200)
    expect((await post('/billing/portal/', true)).status).toBe(200)
  })

  it('answers 401 to anonymous browser form posts, with no LOGIN_URL redirect', async () => {
    const res = await h.client.post('/billing/checkout/', { form: { plan: 'pro' } } as any)
    expect(res.status).toBe(401)
    expect(res.headers.get('location')).toBeNull()
    expect((await h.client.get('/billing/checkout/')).status).toBe(405)
  })
})

describe('checkout and portal with REST authentication', () => {
  const h = useHarness({
    urls,
    settings: () => ({
      REST_FRAMEWORK: { DEFAULT_AUTHENTICATION_CLASSES: [SessionAuthentication, JWTAuthentication] },
    }),
  })

  it('accept a JWT without a session or CSRF token (single-page apps)', async () => {
    seedPrices(h.stripe)
    await syncProductsAndPrices()
    const user = await makeUser()
    const headers = await bearer(user)
    const checkout = await h.client.post('/billing/checkout/', {
      json: { plan: 'pro' },
      headers,
      csrf: false,
    } as any)
    expect(checkout.status).toBe(200)
    expect(((await checkout.json()) as any).url).toMatch(/^https:\/\//)
    const portal = await h.client.post('/billing/portal/', { json: {}, headers, csrf: false } as any)
    expect(portal.status).toBe(200)
    const bad = await h.client.post('/billing/checkout/', {
      json: { plan: 'pro' },
      headers: { authorization: 'Bearer nope' },
      csrf: false,
    } as any)
    expect(bad.status).toBe(401)
  })

  it('enforces CSRF for session requests', async () => {
    seedPrices(h.stripe)
    await syncProductsAndPrices()
    await h.client.forceLogin(await makeUser())
    const post = (csrf: boolean) =>
      h.client.post('/billing/checkout/', { json: { plan: 'pro' }, csrf } as any)
    expect((await post(false)).status).toBe(403)
    expect((await post(true)).status).toBe(200)
  })

  it('BILLING.AUTHENTICATION_CLASSES overrides the REST default; an ambient session is not used', async () => {
    seedPrices(h.stripe)
    await syncProductsAndPrices()
    h.billing.AUTHENTICATION_CLASSES = [JWTAuthentication]
    await h.client.forceLogin(await makeUser())
    const res = await h.client.post('/billing/checkout/', { json: { plan: 'pro' }, csrf: false } as any)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm=/)
  })
})
