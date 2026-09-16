// Az oldalletöltések begyűjtése — a kérési úton kívül.
//
// Egy látogatottsági rendszer legkönnyebb elrontása az, hogy minden
// oldalletöltés egy adatbázis-írás a kérésben. Kétszáz kérés/mp-nél az kétszáz
// plusz írás másodpercenként, mindegyik egy tranzakció, és a látogatottság
// méréséből a lassulás oka lesz.
//
// Ezért: memóriában gyűlik, kötegben megy ki. Egy összeomlásnál elveszik pár
// másodpercnyi statisztika — ez a helyes csere. Egy kimutatás pontatlansága
// nem baj, egy lassú oldal az.
//
// A MUNKAMENET kiszámított, nem a klienstől kapott.
//
// Nincs süti és nincs kliensoldali azonosító. Egy munkamenet = ugyanaz a napi
// látogatókulcs, harminc percnél rövidebb szünetekkel. Ennek három
// következménye van, és mind a három szándékos:
//
//   * a kliens nem tudja megválasztani, melyik munkamenethez tartozik, tehát
//     nem tudja se felfújni, se összemosni őket;
//   * nem kell hozzá hozzájárulási sáv, mert nem tárolunk semmit a
//     böngészőben;
//   * a napi só miatt a munkamenetek napokon át nem fűzhetők össze — a
//     „visszatérő látogató" csak a bejelentkezetteknél pontos, és a kimutatás
//     ezt ki is mondja.

import { query } from '../../infrastructure/database/index.ts'
import { referrerHost, screenClass, shapeOf, visitorKey, type VisitorShape } from './visitor.ts'

/** Meddig tart egy munkamenet tétlenül. Harminc perc az iparági megegyezés. */
const SESSION_GAP_MIN = 30

/** Kötegméret és ütem. Amelyik előbb betelik. */
const MAX_BUFFER = Number(process.env.ANALYTICS_BUFFER ?? 500)
const FLUSH_MS = Number(process.env.ANALYTICS_FLUSH_MS ?? 5000)

/**
 * Ugyanaz a látogató, ugyanaz az oldal, ezen belül: egy letöltés.
 *
 * Ez fogja meg a kettős lapokat, a frissítgetést és a duplán elsütött
 * beacont. Nem tökéletes — nem is kell annak lennie: a cél az, hogy a
 * számok ne legyenek felfújhatók egy F5 nyomva tartásával.
 */
const DEDUPE_MS = 10_000

export interface ViewEvent {
  visitorKey: string
  userId: string | null
  route: string
  entityId: string | null
  referrerHost: string | null
  utm: { source: string | null, medium: string | null, campaign: string | null }
  shape: VisitorShape
  screen: string
  language: string | null
  country: string | null
  at: Date
}

let buffer: ViewEvent[] = []
let timer: NodeJS.Timeout | undefined
const recent = new Map<string, number>()

/**
 * A duplikátumszűrő emlékezetének karbantartása.
 *
 * Előbb a lejárt bejegyzések mennek. Ha ezek után is a határ fölött van — mert
 * valaki tízezer KÜLÖNBÖZŐ útvonalat küldött egy másodpercen belül, és akkor
 * egyik sem lejárt —, akkor az egészet eldobjuk. A csere tudatos: a
 * duplikátumszűrés egy pillanatra elveszik, a memória viszont nem nő
 * korlátlanul egy nyilvános, hitelesítés nélküli végpontról.
 */
const MAX_DEDUPE_KEYS = 20_000

function prune (now: number): void {
  if (recent.size < 10_000) return
  for (const [key, at] of recent) if (now - at > DEDUPE_MS) recent.delete(key)
  if (recent.size > MAX_DEDUPE_KEYS) recent.clear()
}

/**
 * Egy oldalletöltés felvétele a sorba.
 *
 * Nem ír adatbázisba és nem vár semmire. Ha a köteg betelt, kiürítést indít,
 * de azt sem várja meg.
 */
export function enqueueView (event: ViewEvent): 'accepted' | 'duplicate' {
  const now = event.at.getTime()
  const key = `${event.visitorKey}|${event.route}|${event.entityId ?? ''}`
  const last = recent.get(key)
  if (last !== undefined && now - last < DEDUPE_MS) return 'duplicate'
  recent.set(key, now)
  prune(now)

  buffer.push(event)
  if (buffer.length >= MAX_BUFFER) void flush()
  else if (!timer) timer = setTimeout(() => { void flush() }, FLUSH_MS).unref()
  return 'accepted'
}

/**
 * A köteg kiírása.
 *
 * Két lépés, és mindkettő halmazműveletként megy, nem soronként:
 *
 *   1. munkamenetek — minden látogatókulcsra egy sor, a legutóbbi élő
 *      munkamenetre rá, vagy új. Az `ON CONFLICT` a kulcson dönt, nem
 *      egy „megnézem, majd beszúrom" minta, ami versenyben duplikálna.
 *   2. oldalletöltések — egyetlen többsoros INSERT.
 */
export async function flush (): Promise<number> {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (!buffer.length) return 0
  const batch = buffer
  buffer = []

  try {
    // ---- 1. munkamenetek ----
    // Munkamenet-kulcs: a látogató napi kulcsa + az ablak kezdete. Így két
    // kérés ugyanabban a harmincperces ablakban ugyanazt a kulcsot adja,
    // számítás nélkül, és a kliensnek semmit nem kell tárolnia.
    const sessions = new Map<string, ViewEvent[]>()
    for (const event of batch) {
      const window = Math.floor(event.at.getTime() / (SESSION_GAP_MIN * 60_000))
      const key = `${event.visitorKey}:${window}`
      const list = sessions.get(key)
      if (list) list.push(event); else sessions.set(key, [event])
    }

    for (const [sessionKey, events] of sessions) {
      const first = events[0]!
      const last = events[events.length - 1]!
      await query(
        `INSERT INTO analytics_sessions
           (session_key, visitor_key, user_id, started_at, last_seen_at, page_views,
            entry_route, exit_route, referrer_host, utm_source, utm_medium, utm_campaign,
            device_class, browser, os, language, screen_class, country, is_bot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (session_key) DO UPDATE SET
           last_seen_at = GREATEST(analytics_sessions.last_seen_at, EXCLUDED.last_seen_at),
           page_views   = analytics_sessions.page_views + EXCLUDED.page_views,
           exit_route   = EXCLUDED.exit_route,
           -- A fiók akkor kerül rá, amikor bejelentkezik: egy munkamenet
           -- kezdődhet névtelenül és folytatódhat bejelentkezve.
           user_id      = COALESCE(EXCLUDED.user_id, analytics_sessions.user_id)`,
        [
          sessionKey, first.visitorKey, first.userId, first.at, last.at, events.length,
          first.route, last.route, first.referrerHost,
          first.utm.source, first.utm.medium, first.utm.campaign,
          first.shape.deviceClass, first.shape.browser, first.shape.os,
          first.language, first.screen, first.country, first.shape.isBot
        ]
      )
    }

    // ---- 2. oldalletöltések ----
    // Tömbökkel, egyetlen utasításban: a terv gyorsítótárazható, és a
    // sorszám nem szerepel a lekérdezés szövegében.
    await query(
      `INSERT INTO page_views (session_key, profile_id, route, entity_id, referrer, platform, country, created_at)
       SELECT * FROM unnest(
         $1::text[], $2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::bpchar[], $8::timestamptz[])`,
      [
        batch.map(e => `${e.visitorKey}:${Math.floor(e.at.getTime() / (SESSION_GAP_MIN * 60_000))}`),
        // A page_views `profile_id`-t ismer, nem felhasználót; a látogatottság
        // szintjén a kettő különbsége nem érdekes, és a profil az, amihez a
        // nézési adatok is kötődnek.
        batch.map(() => null),
        batch.map(e => e.route.slice(0, 200)),
        batch.map(e => e.entityId),
        batch.map(e => e.referrerHost),
        batch.map(e => e.shape.deviceClass),
        batch.map(e => e.country),
        batch.map(e => e.at)
      ]
    )
    return batch.length
  } catch (error) {
    // A kiírás hibája nem kerülhet vissza a kérésbe: a felhasználó lapja
    // megjelent, és a statisztika nem ér annyit, hogy ezt elrontsa.
    console.error('analytics flush failed:', (error as Error).message)
    return 0
  }
}

/** Leálláskor: ami a pufferben van, még menjen ki. */
export async function drain (): Promise<void> { await flush() }

/** Teszthez: hány esemény vár kiírásra. */
export function pending (): number { return buffer.length }

/** Teszthez: felejtse el a dedupe-előzményt. */
export function resetDedupe (): void { recent.clear() }

export { referrerHost, screenClass, shapeOf, visitorKey }
