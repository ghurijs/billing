// @ghuri/billing/admin: read-only mirrors and the "Process again" action on events.

import { AdminConfig, admin } from '@ghuri/admin'
import { User } from '@ghuri/auth'
import { path } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { Customer, Event, Subscription } from '../src/index'
import '../src/admin'
import { deliver, useHarness } from './helpers'

describe('billing admin', () => {
  const h = useHarness({ apps: [AdminConfig], urls: () => [path('admin/', admin.site.urls)] })

  it('registers every model read-only and replays failed events', async () => {
    for (const model of [Customer, Subscription, Event]) expect(admin.site.isRegistered(model)).toBe(true)
    const staff = await User.objects.createSuperuser({
      username: 'root',
      email: 'root@example.com',
      password: 'pw',
    } as any)
    await h.client.forceLogin(staff)

    const price = h.stripe.createPrice()
    const customer = h.stripe.createCustomer()
    const sub = h.stripe.createSubscription({ customer: customer.id, price: price.id })
    h.stripe.customers.delete(customer.id)
    const errors = console.error
    console.error = () => {}
    try {
      expect((await deliver(h, h.stripe.event('customer.subscription.created', sub))).status).toBe(500)
    } finally {
      console.error = errors
    }
    const row = await Event.objects.get({ status: 'failed' })

    const list = await h.client.get('/admin/billing/event/')
    expect(list.status).toBe(200)
    const html = await list.text()
    expect(html).toContain('customer.subscription.created')
    expect(html).toContain('value="process_again"')
    const add = await h.client.get('/admin/billing/subscription/add/')
    expect(add.status).toBe(403)

    h.stripe.customers.set(customer.id, customer)
    const res = await h.client.post('/admin/billing/event/', {
      form: { action: 'process_again', index: '0', _selected_action: [String(row.pk)] },
    })
    expect(res.status).toBe(302)
    expect((await Event.objects.get({ pk: row.pk })).status).toBe('processed')
    expect(await Subscription.objects.filter({ providerId: sub.id }).exists()).toBe(true)
  })
})
