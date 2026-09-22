// ÚJ EPIZÓD BEJELENTÉSE — egy epizód, egy üzenet, soha nem kétszer.
//
// A KÉSZLET LEGFONTOSABB ÁLLÍTÁSA A DEDUPLIKÁCIÓ. Egy epizód kétszeri
// bejelentése a csatornában két egyforma üzenetet jelent — és ez pontosan
// az a hiba, ami egy újraindítás vagy két párhuzamos worker mellett
// magától előáll, ha a foglalás nem az adatbázis kulcsában van.

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-episode-secret-long-enough-0123456789'
process.env.DISCORD_BOT_TOKEN ??= 'teszt-bot-token-nem-valodi'

let feed: typeof import('../src/modules/discord/episode-feed.ts')
let db: typeof import('../src/infrastructure/database/index.ts')

const GUILD = '500000000000000' + Math.floor(Math.random() * 900 + 100)
const CSATORNA = '600000000000000999'

let kuldott: Array<Record<string, unknown>> = []
let hibazzon = false

function hamisDiscord (): void {
  kuldott = []
  mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string, body?: string }) => {
    const path = new URL(String(url)).pathname.replace('/api/v10', '')
    if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/messages')) {
      if (hibazzon) return { ok: false, status: 403, json: async () => ({ code: 50013, message: 'Missing Permissions' }) }
      kuldott.push(JSON.parse(init!.body!) as Record<string, unknown>)
      return { ok: true, status: 200, json: async () => ({ id: '700000000000000' + kuldott.length }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

describe('az epizódbejelentés', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let animeId = ''
  let epizodId = ''

  before(async () => {
    feed = await import('../src/modules/discord/episode-feed.ts')
    db = await import('../src/infrastructure/database/index.ts')

    // Egy VALÓDI cím a katalógusból, aminek van borítója és leírása — így a
    // teszt azt méri, amit élesben is látni fogunk.
    const a = await db.queryOne<{ id: string }>(
      `SELECT a.id FROM anime a
        WHERE a.visibility = 'public' AND a.synopsis IS NOT NULL
          AND EXISTS (SELECT 1 FROM anime_images i WHERE i.anime_id = a.id AND i.kind = 'cover')
          AND EXISTS (SELECT 1 FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'native')
        LIMIT 1`)
    animeId = a?.id ?? ''
  })

  beforeEach(async () => {
    mock.restoreAll()
    hibazzon = false
    hamisDiscord()
    await db.query('DELETE FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    await db.query(
      `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id, created_by_yume)
       VALUES ($1, 'channel', 'channel:uj-epizodok', $2, true)`, [GUILD, CSATORNA])

    if (animeId && epizodId) await db.query('DELETE FROM episodes WHERE id = $1', [epizodId])
    if (animeId) {
      const e = await db.queryOne<{ id: string }>(
        `INSERT INTO episodes (anime_id, number, title, synopsis, visibility, duration, created_at)
         VALUES ($1, 9991, 'Próba epizód', 'Ebben a részben történik valami.', 'public', 24, now())
         RETURNING id`, [animeId])
      epizodId = e?.id ?? ''
    }
  })

  after(async () => {
    mock.restoreAll()
    await db.query('DELETE FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    if (epizodId) await db.query('DELETE FROM episodes WHERE id = $1', [epizodId])
  })

  it('csatorna nélkül nem küld, és megmondja miért', async () => {
    await db.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    const e = await feed.announceNew(GUILD)
    assert.equal(e.sent, 0)
    assert.match(String(e.reason), /setupot/)
    assert.equal(kuldott.length, 0)
  })

  it('kiküldi az új epizódot', async () => {
    if (!epizodId) return
    const e = await feed.announceNew(GUILD)
    assert.equal(e.sent, 1, JSON.stringify(e))
    assert.equal(kuldott.length, 1)
  })

  /*
   * EGY EPIZÓD, EGY ÜZENET. A foglalás az adatbázis kulcsában van, nem egy
   * előzetes lekérdezésben — így két egyidejű kör sem tud kétszer szólni.
   */
  it('MÁSODSZOR nem jelenti be ugyanazt', async () => {
    if (!epizodId) return
    await feed.announceNew(GUILD)
    const masodik = await feed.announceNew(GUILD)
    assert.equal(masodik.sent, 0, 'kétszer jelentette be')
    assert.equal(kuldott.length, 1)
  })

  it('két egyidejű kör közül csak az egyik küld', async () => {
    if (!epizodId) return
    const [a, b] = await Promise.all([feed.announceNew(GUILD), feed.announceNew(GUILD)])
    assert.equal(a.sent + b.sent, 1, `mindkettő küldött: ${a.sent} + ${b.sent}`)
    assert.equal(kuldott.length, 1)
  })

  /*
   * A FOGLALÁS A KÜLDÉS ELŐTT. Egy elhasalt küldés után az epizód NEM megy
   * ki másodszor — különben a csatornában két egyforma bejelentés állna.
   */
  it('elhasalt küldés után sem küldi ki újra', async () => {
    if (!epizodId) return
    hibazzon = true
    const elso = await feed.announceNew(GUILD)
    assert.equal(elso.failed, 1)

    hibazzon = false
    const masodik = await feed.announceNew(GUILD)
    assert.equal(masodik.sent, 0, 'a hibás bejelentést újraküldte')

    const sor = await db.queryOne<{ error: string | null }>(
      'SELECT error FROM discord_episode_announcements WHERE guild_id = $1 AND episode_id = $2',
      [GUILD, epizodId])
    assert.ok(sor?.error, 'a hiba nem került a naplóba')
  })

  // ---- az embed tartalma ----

  it('a teljes adatlapot tartalmazza', async () => {
    if (!epizodId) return
    const p = await feed.preview(epizodId) as {
      embeds: Array<Record<string, any>>, components: unknown[]
    }
    const e = p.embeds[0]!

    assert.match(String(e.title), /Próba epizód/, 'nincs benne az epizód címe')
    // A JAPÁN CÍM — ezt kérte a kiírás külön.
    assert.ok(String(e.description).length > 0, 'nincs leírás')
    assert.ok(e.thumbnail?.url, 'nincs borítókép')
    assert.ok(e.fields.some((f: any) => f.name.includes('Epizód') && f.value.includes('9991')),
      'nincs benne az epizódszám')
    assert.ok(e.fields.some((f: any) => f.name.includes('Erről a részről')),
      'nincs benne az epizód leírása')
    assert.ok(Array.isArray(p.components) && p.components.length > 0, 'nincsenek gombok')
  })

  it('a japán cím megjelenik, ha van', async () => {
    if (!epizodId) return
    const native = await db.queryOne<{ title: string }>(
      "SELECT title FROM anime_titles WHERE anime_id = $1 AND kind = 'native'", [animeId])
    if (!native) return
    const p = await feed.preview(epizodId) as { embeds: Array<Record<string, any>> }
    assert.ok(String(p.embeds[0]!.description).includes(native.title),
      'a japán cím nincs az embedben')
  })

  /*
   * A HIÁNYZÓ MEZŐ KIMARAD, nem üresen jelenik meg. Egy frissen importált
   * címnél lehet, hogy nincs leírás vagy borító — attól még az epizód
   * bejelenthető.
   */
  it('hiányzó adatnál sem hasal el', async () => {
    const ures = await db.queryOne<{ id: string }>(
      `SELECT a.id FROM anime a
        WHERE a.visibility = 'public' AND a.synopsis IS NULL
          AND NOT EXISTS (SELECT 1 FROM anime_images i WHERE i.anime_id = a.id)
        LIMIT 1`)
    if (!ures) return
    const ep = await db.queryOne<{ id: string }>(
      `INSERT INTO episodes (anime_id, number, visibility, created_at)
       VALUES ($1, 9992, 'public', now()) RETURNING id`, [ures.id])
    try {
      const p = await feed.preview(ep!.id) as { embeds: Array<Record<string, any>> }
      assert.ok(p.embeds[0]!.title, 'nincs cím')
      assert.equal(p.embeds[0]!.thumbnail, undefined, 'üres borítót tett bele')
    } finally {
      await db.query('DELETE FROM episodes WHERE id = $1', [ep!.id])
    }
  })

  it('az előnézet NEM küld', async () => {
    if (!epizodId) return
    await feed.preview(epizodId)
    assert.equal(kuldott.length, 0, 'az előnézet üzenetet küldött')
  })
})
