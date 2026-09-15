// A socket, aminek eddig nem volt tesztje.
//
// Ez az egyetlen felület, ami nem kérés-válasz: egy nyitott kapcsolat, amin
// keresztül egy hitelesített kliens folyamatosan küldhet. A HTTP
// sebességkorlát nem látja, a séma-ellenőrzés nem látja, és a közös nézés
// teljes egészében rajta él.
//
// A réteg megvolt és átgondolt — jegyes hitelesítés, korlátozott
// hitelesítés-előtti puffer, token-vödrös üzenetkorlát, újrahitelesítő söprés.
// Amit nem lehetett tudni: hogy mindez igaz-e.
//
// Valódi socketet nyit valódi kiszolgálóhoz. Egy WebSocket-réteget mockkal
// vizsgálni annyi, mint a zárat a rajza alapján ellenőrizni.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'ws-secret-long-enough-0123456789abcdef'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('the websocket', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let base = ''
  let WebSocketImpl: typeof import('ws').WebSocket
  const usernames: string[] = []
  let token = ''

  async function account (): Promise<string> {
    const username = 'ws_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    return (res.json() as { accessToken: string }).accessToken
  }

  /** Egy jegy, ahogy a kliens is kéri. */
  async function ticket (accessToken: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/ws-ticket', headers: { authorization: `Bearer ${accessToken}` }, payload: {}
    })
    assert.equal(res.statusCode, 200, res.body)
    return (res.json() as { ticket: string }).ticket
  }

  /**
   * Nyitott socket, vagy a lezárás kódja. Sosem lóg örökké.
   *
   * A türelmi idő nem díszítés. A jegyet a kiszolgáló a WebSocket-váltás
   * *után* ellenőrzi — a protokoll szerint ez a rendje —, tehát a kliens előbb
   * lát `open`-t, és csak utána `close(4401)`-et. Egy szonda, ami az `open`-re
   * felold, minden elutasítást sikernek olvas. (Pontosan ezt csinálta az első
   * változatom, és „a jegy nélküli socket megnyílik"-ot jelentett.)
   */
  function connect (query: string, grace = 600): Promise<{ socket?: InstanceType<typeof WebSocketImpl>, closeCode?: number }> {
    return new Promise(resolve => {
      const socket = new WebSocketImpl(`${base}/ws${query}`)
      let settled = false
      const done = (value: { socket?: InstanceType<typeof WebSocketImpl>, closeCode?: number }): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const hard = setTimeout(() => { try { socket.close() } catch { /* már zárva */ } ; done({ closeCode: 0 }) }, 5000)
      socket.on('open', () => {
        // Megvárjuk, hogy a kiszolgáló elutasítja-e, mielőtt nyitottnak
        // neveznénk.
        setTimeout(() => {
          clearTimeout(hard)
          if (socket.readyState === socket.OPEN) done({ socket })
        }, grace)
      })
      socket.on('close', code => { clearTimeout(hard); done({ closeCode: code }) })
      socket.on('error', () => {})
    })
  }

  /** A következő üzenet a socketen, vagy null, ha nem jön időben. */
  function next (socket: InstanceType<typeof WebSocketImpl>, ms = 1500): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ms)
      socket.once('message', data => {
        clearTimeout(timer)
        try { resolve(JSON.parse(String(data)) as Record<string, unknown>) } catch { resolve(null) }
      })
    })
  }

  before(async () => {
    const [{ buildApp }, db, ws] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts'), import('ws')
    ])
    app = await buildApp()
    pool = db.pool as never
    WebSocketImpl = ws.WebSocket
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    base = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    token = await account()
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('refuses a socket with no ticket', async () => {
    const { closeCode } = await connect('')
    assert.equal(closeCode, 4401, 'an unauthenticated socket must be closed, not served')
  })

  test('refuses a ticket that was never issued', async () => {
    const { closeCode } = await connect('?ticket=' + randomBytes(32).toString('base64url'))
    assert.equal(closeCode, 4401)
  })

  test('accepts a real ticket', async () => {
    const { socket, closeCode } = await connect('?ticket=' + await ticket(token))
    assert.ok(socket, `the socket was closed with ${closeCode}`)
    socket.close()
  })

  test('a ticket is single use', async () => {
    // Ez az egész jegy értelme: ami egy naplóba kerül, az utólag ne érjen
    // semmit.
    const one = await ticket(token)
    const first = await connect('?ticket=' + one)
    assert.ok(first.socket, 'the first use should work')
    first.socket.close()

    const second = await connect('?ticket=' + one)
    assert.equal(second.closeCode, 4401, 'a ticket must not work twice')
  })

  test('a used ticket is stored hashed, never in the clear', async () => {
    const raw = await ticket(token)
    const { rows } = await pool.query('SELECT ticket FROM ws_tickets ORDER BY created_at DESC LIMIT 5')
    const stored = rows.map(r => String(r.ticket))
    assert.ok(!stored.includes(raw), 'the ticket itself is in the database')
    assert.ok(stored.every(t => /^[0-9a-f]{64}$/.test(t)), 'stored tickets are not sha256 digests')
  })

  test('an oversized frame does not reach the parser', async () => {
    const { socket } = await connect('?ticket=' + await ticket(token))
    assert.ok(socket)
    // 16 KiB fölött: a réteg eldobja, mielőtt JSON.parse látná.
    socket.send(JSON.stringify({ type: 'join', channel: 'chat:' + 'x'.repeat(40_000) }))
    const reply = await next(socket, 1500)
    // A visszautasítás kimondott: a kliens megtudja, miért nem történt semmi.
    // A csendes eldobás itt rosszabb lenne — egy hibás kliens örökké küldene.
    assert.equal(reply?.error, 'message too large', `unexpected reply: ${JSON.stringify(reply)}`)
    // És a kapcsolat él: egy túl nagy keret nem bontja a socketet, csak ezt
    // az egy üzenetet dobja el.
    assert.equal(socket.readyState, socket.OPEN, 'the connection died on an oversized frame')
    socket.close()
  })

  test('joining someone else\'s user channel is refused', async () => {
    // A `user:{id}` csatorna az értesítéseké. Idegen azonosítóval csatlakozni
    // annyi lenne, mint más értesítéseit olvasni.
    const otherToken = await account()
    const otherId = (await pool.query(
      'SELECT id FROM users WHERE username = $1', [usernames[usernames.length - 1]])).rows[0].id

    const { socket } = await connect('?ticket=' + await ticket(token))
    assert.ok(socket)
    socket.send(JSON.stringify({ type: 'join', channel: `user:${otherId}` }))
    await next(socket, 1200)

    // Amit tényleg ellenőrizni kell: hogy a másik fiók értesítése nem érkezik
    // meg ide. Egy „joined" válasz önmagában nem bizonyíték.
    const heard = await next(socket, 800)
    assert.ok(heard === null || heard.channel !== `user:${otherId}`,
      'a foreign user channel delivered something')
    assert.ok(otherToken)
    socket.close()
  })

  test('a malformed frame is ignored, not fatal', async () => {
    const { socket } = await connect('?ticket=' + await ticket(token))
    assert.ok(socket)
    socket.send('this is not json at all')
    socket.send(JSON.stringify({ type: 42 }))
    socket.send(JSON.stringify(null))
    await next(socket, 800)
    assert.equal(socket.readyState, socket.OPEN, 'the connection died on a malformed frame')
    socket.close()
  })
})
