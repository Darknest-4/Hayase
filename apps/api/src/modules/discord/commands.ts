/**
 * SLASH PARANCSOK — leírás, jogosultság, végrehajtás.
 *
 * A PARANCSOK A GATEWAYEN ÉRKEZNEK, nem HTTP-n. A Discord kétféleképpen
 * tudja kézbesíteni az interakciókat: egy nyilvános HTTP-végpontra (amit
 * Ed25519-aláírással kell hitelesíteni), vagy a már meglévő
 * WebSocket-kapcsolaton. Mivel a gateway úgyis fut, a második a helyes
 * választás: nincs új nyilvános végpont, nincs aláírás-ellenőrzés, és nincs
 * egy újabb támadási felület.
 *
 * DE CSAK AKKOR, HA A FEJLESZTŐI PORTÁLON NINCS interakció-végpont beállítva:
 * ha van, a Discord MINDEN parancsot oda küld, és a gatewayre egy sem érkezik
 * (2026-09-29-ig így volt — lásd `deliveryStatus`). A gateway induláskor
 * ellenőrzi, a vezérlőpult Parancsok nézete kiírja.
 *
 * MINDEN PARANCS VÁLASZOL, MÉG A HIBÁS IS. A Discord három másodpercig vár;
 * utána a felhasználónak azt írja ki, hogy a bot nem válaszolt — ezért a
 * lassú kezelő előbb halasztott választ ad (`respond`).
 *
 * AMI NINCS, AZT KIMONDJA. Egy parancs, ami kitalált adatot ad vissza,
 * rosszabb, mint egy parancs, ami nincs.
 *
 * A NYELV a hívó Discord-kliensének nyelve (magyar vagy angol) — lásd
 * `i18n.ts`.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { record as recordEvent } from '../analytics/events.ts'
import { saveEntry } from '../library/entries.ts'
import { resolveReport } from '../moderation/resolve.ts'
import { closedState, decidedMessage, feliratok, moderatorOf } from './moderation-feed.ts'
import { guildLanguage } from './guild-settings.ts'
import * as rest from './rest-client.ts'
import * as registry from './registry.ts'
import * as welcome from './welcome.ts'
import { allapot as gatewayAllapot, elo as gatewayElo } from './gateway.ts'
import { PERMISSION_BITS, can, parsePermissions } from './permissions.ts'
import { idopont, nyelvBol, szovegek, type Nyelv } from './i18n.ts'
import { DASHBOARD_URL, YUME_URL } from './embed-kit.ts'
import {
  allapotSzoveg, animeCard, animeCards, animeEmbed, animeGombok, animeKompakt, cimkek, epizodErtek,
  episodeWithAnime, gombSor, ido, kartyaSzin, kovetkezoSzoveg, leirasDiscordra, md, mufajSzoveg, nezesUrl,
  szam, tisztaSzoveg, vag, type AnimeCard, type EpizodAdat
} from './anime-card.ts'

const SZIN = 0xE4_1E_63
const YUME = YUME_URL
const DASHBOARD = DASHBOARD_URL
const FIOK = `${YUME}/#/settings?tab=account`

/** Discord interakció-típusok, amiket kezelünk. */
export const INTERACTION = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const
/**
 * Válasz-típusok. A `DEFERRED` = „a bot gondolkodik…" — lásd `respond`; az
 * `UPDATE_MESSAGE` egy gombnyomásra az eredeti üzenetet írja át, az
 * `AUTOCOMPLETE_RESULT` a címkiegészítés javaslatai, a `MODAL` egy
 * beviteli ablak (a moderálás indoklása).
 */
export const RESPONSE = {
  PONG: 1, MESSAGE: 4, DEFERRED: 5, DEFERRED_UPDATE: 6, UPDATE_MESSAGE: 7, AUTOCOMPLETE_RESULT: 8, MODAL: 9
} as const
/** Csak a hívó látja. */
export const EPHEMERAL = 64

/** Angol leírás mindkét angol Discord-nyelvre. */
const en = (description: string): { description_localizations: Record<string, string> } =>
  ({ description_localizations: { 'en-US': description, 'en-GB': description } })

/** A címkiegészítéses címmező — az `/anime search|info` és a `/watchlist add` közös. */
const CIM = (leiras: string, angol: string): Record<string, unknown> =>
  ({ type: 3, name: 'cim', description: leiras, ...en(angol), required: true, autocomplete: true })

/**
 * A PARANCSOK LEÍRÁSA — ez megy fel a Discordra.
 *
 * Az `default_member_permissions` a Discord SAJÁT szűrője: a parancs meg sem
 * jelenik annak, akinek nincs meg a jog. Ez kényelem, NEM védelem — a
 * jogosultságot a kezelő is ellenőrzi, mert egy kliensoldali szűrő
 * megkerülhető.
 */
export const DEFINITIONS = [
  { name: 'help', description: 'Mit tud ez a bot?', ...en('What can this bot do?') },
  { name: 'status', description: 'A YUME és a bot állapota', ...en('The state of YUME and the bot') },
  { name: 'stats', description: 'A YUME számokban', ...en('YUME in numbers') },
  {
    name: 'anime',
    description: 'Animék a YUME katalógusából',
    ...en('Anime from the YUME catalogue'),
    options: [
      {
        type: 1, name: 'search', description: 'Keresés cím szerint', ...en('Search by title'),
        options: [CIM('Amit keresel', 'What you are looking for')]
      },
      {
        type: 1, name: 'info', description: 'Egy cím adatai', ...en('One title\'s details'),
        options: [CIM('A cím neve', 'The title')]
      },
      { type: 1, name: 'latest', description: 'A legfrissebb epizódok', ...en('The latest episodes') },
      { type: 1, name: 'schedule', description: 'A következő adások', ...en('Upcoming airings') },
      { type: 1, name: 'random', description: 'Egy véletlen cím', ...en('A random title') }
    ]
  },
  { name: 'next', description: 'A következő rész, amit nézni fogsz', ...en('The next episode you are going to watch') },
  { name: 'profile', description: 'A YUME-fiókod állapota', ...en('Your YUME account') },
  { name: 'link', description: 'A Discord-fiók összekötése a YUME-fiókkal', ...en('Link your Discord and YUME accounts') },
  { name: 'unlink', description: 'Az összekötés bontása', ...en('Unlink the accounts') },
  {
    name: 'watchlist',
    description: 'A könyvtárad',
    ...en('Your library'),
    options: [
      { type: 1, name: 'list', description: 'A könyvtárad legutóbbi címei', ...en('The latest titles in your library') },
      {
        type: 1, name: 'add', description: 'Cím hozzáadása a könyvtáradhoz', ...en('Add a title to your library'),
        options: [CIM('Melyik cím', 'Which title')]
      }
    ]
  },
  {
    name: 'notifications',
    description: 'Az értesítési rang be- és kikapcsolása',
    ...en('Turn the notification role on or off')
  },
  {
    name: 'setup',
    description: 'A YUME szerverstruktúra állapota',
    ...en('The state of the YUME server structure'),
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD)
  },
  {
    name: 'config',
    description: 'A bot beállításai ezen a szerveren',
    ...en('The bot\'s settings on this server'),
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD)
  },
  {
    name: 'announce',
    description: 'Bejelentés küldése egy csatornába',
    ...en('Send an announcement to a channel'),
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD),
    options: [
      { type: 7, name: 'csatorna', description: 'Hova menjen', ...en('Where it goes'), required: true },
      { type: 3, name: 'szoveg', description: 'Mit írjon', ...en('What it says'), required: true }
    ]
  },
  {
    name: 'logs',
    description: 'A legutóbbi bot-műveletek',
    ...en('The bot\'s recent operations'),
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD)
  }
] as const

/** Amelyik parancs adminjogot kér. A kezelő is ellenőrzi, nem csak a Discord. */
const ADMIN_COMMANDS = new Set(['setup', 'config', 'announce', 'logs'])

// ---------------------------------------------------------------- cooldown

/**
 * VÁRAKOZTATÁS PARANCSONKÉNT ÉS FELHASZNÁLÓNKÉNT.
 *
 * Memóriában, mert egy gateway-folyamat van, és a cooldown másodperces
 * nagyságrend — egy adatbázis-kör ennél többe kerülne, mint amennyit véd.
 * Ha egyszer több példány fut, ez a réteg megy át adatbázisba.
 */
const COOLDOWN_MS = Number(process.env.DISCORD_COMMAND_COOLDOWN_MS ?? 3000)
const utolso = new Map<string, number>()

export function cooldownLeft (userId: string, command: string, now = Date.now()): number {
  const kulcs = `${userId}|${command}`
  const elozo = utolso.get(kulcs)
  if (elozo === undefined) return 0
  const hatra = COOLDOWN_MS - (now - elozo)
  return hatra > 0 ? hatra : 0
}

export function markUsed (userId: string, command: string, now = Date.now()): void {
  utolso.set(`${userId}|${command}`, now)
  // A térkép nem nőhet korlátlanul egy nyilvános felületről.
  if (utolso.size > 5000) {
    for (const [k, t] of utolso) if (now - t > COOLDOWN_MS * 10) utolso.delete(k)
  }
}

/** Teszthez. */
export function resetCooldowns (): void { utolso.clear() }

// ---------------------------------------------------------------- válaszok

export function message (content: string, ephemeral = true): unknown {
  return {
    type: RESPONSE.MESSAGE,
    data: {
      content: content.slice(0, 1900),
      ...(ephemeral ? { flags: EPHEMERAL } : {}),
      // SOHA NEM EMLÍTÜNK SENKIT egy parancsválaszban. Egy `@everyone` egy
      // felhasználói bemenetből az egész szervert felverné.
      allowed_mentions: { parse: [] }
    }
  }
}

export function embed (mezok: Record<string, unknown>, ephemeral = true, components: unknown[] = []): unknown {
  return {
    type: RESPONSE.MESSAGE,
    data: {
      embeds: [{ color: SZIN, ...mezok }],
      ...(components.length ? { components } : {}),
      ...(ephemeral ? { flags: EPHEMERAL } : {}),
      allowed_mentions: { parse: [] }
    }
  }
}

/**
 * Több embed egy válaszban (a listák kis kártyái) — a Discord korlátja tíz
 * embed és összesen 6000 karakter; a kis kártya ennek töredéke.
 */
export function embedek (lista: Array<Record<string, unknown>>, content: string | null, ephemeral = true): unknown {
  return {
    type: RESPONSE.MESSAGE,
    data: {
      ...(content ? { content: content.slice(0, 1900) } : {}),
      embeds: lista.slice(0, 10),
      ...(ephemeral ? { flags: EPHEMERAL } : {}),
      allowed_mentions: { parse: [] }
    }
  }
}

/** Egy gombnyomásra az eredeti üzenet átírása — a gombok eltűnnek. */
function frissit (content: string): unknown {
  return {
    type: RESPONSE.UPDATE_MESSAGE,
    data: { content: content.slice(0, 1900), embeds: [], components: [], allowed_mentions: { parse: [] } }
  }
}

/** Link-gomb (a YUME oldalára). */
const linkGomb = (label: string, url: string): Record<string, unknown> => ({ type: 2, style: 5, label, url })

// ---------------------------------------------------------------- bemenet

export interface Interaction {
  id: string
  token: string
  /** A halasztott válasz kitöltéséhez kell (`editOriginalResponse`). */
  applicationId: string | null
  type: number
  guildId: string | null
  channelId: string | null
  userId: string
  username: string
  /** A hívó guild-jogosultságai, ahogy a Discord küldte. */
  permissions: string
  /** A hívó rangjai ebben a guildben (a `/notifications` kapcsolójához). */
  memberRoles: string[]
  command: string
  sub: string | null
  options: Record<string, string>
  /** Címkiegészítésnél: melyik mezőt gépeli épp. */
  focused: string | null
  /** Gombnyomásnál: a gomb azonosítója (`wl:add:<anime>`…). */
  customId: string | null
  /** A hívó Discord-kliensének nyelve (`hu`, `en-US`…). */
  locale: string | null
  guildLocale: string | null
}

/** A nyers Discord-esemény átalakítása. Ami hiányzik, az `null`, nem kitalált. */
export function parseInteraction (d: unknown): Interaction | null {
  const a = (d ?? {}) as Record<string, unknown>
  if (typeof a.id !== 'string' || typeof a.token !== 'string') return null
  const data = (a.data ?? {}) as Record<string, unknown>
  const tag = (a.member ?? {}) as Record<string, unknown>
  const user = (tag.user ?? a.user ?? {}) as Record<string, unknown>
  if (typeof user.id !== 'string') return null

  let sub: string | null = null
  let focused: string | null = null
  const options: Record<string, string> = {}
  const beolvas = (o: Record<string, unknown>): void => {
    const nev = String(o.name ?? '')
    options[nev] = String(o.value ?? '')
    if (o.focused === true) focused = nev
  }
  const nyers = Array.isArray(data.options) ? data.options as Array<Record<string, unknown>> : []
  for (const o of nyers) {
    if (o.type === 1) {
      sub = String(o.name ?? '')
      for (const p of (Array.isArray(o.options) ? o.options as Array<Record<string, unknown>> : [])) beolvas(p)
    } else {
      beolvas(o)
    }
  }
  // A BEVITELI ABLAK mezői (sorokba csomagolva): az azonosítójuk a kulcs.
  for (const sor of (Array.isArray(data.components) ? data.components as Array<Record<string, unknown>> : [])) {
    for (const m of (Array.isArray(sor.components) ? sor.components as Array<Record<string, unknown>> : [])) {
      if (typeof m.custom_id === 'string') options[m.custom_id] = String(m.value ?? '')
    }
  }

  return {
    id: a.id,
    token: a.token,
    applicationId: typeof a.application_id === 'string' ? a.application_id : null,
    type: Number(a.type ?? 0),
    guildId: typeof a.guild_id === 'string' ? a.guild_id : null,
    channelId: typeof a.channel_id === 'string' ? a.channel_id : null,
    userId: user.id,
    username: String(user.username ?? user.id),
    permissions: String(tag.permissions ?? '0'),
    memberRoles: Array.isArray(tag.roles) ? tag.roles.map(String) : [],
    command: String(data.name ?? ''),
    sub,
    options,
    focused,
    customId: typeof data.custom_id === 'string' ? data.custom_id : null,
    locale: typeof a.locale === 'string' ? a.locale : null,
    guildLocale: typeof a.guild_locale === 'string' ? a.guild_locale : null
  }
}

// ---------------------------------------------------------------- közös

type Szotar = ReturnType<typeof szovegek>

/** A hívó nyelve: a kliensé; ha nincs, magyar. */
const nyelvOf = (i: Interaction): Nyelv => nyelvBol(i.locale)

/** Az epizódszám emberi alakja: „7", nem „7.0". */
const epizodSzam = 'CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * EGY CÍM A BEÍRTBÓL: a címkiegészítés az anime AZONOSÍTÓJÁT küldi értékként
 * (pontos találat), a kézzel beírt szöveg a címre keres — a legrövidebb
 * egyező cím nyer, ahogy eddig is.
 *
 * FELNŐTT CÍM NINCS A TALÁLATOK KÖZÖTT — ahogy az oldal katalógusában sem
 * alapból (lásd `anime-card.ts`).
 */
async function animeFromInput (bemenet: string, limit = 1): Promise<Array<{ id: string, canonical_title: string }>> {
  if (UUID.test(bemenet)) {
    return await query(
      `SELECT id, canonical_title FROM anime
        WHERE id = $1 AND visibility = 'public' AND NOT is_adult`, [bemenet])
  }
  return await query(
    `SELECT id, canonical_title FROM anime
      WHERE visibility = 'public' AND NOT is_adult AND canonical_title ILIKE $1
      ORDER BY length(canonical_title), canonical_title LIMIT $2`,
    [`%${bemenet.replace(/[\\%_]/g, c => '\\' + c)}%`, limit])
}

/** Ennyi kis kártya megy ki egy listában. */
const LISTA_MAX = 5

/** A hívó YUME-fiókja (és egyetlen profilja), ha összekötötte. */
async function yumeUser (discordUserId: string): Promise<{ user_id: string, username: string, profile_id: string | null } | undefined> {
  return await queryOne<{ user_id: string, username: string, profile_id: string | null }>(
    `SELECT l.user_id, u.username,
            (SELECT p.id FROM user_profiles p WHERE p.user_id = l.user_id ORDER BY p.is_default DESC, p.created_at LIMIT 1) AS profile_id
       FROM discord_links l
       JOIN users u ON u.id = l.user_id WHERE l.discord_user_id = $1`, [discordUserId])
}

const nincsFiok = (sz: Szotar): unknown => message(`${sz.nincsKotve}\n${sz.kosdOssze(FIOK)}`)

// ---------------------------------------------------------------- kezelők

async function help (sz: Szotar): Promise<unknown> {
  return embed({ title: sz.helpCim, description: sz.helpSorok.join('\n'), url: YUME })
}

async function status (sz: Szotar): Promise<unknown> {
  const [szolgaltatasok, gw] = await Promise.all([
    query<{ service: string, status: string }>(
      "SELECT service, status FROM service_status WHERE status <> 'not_configured' ORDER BY service"),
    gatewayAllapot()
  ])
  const jel = (s: string): string => s === 'green' ? '✅' : s === 'unknown' ? '❔' : '⚠️'
  return embed({
    title: sz.allapotCim,
    description: szolgaltatasok.map(s => `${jel(s.status)} ${s.service}`).join('\n') || sz.nincsAllapot,
    fields: [
      { name: 'Gateway', value: gatewayElo(gw) ? sz.fut : sz.nemFut, inline: true },
      { name: sz.ujracsatlakozas, value: String(gw?.reconnects ?? '—'), inline: true }
    ]
  })
}

async function stats (sz: Szotar): Promise<unknown> {
  const [katalogus, ma] = await Promise.all([
    queryOne<{ anime: number, episodes: number, users: number }>(
      `SELECT (SELECT count(*) FROM anime WHERE visibility = 'public')::int AS anime,
              (SELECT count(*) FROM episodes WHERE visibility = 'public')::int AS episodes,
              (SELECT count(*) FROM users)::int AS users`),
    queryOne<{ sessions: number, page_views: number }>(
      'SELECT sessions, page_views FROM analytics_daily WHERE day = current_date')
  ])
  const ertek = (v: number | null | undefined): string => v === null || v === undefined ? '—' : String(v)
  return embed({
    title: sz.statCim,
    url: YUME,
    fields: [
      { name: sz.animek, value: ertek(katalogus?.anime), inline: true },
      { name: sz.epizodok, value: ertek(katalogus?.episodes), inline: true },
      { name: sz.felhasznalok, value: ertek(katalogus?.users), inline: true },
      { name: sz.munkamenetMa, value: ertek(ma?.sessions), inline: true },
      { name: sz.oldalletoltesMa, value: ertek(ma?.page_views), inline: true }
    ],
    footer: { text: sz.statLablec }
  })
}

async function animeCommand (i: Interaction, sz: Szotar): Promise<unknown> {
  const nyelv = nyelvOf(i)

  if (i.sub === 'search' || i.sub === 'info') {
    const keresett = (i.options.cim ?? '').trim()
    if (keresett.length < 2) return message(sz.ketKarakter)

    const talalatok = await animeFromInput(keresett, i.sub === 'info' ? 1 : LISTA_MAX + 1)
    if (!talalatok.length) return message(sz.nincsTalalat(md(keresett)))

    /*
     * A KERESÉS kis kártyákat ad (borító, egy sor tény, két sor leírás); ha
     * több a találat, mint amennyi kifér, kimondja — a pontos cím a
     * felugró javaslatokból választható.
     */
    if (i.sub === 'search') {
      const kartyak = await animeCards(talalatok.slice(0, LISTA_MAX).map(t => t.id))
      if (!kartyak.length) return message(sz.nincsTalalat(md(keresett)))
      return embedek(kartyak.map(k => animeKompakt(k, nyelv)),
        sz.talalatokFej(md(keresett), kartyak.length, talalatok.length > LISTA_MAX))
    }

    // AZ ADATLAP: borító, banner, leírás, minden adat, ami van — és gombok.
    const k = await animeCard(talalatok[0]!.id)
    if (!k) return message(sz.nincsTalalat(md(keresett)))
    return embed(animeEmbed(k, nyelv, { banner: true }), true, [gombSor(animeGombok(k, nyelv))])
  }

  /*
   * A LEGFRISSEBB RÉSZEK — CÍMENKÉNT EGY. Egy tömeges import egy cím tizenkét
   * részét hozza be egyszerre; a lista eddig ilyenkor ugyanannak a címnek a
   * részeiből állt. Most címenként a legújabb rész szerepel.
   */
  if (i.sub === 'latest') {
    const sorok = await query<{ id: string, anime_id: string, number: string, ep_cim: string | null, created_at: Date }>(
      `WITH friss AS (
         SELECT e.id, e.anime_id, e.number AS num, ${epizodSzam} AS number, e.title AS ep_cim, e.created_at
           FROM episodes e JOIN anime a ON a.id = e.anime_id
          WHERE e.visibility = 'public' AND a.visibility = 'public' AND NOT a.is_adult
          ORDER BY e.created_at DESC, e.id DESC LIMIT 60
       ), cimenkent AS (
         SELECT DISTINCT ON (anime_id) id, anime_id, number, ep_cim, created_at
           FROM friss ORDER BY anime_id, created_at DESC, num DESC
       )
       SELECT id, anime_id, number, ep_cim, created_at FROM cimenkent
        ORDER BY created_at DESC, id DESC LIMIT $1`, [LISTA_MAX])
    if (!sorok.length) return message(sz.nincsEpizod)
    const kartyak = new Map((await animeCards(sorok.map(r => r.anime_id))).map(k => [k.id, k]))
    const lista = sorok.flatMap(r => {
      const k = kartyak.get(r.anime_id)
      if (!k) return []
      return [animeKompakt(k, nyelv, {
        cim: `${k.cim} — ${sz.resz(r.number)}${r.ep_cim ? `: ${r.ep_cim}` : ''}`,
        url: nezesUrl(r.id),
        sorok: [`🆕 ${ido(r.created_at, 'R')}`],
        leirasHossz: 140
      })]
    })
    return embedek(lista, `🆕 **${sz.legfrissebb}**`)
  }

  if (i.sub === 'schedule') {
    const sorok = await query<{ id: string }>(
      `SELECT id FROM anime
        WHERE visibility = 'public' AND NOT is_adult AND next_airing_at > now()
        ORDER BY next_airing_at, canonical_title LIMIT $1`, [LISTA_MAX])
    if (!sorok.length) return message(sz.nincsAdasido)
    const kartyak = await animeCards(sorok.map(r => r.id))
    return embedek(kartyak.map(k => {
      // <t:…> — a Discord a néző saját időzónájában és nyelvén írja ki.
      const mikor = kovetkezoSzoveg(k, nyelv)
      return animeKompakt(k, nyelv, { sorok: [mikor ? `⏭️ ${mikor}` : null], leirasHossz: 140 })
    }), `📅 **${sz.kovetkezok}** — ${sz.idozonadban}`)
  }

  if (i.sub === 'random') {
    /*
     * A VÉLETLEN SOR EGY HARMINCEZRES TÁBLÁN nem `ORDER BY random()` — az
     * végigolvasná az egészet. Egy véletlen eltolás a `created_at` szerinti
     * sorrendben ugyanolyan jó, és indexet használ.
     */
    const osszes = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM anime WHERE visibility = 'public' AND NOT is_adult")
    const n = osszes?.n ?? 0
    if (n === 0) return message(sz.uresKatalogus)
    const sor = await queryOne<{ id: string }>(
      `SELECT id FROM anime WHERE visibility = 'public' AND NOT is_adult
        ORDER BY created_at, id OFFSET $1 LIMIT 1`, [Math.floor(Math.random() * n)])
    const k = sor ? await animeCard(sor.id) : undefined
    if (!k) return message(sz.uresKatalogus)
    return embed(animeEmbed(k, nyelv, { szerzo: sz.veletlenSzerzo, banner: true }), true, [gombSor(animeGombok(k, nyelv))])
  }

  return message(sz.ismeretlenAlparancs)
}

/** A könyvtár állapotai a kijelzés sorrendjében, jellel. */
const KONYVTAR_JEL: Array<[string, string]> = [
  ['WATCHING', '👀'], ['REWATCHING', '🔁'], ['PLANNING', '📝'], ['COMPLETED', '✅'], ['PAUSED', '⏸️'], ['DROPPED', '🗑️']
]

/** A könyvtár állapotonként — minden profiljáé, ahogy a lista is. */
async function konyvtarOsszesito (userId: string): Promise<Map<string, number>> {
  const sorok = await query<{ status: string, n: number }>(
    `SELECT le.status::text AS status, count(*)::int AS n
       FROM library_entries le JOIN user_profiles p ON p.id = le.profile_id
      WHERE p.user_id = $1 GROUP BY le.status`, [userId])
  return new Map(sorok.map(r => [r.status, r.n]))
}

function osszesitoSor (szamok: Map<string, number>, sz: Szotar): string | null {
  return KONYVTAR_JEL
    .filter(([st]) => (szamok.get(st) ?? 0) > 0)
    .map(([st, jel]) => `${jel} ${sz.statusz[st] ?? st}: **${szamok.get(st)}**`)
    .join(' · ') || null
}

/**
 * A PROFIL — a YUME saját számaiból: szint és XP, nézési idő, megnézett
 * részek, befejezett címek (`profile_stats`, amit az oldal Statisztika lapja
 * is mutat), a könyvtár állapotonként, a kedvenc műfajok és a legutóbb
 * nézett cím. Ami nincs (még nincs statisztika), az kimarad.
 */
async function profile (i: Interaction, sz: Szotar): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return nincsFiok(sz)
  const nyelv = nyelvOf(i)
  const [alap, szamok, utolso] = await Promise.all([
    queryOne<{
      // A bigint oszlopok (xp, percek) szövegként jönnek — a pg így őrzi a pontosságot.
      tag_ota: Date | null, kedvenc: number, level: number | null, xp_total: string | null,
      minutes_watched: string | null, episodes_watched: number | null, anime_completed: number | null,
      mean_score: string | null, genre_breakdown: Record<string, number> | null, updated_at: Date | null
    }>(
      `SELECT u.created_at AS tag_ota,
              (SELECT count(*)::int FROM favorites f
                 JOIN user_profiles p ON p.id = f.profile_id WHERE p.user_id = u.id) AS kedvenc,
              ps.level, ps.xp_total, ps.minutes_watched, ps.episodes_watched, ps.anime_completed,
              ps.mean_score, ps.genre_breakdown, ps.updated_at
         FROM users u
         LEFT JOIN profile_stats ps ON ps.profile_id = $2
        WHERE u.id = $1`, [fiok.user_id, fiok.profile_id]),
    konyvtarOsszesito(fiok.user_id),
    fiok.profile_id
      ? queryOne<{ anime_id: string, at: Date }>(
        `SELECT wp.anime_id, wp.updated_at AS at FROM watch_progress wp
           JOIN anime a ON a.id = wp.anime_id AND a.visibility = 'public'
          WHERE wp.profile_id = $1 ORDER BY wp.updated_at DESC LIMIT 1`, [fiok.profile_id])
      : Promise.resolve(undefined)
  ])
  const legutobb = utolso ? await animeCard(utolso.anime_id) : undefined

  const mezok: Array<{ name: string, value: string, inline: boolean }> = []
  const tesz = (name: string, value: string | null | undefined, inline = true): void => {
    if (value) mezok.push({ name, value: value.slice(0, 1024), inline })
  }
  const xp = Number(alap?.xp_total ?? 0)
  if (alap?.level) tesz(sz.szint, `**${alap.level}**${xp > 0 ? ` · ${szam(xp, nyelv)} XP` : ''}`)
  const perc = Number(alap?.minutes_watched ?? 0)
  if (perc > 0) tesz(sz.nezesiIdo, `**${sz.oraPerc(Math.floor(perc / 60), perc % 60)}**`)
  if (alap?.episodes_watched) tesz(sz.megnezettReszek, `**${szam(alap.episodes_watched, nyelv)}**`)
  if (alap?.anime_completed) tesz(sz.befejezettCimek, `**${szam(alap.anime_completed, nyelv)}**`)
  if (alap?.mean_score) tesz(sz.atlagpont, `**${Number(alap.mean_score).toFixed(1)}** / 10`)
  tesz(sz.kedvencek, `**${alap?.kedvenc ?? 0}**`)
  const osszesen = [...szamok.values()].reduce((a, b) => a + b, 0)
  tesz(`${sz.konyvtar} (${osszesen})`, osszesitoSor(szamok, sz) ?? sz.uresKonyvtar, false)
  const mufajok = Object.entries(alap?.genre_breakdown ?? {})
    .filter(([, p]) => Number(p) > 0).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(([g]) => g)
  tesz(sz.kedvencMufajok, mufajSzoveg(mufajok, nyelv), false)
  if (legutobb && utolso) tesz(sz.legutobbNezett, `**${md(legutobb.cim)}** · ${ido(utolso.at, 'R')}`, false)
  if (alap?.tag_ota) tesz(sz.tagOta, ido(alap.tag_ota, 'D'))

  return embed({
    author: { name: sz.profilSzerzo },
    title: fiok.username,
    url: `${YUME}/#/profile`,
    fields: mezok,
    ...(legutobb?.borito ? { thumbnail: { url: legutobb.borito } } : {}),
    footer: { text: sz.profilLablec },
    // A statisztika frissessége: a Discord a néző idejében írja ki a láblécben.
    ...(alap?.updated_at ? { timestamp: new Date(alap.updated_at).toISOString() } : {})
  })
}

async function watchlist (i: Interaction, sz: Szotar): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return nincsFiok(sz)
  const nyelv = nyelvOf(i)

  /*
   * HOZZÁADÁS — MEGERŐSÍTÉSSEL. A parancs nem ír azonnal: megmutatja, melyik
   * címet találta (egy elgépelt névre a legrövidebb egyezés nem feltétlenül
   * az, amit keresett) — a teljes adatlapjával, borítóval —, és két gombot
   * ad. A gomb a hívó SAJÁT könyvtárába ír, és az üzenet csak neki látszik.
   */
  if (i.sub === 'add') {
    const keresett = (i.options.cim ?? '').trim()
    if (keresett.length < 2) return message(sz.ketKarakter)
    const [a] = await animeFromInput(keresett)
    const k = a ? await animeCard(a.id) : undefined
    if (!k) return message(sz.nincsTalalat(md(keresett)))
    return embed(animeEmbed(k, nyelv, { elotag: `**${sz.hozzaadjam}**`, leirasHossz: 350 }), true, [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: sz.hozzaadGomb, custom_id: `wl:add:${k.id}` },
          { type: 2, style: 2, label: sz.megseGomb, custom_id: 'wl:cancel' }
        ]
      },
      gombSor(animeGombok(k, nyelv))
    ])
  }

  const [sorok, szamok] = await Promise.all([
    query<{ anime_id: string, title: string, status: string, progress: number, score: string | null, episode_count: number | null, felnott: boolean }>(
      `SELECT le.anime_id, a.canonical_title AS title, le.status::text AS status, le.progress, le.score,
              a.episode_count, a.is_adult AS felnott
         FROM library_entries le
         JOIN user_profiles p ON p.id = le.profile_id
         JOIN anime a ON a.id = le.anime_id
        WHERE p.user_id = $1
        ORDER BY le.updated_at DESC LIMIT 10`, [fiok.user_id]),
    konyvtarOsszesito(fiok.user_id)
  ])
  if (!sorok.length) return message(sz.uresKonyvtar)

  // A borító a legutóbb változott címé — felnőtt címé soha (lásd anime-card.ts).
  const elso = sorok.find(r => !r.felnott)
  const boritos = elso ? await animeCard(elso.anime_id) : undefined
  const jel = new Map(KONYVTAR_JEL)
  const osszesen = [...szamok.values()].reduce((a, b) => a + b, 0)
  return embed({
    title: `📚 ${sz.konyvtarCim} (${osszesen})`,
    url: `${YUME}/#/list`,
    description: sorok.map(r => {
      const reszek = r.progress > 0 || r.episode_count
        ? sz.haladas(r.progress, r.episode_count)
        : null
      return [
        `${jel.get(r.status) ?? '•'} **${md(r.title)}**`,
        sz.statusz[r.status] ?? r.status,
        reszek,
        r.score !== null && Number(r.score) > 0 ? `⭐ ${Number(r.score)}/10` : null
      ].filter(Boolean).join(' · ')
    }).join('\n'),
    fields: [{ name: sz.allapotonkent, value: osszesitoSor(szamok, sz) ?? '—', inline: false }],
    ...(boritos?.borito ? { thumbnail: { url: boritos.borito } } : {}),
    footer: { text: sz.konyvtarLablec }
  })
}

/** Haladásjelző: ▰▰▰▱▱▱▱▱▱▱ 30% */
function sav (arany: number): string {
  const a = Math.min(1, Math.max(0, arany))
  const tele = Math.round(a * 10)
  return `${'▰'.repeat(tele)}${'▱'.repeat(10 - tele)} ${Math.round(a * 100)}%`
}

/**
 * EGY RÉSZ KÁRTYÁJA a /next-hez: a rész címe és leírása, a rész képe (ha
 * nincs, a banner), a borító, és ahol abbahagytad.
 */
function reszKartya (
  ep: EpizodAdat, k: AnimeCard, nyelv: Nyelv, cim: string, sorok: Array<string | null>
): Record<string, unknown> {
  const c = cimkek(nyelv)
  const reszLeiras = k.felnott ? '' : leirasDiscordra(ep.leiras, 350)
  const description = [
    ...sorok,
    ep.cim ? `*${md(tisztaSzoveg(ep.cim))}*` : null,
    k.felnott ? c.felnott : null,
    reszLeiras || null
  ].filter(Boolean).join('\n')
  const hossz = ep.hossz ?? k.hossz
  const nagyKep = ep.kep ?? k.banner
  const allapot = allapotSzoveg(k.status, nyelv)
  return {
    color: kartyaSzin(k.felnott ? null : k.szin),
    title: vag(cim, 250),
    url: nezesUrl(ep.id),
    ...(description ? { description: description.slice(0, 4000) } : {}),
    fields: [
      { name: c.epizod, value: epizodErtek(ep, k, nyelv), inline: true },
      ...(hossz ? [{ name: c.hossz, value: c.perc(hossz), inline: true }] : []),
      ...(allapot ? [{ name: c.allapot, value: allapot, inline: true }] : [])
    ],
    ...(k.borito ? { thumbnail: { url: k.borito } } : {}),
    ...(nagyKep ? { image: { url: nagyKep } } : {})
  }
}

/** A /next gombjai: a rész, az adatlap, és az előzetes, ha van. */
const nextGombok = (ep: EpizodAdat, k: AnimeCard, nyelv: Nyelv, sz: Szotar): unknown[] =>
  [gombSor([{ label: sz.megnezem, url: nezesUrl(ep.id), emoji: '▶️' }, ...animeGombok(k, nyelv, { nezes: false })])]

/**
 * A KÖVETKEZŐ RÉSZ: előbb a félbehagyott (a lejátszó pozíciója), ha nincs,
 * a „nézem" állapotú címek közül a legutóbbi következő része — a rész
 * kártyájával (kép, cím, leírás), és ha még nincs kint, azzal, hogy mikor
 * várható (ha a menetrend tudja).
 */
async function next (i: Interaction, sz: Szotar): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return nincsFiok(sz)
  if (!fiok.profile_id) return message(sz.nincsFolyamatban)
  const nyelv = nyelvOf(i)

  const felbe = await queryOne<{ episode_id: string, title: string, number: string, position_sec: string, duration_sec: string | null }>(
    `SELECT wp.episode_id, a.canonical_title AS title, ${epizodSzam} AS number, wp.position_sec, wp.duration_sec
       FROM watch_progress wp
       JOIN episodes e ON e.id = wp.episode_id
       JOIN anime a ON a.id = wp.anime_id
      WHERE wp.profile_id = $1 AND NOT wp.completed
        AND e.visibility = 'public' AND a.visibility = 'public'
      ORDER BY wp.updated_at DESC LIMIT 1`, [fiok.profile_id])
  if (felbe) {
    const url = nezesUrl(felbe.episode_id)
    const cim = sz.folytasd(felbe.title, felbe.number).replace(/\*\*/g, '')
    const hol = Number(felbe.position_sec)
    const hossz = Number(felbe.duration_sec ?? 0)
    const sorok = [
      hol > 0 ? sz.ahol(idopont(hol)) + (hossz > 0 ? ` / ${idopont(hossz)}` : '') : null,
      hol > 0 && hossz > 0 ? sav(hol / hossz) : null
    ]
    const adat = await episodeWithAnime(felbe.episode_id)
    if (adat) return embed(reszKartya(adat.ep, adat.anime, nyelv, cim, sorok), true, nextGombok(adat.ep, adat.anime, nyelv, sz))
    return embed({ title: cim, url, description: sorok.filter(Boolean).join('\n') || undefined },
      true, [{ type: 1, components: [linkGomb(sz.megnezem, url)] }])
  }

  const nezem = await queryOne<{ anime_id: string, title: string, progress: number, next_at: Date | null, next_ep: number | null }>(
    `SELECT le.anime_id, a.canonical_title AS title, le.progress,
            a.next_airing_at AS next_at, a.next_airing_ep AS next_ep
       FROM library_entries le JOIN anime a ON a.id = le.anime_id
      WHERE le.profile_id = $1 AND le.status IN ('WATCHING', 'REWATCHING') AND a.visibility = 'public'
      ORDER BY le.updated_at DESC LIMIT 1`, [fiok.profile_id])
  if (!nezem) return message(sz.nincsFolyamatban)

  const kovetkezo = String(nezem.progress + 1)
  const ep = await queryOne<{ id: string }>(
    `SELECT e.id FROM episodes e
      WHERE e.anime_id = $1 AND e.number = $2 AND e.visibility = 'public' LIMIT 1`,
    [nezem.anime_id, nezem.progress + 1])
  if (!ep) {
    // HA A MENETREND TUDJA, mikor jön — csak akkor, ha pontosan erről a részről szól.
    const varhato = nezem.next_at && new Date(nezem.next_at) > new Date() && nezem.next_ep === nezem.progress + 1
      ? `\n⏭️ ${sz.varhato(ido(nezem.next_at, 'F'), ido(nezem.next_at, 'R'))}`
      : ''
    return message(sz.megNemJelent(nezem.title, kovetkezo) + varhato)
  }
  const cim = sz.kovetkezik(nezem.title, kovetkezo).replace(/\*\*/g, '')
  const adat = await episodeWithAnime(ep.id)
  if (adat) return embed(reszKartya(adat.ep, adat.anime, nyelv, cim, []), true, nextGombok(adat.ep, adat.anime, nyelv, sz))
  const url = nezesUrl(ep.id)
  return embed({ title: cim, url }, true, [{ type: 1, components: [linkGomb(sz.megnezem, url)] }])
}

async function link (i: Interaction, sz: Szotar): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (fiok) return message(sz.marKotve(fiok.username))
  /*
   * AZ ÖSSZEKÖTÉS A FŐOLDALON TÖRTÉNIK, nem itt. A folyamathoz böngésző kell
   * (a Discord engedélyezési lapja), és a YUME-oldali bejelentkezés is — egy
   * parancs ezt nem tudja elvégezni, és úgy tenni, mintha igen, félrevezetés
   * volna. Eddig a vezérlőpultra küldött; az 2026-09-29 óta csak
   * jogosultsággal nyílik, egy átlagos tag ott nem jut be.
   */
  return message(sz.osszekotesItt(FIOK))
}

async function unlink (i: Interaction, sz: Szotar): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return message(sz.nincsKotve)
  return message(sz.kotveVagy(fiok.username, FIOK))
}

/**
 * AZ ÉRTESÍTÉSI RANG — KAPCSOLÓ. Eddig csak felrakni lehetett („a levételéhez
 * szólj egy moderátornak"); most ha rajta van, leveszi. Hogy rajta van-e, azt
 * az interakció maga mondja meg (a tag rangjai).
 */
async function notifications (i: Interaction, sz: Szotar): Promise<unknown> {
  if (!i.guildId) return message(sz.csakSzerveren)
  const rang = await registry.get(i.guildId, 'role', 'role:notifications')
  if (!rang?.discord_object_id) return message(sz.nincsRang)
  if (i.memberRoles.includes(rang.discord_object_id)) {
    const ok = await rest.removeMemberRole(i.guildId, i.userId, rang.discord_object_id, 'YUME /notifications')
    return message(ok ? sz.rangLevettem : sz.rangHiba)
  }
  const ok = await rest.addMemberRole(i.guildId, i.userId, rang.discord_object_id, 'YUME /notifications')
  return message(ok ? sz.rangMegkaptad : sz.rangHiba)
}

async function setupStatus (i: Interaction, sz: Szotar): Promise<unknown> {
  if (!i.guildId) return message(sz.csakSzerveren)
  const sorok = await registry.list(i.guildId)
  const futasok = await registry.runs(i.guildId, 1)
  const utolsoFutas = futasok[0]
  return embed({
    title: sz.setupCim,
    description: sz.setupLeiras(sorok.length,
      utolsoFutas ? `${utolsoFutas.mode} — ${utolsoFutas.status}` : sz.megNemFutott, `${DASHBOARD}/#/setup`),
    footer: { text: sz.setupLablec }
  })
}

async function configCommand (i: Interaction, sz: Szotar): Promise<unknown> {
  if (!i.guildId) return message(sz.csakSzerveren)
  const [beall, uzenetek] = await Promise.all([
    welcome.config(i.guildId),
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [i.guildId])
  ])
  return embed({
    title: sz.beallitasokCim,
    fields: [
      { name: sz.koszonto, value: beall.enabled ? sz.be : sz.ki, inline: true },
      { name: sz.tartosUzenet, value: String(uzenetek?.n ?? 0), inline: true }
    ],
    description: sz.szerkesztes(DASHBOARD)
  })
}

async function announce (i: Interaction, sz: Szotar): Promise<unknown> {
  if (!i.guildId) return message(sz.csakSzerveren)
  const csatorna = i.options.csatorna
  const szoveg = (i.options.szoveg ?? '').trim()
  if (!csatorna || !szoveg) return message(sz.hianyzikBejelentes)
  if (szoveg.length > 1800) return message(sz.tulHosszu)

  /*
   * A CSATORNA ENNEK A SZERVERNEK A CSATORNÁJA. A Discord felülete csak a
   * saját csatornáit kínálja, de a kezelő nem a felületnek hisz: a bot több
   * szerveren is bent van, és egy idegen csatornába küldött bejelentés az
   * ottani közösségnek szólna, ennek a szervernek a nevében.
   */
  const hova = await rest.channelGuild(csatorna)
  if (hova === 'unknown') return message(sz.nemEllenorizheto)
  if (hova === 'not_found' || hova === 'no_access') return message(sz.nemLatja)
  if (hova.guildId !== i.guildId) return message(sz.idegenCsatorna)

  const kliens = rest.createRestClient()
  try {
    await kliens.send(csatorna, {
      embeds: [{ title: sz.bejelentes, description: szoveg, color: SZIN }],
      // A BEJELENTÉS SEM EMLÍT SENKIT. Ha kell, a moderátor kézzel teszi.
      allowed_mentions: { parse: [] }
    })
  } catch (error) {
    return message(sz.nemMentEl(String((error as Error).message).slice(0, 150)))
  }
  return message(sz.elkuldve)
}

async function logs (i: Interaction, sz: Szotar): Promise<unknown> {
  if (!i.guildId) return message(sz.csakSzerveren)
  const sorok = await registry.history(i.guildId, 10)
  return embed({
    title: sz.muveletekCim,
    description: sorok.length
      ? sorok.map(s => `• \`${String(s.action)}\` ${String(s.logical_key)} — <t:${Math.floor(new Date(String(s.at)).getTime() / 1000)}:f>`).join('\n')
      : sz.nincsMuvelet
  })
}

// ---------------------------------------------------------------- futtatás

export interface HandleResult {
  response: unknown
  outcome: 'ok' | 'cooldown' | 'forbidden' | 'error' | 'unknown'
}

/**
 * EGY PARANCS VÉGREHAJTÁSA.
 *
 * A SORREND SZÁMÍT: előbb jogosultság, aztán cooldown, végül a munka. Egy
 * jogosulatlan hívást nem szabad cooldownnal „megjutalmazni" — abból ki
 * lehetne olvasni, hogy a parancs létezik-e.
 */
export async function handle (i: Interaction): Promise<HandleResult> {
  const sz = szovegek(nyelvOf(i))
  if (ADMIN_COMMANDS.has(i.command)) {
    /*
     * A JOGOSULTSÁGOT MI IS ELLENŐRIZZÜK. A Discord
     * `default_member_permissions` mezője csak elrejti a parancsot — a
     * kliens megkerülhető, a kiszolgáló nem.
     */
    const jog = can(
      { owner: false, permissions: parsePermissions(i.permissions) },
      'manage_bot')
    if (!i.guildId || !jog) {
      return { response: message(sz.nincsJog), outcome: 'forbidden' }
    }
  }

  const hatra = cooldownLeft(i.userId, i.command)
  if (hatra > 0) {
    return { response: message(sz.varj(Math.ceil(hatra / 1000))), outcome: 'cooldown' }
  }
  markUsed(i.userId, i.command)

  try {
    let valasz: unknown
    switch (i.command) {
      case 'help': valasz = await help(sz); break
      case 'status': valasz = await status(sz); break
      case 'stats': valasz = await stats(sz); break
      case 'anime': valasz = await animeCommand(i, sz); break
      case 'next': valasz = await next(i, sz); break
      case 'profile': valasz = await profile(i, sz); break
      case 'watchlist': valasz = await watchlist(i, sz); break
      case 'link': valasz = await link(i, sz); break
      case 'unlink': valasz = await unlink(i, sz); break
      case 'notifications': valasz = await notifications(i, sz); break
      case 'setup': valasz = await setupStatus(i, sz); break
      case 'config': valasz = await configCommand(i, sz); break
      case 'announce': valasz = await announce(i, sz); break
      case 'logs': valasz = await logs(i, sz); break
      default:
        return { response: message(sz.ismeretlenParancs), outcome: 'unknown' }
    }

    /*
     * A HASZNÁLAT A MEGLÉVŐ ESEMÉNYSÉMÁBA MEGY, nem külön táblába: ez
     * ugyanolyan „ki, mit, mikor" esemény, mint a többi, és a deduplikáció
     * is kell rá, mert a Discord ismételhet. A guild a metaadatba kerül — a
     * vezérlőpult Parancsok nézete szerverenként számol.
     */
    recordEvent({
      type: 'discord.command.use',
      subjectType: 'discord_command',
      subjectId: i.sub ? `${i.command} ${i.sub}` : i.command,
      visitorKey: `discord:${i.userId}`,
      metadata: i.guildId ? { guildId: i.guildId } : {}
    })

    return { response: valasz, outcome: 'ok' }
  } catch (error) {
    // A HIBA IS VÁLASZ. Három másodperc után a Discord azt írja ki, hogy a
    // bot nem válaszolt — az rosszabb, mint egy őszinte hibaüzenet.
    console.warn(JSON.stringify({
      ido: new Date().toISOString(),
      komponens: 'discord-command', uzenet: 'a parancs elhasalt',
      parancs: i.command, hiba: String((error as Error)?.message ?? error).slice(0, 200)
    }))
    return { response: message(sz.hiba), outcome: 'error' }
  }
}

/**
 * EGY GOMBNYOMÁS — a saját üzeneteink gombjai.
 *
 * A gomb azonosítója (`custom_id`) a mi üzenetünkből jön, és a gomb csak a
 * hívónak látszik (az üzenet csak neki szól) — a kezelő akkor is csak a
 * GOMBOT MEGNYOMÓ felhasználó saját fiókjára ír, és a címet újra ellenőrzi.
 */
export async function handleComponent (i: Interaction): Promise<HandleResult> {
  const sz = szovegek(nyelvOf(i))
  const id = i.customId ?? ''
  try {
    if (id === 'wl:cancel') return { response: frissit(sz.megse), outcome: 'ok' }

    const hozzaad = /^wl:add:([0-9a-f-]{36})$/i.exec(id)
    if (hozzaad) {
      const fiok = await yumeUser(i.userId)
      if (!fiok?.profile_id) return { response: frissit(`${sz.nincsKotve}\n${sz.kosdOssze(FIOK)}`), outcome: 'ok' }
      const animeId = hozzaad[1]!
      const cim = await queryOne<{ canonical_title: string }>(
        "SELECT canonical_title FROM anime WHERE id = $1 AND visibility = 'public'", [animeId])
      if (!cim) return { response: frissit(sz.eltunt), outcome: 'ok' }
      // Ami már bent van, azt nem írjuk át „tervezem"-re — egy nézett cím
      // állapota nem veszhet el egy gombnyomástól.
      const meglevo = await queryOne<{ status: string }>(
        'SELECT status FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [fiok.profile_id, animeId])
      if (meglevo) {
        return { response: frissit(sz.marKonyvtarban(cim.canonical_title, sz.statusz[meglevo.status] ?? meglevo.status)), outcome: 'ok' }
      }
      const sor = await saveEntry(fiok.profile_id, animeId, { status: 'PLANNING' })
      if (!sor) return { response: frissit(sz.eltunt), outcome: 'ok' }
      recordEvent({
        type: 'discord.command.use', subjectType: 'discord_command', subjectId: 'watchlist add:confirm',
        visitorKey: `discord:${i.userId}`, metadata: i.guildId ? { guildId: i.guildId } : {}
      })
      return { response: frissit(sz.hozzaadva(cim.canonical_title)), outcome: 'ok' }
    }

    /*
     * MODERÁLÁS: a moderátori csatorna gombjai. A jogot itt nézzük először
     * (összekötött, aktív YUME-fiók `community.moderate`-tel), és ha nincs,
     * CSAK a gombnyomónak válaszolunk — a közös üzenet nem változik. Ha a
     * bejelentést közben lezárták, az üzenet azt mutatja; különben az
     * indoklás ablaka nyílik (ez nem halasztható — a gateway ezért nem
     * halaszt a `mod:` gomboknál).
     */
    const mod = /^mod:(hide|dismiss):([0-9a-f-]{36})$/i.exec(id)
    if (mod) {
      if (!await moderatorOf(i.userId)) return { response: message(sz.nemModerator), outcome: 'forbidden' }
      const nyelvG = i.guildId ? await guildLanguage(i.guildId) : nyelvOf(i)
      const lezarva = await closedState(mod[2]!, nyelvG)
      if (lezarva) {
        const uj = await decidedMessage(mod[2]!, i.guildId, nyelvG, lezarva)
        return { response: uj ? { type: RESPONSE.UPDATE_MESSAGE, data: uj } : frissit(lezarva), outcome: 'ok' }
      }
      const f = feliratok(nyelvOf(i))
      return {
        response: {
          type: RESPONSE.MODAL,
          data: {
            custom_id: `modr:${mod[1]!.toLowerCase()}:${mod[2]!.toLowerCase()}`,
            title: sz.indoklasCim(mod[1]!.toLowerCase() === 'hide' ? f.elrejt : f.elvet).slice(0, 45),
            components: [{
              type: 1,
              components: [{
                type: 4, custom_id: 'reason', label: sz.indoklas.slice(0, 45), style: 2,
                min_length: 3, max_length: 500, required: true
              }]
            }]
          }
        },
        outcome: 'ok'
      }
    }

    return { response: frissit(sz.lejart), outcome: 'unknown' }
  } catch (error) {
    console.warn(JSON.stringify({
      ido: new Date().toISOString(),
      komponens: 'discord-command', uzenet: 'a gomb kezelése elhasalt',
      gomb: id.slice(0, 40), hiba: String((error as Error)?.message ?? error).slice(0, 200)
    }))
    return { response: frissit(sz.hiba), outcome: 'error' }
  }
}

/**
 * AZ INDOKLÁS ELKÜLDÉSE — a moderálási döntés.
 *
 * A jogot ÚJRA ellenőrizzük (az ablak nyitva maradhatott, miközben a jogot
 * elvették), és a döntés ugyanazon az úton születik, mint az adminfelületen
 * (`resolveReport`). Siker után a moderátori üzenet a döntést mutatja, gombok
 * nélkül; ha közben más döntött, azt.
 */
export async function handleModal (i: Interaction): Promise<HandleResult> {
  const sz = szovegek(nyelvOf(i))
  const m = /^modr:(hide|dismiss):([0-9a-f-]{36})$/.exec(i.customId ?? '')
  if (!m) return { response: message(sz.lejart), outcome: 'unknown' }
  try {
    const moderator = await moderatorOf(i.userId)
    if (!moderator) return { response: message(sz.nemModerator), outcome: 'forbidden' }
    const indoklas = (i.options.reason ?? '').trim()
    if (indoklas.length < 3) return { response: message(sz.rovidIndoklas), outcome: 'error' }

    const action = m[1] as 'hide' | 'dismiss'
    const reportId = m[2]!
    const nyelvG = i.guildId ? await guildLanguage(i.guildId) : nyelvOf(i)
    const f = feliratok(nyelvG)
    const kimenet = await resolveReport(reportId, action, indoklas.slice(0, 500), moderator)
    if (!kimenet.ok && kimenet.reason === 'not_hideable') return { response: message(sz.nemRejtheto), outcome: 'error' }

    const dontes = kimenet.ok
      ? `${action === 'hide' ? f.elrejtve(moderator.username) : f.elvetve(moderator.username)} · ${indoklas.slice(0, 300)}`
      : (await closedState(reportId, nyelvG)) ?? sz.lejart
    const uj = await decidedMessage(reportId, i.guildId, nyelvG, dontes)
    return {
      response: uj ? { type: RESPONSE.UPDATE_MESSAGE, data: uj } : frissit(dontes),
      outcome: kimenet.ok ? 'ok' : 'error'
    }
  } catch (error) {
    console.warn(JSON.stringify({
      ido: new Date().toISOString(),
      komponens: 'discord-command', uzenet: 'a moderálási döntés elhasalt',
      hiba: String((error as Error)?.message ?? error).slice(0, 200)
    }))
    return { response: message(sz.hiba), outcome: 'error' }
  }
}

/**
 * CÍMKIEGÉSZÍTÉS — gépelés közben, a katalógusból.
 *
 * Az érték az anime AZONOSÍTÓJA, a név a címe: a kiválasztott javaslat így
 * pontos találat, nem egy újabb keresés. Nem halasztható (a Discord erre nem
 * vár), ezért egyetlen, indexelt lekérdezés — és ha az elhasal, üres lista.
 */
export async function autocomplete (i: Interaction): Promise<unknown> {
  const beirt = (i.focused ? i.options[i.focused] : '')?.trim() ?? ''
  let sorok: Array<{ id: string, canonical_title: string, season_year: number | null }> = []
  try {
    // Felnőtt cím nélkül — ahogy a találatok között sincs (`animeFromInput`).
    sorok = beirt.length >= 1
      ? await query(
        `SELECT id, canonical_title, season_year FROM anime
          WHERE visibility = 'public' AND NOT is_adult AND canonical_title ILIKE $1
          ORDER BY (canonical_title ILIKE $2) DESC, length(canonical_title) LIMIT 25`,
        [`%${beirt.replace(/[\\%_]/g, c => '\\' + c)}%`, `${beirt.replace(/[\\%_]/g, c => '\\' + c)}%`])
      : await query(
        `SELECT id, canonical_title, season_year FROM anime
          WHERE visibility = 'public' AND NOT is_adult ORDER BY created_at DESC LIMIT 25`)
  } catch {
    sorok = []
  }
  return {
    type: RESPONSE.AUTOCOMPLETE_RESULT,
    data: {
      choices: sorok.map(s => {
        const nev = s.season_year ? `${s.canonical_title} (${s.season_year})` : s.canonical_title
        return { name: nev.length > 100 ? nev.slice(0, 99) + '…' : nev, value: s.id }
      })
    }
  }
}

/**
 * Meddig várunk a kezelőre, mielőtt halasztott választ küldünk. A Discord
 * három másodpercet ad az interakciótól; a hálózatnak is kell idő.
 */
export const DEFER_MS = Number(process.env.DISCORD_DEFER_MS ?? 2000)

export interface Transport {
  /** Az interakció válasza (`/interactions/{id}/{token}/callback`). */
  reply: (payload: unknown) => Promise<boolean>
  /** A halasztott válasz kitöltése (`…/messages/@original`). */
  edit: (data: Record<string, unknown>) => Promise<boolean>
}

/**
 * A PARANCS VÁLASZA — HÁROM MÁSODPERCEN BELÜL, akkor is, ha a munka tovább tart.
 *
 * Eddig a válasz csak a kezelő végén ment el. A Discord három másodpercet ad;
 * ha addig nem jön válasz, a felhasználó „The application did not respond"-ot
 * lát, és a később érkező választ a Discord el sem fogadja. Egy terhelt
 * adatbázis mellett egy keresés ezt könnyen túllépi.
 *
 * Most ha a kezelő `deferMs` alatt nem végez, előbb HALASZTOTT választ
 * küldünk („a bot gondolkodik…"), és amikor a munka kész, azt töltjük ki.
 *
 * A HALASZTÁS MINDIG CSAK A HÍVÓNAK LÁTSZIK. A láthatóság a halasztáskor dől
 * el, és utólag nem változtatható; ma minden válaszunk ilyen, és egy jövőbeli
 * nyilvános válasz inkább maradjon privát, mint fordítva.
 *
 * GOMBNYOMÁSNÁL (`component`) a halasztás a „frissítés később" (6-os típus):
 * az eredeti üzenet marad, és a kitöltés azt írja át.
 */
export async function respond (
  i: Interaction, t: Transport, deferMs = DEFER_MS,
  // A kezelő a teszt kedvéért cserélhető: egy lassú parancs így mérhető.
  kezelo: (i: Interaction) => Promise<HandleResult> = handle,
  { component = false }: { component?: boolean } = {}
): Promise<{ outcome: HandleResult['outcome'], delivered: boolean, deferred: boolean }> {
  const munka = kezelo(i).catch((): HandleResult => ({
    response: message(szovegek(nyelvOf(i)).hiba), outcome: 'error'
  }))
  let idozito: NodeJS.Timeout | undefined
  const kesik = new Promise<null>(resolve => { idozito = setTimeout(() => resolve(null), deferMs) })
  const gyors = await Promise.race([munka, kesik])
  clearTimeout(idozito)
  if (gyors) return { outcome: gyors.outcome, delivered: await t.reply(gyors.response), deferred: false }

  const halasztva = await t.reply(component
    ? { type: RESPONSE.DEFERRED_UPDATE }
    : { type: RESPONSE.DEFERRED, data: { flags: EPHEMERAL } })
  const eredmeny = await munka
  const adat = (eredmeny.response as { data?: Record<string, unknown> }).data ?? {}
  // Halasztás nélkül nincs mit kitölteni — a Discord azt 404-gyel utasítaná el.
  const kitoltve = halasztva && await t.edit(adat)
  return { outcome: eredmeny.outcome, delivered: kitoltve, deferred: true }
}

// ---------------------------------------------------------------- regisztráció

/** A parancsok feltöltése a Discordra. A `PUT` a teljes listát cseréli. */
export async function register (guildId: string): Promise<{ count: number } | null> {
  return await rest.registerCommands(guildId, DEFINITIONS as unknown as unknown[])
}

export async function registered (guildId: string): Promise<string[] | null> {
  const lista = await rest.listCommands(guildId)
  return lista ? lista.map(c => c.name) : null
}

/**
 * EGY PARANCSLEÍRÁS ÖSSZEHASONLÍTHATÓ ALAKJA.
 *
 * A Discord a visszaadott leírást kiegészíti (azonosító, verzió, `type: 1`,
 * `nsfw`, `contexts`…), a hamis értékeket pedig elhagyja (`required: false`)
 * — ezért nem a nyers JSON-t hasonlítjuk, hanem azt, ami a felhasználónak
 * számít: név, leírás, fordítások, jog, mezők.
 */
export function kanonikus (d: Record<string, unknown>): string {
  const lok = (v: unknown): Record<string, string> | null => {
    if (!v || typeof v !== 'object') return null
    const e = Object.entries(v as Record<string, string>).filter(([, s]) => typeof s === 'string').sort(([a], [b]) => a.localeCompare(b))
    return e.length ? Object.fromEntries(e) : null
  }
  const mezo = (o: Record<string, unknown>): unknown => ({
    type: Number(o.type ?? 0),
    name: String(o.name ?? ''),
    description: String(o.description ?? ''),
    lok: lok(o.description_localizations),
    required: o.required === true,
    autocomplete: o.autocomplete === true,
    options: Array.isArray(o.options) ? (o.options as Array<Record<string, unknown>>).map(mezo) : []
  })
  return JSON.stringify({
    name: String(d.name ?? ''),
    description: String(d.description ?? ''),
    lok: lok(d.description_localizations),
    perms: d.default_member_permissions === null || d.default_member_permissions === undefined
      ? null
      : String(d.default_member_permissions),
    options: Array.isArray(d.options) ? (d.options as Array<Record<string, unknown>>).map(mezo) : []
  })
}

/** Ugyanaz a parancskészlet van-e fent, mint amit a kód leír. */
export function azonos (fent: Array<Record<string, unknown>>): boolean {
  const lista = (l: Array<Record<string, unknown>>): string => l.map(kanonikus).sort().join('\n')
  return lista(fent) === lista(DEFINITIONS as unknown as Array<Record<string, unknown>>)
}

/**
 * A PARANCSOK SZINKRONJA — ha a Discordon más van fent, mint a kódban.
 *
 * Eddig a parancsokat csak a vezérlőpult „Parancsok feltöltése" gombja tette
 * fel; egy új vagy módosított parancs a következő kézi kattintásig nem
 * létezett. Most a gateway minden szerverre (induláskor és csatlakozáskor)
 * megnézi, és csak ELTÉRÉSNÉL tölt fel — egy változatlan készletet nem küld
 * újra minden újraindításkor.
 */
export async function sync (guildId: string): Promise<'unchanged' | 'updated' | 'failed' | 'unknown'> {
  const fent = await rest.fetchCommands(guildId)
  if (fent === null) return 'unknown'
  if (azonos(fent)) return 'unchanged'
  return (await register(guildId)) ? 'updated' : 'failed'
}

export interface DeliveryStatus {
  /** `gateway`: a parancsok a botnál; `http`: egy HTTP-végpontra mennek, a bot egyet sem kap. */
  mode: 'gateway' | 'http'
  endpointUrl: string | null
}

/**
 * HOVÁ KÜLDI A DISCORD A PARANCSOKAT. `null`, ha nem kérdezhető le.
 *
 * Ha a fejlesztői portálon interakció-végpont van beállítva, a Discord oda
 * küld mindent, és a gatewayre egy parancs sem érkezik — a felhasználó csak
 * annyit lát, hogy „az alkalmazás nem válaszolt". Ezt ki kell mondani.
 */
export async function deliveryStatus (): Promise<DeliveryStatus | null> {
  const info = await rest.applicationInfo()
  if (!info) return null
  return info.interactionsEndpointUrl
    ? { mode: 'http', endpointUrl: info.interactionsEndpointUrl }
    : { mode: 'gateway', endpointUrl: null }
}
