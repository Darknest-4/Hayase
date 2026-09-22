/**
 * A `DiscordClient` valódi megvalósítása — a Discord REST API fölött.
 *
 * NINCS BENNE `discord.js`. Amit a tartós üzenetekhez csinálunk, az négy
 * HTTP-hívás; egy teljes gateway-könyvtár ehhez több megabájtnyi
 * függőséget, egy állandó WebSocket-kapcsolatot és egy külön életciklust
 * hozna. Ha egyszer kell gateway (élő tagesemények), az külön szolgáltatás
 * lesz — nem ennek a modulnak a mellékhatása.
 *
 * A TOKEN SOHA NEM HAGYJA EL EZT A MODULT. Nem kerül naplóba, nem kerül
 * hibaüzenetbe, és nem kerül a válaszba. A hibák szövegét a hívó naplózza,
 * ezért a válasz törzséből is csak a Discord `code`/`message` mezője megy
 * tovább — a kérés fejléce soha.
 *
 * A CÍM RÖGZÍTETT. Az útvonalba kerülő azonosítókat ellenőrizzük: egy
 * `channelId`-ből érkező `../` a kérést más végpontra vinné. A Discord
 * azonosítói csak számjegyek, tehát ez olcsó és teljes védelem.
 */

import { canPostEmbed, missingForEmbed, parsePermissions, PERMISSION_BITS, hasBit } from './permissions.ts'

import type { DiscordClient, DiscordError, ErrorKind, SentMessage } from './types.ts'

const API_BASE = 'https://discord.com/api/v10'
const TIMEOUT_MS = Number(process.env.DISCORD_TIMEOUT_MS ?? 10_000)

/** A bot tokenje. Kizárólag a környezetből — sosem paraméterből, sosem kódból. */
export function botToken (): string | null {
  const raw = process.env.DISCORD_BOT_TOKEN
  return raw && raw.trim() !== '' ? raw.trim() : null
}

export function isConfigured (): boolean {
  return botToken() !== null
}

/**
 * Discord-azonosító ellenőrzése.
 *
 * Csak számjegy, 17–20 jegy. Ez nem formaiság: az azonosító az ÚTVONALBA
 * kerül, és egy `..%2F` belőle más végpontra irányítaná a kérést.
 */
function safeId (value: string, mit: string): string {
  if (!/^\d{17,20}$/.test(value)) {
    throw fail('unknown', `érvénytelen ${mit}-azonosító`)
  }
  return value
}

function fail (kind: ErrorKind, message: string, retryAfterMs?: number): DiscordError {
  const e = new Error(message) as DiscordError
  e.kind = kind
  if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs
  return e
}

/**
 * A Discord hibakódjának besorolása.
 *
 * A KÓDRA ÉPÜL, NEM A SZÖVEGRE. A Discord `code` mezője stabil szerződés
 * (10003 = ismeretlen csatorna, 10008 = ismeretlen üzenet, 50001 = nincs
 * hozzáférés, 50013 = hiányzó jogosultság); a `message` szövege
 * változhat és fordítható. Egy szövegre épülő elágazás némán rossz ágra
 * vinne — például egy jogosultsági hibát üzenet-újralétrehozásnak néznénk,
 * és percenként küldenénk egy újat.
 */
function kindOf (status: number, code: number | null): ErrorKind {
  if (code === 10003) return 'channel_not_found'
  if (code === 10008) return 'message_not_found'
  if (code === 50001 || code === 50013) return 'forbidden'
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'message_not_found'
  if (status >= 500) return 'transient'
  return 'unknown'
}

interface DiscordBody {
  code?: number
  message?: string
  retry_after?: number
  [key: string]: unknown
}

async function request (path: string, init: RequestInit = {}): Promise<{ status: number, body: DiscordBody }> {
  const token = botToken()
  if (!token) throw fail('forbidden', 'nincs beállítva Discord bot token')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        // A TOKEN CSAK ITT SZEREPEL. Nem naplózzuk, és a hibaágak sem
        // hivatkoznak a fejlécekre.
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        'user-agent': 'YumeBot (https://animehub.hu, 1.0)',
        ...(init.headers as Record<string, string> | undefined)
      },
      signal: controller.signal
    })

    let body: DiscordBody = {}
    try { body = await res.json() as DiscordBody } catch { /* üres törzs is lehet */ }
    return { status: res.status, body }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw fail('transient', 'a Discord nem válaszolt időben')
    // A hálózati hiba szövege nem tartalmaz titkot, de a biztonság kedvéért
    // csak a típusát adjuk tovább.
    throw fail('transient', 'a Discord nem érhető el')
  } finally {
    clearTimeout(timer)
  }
}

function assertOk (status: number, body: DiscordBody): void {
  if (status >= 200 && status < 300) return
  const code = typeof body.code === 'number' ? body.code : null
  const kind = kindOf(status, code)
  const retryAfterMs = typeof body.retry_after === 'number'
    ? Math.round(body.retry_after * 1000)
    : undefined
  // A Discord `message` mezője mehet tovább — az a hiba leírása, nem titok.
  const uzenet = typeof body.message === 'string' ? body.message : `HTTP ${status}`
  throw fail(kind, uzenet, retryAfterMs)
}

/**
 * A bot jogosultságai egy csatornában.
 *
 * KÉT LEKÉRDEZÉS, mert a Discord nem ad egyetlen „mit tehetek itt" végpontot:
 * a csatorna felülbírálatait (`permission_overwrites`) a szerepkörök alapján
 * kell kiértékelni. Ehhez viszont ismerni kellene a bot szerepköreit is —
 * ezért a gyakorlatban a `guild` szintű jogot nézzük, és a küldést a
 * tényleges hiba dönti el.
 *
 * EZ SZÁNDÉKOSAN ÓVATOS: ha nem tudjuk biztosan, hogy nincs jogunk, akkor
 * megpróbáljuk, és a Discord hibája dönt. A fordítottja rosszabb volna —
 * egy téves „nincs jogod" miatt soha nem indulna el a statisztika.
 */
async function channelPermissions (channelId: string): Promise<bigint | null> {
  const { status, body } = await request(`/channels/${safeId(channelId, 'csatorna')}`)
  if (status === 404) return null
  assertOk(status, body)
  const perms = (body as { permissions?: unknown }).permissions
  return perms === undefined ? null : parsePermissions(perms)
}

export function createRestClient (): DiscordClient {
  return {
    async send (channelId: string, payload: unknown): Promise<SentMessage> {
      const { status, body } = await request(
        `/channels/${safeId(channelId, 'csatorna')}/messages`,
        { method: 'POST', body: JSON.stringify(payload) })
      assertOk(status, body)
      return { id: String((body as { id?: unknown }).id ?? '') }
    },

    async edit (channelId: string, messageId: string, payload: unknown): Promise<SentMessage> {
      const { status, body } = await request(
        `/channels/${safeId(channelId, 'csatorna')}/messages/${safeId(messageId, 'üzenet')}`,
        { method: 'PATCH', body: JSON.stringify(payload) })
      assertOk(status, body)
      return { id: String((body as { id?: unknown }).id ?? messageId) }
    },

    async fetch (channelId: string, messageId: string): Promise<SentMessage | null> {
      const { status, body } = await request(
        `/channels/${safeId(channelId, 'csatorna')}/messages/${safeId(messageId, 'üzenet')}`)
      if (status === 404) return null
      assertOk(status, body)
      return { id: String((body as { id?: unknown }).id ?? messageId) }
    },

    /*
     * A SAJÁT ÜZENETÜNK TÖRLÉSE. A Discord 204-gyel felel, üres törzzsel.
     * A „már nincs meg" itt nem hiba: pont az az állapot, amit el akartunk
     * érni.
     */
    async remove (channelId: string, messageId: string): Promise<void> {
      const { status, body } = await request(
        `/channels/${safeId(channelId, 'csatorna')}/messages/${safeId(messageId, 'üzenet')}`,
        { method: 'DELETE' })
      if (status === 404 || body.code === 10008) return
      assertOk(status, body)
    },

    async canPost (channelId: string): Promise<boolean> {
      try {
        const perms = await channelPermissions(channelId)
        // NEM TUDJUK = MEGPRÓBÁLJUK. Lásd `channelPermissions`.
        if (perms === null) return true
        return canPostEmbed(perms)
      } catch (error) {
        // Ha a csatorna nincs meg, a küldésnek sincs értelme.
        if ((error as DiscordError).kind === 'channel_not_found') return false
        // Minden más bizonytalanságnál megpróbáljuk; a Discord hibája dönt.
        return true
      }
    }
  }
}

/**
 * Egy guild adatai — a `server_statistics` üzenethez.
 *
 * A `with_counts=true` nélkül a Discord NEM ad taglétszámot: a `guild`
 * objektum `member_count` mezője csak a gateway-en keresztül érkezik. A
 * közelítő számok viszont a REST-en is elérhetők, és ehhez pontosan
 * elegendők — egy statisztikai embedben a ±1 tag nem számít.
 *
 * NULL, HA NINCS TOKEN vagy nem érjük el. A hívó ilyenkor „—"-t ír, nem
 * nullát: a nulla azt állítaná, hogy a szervernek nincs tagja.
 */
export async function fetchGuild (guildId: string): Promise<{
  name: string, memberCount: number | null, onlineCount: number | null
} | null> {
  if (!isConfigured()) return null
  try {
    const { status, body } = await request(`/guilds/${safeId(guildId, 'guild')}?with_counts=true`)
    if (status >= 400) return null
    const b = body as { name?: unknown, approximate_member_count?: unknown, approximate_presence_count?: unknown }
    const szam = (v: unknown): number | null => typeof v === 'number' ? v : null
    return {
      name: typeof b.name === 'string' ? b.name : '',
      memberCount: szam(b.approximate_member_count),
      onlineCount: szam(b.approximate_presence_count)
    }
  } catch {
    return null
  }
}

/**
 * A guild CSATORNÁI és SZEREPKÖREI — a vezérlőpulthoz.
 *
 * EZ NEM IGÉNYEL PRIVILEGIZÁLT INTENTET. A taglista igen (`GUILD_MEMBERS`),
 * és azt a fejlesztői portálon kell engedélyezni — a csatornák és a
 * szerepkörök viszont a bot alap jogosultságaival lekérdezhetők. Ezért van
 * ez a két nézet valós adattal, miközben a tagstatisztika nincs.
 *
 * NULL, HA NEM ÉRJÜK EL. A hívó ilyenkor megmondja, miért nincs adat —
 * üres listát mutatni annyi volna, mint azt állítani, hogy a szerveren
 * nincs egyetlen csatorna sem.
 */
export async function fetchChannels (guildId: string): Promise<Array<{
  id: string, name: string, type: number, position: number, parentId: string | null
}> | null> {
  if (!isConfigured()) return null
  try {
    const { status, body } = await request(`/guilds/${safeId(guildId, 'guild')}/channels`)
    if (status >= 400 || !Array.isArray(body)) return null
    return (body as unknown as Array<Record<string, unknown>>).map(c => ({
      id: String(c.id ?? ''),
      name: String(c.name ?? ''),
      type: Number(c.type ?? -1),
      position: Number(c.position ?? 0),
      parentId: c.parent_id === null || c.parent_id === undefined ? null : String(c.parent_id)
    }))
  } catch {
    return null
  }
}

export async function fetchRoles (guildId: string): Promise<Array<{
  id: string, name: string, color: number, position: number, managed: boolean, permissions: string
}> | null> {
  if (!isConfigured()) return null
  try {
    const { status, body } = await request(`/guilds/${safeId(guildId, 'guild')}/roles`)
    if (status >= 400 || !Array.isArray(body)) return null
    return (body as unknown as Array<Record<string, unknown>>).map(r => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      color: Number(r.color ?? 0),
      position: Number(r.position ?? 0),
      managed: r.managed === true,
      permissions: String(r.permissions ?? '0')
    }))
  } catch {
    return null
  }
}

/** Üzemeltetői diagnosztika: mi hiányzik a bot jogosultságaiból egy csatornán. */
export async function diagnoseChannel (channelId: string): Promise<{
  ok: boolean, missing: string[], reason: string | null
}> {
  if (!isConfigured()) return { ok: false, missing: [], reason: 'nincs beállítva bot token' }
  try {
    const perms = await channelPermissions(channelId)
    if (perms === null) return { ok: true, missing: [], reason: 'a jogosultságok nem kérdezhetők le — a küldés dönt' }
    return { ok: canPostEmbed(perms), missing: missingForEmbed(perms), reason: null }
  } catch (error) {
    return { ok: false, missing: [], reason: (error as DiscordError).kind ?? 'unknown' }
  }
}

export { PERMISSION_BITS, hasBit }
