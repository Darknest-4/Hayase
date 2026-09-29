// A LISTÁK ANIMEKÁRTYÁI — a „legfrissebb" és a „következő" sorrendtől függő
// kimenetek: /anime latest, /anime schedule, a tartós üzenetek (új részek,
// menetrend, népszerű), az epizód-bejelentés felnőtt-szűrője, és az előzetes
// kapcsolója.
//
// MIÉRT KÜLÖN, EGYEDÜL. Ezek a kimenetek az EGÉSZ katalógus legújabb
// részeit és legközelebbi adásait mutatják. A próbacímnek ehhez a legfrissebbnek
// kell lennie — `npm test` párhuzamos futásában egy másik készlet épp akkor
// szúrhat be újabbat (és a hírfolyam-teszt „egy rész ment ki" állítását a mi
// friss részeink borítanák). A `feature.trailers` átkapcsolása is az egész
// adatbázisé. Ezért: `npm run test:exclusive` (CI-ban külön lépés).

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-anime-lists-secret-long-enough-0123456789'
process.env.DISCORD_BOT_TOKEN ??= 'teszt-bot-token-nem-valodi'

let commands: typeof import('../src/modules/discord/commands.ts')
let feed: typeof import('../src/modules/discord/episode-feed.ts')
let render: typeof import('../src/modules/discord/render.ts')
let card: typeof import('../src/modules/discord/anime-card.ts')
let flags: typeof import('../src/modules/settings/feature-flags.ts')['flags']
let db: typeof import('../src/infrastructure/database/index.ts')

const jel = randomBytes(4).toString('hex')
const CIM = `Listateszt ${jel}`
const CIM_FELNOTT = `Listateszt Felnőtt ${jel}`
const TUKOR = `media/cover/cc/listateszt-${jel}.jpg`
const GUILD = '500000000000001' + String(Math.floor(Math.random() * 900 + 100))
const CSATORNA = '600000000000001999'

let anime = ''
let felnott = ''
let reszek: string[] = []
let felnottReszek: string[] = []
let eredetiElozetes: { enabled: boolean, access: string } | null = null

type Embed = { title?: string, description?: string, thumbnail?: { url: string } }
type Valasz = { data: { content?: string, embeds?: Embed[], components?: Array<{ components: Array<{ label?: string }> }> } }

function interakcio (extra: Record<string, unknown>): never {
  return {
    id: '500000000000000022', token: 'lista-token', applicationId: '500000000000000023', type: 2,
    guildId: GUILD, channelId: '600000000000000022', userId: '700000000000000222', username: 'lista',
    permissions: '0', memberRoles: [], command: 'anime', sub: null, options: {}, focused: null,
    customId: null, locale: null, guildLocale: null, ...extra
  } as never
}

async function parancs (extra: Record<string, unknown>): Promise<Valasz> {
  commands.resetCooldowns()
  const e = await commands.handle(interakcio(extra))
  assert.equal(e.outcome, 'ok', JSON.stringify(e.response))
  return e.response as Valasz
}

const borito = new RegExp(`/${TUKOR.replace(/[.]/g, '\\.')}$`)

describe('a listák animekártyái', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  before(async () => {
    commands = await import('../src/modules/discord/commands.ts')
    feed = await import('../src/modules/discord/episode-feed.ts')
    render = await import('../src/modules/discord/render.ts')
    card = await import('../src/modules/discord/anime-card.ts')
    flags = (await import('../src/modules/settings/feature-flags.ts')).flags
    db = await import('../src/infrastructure/database/index.ts')

    const uj = async (cim: string, felnottE: boolean, perc: number): Promise<string> =>
      (await db.queryOne<{ id: string }>(
        `INSERT INTO anime (canonical_title, format, status, season, season_year, episode_count, synopsis,
                            average_score, next_airing_at, next_airing_ep, is_adult, visibility)
         VALUES ($1, 'TV', 'RELEASING', 'FALL', 2026, 12, 'Lista leírás.', 77, now() + ($3::int * interval '1 minute'),
                 3, $2, 'public') RETURNING id`, [cim, felnottE, perc]))!.id
    // A felnőtt cím adása KORÁBBAN van: ha a szűrő nem működne, ő állna elöl.
    anime = await uj(CIM, false, 30)
    felnott = await uj(CIM_FELNOTT, true, 20)
    await db.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, mirror_key, is_primary) VALUES
         ($1, 'cover', 'https://s4.anilist.co/file/lt.jpg', $2, true),
         ($3, 'cover', 'https://s4.anilist.co/file/ltf.jpg', 'media/cover/dd/ltf.jpg', true)`, [anime, TUKOR, felnott])
    await db.query(
      "INSERT INTO anime_videos (anime_id, kind, provider, ref) VALUES ($1, 'trailer', 'youtube', 'eimOB2r6kuw')", [anime])

    // A részek MOST kerülnek be — a felnőtté a legutolsó pillanatban, hogy a
    // legfrissebb legyen, ha a szűrő nem működne.
    const resz = async (a: string, n: number, mp: number): Promise<string> =>
      (await db.queryOne<{ id: string }>(
        `INSERT INTO episodes (anime_id, number, visibility, created_at)
         VALUES ($1, $2, 'public', now() + ($3::int * interval '1 second')) RETURNING id`, [a, n, mp]))!.id
    reszek = [await resz(anime, 1, 1), await resz(anime, 2, 1)]
    felnottReszek = [await resz(felnott, 1, 2)]

    const f = await db.queryOne<{ enabled: boolean, access: string }>(
      "SELECT enabled, access FROM feature_flags WHERE key = 'feature.trailers'")
    eredetiElozetes = f ?? null
    assert.ok(eredetiElozetes, 'a feature.trailers kapcsoló hiányzik — a 0011-es migráció teszi be')
  })

  after(async () => {
    mock.restoreAll()
    if (eredetiElozetes) {
      await db?.query("UPDATE feature_flags SET enabled = $1, access = $2 WHERE key = 'feature.trailers'",
        [eredetiElozetes.enabled, eredetiElozetes.access])
    }
    flags?.invalidate()
    await db?.query('DELETE FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])
    await db?.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
    await db?.query('DELETE FROM anime_stats_daily WHERE anime_id = ANY($1::uuid[])', [[anime, felnott].filter(Boolean)])
    await db?.query('DELETE FROM anime WHERE id = ANY($1::uuid[])', [[anime, felnott].filter(Boolean)])
  })

  it('az /anime latest címenként a legújabb részt adja, borítóval — felnőtt cím nélkül', async () => {
    const v = await parancs({ sub: 'latest' })
    assert.match(String(v.data.content), /Legfrissebb epizódok/)
    const cimek = (v.data.embeds ?? []).map(e => String(e.title))
    assert.equal(cimek[0], `${CIM} — 2. rész`, cimek.join(' | '))
    assert.equal(cimek.filter(c => c.startsWith(CIM + ' ')).length, 1, 'ugyanaz a cím kétszer')
    assert.ok(!cimek.some(c => c.includes(CIM_FELNOTT)), 'felnőtt cím a listában')
    assert.match(String(v.data.embeds![0]!.thumbnail?.url), borito)
    assert.match(String(v.data.embeds![0]!.description), /🆕 <t:\d+:R>/)
  })

  it('az /anime schedule a következő adásokat adja időponttal és borítóval — felnőtt cím nélkül', async () => {
    const v = await parancs({ sub: 'schedule' })
    const cimek = (v.data.embeds ?? []).map(e => String(e.title))
    assert.equal(cimek[0], CIM, cimek.join(' | '))
    assert.ok(!cimek.includes(CIM_FELNOTT))
    assert.match(String(v.data.embeds![0]!.description), /^⏭️ \*\*3\. rész\*\* · <t:\d+:F> \(<t:\d+:R>\)/)
    assert.match(String(v.data.embeds![0]!.thumbnail?.url), borito)
  })

  it('a tartós üzenetek borítót és tényeket kapnak, felnőtt cím nélkül — és az ujjlenyomat stabil marad', async () => {
    const ctx = { guildId: GUILD, configuration: {} }
    const uj = await render.renderMessage('latest_releases', ctx) as { embeds: Embed[] }
    const d = String(uj.embeds[0]!.description)
    assert.ok(d.startsWith(`**${CIM}**\n\`2. rész\``), d.slice(0, 200))
    assert.ok(d.includes('📺 TV · 🗓️ Ősz 2026 · 🎬 2 / 12 elérhető · ⭐ 77%'), d.slice(0, 400))
    assert.ok(!d.includes(CIM_FELNOTT))
    assert.match(String(uj.embeds[0]!.thumbnail?.url), borito)

    const menet = await render.renderMessage('anime_schedule', ctx) as { embeds: Array<Embed & { fields: Array<{ value: string }> }> }
    assert.match(String(menet.embeds[0]!.thumbnail?.url), borito)
    assert.ok(!JSON.stringify(menet).includes(CIM_FELNOTT))

    await db.query(
      `INSERT INTO anime_stats_daily (day, anime_id, views, unique_viewers)
       VALUES (current_date, $1, 1000000000, 5), (current_date, $2, 1000000001, 5)`, [anime, felnott])
    const nep = await render.renderMessage('popular_anime', ctx) as { embeds: Embed[] }
    const np = String(nep.embeds[0]!.description)
    assert.ok(np.startsWith(`🥇 **${CIM}**`), np.slice(0, 200))
    assert.ok(np.split('\n')[1]!.endsWith('📺 TV · ⭐ 77%'), np.split('\n')[1])
    assert.ok(!np.includes(CIM_FELNOTT))
    assert.match(String(nep.embeds[0]!.thumbnail?.url), borito)

    const pm = await import('../src/modules/discord/persistent-messages.ts')
    for (const tipus of ['latest_releases', 'anime_schedule', 'popular_anime']) {
      assert.equal(pm.contentHash(await render.renderMessage(tipus, ctx)), pm.contentHash(await render.renderMessage(tipus, ctx)),
        `${tipus}: a kártyák mozgatják az ujjlenyomatot`)
    }
  })

  it('felnőtt cím része nem megy ki a csatornába — a borítója sem', async () => {
    await db.query(
      `INSERT INTO discord_registry (guild_id, object_type, logical_key, discord_object_id, created_by_yume)
       VALUES ($1, 'channel', 'channel:uj-epizodok', $2, true)`, [GUILD, CSATORNA])
    const kuldott: Array<Record<string, unknown>> = []
    mock.method(globalThis, 'fetch', async (url: string, init?: { method?: string, body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST' && new URL(String(url)).pathname.endsWith('/messages')) {
        kuldott.push(JSON.parse(init!.body!) as Record<string, unknown>)
        return { ok: true, status: 200, json: async () => ({ id: '800000000000000' + kuldott.length }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    // Addig körözünk, amíg van mit küldeni (egy kör legföljebb öt részt visz).
    for (let i = 0; i < 40; i++) {
      const e = await feed.announceNew(GUILD)
      if (e.sent + e.failed + e.skipped === 0) break
    }
    mock.restoreAll()
    const bejelentve = new Set((await db.query<{ episode_id: string }>(
      'SELECT episode_id FROM discord_episode_announcements WHERE guild_id = $1', [GUILD])).map(r => r.episode_id))
    assert.ok(reszek.every(r => bejelentve.has(r)), 'a próbacím részei nem mentek ki')
    assert.ok(!felnottReszek.some(r => bejelentve.has(r)), 'felnőtt cím része kiment a csatornába')
    assert.ok(!JSON.stringify(kuldott).includes(CIM_FELNOTT))
  })

  it('az előzetes gombja csak akkor van, ha az oldalon is mindenkinek látszik', async () => {
    const gombok = async (): Promise<Array<string | undefined>> =>
      (await parancs({ sub: 'info', options: { cim: anime } })).data.components![0]!.components.map(c => c.label)

    await db.query("UPDATE feature_flags SET enabled = true, access = 'public' WHERE key = 'feature.trailers'")
    flags.invalidate()
    assert.ok((await gombok()).includes('Előzetes'))
    assert.equal((await card.animeCard(anime))?.elozetes, 'eimOB2r6kuw')

    await db.query("UPDATE feature_flags SET enabled = false WHERE key = 'feature.trailers'")
    flags.invalidate()
    assert.ok(!(await gombok()).includes('Előzetes'), 'kikapcsolt előzetes gombja kiment')
    assert.equal((await card.animeCard(anime))?.elozetes, null)

    // Csak bejelentkezve látszó előzetes sem nyilvános — a Discordon mindenki látná.
    await db.query("UPDATE feature_flags SET enabled = true, access = 'auth' WHERE key = 'feature.trailers'")
    flags.invalidate()
    assert.equal((await card.animeCard(anime))?.elozetes, null)
  })
})
