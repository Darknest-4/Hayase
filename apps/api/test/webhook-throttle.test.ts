// „Túl gyorsan küldesz" nem ugyanaz, mint „elhasalt".
//
// Ez a példány botja 1060 kézbesítés után kikapcsolva állt. A napló megmondta,
// miért: hat kézbesítés egyetlen időbélyegen, öt közülük HTTP 429. A Discord
// webhookonként nagyjából öt kérést enged két másodpercenként; egy
// katalógusimport vagy egy tesztfutás ennél sokkal gyorsabban termel eseményt.
//
// A 429 addig pontosan úgy számított, mint egy halott URL: húsz egymás utáni
// után a webhook kikapcsolta magát. Vagyis egy forgalmas fél óra kikapcsolta a
// működő botot, és a panelen „hibaként" látszott, miközben a Discord csak
// annyit mondott, hogy lassítsunk.
//
// Két tulajdonság van itt kikötve:
//
//   * egy 429 nem növeli a sikertelenség-számlálót, és nem kapcsol ki semmit;
//   * a hiba magával hozza a kért várakozást, hogy a sor ne a saját fél
//     perces visszalépését használja egy fél másodperces korlátra.
//
// Igazi HTTP-kiszolgálóval fut, nem mockkal: a vizsgált dolog az, hogy mit
// olvasunk ki a válasz fejléceiből.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, describe, test } from 'node:test'

import type { AddressInfo } from 'node:net'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'webhook-throttle-secret-long-enough-0123456789'
// Ugyanaz az üzemeltetői kiskapu, amit a webhook-payload teszt is használ: az
// SSRF-őr helyesen utasítja el a loopbackot, és ez a szándékolt kivétel rá.
process.env.WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'

describe('a rate-limited webhook is not a broken one', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let deliver: typeof import('../src/modules/webhooks/delivery.ts').deliver
  let server: ReturnType<typeof createServer>
  let base = ''
  const hookIds: string[] = []
  /** Mit válaszoljon a következő kérésre. */
  let reply: { status: number, headers: Record<string, string> } = { status: 200, headers: {} }
  let hits = 0

  before(async () => {
    const [db, hooks] = await Promise.all([
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/webhooks/delivery.ts')
    ])
    pool = db.pool
    deliver = hooks.deliver

    server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        hits++
        res.writeHead(reply.status, reply.headers).end('')
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

  async function hook (): Promise<string> {
    const name = 'thr_' + randomBytes(4).toString('hex')
    const { rows } = await pool.query(
      `INSERT INTO webhooks (name, url, format, events, enabled)
       VALUES ($1, $2, 'json', ARRAY['user.registered']::text[], true) RETURNING id`,
      [name, base + '/hook']
    )
    hookIds.push(String(rows[0].id))
    return String(rows[0].id)
  }

  const state = async (id: string): Promise<{ enabled: boolean, failure_count: number }> => {
    const { rows } = await pool.query('SELECT enabled, failure_count FROM webhooks WHERE id = $1', [id])
    return rows[0]
  }

  test('a 429 carries the wait the receiver asked for', async () => {
    const id = await hook()
    reply = { status: 429, headers: { 'x-ratelimit-reset-after': '1.5' } }

    const error = await deliver(id, 'user.registered', { username: 'a' }, new Date().toISOString())
      .then(() => null, (e: Error) => e)

    assert.ok(error, 'a throttled delivery must not report success')
    assert.match(error.message, /rate limited/)
    assert.equal((error as Error & { retryAfterMs?: number }).retryAfterMs, 1500)
  })

  test('a 429 does not count against the webhook', async () => {
    const id = await hook()
    reply = { status: 429, headers: { 'retry-after': '2' } }

    for (let i = 0; i < 3; i++) {
      await deliver(id, 'user.registered', { username: 'a' }, new Date().toISOString()).catch(() => {})
    }

    const row = await state(id)
    assert.equal(row.failure_count, 0, 'throttling is not a failure of the endpoint')
    assert.equal(row.enabled, true, 'a busy hour must not disable a working bot')
  })

  test('a real failure still counts, and still disables eventually', async () => {
    // A másik fele: ha a 429 nem számít, attól egy halott végpontnak még
    // számítania kell — különben a kikapcsolás soha nem történne meg.
    const id = await hook()
    reply = { status: 500, headers: {} }

    await deliver(id, 'user.registered', { username: 'a' }, new Date().toISOString()).catch(() => {})

    const row = await state(id)
    assert.equal(row.failure_count, 1)
  })

  test('deliveries to one webhook are spaced apart', async () => {
    // Nem korlát, csak annyi, hogy két csomag ne ugyanabban az
    // ezredmásodpercben érkezzen — a naplóban pontosan ez volt a baj.
    const id = await hook()
    reply = { status: 200, headers: {} }
    hits = 0

    const started = Date.now()
    for (let i = 0; i < 3; i++) {
      await deliver(id, 'user.registered', { username: 'a' }, new Date().toISOString())
    }
    const elapsed = Date.now() - started

    assert.equal(hits, 3)
    assert.ok(elapsed >= 700, `three deliveries took ${elapsed}ms — they were not spaced`)
  })

  test('a test run cannot fan out to the operator\'s Discord', async () => {
    /*
     * A suite egy igazi adatbázis ellen fut, és minden próbafiók
     * regisztrációja `user.registered`-et vált ki. Egy bekapcsolt webhookon át
     * ez valódi üzenet egy valódi csatornában, tucatjával — a napló pontosan
     * ezt mutatta, sorozatnyi `user.registered` egyetlen időbélyegen.
     *
     * A némítás csak a szórásra vonatkozik: a fenti tesztek közvetlenül a
     * kézbesítést hívják, és futnak tovább.
     */
    const id = await hook()
    reply = { status: 200, headers: {} }
    hits = 0

    const before = process.env.YUME_SUPPRESS_WEBHOOKS
    process.env.YUME_SUPPRESS_WEBHOOKS = '1'
    try {
      const { emitEvent } = await import('../src/modules/webhooks/delivery.ts')
      await emitEvent('user.registered', { username: 'nobody' })
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = $1', [id])
      assert.equal(rows[0].n, 0, 'a suppressed run must queue nothing')
      assert.equal(hits, 0)
    } finally {
      if (before === undefined) delete process.env.YUME_SUPPRESS_WEBHOOKS
      else process.env.YUME_SUPPRESS_WEBHOOKS = before
    }
  })

  test('a receiver that says nothing still gets a sensible wait', async () => {
    const id = await hook()
    reply = { status: 429, headers: {} }

    const error = await deliver(id, 'user.registered', { username: 'a' }, new Date().toISOString())
      .then(() => null, (e: Error) => e)

    assert.equal((error as Error & { retryAfterMs?: number }).retryAfterMs, 1000)
  })
})
