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

/**
 * ---- A SETUP ÍRÓ MŰVELETEI ----
 *
 * MIND `null`-T AD VISSZA HIBA ESETÉN, nem dob. A setup tucatnyi lépésből
 * áll, és egy elbukott lépés nem szakíthatja félbe a többit: a hívó
 * lépésenként jegyzi az eredményt, és a végén megmondja, mi sikerült és mi
 * nem. Egy kivétel itt azt jelentené, hogy az első jogosultsági hiba után
 * semmi más nem történik — és a felhasználó egy félbehagyott szervert kap
 * anélkül, hogy tudná, mi maradt ki.
 *
 * A HIBA OKA NEM VÉSZ EL: a `lastError` mezőben marad, és a hívó kiolvassa.
 */
let utolsoHiba: string | null = null

/** A legutóbbi író művelet hibája, ha volt. A hívó ezt teszi a naplóba. */
export function lastError (): string | null {
  return utolsoHiba
}

async function ir (
  path: string, method: string, body?: unknown, reason?: string
): Promise<Record<string, unknown> | null> {
  utolsoHiba = null
  try {
    const { status, body: valasz } = await request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      /*
       * AZ AUDIT REASON A DISCORD SAJÁT NAPLÓJÁBA MEGY. Enélkül a szerver
       * naplójában csak annyi állna, hogy „YUME Bot törölt egy csatornát" —
       * így az is, hogy miért. A fejléc URL-kódolt, mert ékezetes.
       */
      ...(reason ? { headers: { 'x-audit-log-reason': encodeURIComponent(reason).slice(0, 500) } } : {})
    })
    if (status >= 400) {
      const kod = typeof valasz.code === 'number' ? valasz.code : null
      utolsoHiba = `${kindOf(status, kod)}: ${typeof valasz.message === 'string' ? valasz.message : 'HTTP ' + status}`
      return null
    }
    return valasz
  } catch (error) {
    utolsoHiba = String((error as DiscordError)?.kind ?? (error as Error)?.message ?? 'ismeretlen hiba')
    return null
  }
}

export interface PermissionOverwrite {
  /** Szerepkör vagy felhasználó azonosítója. */
  id: string
  /** 0 = szerepkör, 1 = tag. */
  type: 0 | 1
  allow: string
  deny: string
}

export async function createChannel (guildId: string, mezok: {
  name: string
  type: number
  parentId?: string | null
  topic?: string
  position?: number
  overwrites?: PermissionOverwrite[]
}, reason: string): Promise<{ id: string } | null> {
  const valasz = await ir(`/guilds/${safeId(guildId, 'guild')}/channels`, 'POST', {
    name: mezok.name,
    type: mezok.type,
    ...(mezok.parentId ? { parent_id: mezok.parentId } : {}),
    ...(mezok.topic ? { topic: mezok.topic.slice(0, 1024) } : {}),
    ...(mezok.position !== undefined ? { position: mezok.position } : {}),
    ...(mezok.overwrites ? { permission_overwrites: mezok.overwrites } : {})
  }, reason)
  const id = valasz?.id
  return typeof id === 'string' ? { id } : null
}

export async function editChannel (channelId: string, mezok: {
  name?: string
  topic?: string
  parentId?: string | null
  position?: number
  overwrites?: PermissionOverwrite[]
}, reason: string): Promise<boolean> {
  const valasz = await ir(`/channels/${safeId(channelId, 'csatorna')}`, 'PATCH', {
    ...(mezok.name ? { name: mezok.name } : {}),
    ...(mezok.topic !== undefined ? { topic: mezok.topic.slice(0, 1024) } : {}),
    ...(mezok.parentId !== undefined ? { parent_id: mezok.parentId } : {}),
    ...(mezok.position !== undefined ? { position: mezok.position } : {}),
    ...(mezok.overwrites ? { permission_overwrites: mezok.overwrites } : {})
  }, reason)
  return valasz !== null
}

/**
 * Csatorna törlése.
 *
 * A „MÁR NINCS MEG" SIKER. Pont az az állapot, amit el akartunk érni — ha
 * hibának vennénk, egy kézzel letörölt csatorna örökre elakasztaná a
 * takarítást.
 */
export async function deleteChannel (channelId: string, reason: string): Promise<boolean> {
  const valasz = await ir(`/channels/${safeId(channelId, 'csatorna')}`, 'DELETE', undefined, reason)
  if (valasz !== null) return true
  return String(utolsoHiba).startsWith('channel_not_found') || String(utolsoHiba).startsWith('message_not_found')
}

export async function createRole (guildId: string, mezok: {
  name: string
  color: number
  hoist: boolean
  mentionable: boolean
  permissions: string
}, reason: string): Promise<{ id: string } | null> {
  const valasz = await ir(`/guilds/${safeId(guildId, 'guild')}/roles`, 'POST', {
    name: mezok.name,
    color: mezok.color,
    hoist: mezok.hoist,
    mentionable: mezok.mentionable,
    permissions: mezok.permissions
  }, reason)
  const id = valasz?.id
  return typeof id === 'string' ? { id } : null
}

export async function editRole (guildId: string, roleId: string, mezok: {
  name?: string
  color?: number
  hoist?: boolean
  mentionable?: boolean
  permissions?: string
}, reason: string): Promise<boolean> {
  const valasz = await ir(
    `/guilds/${safeId(guildId, 'guild')}/roles/${safeId(roleId, 'rang')}`, 'PATCH', mezok, reason)
  return valasz !== null
}

export async function deleteRole (guildId: string, roleId: string, reason: string): Promise<boolean> {
  const valasz = await ir(
    `/guilds/${safeId(guildId, 'guild')}/roles/${safeId(roleId, 'rang')}`, 'DELETE', undefined, reason)
  if (valasz !== null) return true
  // A Discord ismeretlen rangra 10011-et ad; az is a kívánt végállapot.
  return String(utolsoHiba).includes('Unknown Role') || String(utolsoHiba).startsWith('message_not_found')
}

/** Rang hozzáadása egy taghoz — a welcome rendszerhez. */
export async function addMemberRole (
  guildId: string, userId: string, roleId: string, reason: string
): Promise<boolean> {
  const valasz = await ir(
    `/guilds/${safeId(guildId, 'guild')}/members/${safeId(userId, 'tag')}/roles/${safeId(roleId, 'rang')}`,
    'PUT', undefined, reason)
  return valasz !== null
}

/**
 * A BOT SAJÁT TAGSÁGA a guildben — ebből derül ki a rang-hierarchiája.
 *
 * MIÉRT KELL. A Discord nem engedi, hogy a bot olyan rangot kezeljen, ami a
 * sajátja FÖLÖTT van. Ha ezt nem néznénk meg előre, a setup nekifutna, és a
 * Discord 50013-mal utasítaná vissza — a felhasználó pedig egy
 * „hiányzó jogosultság" hibát látna anélkül, hogy megtudná, a rangsorrenden
 * múlik.
 */
export async function botMember (guildId: string): Promise<{ roles: string[] } | null> {
  if (!isConfigured()) return null
  try {
    const { status, body } = await request(`/guilds/${safeId(guildId, 'guild')}/members/@me`)
    if (status >= 400) return null
    const roles = (body as { roles?: unknown }).roles
    return { roles: Array.isArray(roles) ? roles.map(String) : [] }
  } catch {
    return null
  }
}

/** A bot saját alkalmazásazonosítója — a parancsregisztrációhoz. */
export async function applicationId (): Promise<string | null> {
  if (!isConfigured()) return null
  try {
    const { status, body } = await request('/applications/@me')
    if (status >= 400) return null
    const id = (body as { id?: unknown }).id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/**
 * SLASH PARANCSOK REGISZTRÁLÁSA — guild szinten.
 *
 * GUILD SZINTŰ, NEM GLOBÁLIS, és ez tudatos: a globális parancsok akár egy
 * órát is késhetnek, amíg megjelennek, a guild szintűek azonnal. Egy
 * setupnál, amit az üzemeltető épp néz, az egy óra használhatatlan.
 *
 * A `PUT` a teljes listát cseréli: ami nincs benne, az eltűnik. Ezért ez
 * egyben a „töröld a régieket" művelet is.
 */
export async function registerCommands (
  guildId: string, commands: unknown[]
): Promise<{ count: number } | null> {
  const appId = await applicationId()
  if (!appId) return null
  const valasz = await ir(
    `/applications/${safeId(appId, 'alkalmazás')}/guilds/${safeId(guildId, 'guild')}/commands`,
    'PUT', commands)
  if (valasz === null) return null
  // A `PUT` tömbbel válaszol; az `ir` objektumként tipizálja, ezért itt
  // olvassuk ki a hosszát.
  const lista = valasz as unknown
  return { count: Array.isArray(lista) ? lista.length : 0 }
}

/** A guildben regisztrált parancsok — az állapot kiírásához. */
export async function listCommands (guildId: string): Promise<Array<{ name: string }> | null> {
  const appId = await applicationId()
  if (!appId) return null
  try {
    const { status, body } = await request(
      `/applications/${safeId(appId, 'alkalmazás')}/guilds/${safeId(guildId, 'guild')}/commands`)
    if (status >= 400 || !Array.isArray(body)) return null
    return (body as unknown as Array<Record<string, unknown>>).map(c => ({ name: String(c.name ?? '') }))
  } catch {
    return null
  }
}

/**
 * VÁLASZ EGY INTERAKCIÓRA.
 *
 * HÁROM MÁSODPERC. A Discord ennyit vár a válaszra, utána a felhasználónak
 * azt írja ki, hogy „a bot nem válaszolt" — akkor is, ha a válasz egy
 * másodperccel később megérkezik. Ezért a parancskezelők előbb válaszolnak,
 * és csak utána dolgoznak, ha hosszabb munka kell.
 *
 * A HITELESÍTÉS ITT AZ INTERAKCIÓ TOKENJE, nem a bot tokenje — a Discord
 * ezt adja az eseménnyel, és tizenöt percig érvényes.
 */
export async function respondToInteraction (
  interactionId: string, token: string, payload: unknown
): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(
        `${API_BASE}/interactions/${safeId(interactionId, 'interakció')}/${encodeURIComponent(token)}/callback`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'YumeBot (https://animehub.hu, 1.0)' },
          body: JSON.stringify(payload),
          signal: controller.signal
        })
      return res.status < 400
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

/** Privát üzenet egy tagnak — a welcome DM-hez. Kétlépcsős a Discordnál. */
export async function sendDirectMessage (
  userId: string, payload: unknown
): Promise<boolean> {
  const csatorna = await ir('/users/@me/channels', 'POST', { recipient_id: safeId(userId, 'tag') })
  const id = csatorna?.id
  if (typeof id !== 'string') return false
  const uzenet = await ir(`/channels/${id}/messages`, 'POST', payload)
  return uzenet !== null
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
