// Belépés Discorddal — csak már összekötött fiókba.
//
// Új belépési út, ezért a próba azt méri, amit egy belépésnél mérni kell:
// hogy csak az jut be, akinek szabad (összekötött, aktív, kétlépcsős titok
// nélküli fiók), hogy az állapot egyszer használható és a KEZDEMÉNYEZŐ
// böngészőhöz kötött (login CSRF), és hogy a hozzáférési token nem kerül a
// címsorba. A Discordot a `fetch` szintjén hamisítjuk.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-login-secret-long-enough-0123456789'

describe('belépés Discorddal', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
  let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
  const jel = randomBytes(4).toString('hex')
  const username = 'dclogin' + jel
  const DISCORD_ID = '8' + String(Date.now()).padEnd(17, '1').slice(0, 17)
  const VISSZA = 'https://yume.example.com/v1/auth/discord/callback'
  let userId = ''
  const regiEnv: Record<string, string | undefined> = {}

  before(async () => {
    for (const k of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_LOGIN_REDIRECT_URI']) regiEnv[k] = process.env[k]
    process.env.DISCORD_CLIENT_ID = '123456789012345678'
    process.env.DISCORD_CLIENT_SECRET = 'login-proba-secret-NEM-VALODI'
    process.env.DISCORD_LOGIN_REDIRECT_URI = VISSZA
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/infrastructure/database/index.ts')])
    pool = db.pool
    app = await buildApp()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' } })
    assert.equal(res.statusCode, 201, res.body)
    userId = (await pool.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username])).rows[0]!.id
    await pool.query('INSERT INTO discord_links (user_id, discord_user_id) VALUES ($1, $2)', [userId, DISCORD_ID])
  })

  afterEach(() => { mock.restoreAll() })

  after(async () => {
    try {
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      for (const [k, v] of Object.entries(regiEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await app?.close()
    }
  })

  /** A Discord: a kód beváltása és a „ki vagyok" — a megadott azonosítóval. */
  const discord = (id: string = DISCORD_ID): Array<{ url: string, body: string }> => {
    const hivasok: Array<{ url: string, body: string }> = []
    mock.method(globalThis, 'fetch', async (url: string, init?: { body?: unknown }) => {
      hivasok.push({ url: String(url), body: String(init?.body ?? '') })
      const body = String(url).endsWith('/oauth2/token') ? { access_token: 'proba-hozzaferes', token_type: 'Bearer' } : { id }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
    })
    return hivasok
  }

  /** Indítás: az állapot a címből, a nonce a sütiből. */
  const indit = async (): Promise<{ state: string, suti: string, url: URL }> => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/discord/start', payload: {} })
    assert.equal(res.statusCode, 200, res.body)
    const url = new URL(res.json().url)
    const set = String(res.headers['set-cookie'] ?? '')
    const suti = /yume_dlogin=([^;]+)/.exec(set)?.[1] ?? ''
    return { state: url.searchParams.get('state') ?? '', suti, url }
  }

  const visszahivas = async (q: string, suti: string | null) => await app.inject({
    url: `/v1/auth/discord/callback?${q}`,
    ...(suti ? { cookies: { yume_dlogin: suti } } : {})
  })

  it('beállítatlan példányon nincs Discord-belépés — gomb sem', async () => {
    const vissza = process.env.DISCORD_LOGIN_REDIRECT_URI
    delete process.env.DISCORD_LOGIN_REDIRECT_URI
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/discord/start', payload: {} })).statusCode, 503)
      assert.equal((await app.inject({ url: '/v1/config' })).json().site.discordLogin, false)
    } finally {
      process.env.DISCORD_LOGIN_REDIRECT_URI = vissza
    }
  })

  it('az indítás a böngészőhöz kötött sütit állít be, és csak az azonosítót kéri', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/discord/start', payload: {} })
    const set = String(res.headers['set-cookie'] ?? '')
    assert.match(set, /yume_dlogin=/)
    assert.match(set, /HttpOnly/i)
    assert.match(set, /SameSite=Lax/i)
    assert.match(set, /Path=\/v1\/auth\/discord/)
    const url = new URL(res.json().url)
    assert.equal(url.host, 'discord.com')
    assert.equal(url.searchParams.get('scope'), 'identify')
    assert.equal(url.searchParams.get('redirect_uri'), VISSZA)
    assert.equal((await app.inject({ url: '/v1/config' })).json().site.discordLogin, true)
  })

  it('összekötött fiókba beléptet: frissítő süti, a hozzáférési token NEM a címben', async () => {
    const { state, suti } = await indit()
    const h = discord()
    const res = await visszahivas(`code=proba-kod&state=${encodeURIComponent(state)}`, suti)
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/#/login?discord=ok')
    // A kód beváltása ugyanazzal a visszatérési címmel történt, amivel az engedélyezés indult.
    assert.match(decodeURIComponent(h.find(x => x.url.endsWith('/oauth2/token'))!.body), new RegExp(VISSZA.replace(/[/.]/g, '\\$&')))
    const set = ([] as string[]).concat(res.headers['set-cookie'] as string | string[])
    const frissito = set.find(c => c.startsWith('yume_refresh='))
    assert.ok(frissito, 'nem kapott frissítő sütit')
    // A főoldal ebből vesz fel munkamenetet.
    const token = await app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { yume_refresh: /yume_refresh=([^;]+)/.exec(frissito)![1]! }, payload: {} })
    assert.equal(token.statusCode, 200, token.body)
    const payload = JSON.parse(Buffer.from(String(token.json().accessToken).split('.')[1]!, 'base64url').toString())
    assert.equal(payload.sub, userId)
    const { rows } = await pool.query(
      "SELECT 1 FROM account_events WHERE user_id = $1 AND event = 'LOGIN' AND metadata->>'method' = 'discord'", [userId])
    assert.ok(rows.length >= 1, 'a belépés nem került a fiók eseményei közé')
  })

  it('az állapot egyszer használható', async () => {
    const { state, suti } = await indit()
    discord()
    assert.equal((await visszahivas(`code=a&state=${encodeURIComponent(state)}`, suti)).headers.location, '/#/login?discord=ok')
    assert.equal((await visszahivas(`code=b&state=${encodeURIComponent(state)}`, suti)).headers.location, '/#/login?discord=expired')
  })

  /*
   * LOGIN CSRF: a támadó a SAJÁT belépésének visszahívását nyittatná meg az
   * áldozattal. Az áldozat böngészőjében nincs meg a támadó sütije — tehát az
   * állapot ott érvénytelen, és senki nem lép be semmibe.
   */
  it('más böngészőben — süti nélkül vagy idegen sütivel — érvénytelen', async () => {
    discord()
    const elso = await indit()
    const nelkul = await visszahivas(`code=a&state=${encodeURIComponent(elso.state)}`, null)
    assert.equal(nelkul.headers.location, '/#/login?discord=expired')
    const masodik = await indit()
    const idegen = await visszahivas(`code=a&state=${encodeURIComponent(masodik.state)}`, elso.suti)
    assert.equal(idegen.headers.location, '/#/login?discord=expired')
    assert.ok(!String(idegen.headers['set-cookie'] ?? '').includes('yume_refresh='), 'idegen sütivel is beléptetett')
  })

  it('összekötetlen Discord-fiókkal nem jut be semmibe', async () => {
    const { state, suti } = await indit()
    discord('899999999999999999')
    const res = await visszahivas(`code=a&state=${encodeURIComponent(state)}`, suti)
    assert.equal(res.headers.location, '/#/login?discord=not_linked')
    assert.ok(!String(res.headers['set-cookie'] ?? '').includes('yume_refresh='))
  })

  it('felfüggesztett fiók nem léphet be', async () => {
    await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId])
    try {
      const { state, suti } = await indit()
      discord()
      assert.equal((await visszahivas(`code=a&state=${encodeURIComponent(state)}`, suti)).headers.location, '/#/login?discord=blocked')
    } finally {
      await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [userId])
    }
  })

  it('kétlépcsős titokkal védett fiók nem léphet be Discorddal', async () => {
    await pool.query("UPDATE users SET mfa_secret = 'titkositott-proba' WHERE id = $1", [userId])
    try {
      const { state, suti } = await indit()
      discord()
      const res = await visszahivas(`code=a&state=${encodeURIComponent(state)}`, suti)
      assert.equal(res.headers.location, '/#/login?discord=mfa')
      assert.ok(!String(res.headers['set-cookie'] ?? '').includes('yume_refresh='))
    } finally {
      await pool.query('UPDATE users SET mfa_secret = NULL WHERE id = $1', [userId])
    }
  })

  it('a Discordnál megszakított belépés visszatér, és az állapot sem marad élve', async () => {
    const { state, suti } = await indit()
    const res = await visszahivas(`error=access_denied&state=${encodeURIComponent(state)}`, suti)
    assert.equal(res.headers.location, '/#/login?discord=cancelled')
    discord()
    assert.equal((await visszahivas(`code=a&state=${encodeURIComponent(state)}`, suti)).headers.location, '/#/login?discord=expired')
  })
})
