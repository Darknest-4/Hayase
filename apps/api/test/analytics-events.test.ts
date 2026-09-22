// Az egységes eseményséma.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA A DEDUPLIKÁCIÓ ALAKJA. Egy tartósan egyedi
// kulcs azt jelentené, hogy ugyanaz a felhasználó ugyanazt SOHA többé nem
// csinálhatja — pedig egy címet kétszer is meg lehet nyitni. Az ablakos kulcs
// a helyes viselkedés, és ezt könnyű elrontani úgy, hogy a hiba csak
// hónapokkal később, egy hiányzó számban derül ki.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'analytics-events-secret-long-enough-0123456789'

let ev: typeof import('../src/modules/analytics/events.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const ALANY = 'teszt-' + randomUUID().slice(0, 8)

describe('az egységes eseményséma', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    ev = await import('../src/modules/analytics/events.ts')
    db = await import('../src/infrastructure/database/index.ts')
  })

  beforeEach(async () => {
    ev.reset()
    await db.query('DELETE FROM analytics_events WHERE subject_id = $1', [ALANY])
  })

  after(async () => {
    ev.reset()
    await db.query('DELETE FROM analytics_events WHERE subject_id = $1', [ALANY])
  })

  // ---- a típusszótár ----

  /*
   * ZÁRT SZÓTÁR. Egy szabad szöveg némán új eseményfajtát hozna létre egy
   * elgépelt névből, és a kimutatásból pont az hiányozna, amit mérni
   * akartunk.
   */
  it('ismeretlen típust nem vesz fel', async () => {
    ev.record({ type: 'search.reslut.open' as never, subjectId: ALANY })
    assert.equal(ev.pending(), 0, 'elgépelt típust is felvett')
    await ev.flush()
    const sorok = await db.query('SELECT 1 FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sorok.length, 0)
  })

  it('a típusellenőrzés a listából dolgozik', () => {
    for (const t of ev.EVENT_TYPES) assert.equal(ev.isEventType(t), true, t)
    for (const t of ['', 'valami', 'search', null, 42]) {
      assert.equal(ev.isEventType(t as never), false, String(t))
    }
  })

  // ---- a deduplikációs kulcs ----

  it('ugyanaz az esemény ugyanabban az ablakban EGY kulcs', () => {
    const a = new Date('2026-09-22T10:00:00.000Z')
    const b = new Date('2026-09-22T10:00:09.900Z')
    const e = { type: 'anime.open' as const, userId: 'u1', subjectType: 'anime', subjectId: 'x' }
    assert.equal(ev.dedupeKey(e, a), ev.dedupeKey(e, b))
  })

  /*
   * ÉS EZ A MÁSIK FELE: két perc múlva MÁSIK esemény. Enélkül a felhasználó
   * ugyanazt a címet soha többé nem nyithatná meg „mérhetően".
   */
  it('két perc múlva MÁSIK esemény', () => {
    const a = new Date('2026-09-22T10:00:00.000Z')
    const b = new Date('2026-09-22T10:02:00.000Z')
    const e = { type: 'anime.open' as const, userId: 'u1', subjectType: 'anime', subjectId: 'x' }
    assert.notEqual(ev.dedupeKey(e, a), ev.dedupeKey(e, b))
  })

  it('két felhasználó ugyanarra más kulcsot kap', () => {
    const at = new Date('2026-09-22T10:00:00.000Z')
    const alap = { type: 'anime.open' as const, subjectType: 'anime', subjectId: 'x' }
    assert.notEqual(ev.dedupeKey({ ...alap, userId: 'u1' }, at), ev.dedupeKey({ ...alap, userId: 'u2' }, at))
  })

  /*
   * A KULCSBAN NINCS NYERS AZONOSÍTÓ. A kulcs úgyis csak összehasonlításra
   * szolgál; így egy adatbázis-kiolvasás sem ad belőle vissza semmit.
   */
  it('a kulcs nem tartalmazza a nyers azonosítókat', () => {
    const kulcs = ev.dedupeKey({
      type: 'anime.open', userId: 'titkos-felhasznalo-azonosito', subjectId: 'titkos-alany'
    }, new Date())
    assert.ok(!kulcs.includes('titkos'))
    assert.match(kulcs, /^[0-9a-f]{32}$/)
  })

  // ---- írás ----

  it('felveszi és kiírja az eseményt', async () => {
    ev.record({ type: 'search.result.open', userId: null, visitorKey: 'v1', subjectType: 'anime', subjectId: ALANY, metadata: { position: 3 } })
    assert.equal(ev.pending(), 1)
    assert.equal(await ev.flush(), 1)

    const sor = await db.queryOne<{
      event_type: string, visitor_key: string, metadata: Record<string, unknown>, dedupe_key: string
    }>('SELECT event_type, visitor_key, metadata, dedupe_key FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sor?.event_type, 'search.result.open')
    assert.equal(sor?.visitor_key, 'v1')
    assert.equal(sor?.metadata.position, 3)
    assert.match(String(sor?.dedupe_key), /^[0-9a-f]{32}$/)
  })

  /*
   * A DEDUPLIKÁCIÓT AZ ADATBÁZIS DÖNTI EL, nem egy előzetes lekérdezés. Két
   * egyidejű kérés a „megnézem, van-e már" mintával MINDKETTŐNEK azt mondaná,
   * hogy nincs — és két sor jönne létre.
   */
  it('ugyanaz az esemény ugyanabban az ablakban egyszer kerül be', async () => {
    const at = new Date()
    const e = { type: 'anime.open' as const, visitorKey: 'v2', subjectType: 'anime', subjectId: ALANY, at }
    ev.record(e)
    ev.record(e)
    await ev.flush()
    // Külön kötegben is — vagyis két PÉLDÁNY között is véd.
    ev.record(e)
    await ev.flush()

    const sorok = await db.query('SELECT 1 FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sorok.length, 1, `${sorok.length} sor jött létre egy eseményből`)
  })

  it('a bejelentkezett felhasználónál NEM tárol látogatói kulcsot', async () => {
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')
    if (!rows[0]) return // üres adatbázison nincs mit mérni
    ev.record({ type: 'favorite.add', userId: rows[0].id, visitorKey: 'ezt-el-kell-dobni', subjectId: ALANY })
    await ev.flush()
    const sor = await db.queryOne<{ user_id: string, visitor_key: string | null }>(
      'SELECT user_id, visitor_key FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sor?.user_id, rows[0].id)
    assert.equal(sor?.visitor_key, null, 'a bejelentkezett felhasználóhoz látogatói kulcsot is tárolt')
  })

  it('a puffer a kiírás előtt ürül', async () => {
    ev.record({ type: 'anime.open', visitorKey: 'v3', subjectId: ALANY })
    await ev.flush()
    assert.equal(ev.pending(), 0)
    assert.equal(await ev.flush(), 0, 'másodszor is kiírt valamit')
  })
})

describe('a keresés → megnyitás', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>

  before(async () => {
    ev = await import('../src/modules/analytics/events.ts')
    db = await import('../src/infrastructure/database/index.ts')
    const { buildApp } = await import('../src/app.ts')
    app = await buildApp()
    await app.ready()
  })

  after(async () => {
    ev.reset()
    await db.query('DELETE FROM analytics_events WHERE subject_id = $1', [ALANY])
    await app?.close()
  })

  /*
   * A KLIENS CSAK AZT MONDHATJA MEG, MI TÖRTÉNT. Hogy ki ő és mikor volt, azt
   * a kiszolgáló írja — egy kliens által küldött időbélyeg vagy azonosító
   * ingyen hamisítható.
   */
  it('a kliens által küldött azonosító és időbélyeg HATÁSTALAN', async () => {
    /*
     * A SÉMA NÉMÁN LEDOBJA az ismeretlen mezőket (`additionalProperties:
     * false` + Fastify alapértelmezett ajv-beállítása), nem 400-at ad — és
     * ez a helyes viselkedés egy beacon-végponton. Először 400-at vártam, és
     * a teszt tévedett, nem a kód.
     *
     * AMI SZÁMÍT, AZ A HATÁS: a kliens nem írhatja felül, hogy KI ő és MIKOR
     * volt. Ezt mérjük, nem a státuszkódot.
     */
    const elotte = Date.now()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/event',
      payload: { type: 'anime.open', subjectId: ALANY, userId: 'valaki-mas', at: '2020-01-01T00:00:00Z' }
    })
    assert.equal(res.statusCode, 204)
    await ev.flush()

    const sor = await db.queryOne<{ user_id: string | null, created_at: Date }>(
      'SELECT user_id, created_at FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sor?.user_id, null, 'a kliens által küldött felhasználó bekerült')
    assert.ok(new Date(String(sor?.created_at)).getTime() >= elotte - 1000,
      'a kliens által küldött időbélyeg bekerült')

    await db.query('DELETE FROM analytics_events WHERE subject_id = $1', [ALANY])
  })

  it('ismeretlen típust elutasít', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/analytics/event', payload: { type: 'barmi.mas', subjectId: ALANY }
    })
    assert.equal(res.statusCode, 400)
  })

  it('érvényes eseményre 204, és tényleg rögzíti', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/event',
      payload: { type: 'search.result.open', subjectType: 'anime', subjectId: ALANY, position: 2 }
    })
    assert.equal(res.statusCode, 204)
    await ev.flush()
    const sor = await db.queryOne<{ event_type: string, metadata: Record<string, unknown> }>(
      'SELECT event_type, metadata FROM analytics_events WHERE subject_id = $1', [ALANY])
    assert.equal(sor?.event_type, 'search.result.open')
    assert.equal(sor?.metadata.position, 2)
  })
})
