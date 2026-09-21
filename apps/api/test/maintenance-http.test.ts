// Karbantartási mód — valódi alkalmazáspéldánnyal, valódi adatbázissal.
//
// A magot (`maintenance-core.test.ts`) tiszta függvényként járjuk körbe. Ez a
// készlet arról szól, ami CSAK a HTTP-n látszik: fejlécek, válaszalakok, a
// gyorsítótár viselkedése, és hogy a döntés tényleg eljut a kérésig.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'

const { buildApp } = await import('../src/app.ts')
const db = await import('../src/infrastructure/database/index.ts')
const cache = await import('../src/modules/maintenance/cache.ts')
const repository = await import('../src/modules/maintenance/repository.ts')
const bypass = await import('../src/modules/maintenance/bypass.ts')
const { MODE, SCOPE } = await import('../src/modules/maintenance/state.ts')

const REASON = process.env.DATABASE_URL ? false : 'no DATABASE_URL'

/** Kívülről érkező kérés — különben a belső mentesség alá esne. */
const OUTSIDE = { 'x-forwarded-for': '203.0.113.90' }

describe('karbantartás a HTTP-n', { skip: REASON }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  before(async () => {
    app = await buildApp()
    await app.ready()
  })

  after(async () => {
    // A tábla visszaállítása kikapcsolt állapotba, hogy egy elhasalt teszt ne
    // hagyja karbantartásban a teszt-adatbázist.
    //
    // A KÉSZLET NEM ZÁRJA LE A KAPCSOLATKÉSZLETET. Az egy MODULSZINTŰ EGYKE,
    // és a következő `describe` blokk is ugyanazt használja — az első lezárás
    // után a második fele „cancelledByParent" hibával elszállt, mert a
    // lekérdezései egy halott készletre mentek.
    await set({ mode: MODE.OFF, enabled: false })
    await app?.close()
  })

  /** Beállítás mentése és azonnali érvényesítés a saját példányon. */
  const set = async (over: Record<string, unknown>): Promise<void> => {
    await repository.save({
      mode: MODE.OFF, scope: SCOPE.GLOBAL, enabled: false,
      startsAt: null, endsAt: null, estimatedEndAt: null,
      timezone: 'Europe/Budapest', title: 'Karbantartás',
      publicMessage: 'A YUME rövidesen újra elérhető lesz.',
      allowExistingSessions: false, drainSeconds: 0, actorId: null,
      ...over
    } as never)
    cache.invalidate()
    await cache.configNow()
  }

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...OUTSIDE, ...headers } })

  it('kikapcsolva minden a szokásos', async () => {
    await set({ enabled: false })
    const response = await get('/v1/config')
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-yume-maintenance'], undefined)
  })

  it('a nyilvános státusz működik, és keveset mond', async () => {
    await set({ enabled: false })
    const response = await get('/v1/status')
    assert.equal(response.statusCode, 200)
    const body = response.json() as Record<string, unknown>
    assert.equal(body.status, 'operational')
    assert.equal(body.mode, MODE.OFF)
    // A 27. pont: se belső ok, se adatbázis, se infrastruktúra.
    for (const forbidden of ['reason', 'sql', 'host', 'database', 'stack', 'error']) {
      assert.ok(!(forbidden in body), `kiszivárgott mező: ${forbidden}`)
    }
    assert.equal(response.headers['cache-control'], 'no-store')
  })

  it('teljes karbantartás: 503, helyes fejlécekkel', async () => {
    await set({ enabled: true, mode: MODE.ACTIVE })
    const response = await get('/v1/anime', { accept: 'application/json' })

    assert.equal(response.statusCode, 503)
    assert.equal(response.headers['x-yume-maintenance'], 'true')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.ok(Number(response.headers['retry-after']) > 0)
    assert.ok(response.headers['x-request-id'])

    const body = response.json() as { error: Record<string, unknown> }
    assert.equal(body.error.code, 'YUME_MAINTENANCE')
    assert.equal(body.error.mode, MODE.ACTIVE)
    assert.equal(body.error.scope, SCOPE.GLOBAL)
    assert.ok(body.error.requestId)
  })

  it('a válasz nem árul el semmit a belső világról', async () => {
    await set({ enabled: true, mode: MODE.ACTIVE })
    const response = await get('/v1/anime', { accept: 'application/json' })
    const raw = response.body.toLowerCase()
    for (const leak of ['postgres', 'yume_test', '/opt/', 'password', 'select ', 'node_modules', 'at object']) {
      assert.ok(!raw.includes(leak), `kiszivárgott: ${leak}`)
    }
  })

  it('a böngésző karbantartási OLDALT kap, nem JSON-t', async () => {
    await set({ enabled: true, mode: MODE.ACTIVE, title: 'Épp dolgozunk', publicMessage: 'Mindjárt jövünk.' })
    const response = await get('/v1/anime', { accept: 'text/html,application/xhtml+xml' })
    assert.equal(response.statusCode, 503)
    assert.match(String(response.headers['content-type']), /text\/html/)
    assert.match(response.body, /<!doctype html>/i)
    assert.match(response.body, /Épp dolgozunk/)
    assert.match(response.body, /Mindjárt jövünk/)
    // Az oldal magában áll: egy külső stíluslap pont most nem töltődne be.
    assert.ok(!/https?:\/\//.test(response.body))
  })

  it('az egészségjelző és a státusz karbantartás alatt is él', async () => {
    // Enélkül nem lehetne KIJÖNNI: az irányítórendszer halottnak hinné a
    // szolgáltatást, és a karbantartási oldal sem tudná megkérdezni, vége-e.
    await set({ enabled: true, mode: MODE.EMERGENCY })
    for (const url of ['/v1/health', '/v1/status']) {
      const response = await get(url)
      assert.notEqual(response.statusCode, 503, url)
    }
  })

  it('a saját rendszerünket a karbantartás sem zárja ki', async () => {
    await set({ enabled: true, mode: MODE.ACTIVE })
    // Fejléc nélkül, hurokcímről — pont úgy, ahogy a worker hív.
    const response = await app.inject({ method: 'GET', url: '/v1/anime' })
    assert.notEqual(response.statusCode, 503)
  })

  it('csak olvasható: az olvasás megy, az írás 503', async () => {
    await set({ enabled: true, mode: MODE.READ_ONLY })
    assert.notEqual((await get('/v1/anime')).statusCode, 503)

    const write = await app.inject({
      method: 'POST', url: '/v1/comments',
      headers: { ...OUTSIDE, accept: 'application/json' },
      payload: {}
    })
    assert.equal(write.statusCode, 503)
    assert.equal(write.headers['x-yume-maintenance'], 'true')
  })

  it('részleges: csak a lezárt terület esik ki', async () => {
    await set({ enabled: true, mode: MODE.DEGRADED, scope: SCOPE.SEARCH })
    assert.equal((await get('/v1/search?q=x', { accept: 'application/json' })).statusCode, 503)
    assert.notEqual((await get('/v1/config')).statusCode, 503)
  })

  it('ütemezett: még minden működik, de a státusz már mutatja', async () => {
    const startsAt = new Date(Date.now() + 3600_000)
    await set({ enabled: true, mode: MODE.ACTIVE, startsAt, endsAt: new Date(Date.now() + 7200_000) })

    assert.notEqual((await get('/v1/anime')).statusCode, 503)
    const status = (await get('/v1/status')).json() as Record<string, unknown>
    assert.equal(status.mode, MODE.SCHEDULED)
    assert.equal(status.status, 'operational')
    assert.ok(Number(status.retryAfter) > 3000, 'nincs visszaszámláló a kezdésig')
  })

  it('a LEJÁRT karbantartás magától véget ér — worker nélkül', async () => {
    await set({
      enabled: true, mode: MODE.ACTIVE,
      startsAt: new Date(Date.now() - 7200_000),
      endsAt: new Date(Date.now() - 3600_000)
    })
    const response = await get('/v1/anime')
    assert.notEqual(response.statusCode, 503, 'a lejárt karbantartás még fogott')
    const status = (await get('/v1/status')).json() as Record<string, unknown>
    assert.equal(status.mode, MODE.OFF)
  })
})

describe('mentességi jegy', { skip: REASON }, () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  before(async () => {
    app = await buildApp()
    await app.ready()
    await repository.save({
      mode: MODE.ACTIVE, scope: SCOPE.GLOBAL, enabled: true,
      startsAt: null, endsAt: null, estimatedEndAt: null,
      timezone: 'Europe/Budapest', title: 'Karbantartás', publicMessage: 'Mindjárt.',
      allowExistingSessions: false, drainSeconds: 0, actorId: null
    } as never)
    cache.invalidate()
    await cache.configNow()
  })

  after(async () => {
    await repository.save({
      mode: MODE.OFF, scope: SCOPE.GLOBAL, enabled: false,
      startsAt: null, endsAt: null, estimatedEndAt: null,
      timezone: 'Europe/Budapest', title: '', publicMessage: '',
      allowExistingSessions: false, drainSeconds: 0, actorId: null
    } as never)
    cache.invalidate()
    await app?.close()
  })

  const withToken = (token: string) => app.inject({
    method: 'GET', url: '/v1/anime',
    headers: { ...OUTSIDE, [bypass.BYPASS_HEADER]: token }
  })

  it('érvényes jeggyel be lehet menni', async () => {
    const issued = await bypass.issue({ actorId: null, label: 'teszt', minutes: 15 })
    const response = await withToken(issued.token)
    assert.notEqual(response.statusCode, 503)
  })

  it('a visszavont jegy azonnal érvénytelen', async () => {
    const issued = await bypass.issue({ actorId: null, label: 'visszavonandó', minutes: 15 })
    assert.notEqual((await withToken(issued.token)).statusCode, 503)

    const rows = await db.query<{ id: string }>(
      'SELECT id FROM maintenance_bypass_tokens WHERE token_hash = $1', [bypass.hashToken(issued.token)]
    )
    await bypass.revoke(String(rows[0]?.id), null)
    assert.equal((await withToken(issued.token)).statusCode, 503, 'a visszavont jegy még működött')
  })

  it('a meghamisított jegy elbukik', async () => {
    const issued = await bypass.issue({ actorId: null, minutes: 15 })
    // Az utolsó karakter átírása — az aláírás így nem stimmel.
    const tampered = issued.token.slice(0, -1) + (issued.token.endsWith('A') ? 'B' : 'A')
    assert.equal((await withToken(tampered)).statusCode, 503)
    assert.equal(bypass.verifySignature(tampered).ok, false)
  })

  it('a kitalált jegy elbukik, és nem is terheli az adatbázist', async () => {
    assert.equal(bypass.verifySignature('akarmi').ok, false)
    assert.equal((await withToken('akarmi')).statusCode, 503)
  })

  it('a szűkebb hatókörű jegy nem nyitja ki az egész oldalt', async () => {
    const issued = await bypass.issue({ actorId: null, scope: SCOPE.SEARCH, minutes: 15 })
    // Keresésre jó…
    const search = await app.inject({
      method: 'GET', url: '/v1/search?q=x',
      headers: { ...OUTSIDE, [bypass.BYPASS_HEADER]: issued.token }
    })
    assert.notEqual(search.statusCode, 503)
    // …a katalógusra nem.
    assert.equal((await withToken(issued.token)).statusCode, 503)
  })

  it('örök jegyet nem lehet kiállítani', async () => {
    // A 12. pont kifejezetten kéri. Az adatbázis is betartatja.
    const issued = await bypass.issue({ actorId: null, minutes: 99999 })
    const hours = (issued.expiresAt.getTime() - Date.now()) / 3_600_000
    assert.ok(hours <= 24, `a jegy ${hours.toFixed(1)} óráig élne`)
  })

  it('a jegy sehol nincs eltárolva nyersen', async () => {
    const issued = await bypass.issue({ actorId: null, label: 'lenyomat', minutes: 15 })
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM maintenance_bypass_tokens WHERE token_hash = $1`,
      [issued.token]
    )
    assert.equal(rows[0]?.n, '0', 'a jegy nyersen szerepel a táblában')
  })
})

// A kapcsolatkészlet lezárása EGY HELYEN, az összes blokk után. Modulszintű
// egyke: aki korábban zárja le, a többi blokkot viszi magával.
after(async () => { await db.pool.end().catch(() => {}) })
