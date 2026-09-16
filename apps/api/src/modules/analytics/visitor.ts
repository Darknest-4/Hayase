// Ki ez a látogató — annyira, amennyire tudni kell, és nem tovább.
//
// Egy látogatottsági kimutatáshoz két dolog kell: meg lehessen mondani, hogy
// két kérés ugyanattól az emberrel jött-e (különben minden oldalletöltés külön
// „látogató"), és ne lehessen megmondani, hogy KI az.
//
// A megoldás egy napi sóval képzett hash. Ugyanaz a látogató holnap MÁS
// kulcsot kap, mert a só cserélődik és a tegnapit eldobjuk. Ez szándékos
// veszteség:
//
//   * a napon belüli egyediséghez elég ("ma hány ember járt itt"),
//   * a napokon átívelő követéshez NEM elég, és nem is tesszük azzá.
//
// Ennek ára van: a „visszatérő látogató" ebből csak a bejelentkezetteknél
// pontos. Ezt a jelentés ki is mondja, ahelyett hogy egy örök azonosítóval
// pontosabbnak látszana annál, amit egy anime-katalógusnak tudnia kell.
//
// A nyers IP SEHOL nem kerül a látogatottsági táblákba. Biztonsági naplóba
// igen (`security_logs`) — ott más a kérdés: „ki próbálkozott", és ahhoz a
// cím maga kell.

import { createHash, randomBytes } from 'node:crypto'

import { query, queryOne } from '../../infrastructure/database/index.ts'

import type { FastifyRequest } from 'fastify'

export interface VisitorShape {
  deviceClass: 'mobile' | 'tablet' | 'desktop' | 'tv' | 'bot' | 'unknown'
  browser: string
  os: string
  isBot: boolean
}

// ---- a napi só -------------------------------------------------------------

let cached: { day: string, salt: string } | undefined

/**
 * A mai só.
 *
 * Az adatbázisban él, nem a folyamat memóriájában: két worker és egy app
 * ugyanazt a kulcsot kell hogy számolja, különben ugyanaz a látogató
 * példányonként más azonosítót kapna, és az egyedi látogatók száma a
 * konténerek számával szorzódna.
 *
 * Verseny esetén az `ON CONFLICT DO NOTHING` + visszaolvasás dönt: két
 * egyidejű első kérés közül a második a másik sóját kapja, nem a sajátját.
 */
export async function dailySalt (now = new Date()): Promise<string> {
  const day = now.toISOString().slice(0, 10)
  if (cached?.day === day) return cached.salt

  await query(
    'INSERT INTO analytics_salt (day, salt) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING',
    [day, randomBytes(32).toString('base64')]
  )
  const row = await queryOne<{ salt: string }>('SELECT salt FROM analytics_salt WHERE day = $1', [day])
  cached = { day, salt: row?.salt ?? '' }
  return cached.salt
}

/** Teszthez és a megőrzési feladathoz: felejtse el, amit megjegyzett. */
export function forgetSalt (): void { cached = undefined }

/**
 * A látogató napi kulcsa.
 *
 * Cím + böngészőazonosító + a napi só. Rövidítve tároljuk: 32 hexjegy bőven
 * elég ahhoz, hogy ütközés gyakorlatilag ne legyen, és rövidebb sor kevesebb
 * hely egy táblában, ami naponta nő.
 */
export async function visitorKey (ip: string, userAgent: string, now = new Date()): Promise<string> {
  const salt = await dailySalt(now)
  return createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 32)
}

// ---- a böngésző ------------------------------------------------------------
//
// Saját osztályozó, nem függőség. Egy teljes UA-elemző könyvtár több ezer
// szabályt visz be, havonta frissül, és pontosan azt a kérdést válaszolja meg,
// amit itt NEM kérdezünk: „pontosan melyik készülék". Amit kérdezünk, az hat
// kategória, és ahhoz ennyi elég.
//
// Ami nem ismerhető fel, az 'unknown' marad. Nem tippelünk: egy rossz
// kategória rosszabb, mint egy üres.

const BOTS = /bot|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview|headlesschrome|lighthouse|pingdom|uptime|curl\/|wget|python-requests|go-http-client|axios\//i

/** Böngésző — sorrend számít: a Chrome UA-ja az Edge-ben is benne van. */
const BROWSERS: Array<[RegExp, string]> = [
  [/edg(?:e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox\/|fxios/i, 'Firefox'],
  [/chrome\/|crios/i, 'Chrome'],
  // A Safari minden WebKit-alapú UA-ban szerepel, ezért ez van a legvégén.
  [/safari\//i, 'Safari']
]

const SYSTEMS: Array<[RegExp, string]> = [
  [/windows nt/i, 'Windows'],
  [/android/i, 'Android'],
  // Az iPadOS asztali Safarinak adja ki magát; a 'macintosh' ág ezért nem elég.
  [/iphone|ipod/i, 'iOS'],
  [/ipad/i, 'iPadOS'],
  [/mac os x|macintosh/i, 'macOS'],
  [/cros/i, 'ChromeOS'],
  [/linux/i, 'Linux']
]

/** Milyen készülékről jött — kategória, nem ujjlenyomat. */
export function shapeOf (userAgent: string | undefined): VisitorShape {
  const ua = userAgent ?? ''
  if (!ua) return { deviceClass: 'unknown', browser: 'ismeretlen', os: 'ismeretlen', isBot: false }
  if (BOTS.test(ua)) return { deviceClass: 'bot', browser: 'robot', os: 'ismeretlen', isBot: true }

  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'egyéb'
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'egyéb'

  let deviceClass: VisitorShape['deviceClass'] = 'desktop'
  if (/smart-?tv|appletv|googletv|crkey|bravia|webos|tizen/i.test(ua)) deviceClass = 'tv'
  else if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) deviceClass = 'tablet'
  else if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) deviceClass = 'mobile'

  return { deviceClass, browser, os, isBot: false }
}

/** Képernyősáv a szélességből. Sáv, nem pixel: a pontos méret azonosít. */
export function screenClass (width: unknown): 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'unknown' {
  const w = Number(width)
  if (!Number.isFinite(w) || w <= 0 || w > 10000) return 'unknown'
  if (w < 480) return 'xs'
  if (w < 768) return 'sm'
  if (w < 1024) return 'md'
  if (w < 1600) return 'lg'
  return 'xl'
}

/**
 * A hivatkozó — csak a gazdagép, az útvonal nélkül.
 *
 * Egy teljes hivatkozó URL tartalmazhat keresőkifejezést, munkamenet-azonosítót
 * vagy épp egy magánoldal címét. A kérdés, amire válaszolni akarunk, az, hogy
 * „honnan jönnek", és ahhoz a gazdagép elég.
 */
export function referrerHost (referrer: unknown, selfHost?: string): string | null {
  if (typeof referrer !== 'string' || !referrer) return null
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    if (!host) return null
    // A saját oldalunkról érkező hivatkozás nem „forrás", hanem navigáció.
    if (selfHost && host === selfHost.toLowerCase()) return null
    return host.slice(0, 120)
  } catch { return null }
}

/** A kliens nyelve — csak a fő címke, nem a teljes elfogadási lista. */
export function languageOf (request: FastifyRequest): string | null {
  const raw = request.headers['accept-language']
  if (typeof raw !== 'string' || !raw) return null
  const first = raw.split(',')[0]?.trim().slice(0, 12)
  return first ? first.toLowerCase() : null
}
