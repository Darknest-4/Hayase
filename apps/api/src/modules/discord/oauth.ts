/**
 * Discord OAuth — a YUME-fiók és a Discord-fiók összekötése.
 *
 * A YUME-FIÓK AZ ELSŐDLEGES IDENTITÁS (7.1. pont). Ez a folyamat NEM
 * bejelentkezés: a felhasználó már be van jelentkezve a YUME-ba, és itt
 * hozzákapcsolja a Discord-fiókját. Ezért nem hozunk létre munkamenetet, nem
 * adunk ki tokent, és nem nyúlunk a meglévő auth-rendszerhez.
 *
 * AMIT A DISCORDTÓL KÉRÜNK, ÉS AMIT NEM:
 *
 *   identify  — a Discord felhasználói azonosító. Ez az, amivel a tagságot
 *               és a jogosultságot össze tudjuk kötni.
 *   guilds    — mely szervereknek tagja, és milyen joggal. Enélkül nem lehet
 *               eldönteni, melyik guild vezérlőpultját nyithatja meg.
 *
 * NEM kérünk `email`-t, `connections`-t és `guilds.members.read`-et: egyikre
 * sincs szükség a vezérlőpulthoz, és amit nem kérünk, azt nem is tudjuk
 * elveszíteni.
 *
 * A TITOK SOHA NEM HAGYJA EL EZT A MODULT. Nem kerül naplóba, válaszba,
 * hibaüzenetbe és a frontendre sem. A `client_id` viszont nyilvános — az ott
 * áll minden meghívó címben.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { parsePermissions } from './permissions.ts'

const API_BASE = 'https://discord.com/api/v10'
const TIMEOUT_MS = Number(process.env.DISCORD_TIMEOUT_MS ?? 10_000)

/** A kért engedélyek. Bővíteni csak akkor, ha tényleg kell hozzá adat. */
export const SCOPES = ['identify', 'guilds'] as const

export function clientId (): string | null {
  const v = process.env.DISCORD_CLIENT_ID
  return v && v.trim() !== '' ? v.trim() : null
}

function clientSecret (): string | null {
  const v = process.env.DISCORD_CLIENT_SECRET
  return v && v.trim() !== '' ? v.trim() : null
}

/**
 * A visszairányítási cím.
 *
 * RÖGZÍTETT, NEM A KÉRÉSBŐL SZÁRMAZIK. Ha a kérés `Host` fejlécéből
 * építenénk, egy hamisított fejléc a Discord engedélyezési kódját idegen
 * címre vinné — és a Discord ezt nem is fogadná el, mert a portálon
 * regisztrált értékkel kell egyeznie. A rögzítés tehát nem korlátozás,
 * hanem a helyes működés feltétele.
 */
export function redirectUri (): string {
  return process.env.DISCORD_REDIRECT_URI?.trim() ||
    'https://discord.animehub.hu/v1/discord/oauth/callback'
}

export function isConfigured (): boolean {
  return clientId() !== null && clientSecret() !== null
}

// ---------------------------------------------------------------- állapot

/**
 * A CSRF-védelem: `state`.
 *
 * MIÉRT KELL. Enélkül egy támadó a SAJÁT Discord-fiókjának engedélyezési
 * kódjával nyithatná meg az áldozat visszairányítási címét — és onnantól az
 * áldozat YUME-fiókjához a TÁMADÓ Discord-fiókja lenne kötve. Az áldozat
 * guildjeit ettől nem látná, de a saját guildjeit igen, az áldozat nevében.
 *
 * A `state` a felhasználóhoz van kötve és lejár. NEM tároljuk nyersen: a
 * hash-ét tartjuk, hogy egy adatbázis-kiolvasás se adjon használható
 * kulcsot.
 */
const STATE_TTL_MS = 10 * 60_000

function hashState (state: string): string {
  return createHash('sha256').update(state).digest('hex')
}

export async function createState (userId: string): Promise<string> {
  const state = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO discord_oauth_states (state_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3::int || ' milliseconds')::interval)`,
    [hashState(state), userId, STATE_TTL_MS])
  return state
}

/**
 * Az állapot beváltása — EGYSZER HASZNÁLHATÓ.
 *
 * A törlés és az olvasás EGY utasításban: egy „megnézem, majd törlöm" minta
 * versenyben kétszer is beváltható kódot adna.
 */
export async function consumeState (state: string): Promise<string | null> {
  if (!state || state.length < 16) return null
  const row = await queryOne<{ user_id: string }>(
    `DELETE FROM discord_oauth_states
      WHERE state_hash = $1 AND expires_at > now()
      RETURNING user_id`,
    [hashState(state)])
  return row?.user_id ?? null
}

/** Lejárt állapotok takarítása. A megőrzési feladat hívja. */
export async function pruneStates (): Promise<number> {
  const rows = await query<{ n: number }>(
    `WITH d AS (DELETE FROM discord_oauth_states WHERE expires_at < now() RETURNING 1)
     SELECT count(*)::int AS n FROM d`)
  return rows[0]?.n ?? 0
}

// ---------------------------------------------------------------- folyamat

/** Az engedélyezési cím, ahova a felhasználót küldjük. */
export function authorizeUrl (state: string): string {
  const id = clientId()
  if (!id) throw new Error('nincs beállítva Discord client id')
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    // A felhasználó lássa, mit enged meg — még akkor is, ha korábban már
    // engedélyezte. Egy néma újraengedélyezés rossz szokás.
    prompt: 'consent'
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}

interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

/**
 * A kód beváltása hozzáférési tokenre.
 *
 * A TOKENT NEM TÁROLJUK. Egyszer használjuk — lekérjük vele a felhasználót és
 * a guildjeit —, aztán eldobjuk. Egy eltárolt hozzáférési token olyan
 * kockázat, aminek nincs haszna: a jogosultságot amúgy is frissen kell
 * lekérdezni (7.2. pont), és egy lejárt tokennel az sem megy.
 */
async function exchangeCode (code: string): Promise<string> {
  const id = clientId()
  const secret = clientSecret()
  if (!id || !secret) throw new Error('nincs beállítva Discord OAuth')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri()
      }),
      signal: controller.signal
    })
    const body = await res.json() as TokenResponse & { error?: string }
    if (!res.ok || !body.access_token) {
      // A Discord hibakódja mehet; a titok és a kód nem.
      throw new Error(`a Discord elutasította a kódot: ${String(body.error ?? res.status)}`)
    }
    return body.access_token
  } finally {
    clearTimeout(timer)
  }
}

async function fetchAs<T> (token: string, path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`Discord HTTP ${res.status}`)
    return await res.json() as T
  } finally {
    clearTimeout(timer)
  }
}

export interface LinkedAccount {
  discordUserId: string
  username: string | null
  guilds: number
}

/**
 * A folyamat lezárása: a fiók összekötése és a guildek eltárolása.
 *
 * A DISCORD USER ID AZ AZONOSÍTÓ, NEM A FELHASZNÁLÓNÉV. A név
 * megváltoztatható; az azonosító nem. Egy névre épülő összerendelés a
 * következő névváltásnál idegen fiókot engedne be.
 */
export async function completeLink (userId: string, code: string): Promise<LinkedAccount> {
  const token = await exchangeCode(code)

  const me = await fetchAs<{ id?: string, username?: string }>(token, '/users/@me')
  const discordUserId = String(me.id ?? '')
  if (!/^\d{17,20}$/.test(discordUserId)) throw new Error('a Discord érvénytelen azonosítót adott')

  /*
   * EGY DISCORD-FIÓK EGY YUME-FIÓKHOZ. Az egyedi index ezt az adatbázisban
   * is kikényszeríti; itt csak a hibaüzenet lesz emberi. Enélkül két
   * YUME-fiók ugyanarra a Discord-azonosítóra hivatkozhatna, és a
   * jogosultság-ellenőrzés megkerülhető lenne egy második fiók
   * létrehozásával.
   */
  const masnal = await queryOne<{ user_id: string }>(
    'SELECT user_id FROM discord_links WHERE discord_user_id = $1 AND user_id <> $2',
    [discordUserId, userId])
  if (masnal) throw new Error('ez a Discord-fiók már egy másik YUME-fiókhoz van kötve')

  await query(
    `INSERT INTO discord_links (user_id, discord_user_id, discord_username)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET discord_user_id = excluded.discord_user_id,
           discord_username = excluded.discord_username,
           updated_at = now()`,
    [userId, discordUserId, typeof me.username === 'string' ? me.username.slice(0, 64) : null])

  const guilds = await syncGuilds(discordUserId, token)
  return {
    discordUserId,
    username: typeof me.username === 'string' ? me.username : null,
    guilds
  }
}

interface GuildRow {
  id?: string
  name?: string
  owner?: boolean
  permissions?: string
}

/**
 * A guildek frissítése.
 *
 * A RÉGI SOROKAT TÖRÖLJÜK. Ha valaki kilép egy szerverből, a tagsága nem
 * maradhat ott örökre — különben a vezérlőpult egy olyan guildhez engedné be,
 * amihez már semmi köze. A `fetched_at` a frissesség jele; a törlés a
 * megszűnt tagságé.
 */
export async function syncGuilds (discordUserId: string, accessToken: string): Promise<number> {
  const lista = await fetchAs<GuildRow[]>(accessToken, '/users/@me/guilds')
  if (!Array.isArray(lista)) return 0

  const ervenyes = lista.filter(g => typeof g.id === 'string' && /^\d{17,20}$/.test(g.id))

  await query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [discordUserId])
  if (!ervenyes.length) return 0

  await query(
    `INSERT INTO discord_guild_members (discord_user_id, guild_id, guild_name, owner, permissions, fetched_at)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::boolean[], $5::text[]), now()`,
    [discordUserId,
      ervenyes.map(g => g.id!),
      ervenyes.map(g => typeof g.name === 'string' ? g.name.slice(0, 100) : null),
      ervenyes.map(g => g.owner === true),
      // A jogosultság sztringként érkezik és sztringként tároljuk: 64 bites
      // érték, amit a `number` nem bír el.
      ervenyes.map(g => parsePermissions(g.permissions).toString())])

  return ervenyes.length
}

/** A felhasználó összekötött fiókja, ha van. */
export async function linkOf (userId: string): Promise<{
  discordUserId: string, username: string | null, linkedAt: Date
} | null> {
  const row = await queryOne<{ discord_user_id: string, discord_username: string | null, linked_at: Date }>(
    'SELECT discord_user_id, discord_username, linked_at FROM discord_links WHERE user_id = $1', [userId])
  return row
    ? { discordUserId: row.discord_user_id, username: row.discord_username, linkedAt: row.linked_at }
    : null
}

/** Az összekötés bontása. A guild-tagságok is mennek vele. */
export async function unlink (userId: string): Promise<boolean> {
  const row = await queryOne<{ discord_user_id: string }>(
    'DELETE FROM discord_links WHERE user_id = $1 RETURNING discord_user_id', [userId])
  if (!row) return false
  await query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [row.discord_user_id])
  return true
}

/** Időzítés-független összehasonlítás. A `state` ellenőrzéséhez. */
export function safeEqual (a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}
