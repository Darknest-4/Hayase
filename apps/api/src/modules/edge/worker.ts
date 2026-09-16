// Az él háttérmunkája — minden, ami nem fér bele a kérési útba.
//
// A HOT PATH és az ASZINKRON ELEMZÉS szétválasztása nem stílus: a kérési út
// annyit csinál, amennyi a DÖNTÉSHEZ kell, és semmi többet. Minden, ami
// hosszabb távú mintát néz vagy külső adatot kér, ide kerül.
//
// Négy feladat:
//   1. IP-adatok frissítése — hálózati hívás, ezért soha nem a kérési útban;
//   2. viselkedéselemzés — ami csak sok kérés EGYÜTT nézéséből látszik;
//   3. napi összesítő — amiből a panel olvas;
//   4. takarítás — a nyers döntések és a lejárt tiltások.

import { pruneExpired } from './bans.ts'
import { flush } from './events.ts'
import { query, queryOne } from '../../infrastructure/database/index.ts'
import { refresh, stale } from './ip-intel.ts'

import type { Job } from '../../infrastructure/queue/index.ts'

/** Meddig élnek a nyers döntések. Az összesítő marad. */
const DECISION_RETENTION_DAYS = Number(process.env.EDGE_DECISION_RETENTION_DAYS ?? 30)

/**
 * IP-adatok frissítése.
 *
 * Kis kötegekben, mert minden cím egy fordított névfeloldás — és ötven
 * párhuzamos DNS-kérés a worker folyamatot is megfekteti. Sorban megy, és
 * inkább lassan fut végig, mint hogy egy futás mindent felzabáljon.
 */
export async function refreshIntel (limit = 25): Promise<number> {
  const addresses = await stale(limit)
  let done = 0
  for (const ip of addresses) {
    try {
      await refresh(ip)
      done++
    } catch {
      // Egy cím kiesése nem viszi magával a köteget.
    }
  }
  return done
}

/**
 * Viselkedéselemzés — a scraper-felismerés igazi helye.
 *
 * A kérési úton egy kérésről csak annyit lehet tudni, amennyi benne van. Egy
 * SCRAPER viszont nem egy kérésről ismerszik meg, hanem a sorozatról: sok
 * címet jár végig, mindegyiket egyszer, egyenletes ütemben, és sosem tér
 * vissza egyikhez sem. Ez a minta csak utólag látszik.
 *
 * Amit itt keresünk, és amit a kérési út nem lát:
 *
 *   * ENDPOINT-BEJÁRÁS — sok különböző azonosító ugyanazon az útvonalon,
 *     ismétlődés nélkül. Egy ember visszatér ugyanarra a címre; egy gyűjtő
 *     nem;
 *   * EGYOLDALÚ FORGALOM — csak olvasás, soha semmi más. Egy valódi
 *     látogató konfigurációt kér, képet tölt, néha ír;
 *   * TARTÓS JELENLÉT — órákon át egyenletes terhelés, szünet nélkül.
 */
export async function analyseBehaviour (): Promise<number> {
  /*
   * A jelölt címek: az elmúlt órában sokat kértek, és szinte kizárólag
   * olvasó végpontokat, sok különböző útvonalon.
   *
   * A `having` küszöbei szándékosan magasak. Egy scraper-gyanú, ami minden
   * aktív látogatóra ráillik, nem gyanú, hanem zaj — és az első hamis
   * riasztás után az operátor kikapcsolja az egészet.
   */
  const candidates = await query<{ ip: string, hits: number, routes: number }>(
    `SELECT d.ip::text AS ip, count(*)::int AS hits, count(DISTINCT d.route)::int AS routes
       FROM edge_decisions d
      WHERE d.at > now() - interval '1 hour' AND d.ip IS NOT NULL
      GROUP BY d.ip
     HAVING count(*) > 600 AND count(DISTINCT d.route) <= 3
      LIMIT 50`
  )

  let flagged = 0
  for (const row of candidates) {
    /*
     * Sok kérés, kevés különböző útvonal: ez a gyűjtés alakja. Egy ember, aki
     * tényleg sokat böngészik, sokféle végpontot érint — a főoldalt, a
     * keresést, a részleteket, a könyvtárát.
     *
     * A megjelölés NEM tiltás: egy biztonsági eseményt írunk, amit az
     * operátor lát, és amiből a következő kérések kockázati pontszáma
     * magasabb lesz. A tiltásról továbbra is a küszöbök döntenek.
     */
    await query(
      `INSERT INTO security_logs (ip, event, severity, metadata)
       VALUES ($1::inet, 'scraper_suspected', 'medium', $2::jsonb)`,
      [row.ip, JSON.stringify({ hits: row.hits, routes: row.routes, window: '1h' })]
    )
    flagged++
  }
  return flagged
}

/**
 * Napi összesítő.
 *
 * A panel ebből olvas, nem a nyers döntéstáblából. Idempotens: a frissen
 * számolt értékre ír, nem hozzáad — egy kétszer lefutott nap nem duplázza a
 * számokat, és egy félbeszakadt futás megismételhető.
 */
export async function rollup (day?: string): Promise<void> {
  const d = day ?? new Date().toISOString().slice(0, 10)
  await query(
    `INSERT INTO edge_daily (day, action, route, hits, unique_ips)
     SELECT $1::date, action, coalesce(route, ''), count(*)::int, count(DISTINCT ip)::int
       FROM edge_decisions
      WHERE at >= $1::date AND at < $1::date + 1
      GROUP BY action, coalesce(route, '')
     ON CONFLICT (day, action, route) DO UPDATE SET
       hits = EXCLUDED.hits, unique_ips = EXCLUDED.unique_ips`,
    [d]
  )
}

/** Takarítás: a nyers döntések és a rég lejárt tiltások. */
export async function prune (): Promise<Record<string, number>> {
  const decisions = await queryOne<{ n: number }>(
    `WITH d AS (
       DELETE FROM edge_decisions WHERE at < now() - ($1 || ' days')::interval RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [DECISION_RETENTION_DAYS]
  )
  const bans = await pruneExpired()

  /*
   * Az IP-adatok: amit egy éve nem láttunk, arról nem kell tudnunk semmit.
   * Ez adatvédelmi kérdés is — egy címhez kötött megállapítás személyes adat
   * lehet, és nincs okunk örökké tartani.
   */
  const intel = await queryOne<{ n: number }>(
    `WITH d AS (
       DELETE FROM ip_intel i
        WHERE i.checked_at < now() - interval '1 year'
          AND NOT EXISTS (SELECT 1 FROM edge_bans b
                           WHERE b.lifted_at IS NULL AND b.subject_inet >>= i.ip)
        RETURNING 1)
     SELECT count(*)::int AS n FROM d`
  )

  return {
    decisions: Number(decisions?.n ?? 0),
    bans,
    ip_intel: Number(intel?.n ?? 0)
  }
}

/** A feladatsor kezelője. */
export async function handleEdgeJob (job: Job): Promise<void> {
  // A puffer kiürítése minden futásnál: ha egy csendes példányon a
  // kérésenkénti ütemező nem sült el, itt akkor is kimegy.
  await flush()

  if (job.payload.prune === true) {
    const removed = await prune()
    console.log('edge retention:', JSON.stringify(removed))
    return
  }

  if (job.payload.intel === true) {
    const done = await refreshIntel()
    if (done) console.log(`edge: ${done} IP-cím frissítve`)
    return
  }

  if (job.payload.behaviour === true) {
    const flagged = await analyseBehaviour()
    if (flagged) console.log(`edge: ${flagged} cím megjelölve gyűjtés gyanújával`)
    return
  }

  const day = typeof job.payload.day === 'string' ? job.payload.day : undefined
  await rollup(day)
}
