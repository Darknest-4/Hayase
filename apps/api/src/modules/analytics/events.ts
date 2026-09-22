/**
 * AZ EGYSÉGES ESEMÉNYSÉMA — egy boríték minden új eseményfajtának.
 *
 * MIÉRT KELL, ha már van öt eseménytáblánk. Mert azok mind SAJÁT ALAKÚAK, és
 * ez két dolgot lehetetlenné tesz: új eseményfajtát csak új táblával lehet
 * felvenni, és két eseményfajta között nem lehet összefüggést nézni.
 *
 * A MÁSODIKRA VAN KONKRÉT PÉLDA, és elsősorban emiatt született ez a modul: a
 * „keresés → megnyitás" arány. A keresést mérjük, a megnyitást is, de a
 * KETTŐ KÖZTI kapcsolatot nem — pedig egy katalógusnál ez az egyik
 * legfontosabb szám: megtalálják-e, amit keresnek.
 *
 * A MEGLÉVŐ TÁBLÁKAT NEM ÍRJUK ÁT. Ez az ÚJ eseményeké, meg azoké, amiknek ma
 * nincs otthonuk. Egy működő, indexelt, összesített rendszert átköltöztetni
 * egy általános alakra kockázat haszon nélkül: ugyanazok a számok jönnének,
 * lassabban.
 *
 * A TÍPUSOK ZÁRT SZÓTÁRA a kódban van. Egy szabad szöveg némán új
 * eseményfajtát hozna létre egy elgépelt névből, és a kimutatásból pont az
 * hiányozna, amit mérni akartunk.
 */

import { createHash, randomUUID } from 'node:crypto'

import { query } from '../../infrastructure/database/index.ts'

/**
 * Amit mérünk. ZÁRT UNIÓ — új fajta ide kerül, nem a hívóhoz.
 *
 * A pont-elválasztás nem díszítés: az első tag a terület, a második a tárgy,
 * a harmadik a művelet. Így egy `search.%` lekérdezés az egész területet
 * megkapja, és a nevek nem csúsznak szét hívónként.
 */
export const EVENT_TYPES = [
  /** Keresési találatra kattintás — ez köti össze a keresést a megnyitással. */
  'search.result.open',
  /** Cím megnyitása bárhonnan. */
  'anime.open',
  /** Epizód megnyitása. */
  'episode.open',
  /** Könyvtárba vétel. */
  'library.add',
  /** Kedvencekhez adás. */
  'favorite.add'
] as const

export type EventType = typeof EVENT_TYPES[number]

export function isEventType (value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}

export interface YumeEvent {
  type: EventType
  /** A bejelentkezett felhasználó — VAGY a látogatói kulcs, soha nem mindkettő. */
  userId?: string | null
  visitorKey?: string | null
  subjectType?: string | null
  subjectId?: string | null
  metadata?: Record<string, unknown>
  at?: Date
  /** Saját azonosító idempotens újraküldéshez. Ha nincs, generálunk. */
  eventId?: string
}

/** Meddig számít ugyanannak. Lásd `dedupeKey`. */
export const DEDUPE_WINDOW_MS = Number(process.env.ANALYTICS_EVENT_DEDUPE_MS ?? 10_000)

/**
 * A DEDUPLIKÁCIÓS KULCS — IDŐABLAKOS, és ez a lényeg.
 *
 * Egy tartósan egyedi kulcs azt jelentené, hogy ugyanaz a felhasználó
 * ugyanazt SOHA többé nem csinálhatja — pedig egy címet kétszer is meg lehet
 * nyitni. A kulcsban ezért benne van egy időszelet: ugyanaz az esemény
 * ugyanabban a tíz másodpercben EGY, két perc múlva viszont MÁSIK.
 *
 * Ez pontosan az a viselkedés, amit az oldalletöltés-gyűjtő memóriában már
 * csinál — csak itt tartósan, és több PÉLDÁNY között is: az adatbázis egyedi
 * indexe dönt, nem egy folyamat memóriája. Két worker ugyanazt az eseményt
 * nem tudja kétszer beírni.
 *
 * A HASH-BEN NINCS NYERS AZONOSÍTÓ. A kulcs úgyis csak összehasonlításra
 * szolgál, és így egy adatbázis-kiolvasás sem ad belőle vissza semmit.
 */
export function dedupeKey (e: YumeEvent, at: Date = e.at ?? new Date()): string {
  const szelet = Math.floor(at.getTime() / DEDUPE_WINDOW_MS)
  const ki = e.userId ?? e.visitorKey ?? 'nevtelen'
  return createHash('sha256')
    .update([e.type, ki, e.subjectType ?? '', e.subjectId ?? '', String(szelet)].join('|'))
    .digest('hex')
    .slice(0, 32)
}

// ---------------------------------------------------------------- a gyűjtő

interface Sor {
  eventId: string
  type: string
  userId: string | null
  visitorKey: string | null
  subjectType: string | null
  subjectId: string | null
  metadata: string
  dedupe: string
  at: Date
}

const MAX = Number(process.env.ANALYTICS_EVENT_BUFFER ?? 200)
const FLUSH_MS = Number(process.env.ANALYTICS_EVENT_FLUSH_MS ?? 5000)

let buffer: Sor[] = []
let timer: NodeJS.Timeout | undefined

/**
 * Egy esemény felvétele.
 *
 * NEM ÍR ADATBÁZISBA ÉS NEM VÁR SEMMIRE. A hívó számára ez `void` hívás a
 * válasz visszaadása előtt: a mérés nem lehet a lassulás oka. Ugyanaz a
 * minta, mint a látogatottsági gyűjtőnél.
 */
export function record (e: YumeEvent): void {
  if (!isEventType(e.type)) return
  const at = e.at ?? new Date()
  buffer.push({
    eventId: e.eventId ?? randomUUID(),
    type: e.type,
    userId: e.userId ?? null,
    visitorKey: e.userId ? null : (e.visitorKey ?? null),
    subjectType: e.subjectType ?? null,
    subjectId: e.subjectId ?? null,
    metadata: JSON.stringify(e.metadata ?? {}),
    dedupe: dedupeKey(e, at),
    at
  })

  if (buffer.length >= MAX) void flush()
  else if (!timer) timer = setTimeout(() => { void flush() }, FLUSH_MS).unref()
}

/**
 * A köteg kiírása.
 *
 * `ON CONFLICT DO NOTHING` — a deduplikációt az adatbázis egyedi indexe
 * dönti el, nem egy előzetes lekérdezés. Két egyidejű kérés a „megnézem,
 * van-e már" mintával MINDKETTŐNEK azt mondaná, hogy nincs.
 */
export async function flush (): Promise<number> {
  if (timer) { clearTimeout(timer); timer = undefined }
  if (!buffer.length) return 0

  // A puffer ELŐBB ürül: egy elhasalt írás inkább vesszen el, mint hogy
  // kétszer menjen ki. (Itt a dedupe úgyis véd, de a szabály egységes.)
  const koteg = buffer
  buffer = []

  await query(
    `INSERT INTO analytics_events
            (event_id, event_type, user_id, visitor_key, subject_type, subject_id,
             metadata, dedupe_key, created_at)
     SELECT * FROM unnest(
             $1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::text[], $6::text[],
             $7::jsonb[], $8::text[], $9::timestamptz[])
     ON CONFLICT DO NOTHING`,
    [
      koteg.map(s => s.eventId),
      koteg.map(s => s.type),
      koteg.map(s => s.userId),
      koteg.map(s => s.visitorKey),
      koteg.map(s => s.subjectType),
      koteg.map(s => s.subjectId),
      koteg.map(s => s.metadata),
      koteg.map(s => s.dedupe),
      koteg.map(s => s.at.toISOString())
    ])
  return koteg.length
}

/** Teszthez: mennyi vár kiírásra. */
export function pending (): number {
  return buffer.length
}

/** Teszthez és leálláshoz: eldobás kiírás nélkül. */
export function reset (): void {
  if (timer) { clearTimeout(timer); timer = undefined }
  buffer = []
}
