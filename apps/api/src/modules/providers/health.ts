// A szolgáltatók egészsége — körkörös megszakító.
//
// MIÉRT KELL. Egy elérhetetlen szolgáltató nem attól fáj, hogy nem ad
// forrást, hanem attól, hogy VÁRAKOZTAT. Ha négy szolgáltatóból az első
// lefagyott, és minden lejátszásindítás megvárja a saját időtúllépését, akkor
// a nézők négy szolgáltatónyi késleltetést kapnak azért, hogy a negyedik
// működik. A megszakító ezt vágja el: a romlott szolgáltatót egy ideig meg se
// kérdezzük.
//
// HÁROM ÁLLAPOT:
//
//   zárt     minden rendben, megyünk rajta;
//   nyitott  eleget hibázott — nem kérdezzük meg, amíg le nem jár a türelmi idő;
//   félig    a türelmi idő letelt: EGY kérést átengedünk. Ha az sikerül,
//            zárunk; ha nem, újra nyitunk, hosszabb idővel.
//
// AMI HIBÁNAK SZÁMÍT: kivétel vagy időtúllépés. Az ÜRES EREDMÉNY NEM hiba —
// az azt jelenti, hogy megkérdeztük, és nincs. Ha az üres választ is
// büntetnénk, egy ritka címnél az egész szolgáltatót kizárnánk.
//
// MEMÓRIÁBAN ÉL, és ez szándékos: egy telepítés után tiszta lappal indulni a
// helyes viselkedés (a szolgáltató lehet, hogy épp azért volt rossz, amit
// most javítottunk). Ami egy üzemeltetőnek kell — „mióta romlik?" —, az a
// `provider_events` táblába megy, ÁLLAPOTVÁLTOZÁSKOR, nem minden kérésnél.

import { query } from '../../infrastructure/database/index.ts'

export type HealthState = 'up' | 'down' | 'half-open'

interface Entry {
  failures: number
  successes: number
  /** Egymás utáni hibák — ez nyitja a megszakítót, nem az összes hiba. */
  streak: number
  openedAt: number | null
  /** Hányadszor nyílt ki sorban — ez hosszabbítja a türelmi időt. */
  opens: number
  lastError: string | null
  lastLatencyMs: number | null
  lastAt: number | null
}

/** Ennyi egymás utáni hiba után nyitunk. */
const TRIP_AFTER = 3

/** Az első türelmi idő; minden további nyitásnál duplázódik, eddig a határig. */
const BASE_COOLDOWN_MS = 30_000
const MAX_COOLDOWN_MS = 10 * 60_000

const entries = new Map<string, Entry>()

function entry (slug: string): Entry {
  let e = entries.get(slug)
  if (!e) {
    e = { failures: 0, successes: 0, streak: 0, openedAt: null, opens: 0, lastError: null, lastLatencyMs: null, lastAt: null }
    entries.set(slug, e)
  }
  return e
}

function cooldown (opens: number): number {
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.max(0, opens - 1))
}

/** Csak tesztekhez. */
export function reset (): void {
  entries.clear()
}

/**
 * Az esemény naplózása — ÁLLAPOTVÁLTOZÁSKOR, nem minden kérésnél.
 *
 * Nem vár rá senki: egy naplósor késése ne lassítson egy lejátszásindítást.
 */
function record (slug: string, event: string, detail: string | null, latencyMs: number | null, sources: number | null): void {
  void query(
    'INSERT INTO provider_events (slug, event, detail, latency_ms, sources) VALUES ($1, $2, $3, $4, $5)',
    [slug, event, detail, latencyMs, sources]
  ).catch(error => { console.error('a szolgáltató eseménye nem került naplóba', error) })
}

/** Megkérdezhető-e most ez a szolgáltató? */
export function usable (slug: string): boolean {
  return state(slug) !== 'down'
}

/** A pillanatnyi állapot. A félig nyitott ág EGY próbát enged át. */
export function state (slug: string): HealthState {
  const e = entries.get(slug)
  if (!e || e.openedAt === null) return 'up'
  if (Date.now() - e.openedAt < cooldown(e.opens)) return 'down'
  return 'half-open'
}

/** Sikeres feloldás. Zárja a megszakítót, ha nyitva volt. */
export function succeeded (slug: string, latencyMs: number, sources: number): void {
  const e = entry(slug)
  const volt = state(slug)
  e.successes++
  e.streak = 0
  e.lastLatencyMs = latencyMs
  e.lastAt = Date.now()
  e.lastError = null
  if (e.openedAt !== null) {
    e.openedAt = null
    e.opens = 0
    record(slug, 'up', `${volt === 'half-open' ? 'a próbakérés sikerült' : 'helyreállt'}`, latencyMs, sources)
  }
}

/**
 * Sikertelen feloldás.
 *
 * FÉLIG NYITOTT ÁLLAPOTBAN AZONNAL ÚJRANYIT, és a türelmi idő duplázódik —
 * különben egy tartósan halott szolgáltatót harmincmásodpercenként
 * megkérdeznénk a világ végéig.
 */
export function failed (slug: string, reason: string, latencyMs: number | null = null): void {
  const e = entry(slug)
  const volt = state(slug)
  e.failures++
  e.streak++
  e.lastError = reason.slice(0, 500)
  e.lastLatencyMs = latencyMs
  e.lastAt = Date.now()

  if (volt === 'half-open') {
    e.openedAt = Date.now()
    e.opens++
    record(slug, 'down', `a próbakérés is elhasalt: ${e.lastError}`, latencyMs, null)
    return
  }
  if (e.openedAt === null && e.streak >= TRIP_AFTER) {
    e.openedAt = Date.now()
    e.opens++
    record(slug, 'down', `${e.streak} egymás utáni hiba: ${e.lastError}`, latencyMs, null)
  }
}

/** Egy szolgáltató pillanatképe — az adminfelületnek. */
export interface Snapshot {
  slug: string
  state: HealthState
  failures: number
  successes: number
  streak: number
  lastError: string | null
  lastLatencyMs: number | null
  lastAt: Date | null
  /** Mikor próbálkozunk vele legközelebb, ha épp ki van zárva. */
  retryAt: Date | null
}

export function snapshot (slug: string): Snapshot {
  const e = entries.get(slug)
  const st = state(slug)
  return {
    slug,
    state: st,
    failures: e?.failures ?? 0,
    successes: e?.successes ?? 0,
    streak: e?.streak ?? 0,
    lastError: e?.lastError ?? null,
    lastLatencyMs: e?.lastLatencyMs ?? null,
    lastAt: e?.lastAt ? new Date(e.lastAt) : null,
    retryAt: e?.openedAt != null && st === 'down' ? new Date(e.openedAt + cooldown(e.opens)) : null
  }
}

/** A legutóbbi események egy szolgáltatóról — az adminfelület idővonala. */
export function history (slug: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return query(
    'SELECT event, detail, latency_ms, sources, at FROM provider_events WHERE slug = $1 ORDER BY at DESC LIMIT $2',
    [slug, Math.min(100, Math.max(1, limit))]
  )
}
