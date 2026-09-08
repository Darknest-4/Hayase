// What a webhook actually says when it arrives.
//
// The generic payload was `{ event, data, at }` and nothing else, which left a
// receiver unable to answer three ordinary questions that only the sender
// knows: have I already processed this, which of my Yume instances sent it,
// and is this the first attempt or the fifth. A retry after a timeout was
// indistinguishable from a second event.
//
// The other half is the events themselves. "A user registered: bob" is not
// something anybody can act on — the hundredth signup and the very first one,
// which the bootstrap makes an administrator, read identically.
//
// These run against a local HTTP server rather than a mock, because the thing
// under test is the bytes on the wire: the body, the headers and the
// signature over them.

import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import type { AddressInfo } from 'node:net'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'webhook-payload-secret-long-enough-0123456789'

// The SSRF guard refuses loopback, which is correct and is its own test's
// subject (test/ssrf.test.ts). `WEBHOOK_ALLOWED_HOSTS` is the operator escape
// hatch that already exists for exactly this — a webhook aimed at something on
// the same machine — so the guard is used as designed rather than bypassed.
// It is read when lib/ssrf.ts is first imported, so it is set before any
// import of the module graph below.
process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'

describe('webhook payloads', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let deliver: typeof import('../src/lib/webhooks.ts').deliver
  let server: ReturnType<typeof createServer>
  let base = ''
  const hookIds: string[] = []

  interface Received { headers: Record<string, string | string[] | undefined>, body: string }
  let received: Received[] = []

  before(async () => {
    const [db, hooks] = await Promise.all([import('../src/db.ts'), import('../src/lib/webhooks.ts')])
    pool = db.pool
    deliver = hooks.deliver

    server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        received.push({ headers: req.headers, body })
        res.writeHead(200).end('ok')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    try {
      if (hookIds.length) await pool.query('DELETE FROM webhooks WHERE id = ANY($1)', [hookIds])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await pool?.end()
    }
  })

  async function hook (format: string, secret: string | null = null): Promise<{ id: string, name: string }> {
    const name = 'wh_' + randomBytes(4).toString('hex')
    const { rows } = await pool.query(
      `INSERT INTO webhooks (name, url, format, events, enabled, secret)
       VALUES ($1, $2, $3, ARRAY['user.registered']::text[], true, $4) RETURNING id, name`,
      [name, base + '/hook', format, secret]
    )
    hookIds.push(String(rows[0].id))
    return { id: String(rows[0].id), name: String(rows[0].name) }
  }

  const lastBody = (): Record<string, any> => JSON.parse(received[received.length - 1]!.body)
  const lastHeaders = (): Record<string, any> => received[received.length - 1]!.headers as Record<string, any>

  test('the envelope carries who sent it, when, and which attempt this is', async () => {
    received = []
    const h = await hook('json')
    await deliver(h.id, 'user.registered', { username: 'alice', totalUsers: 42 },
      '2026-09-07T10:00:00.000Z', { deliveryId: 'fixed-delivery-id', attempt: 3 })

    assert.equal(received.length, 1, 'the endpoint was called')
    const body = lastBody()

    assert.equal(body.id, 'fixed-delivery-id')
    assert.equal(body.event, 'user.registered')
    assert.equal(body.at, '2026-09-07T10:00:00.000Z', 'when the event happened')
    assert.ok(body.sentAt, 'when this attempt was made')
    assert.notEqual(body.sentAt, body.at, 'the two timestamps are different things')
    assert.equal(body.attempt, 3)
    assert.equal(body.webhook.id, h.id)
    assert.equal(body.webhook.name, h.name)
    assert.ok(body.instance.name, 'the instance names itself')
    assert.ok(body.instance.environment)
    assert.deepEqual(body.data, { username: 'alice', totalUsers: 42 }, 'the event data is untouched')
  })

  test('the headers repeat what a receiver routes on', async () => {
    received = []
    const h = await hook('json')
    await deliver(h.id, 'user.registered', { username: 'bob' }, new Date().toISOString(),
      { deliveryId: 'header-delivery', attempt: 2 })

    const headers = lastHeaders()
    assert.equal(headers['x-yume-event'], 'user.registered')
    assert.equal(headers['x-yume-delivery'], 'header-delivery')
    assert.equal(headers['x-yume-attempt'], '2')
    assert.ok(headers['x-yume-timestamp'], 'a send timestamp is present')
  })

  test('the signature covers the whole envelope, not only the data', async () => {
    received = []
    const secret = 'a-signing-secret-long-enough-to-matter'
    const h = await hook('json', secret)
    await deliver(h.id, 'user.registered', { username: 'carol' }, new Date().toISOString())

    const { headers, body } = received[0]!
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    assert.equal(headers['x-yume-signature'], expected)

    // A receiver that verifies the signature and then trusts `id` needs the id
    // to be inside the signed bytes, not only in a header anybody can rewrite.
    assert.ok(body.includes('"id"'), 'the delivery id is part of what is signed')
  })

  test('a delivery id is stable across retries so a receiver can deduplicate', async () => {
    received = []
    const h = await hook('json')
    const id = 'retry-me'
    await deliver(h.id, 'user.registered', { username: 'dave' }, '2026-09-07T10:00:00.000Z', { deliveryId: id, attempt: 1 })
    await deliver(h.id, 'user.registered', { username: 'dave' }, '2026-09-07T10:00:00.000Z', { deliveryId: id, attempt: 2 })

    assert.equal(received.length, 2)
    const [first, second] = received.map(r => JSON.parse(r.body))
    assert.equal(first.id, second.id, 'the same event keeps one id')
    assert.equal(first.attempt, 1)
    assert.equal(second.attempt, 2)
  })

  test('a Discord webhook gets an embed, not the envelope', async () => {
    received = []
    const h = await hook('discord')
    await deliver(h.id, 'user.registered', { username: 'erin', totalUsers: 7, promotedToAdmin: true },
      new Date().toISOString(), { attempt: 2 })

    const body = lastBody()
    assert.ok(Array.isArray(body.embeds) && body.embeds.length === 1)
    const embed = body.embeds[0]
    assert.match(String(embed.title), /registered/i)
    // The footer is where a channel watching several instances finds out which
    // one this is, and that this is a retry rather than a second signup.
    assert.match(String(embed.footer.text), /user\.registered/)
    assert.match(String(embed.footer.text), /retry 2/)
    const names = embed.fields.map((f: { name: string }) => f.name)
    assert.ok(names.includes('Account #'), 'the scale of the instance is in the embed')
    assert.ok(names.some((n: string) => n.includes('Promoted')), 'the bootstrap promotion is announced')
  })

  test('the recorded delivery is the envelope that was sent', async () => {
    received = []
    const h = await hook('json')
    await deliver(h.id, 'user.registered', { username: 'frank' }, new Date().toISOString(), { deliveryId: 'recorded' })

    const { rows } = await pool.query(
      'SELECT payload, status_code FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 1',
      [h.id])
    assert.equal(Number(rows[0].status_code), 200)
    // The delivery log used to record `{ event, data, at }` while something
    // else went over the wire, so "what did we actually send" was unanswerable
    // from the one place built to answer it.
    assert.equal(rows[0].payload.id, 'recorded')
    assert.equal(rows[0].payload.attempt, 1)
    assert.ok(rows[0].payload.instance)
  })

  test('a disabled webhook is not delivered to at all', async () => {
    received = []
    const h = await hook('json')
    await pool.query('UPDATE webhooks SET enabled = false WHERE id = $1', [h.id])
    await deliver(h.id, 'user.registered', { username: 'gina' }, new Date().toISOString())
    assert.equal(received.length, 0)
  })
})
