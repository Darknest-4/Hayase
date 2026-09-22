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
 * MINDEN PARANCS VÁLASZOL, MÉG A HIBÁS IS. A Discord három másodpercig vár;
 * utána a felhasználónak azt írja ki, hogy a bot nem válaszolt — akkor is,
 * ha a válasz később megérkezik. Ezért minden ág ad választ, és a hosszabb
 * lekérdezések is ezen a határon belül maradnak (napi összesítőkből
 * olvasunk, nem nyers eseményből).
 *
 * AMI NINCS, AZT KIMONDJA. Egy parancs, ami kitalált adatot ad vissza,
 * rosszabb, mint egy parancs, ami nincs.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { record as recordEvent } from '../analytics/events.ts'
import * as rest from './rest-client.ts'
import * as registry from './registry.ts'
import * as welcome from './welcome.ts'
import { allapot as gatewayAllapot, elo as gatewayElo } from './gateway.ts'
import { PERMISSION_BITS, can, parsePermissions } from './permissions.ts'

const SZIN = 0xE4_1E_63
const YUME = process.env.PUBLIC_URL ?? 'https://animehub.hu'
const DASHBOARD = process.env.DISCORD_DASHBOARD_URL ?? 'https://discord.animehub.hu'

/** Discord interakció-típusok, amiket kezelünk. */
export const INTERACTION = { PING: 1, COMMAND: 2 } as const
/** Válasz-típusok. */
export const RESPONSE = { PONG: 1, MESSAGE: 4 } as const
/** Csak a hívó látja. */
export const EPHEMERAL = 64

/**
 * A PARANCSOK LEÍRÁSA — ez megy fel a Discordra.
 *
 * Az `default_member_permissions` a Discord SAJÁT szűrője: a parancs meg sem
 * jelenik annak, akinek nincs meg a jog. Ez kényelem, NEM védelem — a
 * jogosultságot a kezelő is ellenőrzi, mert egy kliensoldali szűrő
 * megkerülhető.
 */
export const DEFINITIONS = [
  { name: 'help', description: 'Mit tud ez a bot?' },
  { name: 'status', description: 'A YUME és a bot állapota' },
  { name: 'stats', description: 'A YUME számokban' },
  {
    name: 'anime',
    description: 'Animék a YUME katalógusából',
    options: [
      {
        type: 1,
        name: 'search',
        description: 'Keresés cím szerint',
        options: [{ type: 3, name: 'cim', description: 'Amit keresel', required: true }]
      },
      {
        type: 1,
        name: 'info',
        description: 'Egy cím adatai',
        options: [{ type: 3, name: 'cim', description: 'A cím neve', required: true }]
      },
      { type: 1, name: 'latest', description: 'A legfrissebb epizódok' },
      { type: 1, name: 'schedule', description: 'A következő adások' },
      { type: 1, name: 'random', description: 'Egy véletlen cím' }
    ]
  },
  { name: 'profile', description: 'A YUME-fiókod állapota' },
  { name: 'link', description: 'A Discord-fiók összekötése a YUME-fiókkal' },
  { name: 'unlink', description: 'Az összekötés bontása' },
  { name: 'watchlist', description: 'A könyvtárad' },
  { name: 'notifications', description: 'Értesítési rang be- és kikapcsolása' },
  {
    name: 'setup',
    description: 'A YUME szerverstruktúra állapota',
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD)
  },
  {
    name: 'config',
    description: 'A bot beállításai ezen a szerveren',
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD)
  },
  {
    name: 'announce',
    description: 'Bejelentés küldése egy csatornába',
    default_member_permissions: String(PERMISSION_BITS.MANAGE_GUILD),
    options: [
      { type: 7, name: 'csatorna', description: 'Hova menjen', required: true },
      { type: 3, name: 'szoveg', description: 'Mit írjon', required: true }
    ]
  },
  {
    name: 'logs',
    description: 'A legutóbbi bot-műveletek',
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

export function embed (mezok: Record<string, unknown>, ephemeral = true): unknown {
  return {
    type: RESPONSE.MESSAGE,
    data: {
      embeds: [{ color: SZIN, ...mezok }],
      ...(ephemeral ? { flags: EPHEMERAL } : {}),
      allowed_mentions: { parse: [] }
    }
  }
}

// ---------------------------------------------------------------- bemenet

export interface Interaction {
  id: string
  token: string
  type: number
  guildId: string | null
  channelId: string | null
  userId: string
  username: string
  /** A hívó guild-jogosultságai, ahogy a Discord küldte. */
  permissions: string
  command: string
  sub: string | null
  options: Record<string, string>
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
  const options: Record<string, string> = {}
  const nyers = Array.isArray(data.options) ? data.options as Array<Record<string, unknown>> : []
  for (const o of nyers) {
    if (o.type === 1) {
      sub = String(o.name ?? '')
      for (const p of (Array.isArray(o.options) ? o.options as Array<Record<string, unknown>> : [])) {
        options[String(p.name ?? '')] = String(p.value ?? '')
      }
    } else {
      options[String(o.name ?? '')] = String(o.value ?? '')
    }
  }

  return {
    id: a.id,
    token: a.token,
    type: Number(a.type ?? 0),
    guildId: typeof a.guild_id === 'string' ? a.guild_id : null,
    channelId: typeof a.channel_id === 'string' ? a.channel_id : null,
    userId: user.id,
    username: String(user.username ?? user.id),
    permissions: String(tag.permissions ?? '0'),
    command: String(data.name ?? ''),
    sub,
    options
  }
}

// ---------------------------------------------------------------- kezelők

async function help (): Promise<unknown> {
  return embed({
    title: 'YUME — parancsok',
    description: [
      '**/help** — ez a lista',
      '**/status** — a bot és a rendszer állapota',
      '**/stats** — a YUME számokban',
      '**/anime search | info | latest | schedule | random** — a katalógus',
      '**/profile** — a YUME-fiókod',
      '**/link**, **/unlink** — fiók-összekötés',
      '**/watchlist** — a könyvtárad',
      '**/notifications** — értesítési rang',
      '',
      '_Adminoknak:_ **/setup**, **/config**, **/announce**, **/logs**'
    ].join('\n'),
    url: YUME
  })
}

async function status (): Promise<unknown> {
  const [szolgaltatasok, gw] = await Promise.all([
    query<{ service: string, status: string }>(
      "SELECT service, status FROM service_status WHERE status <> 'not_configured' ORDER BY service"),
    gatewayAllapot()
  ])
  const jel = (s: string): string => s === 'green' ? '✅' : s === 'unknown' ? '❔' : '⚠️'
  return embed({
    title: 'Rendszerállapot',
    description: szolgaltatasok.map(s => `${jel(s.status)} ${s.service}`).join('\n') || 'Nincs állapotadat.',
    fields: [
      {
        name: 'Gateway',
        value: gatewayElo(gw) ? '✅ fut' : '⚠️ nem fut',
        inline: true
      },
      {
        name: 'Újracsatlakozás',
        value: String(gw?.reconnects ?? '—'),
        inline: true
      }
    ]
  })
}

async function stats (): Promise<unknown> {
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
    title: 'YUME — statisztika',
    url: YUME,
    fields: [
      { name: 'Animék', value: ertek(katalogus?.anime), inline: true },
      { name: 'Epizódok', value: ertek(katalogus?.episodes), inline: true },
      { name: 'Felhasználók', value: ertek(katalogus?.users), inline: true },
      { name: 'Munkamenet (ma)', value: ertek(ma?.sessions), inline: true },
      { name: 'Oldalletöltés (ma)', value: ertek(ma?.page_views), inline: true }
    ],
    footer: { text: 'A számok a YUME adatbázisából jönnek.' }
  })
}

/** Az epizódszám emberi alakja: „7", nem „7.0". */
const epizodSzam = 'CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END'

async function animeCommand (i: Interaction): Promise<unknown> {
  if (i.sub === 'search' || i.sub === 'info') {
    const keresett = (i.options.cim ?? '').trim()
    if (keresett.length < 2) return message('Adj meg legalább két karaktert.')

    const talalatok = await query<{ id: string, canonical_title: string, status: string | null, season_year: number | null }>(
      `SELECT id, canonical_title, status, season_year FROM anime
        WHERE visibility = 'public' AND canonical_title ILIKE $1
        ORDER BY length(canonical_title) LIMIT $2`,
      [`%${keresett}%`, i.sub === 'info' ? 1 : 8])

    if (!talalatok.length) return message(`Nincs találat erre: **${keresett}**`)

    if (i.sub === 'search') {
      return embed({
        title: `Találatok: ${keresett}`,
        description: talalatok
          .map(t => `• **${t.canonical_title}**${t.season_year ? ` (${t.season_year})` : ''}\n  ${YUME}/#/anime/${t.id}`)
          .join('\n')
      })
    }

    const a = talalatok[0]!
    const epizodok = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM episodes WHERE anime_id = $1 AND visibility = 'public'", [a.id])
    return embed({
      title: a.canonical_title,
      url: `${YUME}/#/anime/${a.id}`,
      fields: [
        { name: 'Állapot', value: a.status ?? '—', inline: true },
        { name: 'Év', value: a.season_year ? String(a.season_year) : '—', inline: true },
        { name: 'Epizódok', value: String(epizodok?.n ?? 0), inline: true }
      ]
    })
  }

  if (i.sub === 'latest') {
    const sorok = await query<{ title: string, number: string }>(
      `SELECT a.canonical_title AS title, ${epizodSzam} AS number
         FROM episodes e JOIN anime a ON a.id = e.anime_id
        WHERE e.visibility = 'public' AND a.visibility = 'public'
        ORDER BY e.created_at DESC, e.id DESC LIMIT 8`)
    return embed({
      title: 'Legfrissebb epizódok',
      url: YUME,
      description: sorok.length
        ? sorok.map(r => `• **${r.title}** — ${r.number}. rész`).join('\n')
        : 'Még nincs publikus epizód.'
    })
  }

  if (i.sub === 'schedule') {
    const sorok = await query<{ title: string, ep: number | null, at: Date }>(
      `SELECT canonical_title AS title, next_airing_ep AS ep, next_airing_at AS at
         FROM anime WHERE visibility = 'public' AND next_airing_at > now()
        ORDER BY next_airing_at, canonical_title LIMIT 8`)
    return embed({
      title: 'Következő epizódok',
      url: YUME,
      description: sorok.length
        ? sorok.map(r => `• **${r.title}** — ${r.ep !== null ? `${r.ep}. rész · ` : ''}${new Date(r.at).toISOString().slice(0, 10)}`).join('\n')
        : 'Egyetlen címhez sincs jövőbeli adásidő.'
    })
  }

  if (i.sub === 'random') {
    /*
     * A VÉLETLEN SOR EGY HARMINCEZRES TÁBLÁN nem `ORDER BY random()` — az
     * végigolvasná az egészet. Egy véletlen eltolás a `created_at` szerinti
     * sorrendben ugyanolyan jó, és indexet használ.
     */
    const osszes = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM anime WHERE visibility = 'public'")
    const n = osszes?.n ?? 0
    if (n === 0) return message('A katalógus üres.')
    const sor = await queryOne<{ id: string, canonical_title: string }>(
      `SELECT id, canonical_title FROM anime WHERE visibility = 'public'
        ORDER BY created_at OFFSET $1 LIMIT 1`, [Math.floor(Math.random() * n)])
    return embed({
      title: sor?.canonical_title ?? 'Véletlen cím',
      url: sor ? `${YUME}/#/anime/${sor.id}` : YUME,
      description: 'Véletlenül választva a katalógusból.'
    })
  }

  return message('Ismeretlen alparancs.')
}

/** A hívó YUME-fiókja, ha összekötötte. */
async function yumeUser (discordUserId: string): Promise<{ user_id: string, username: string } | undefined> {
  return await queryOne<{ user_id: string, username: string }>(
    `SELECT l.user_id, u.username FROM discord_links l
       JOIN users u ON u.id = l.user_id WHERE l.discord_user_id = $1`, [discordUserId])
}

async function profile (i: Interaction): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) {
    return message(
      'Ehhez a Discord-fiókhoz nincs YUME-fiók kötve.\n' +
      `Összekötheted itt: ${DASHBOARD}/#/settings`)
  }
  const stat = await queryOne<{ konyvtar: number, kedvenc: number }>(
    `SELECT (SELECT count(*)::int FROM library_entries le
               JOIN user_profiles p ON p.id = le.profile_id WHERE p.user_id = $1) AS konyvtar,
            (SELECT count(*)::int FROM favorites f
               JOIN user_profiles p ON p.id = f.profile_id WHERE p.user_id = $1) AS kedvenc`,
    [fiok.user_id])
  return embed({
    title: fiok.username,
    url: YUME,
    fields: [
      { name: 'Könyvtár', value: String(stat?.konyvtar ?? 0), inline: true },
      { name: 'Kedvencek', value: String(stat?.kedvenc ?? 0), inline: true }
    ]
  })
}

async function watchlist (i: Interaction): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return message(`Kösd össze a fiókodat: ${DASHBOARD}/#/settings`)
  const sorok = await query<{ title: string, status: string }>(
    `SELECT a.canonical_title AS title, le.status
       FROM library_entries le
       JOIN user_profiles p ON p.id = le.profile_id
       JOIN anime a ON a.id = le.anime_id
      WHERE p.user_id = $1
      ORDER BY le.updated_at DESC LIMIT 10`, [fiok.user_id])
  return embed({
    title: 'A könyvtárad',
    url: `${YUME}/#/list`,
    description: sorok.length
      ? sorok.map(r => `• **${r.title}** — ${r.status}`).join('\n')
      : 'A könyvtárad üres.'
  })
}

async function link (i: Interaction): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (fiok) return message(`Ez a Discord-fiók már össze van kötve ezzel: **${fiok.username}**`)
  /*
   * AZ ÖSSZEKÖTÉS A VEZÉRLŐPULTON TÖRTÉNIK, nem itt. A folyamathoz
   * böngésző kell (a Discord engedélyezési lapja), és a YUME-oldali
   * bejelentkezés is — egy parancs ezt nem tudja elvégezni, és úgy tenni,
   * mintha igen, félrevezetés volna.
   */
  return message(
    'Az összekötés a vezérlőpulton indul, mert böngésző kell hozzá:\n' +
    `${DASHBOARD}/#/settings`)
}

async function unlink (i: Interaction): Promise<unknown> {
  const fiok = await yumeUser(i.userId)
  if (!fiok) return message('Ehhez a Discord-fiókhoz nincs YUME-fiók kötve.')
  return message(
    `A(z) **${fiok.username}** fiókkal vagy összekötve.\n` +
    `A bontás a vezérlőpulton, a saját fiókoddal belépve: ${DASHBOARD}/#/settings`)
}

async function notifications (i: Interaction): Promise<unknown> {
  if (!i.guildId) return message('Ez a parancs csak szerveren használható.')
  const rang = await registry.get(i.guildId, 'role', 'role:notifications')
  if (!rang?.discord_object_id) {
    return message('Az értesítési rang nincs beállítva ezen a szerveren. Futtasd a setupot.')
  }
  const ok = await rest.addMemberRole(i.guildId, i.userId, rang.discord_object_id, 'YUME /notifications')
  return ok
    ? message('Megkaptad az értesítési rangot. A levételéhez szólj egy moderátornak.')
    : message('Nem sikerült a rangot hozzáadni — lehet, hogy a bot rangja alacsonyabban áll.')
}

async function setupStatus (i: Interaction): Promise<unknown> {
  if (!i.guildId) return message('Ez a parancs csak szerveren használható.')
  const sorok = await registry.list(i.guildId)
  const futasok = await registry.runs(i.guildId, 1)
  const utolsoFutas = futasok[0]
  return embed({
    title: 'YUME setup — állapot',
    description:
      `Nyilvántartott objektum: **${sorok.length}**\n` +
      `Utolsó futás: ${utolsoFutas ? `${utolsoFutas.mode} — ${utolsoFutas.status}` : 'még nem futott'}\n\n` +
      `A setup futtatása a vezérlőpulton: ${DASHBOARD}/#/setup`,
    footer: { text: 'Veszélyes műveletet parancsból nem végzünk.' }
  })
}

async function configCommand (i: Interaction): Promise<unknown> {
  if (!i.guildId) return message('Ez a parancs csak szerveren használható.')
  const [beall, uzenetek] = await Promise.all([
    welcome.config(i.guildId),
    queryOne<{ n: number }>('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [i.guildId])
  ])
  return embed({
    title: 'A bot beállításai',
    fields: [
      { name: 'Köszöntő', value: beall.enabled ? '✅ be' : '➖ ki', inline: true },
      { name: 'Tartós üzenet', value: String(uzenetek?.n ?? 0), inline: true }
    ],
    description: `A szerkesztés a vezérlőpulton: ${DASHBOARD}`
  })
}

async function announce (i: Interaction): Promise<unknown> {
  if (!i.guildId) return message('Ez a parancs csak szerveren használható.')
  const csatorna = i.options.csatorna
  const szoveg = (i.options.szoveg ?? '').trim()
  if (!csatorna || !szoveg) return message('Hiányzik a csatorna vagy a szöveg.')
  if (szoveg.length > 1800) return message('A szöveg túl hosszú (legfeljebb 1800 karakter).')

  const kliens = rest.createRestClient()
  try {
    await kliens.send(csatorna, {
      embeds: [{ title: 'Bejelentés', description: szoveg, color: SZIN }],
      // A BEJELENTÉS SEM EMLÍT SENKIT. Ha kell, a moderátor kézzel teszi.
      allowed_mentions: { parse: [] }
    })
  } catch (error) {
    return message(`Nem sikerült elküldeni: ${String((error as Error).message).slice(0, 150)}`)
  }
  return message('Elküldve.')
}

async function logs (i: Interaction): Promise<unknown> {
  if (!i.guildId) return message('Ez a parancs csak szerveren használható.')
  const sorok = await registry.history(i.guildId, 10)
  return embed({
    title: 'Legutóbbi műveletek',
    description: sorok.length
      ? sorok.map(s => `• \`${String(s.action)}\` ${String(s.logical_key)} — ${new Date(String(s.at)).toLocaleString('hu-HU')}`).join('\n')
      : 'Még nem történt művelet.'
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
  if (ADMIN_COMMANDS.has(i.command)) {
    /*
     * A JOGOSULTSÁGOT MI IS ELLENŐRIZZÜK. A Discord
     * `default_member_permissions` mezője csak elrejti a parancsot — a
     * kliens megkerülhető, a kiszolgáló nem.
     */
    const jog = can(
      { owner: false, permissions: parsePermissions(i.permissions) },
      'manage_messages')
    if (!i.guildId || !jog) {
      return { response: message('Ehhez „Szerver kezelése" jogosultság kell.'), outcome: 'forbidden' }
    }
  }

  const hatra = cooldownLeft(i.userId, i.command)
  if (hatra > 0) {
    return {
      response: message(`Várj még ${Math.ceil(hatra / 1000)} másodpercet.`),
      outcome: 'cooldown'
    }
  }
  markUsed(i.userId, i.command)

  try {
    let valasz: unknown
    switch (i.command) {
      case 'help': valasz = await help(); break
      case 'status': valasz = await status(); break
      case 'stats': valasz = await stats(); break
      case 'anime': valasz = await animeCommand(i); break
      case 'profile': valasz = await profile(i); break
      case 'watchlist': valasz = await watchlist(i); break
      case 'link': valasz = await link(i); break
      case 'unlink': valasz = await unlink(i); break
      case 'notifications': valasz = await notifications(i); break
      case 'setup': valasz = await setupStatus(i); break
      case 'config': valasz = await configCommand(i); break
      case 'announce': valasz = await announce(i); break
      case 'logs': valasz = await logs(i); break
      default:
        return { response: message('Ismeretlen parancs.'), outcome: 'unknown' }
    }

    /*
     * A HASZNÁLAT A MEGLÉVŐ ESEMÉNYSÉMÁBA MEGY, nem külön táblába: ez
     * ugyanolyan „ki, mit, mikor" esemény, mint a többi, és a deduplikáció
     * is kell rá, mert a Discord ismételhet.
     */
    recordEvent({
      type: 'discord.command.use',
      subjectType: 'discord_command',
      subjectId: i.sub ? `${i.command} ${i.sub}` : i.command,
      visitorKey: `discord:${i.userId}`,
      metadata: {}
    })

    return { response: valasz, outcome: 'ok' }
  } catch (error) {
    // A HIBA IS VÁLASZ. Három másodperc után a Discord azt írja ki, hogy a
    // bot nem válaszolt — az rosszabb, mint egy őszinte hibaüzenet.
    console.warn(JSON.stringify({
      komponens: 'discord-command', uzenet: 'a parancs elhasalt',
      parancs: i.command, hiba: String((error as Error)?.message ?? error).slice(0, 200)
    }))
    return { response: message('A parancs végrehajtása nem sikerült. Próbáld újra később.'), outcome: 'error' }
  }
}

/** A parancsok feltöltése a Discordra. A `PUT` a teljes listát cseréli. */
export async function register (guildId: string): Promise<{ count: number } | null> {
  return await rest.registerCommands(guildId, DEFINITIONS as unknown as unknown[])
}

export async function registered (guildId: string): Promise<string[] | null> {
  const lista = await rest.listCommands(guildId)
  return lista ? lista.map(c => c.name) : null
}
