// A tiltómotor.
//
// Egy tábla mindenféle tiltásnak, mert a forró úton a kérdés mindig ugyanaz:
// „tiltott-e ez a kérés?". Öt táblából öt lekérdezés lenne, és a kérési út
// nem bír el ötöt.
//
// AMI MÁR MEGVOLT, ÉS AMIT NEM VÁLTUNK LE: a `users.status` fiókszintű
// tiltása és a `token_version` visszavonás. Az a fiók állapota — moderációs
// döntés, ami a felhasználónak is látszik, és ami túléli a munkameneteket.
// Az Edge tiltásai MELLETTE élnek: ezek a hálózat felől jövő támadásra
// válaszolnak, gyorsan és visszavonhatóan, és a legtöbbjük magától lejár.
//
// A KÉT DOLOG KÜLÖN MARAD. Egy IP-tiltás nem tilt ki fiókot, és egy kitiltott
// fiók nem tiltja ki az IP-t, amiről belépett — egy megosztott hálózaton (egy
// iskola, egy kollégium, egy mobilszolgáltató NAT-ja) a kettő
// összekapcsolása sok ártatlant fogna meg egyetlen elkövetőért.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'

export type BanKind = 'ip' | 'network' | 'user' | 'session' | 'api_key'
export type BanSource = 'manual' | 'risk' | 'waf' | 'rate_limit' | 'bot' | 'abuse'

export interface Ban {
  id: string
  kind: BanKind
  subject: string
  reason: string
  source: BanSource
  automatic: boolean
  riskScore: number | null
  createdAt: Date
  expiresAt: Date | null
}

export interface NewBan {
  kind: BanKind
  subject: string
  reason: string
  source?: BanSource
  /** Másodperc. Hiánya véglegeset jelent — és ezt a hívónak ki kell mondania. */
  seconds?: number
  riskScore?: number
  automatic?: boolean
  createdBy?: string | null
  notes?: Record<string, unknown>
}

/**
 * Élő tiltások gyorsítótára.
 *
 * A forró út ezt olvassa. Rövid élettartam, mert egy frissen kiadott tiltásnak
 * másodperceken belül hatnia kell — egy percig élő gyorsítótár azt jelentené,
 * hogy egy támadó még egy percig dolgozhat, miután az operátor megnyomta a
 * gombot.
 */
let snapshot: { at: number, bans: Ban[] } | null = null
const CACHE_MS = Number(process.env.EDGE_BAN_CACHE_MS ?? 10_000)

interface Row {
  id: string
  kind: BanKind
  subject: string
  reason: string
  source: BanSource
  automatic: boolean
  risk_score: number | null
  created_at: Date
  expires_at: Date | null
}

const fromRow = (row: Row): Ban => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  reason: row.reason,
  source: row.source,
  automatic: row.automatic,
  riskScore: row.risk_score === null ? null : Number(row.risk_score),
  createdAt: row.created_at,
  expiresAt: row.expires_at
})

/**
 * Minden élő tiltás.
 *
 * Azért olvassuk be egyben, mert kevés van belőlük: egy tiltólista, ami
 * ezresével nő, nem tiltólista, hanem tűzfalszabály — és azt nem ebben a
 * rétegben kell megoldani. A gyorsítótár mérete így a memóriában elfér, és a
 * forró úton nincs lekérdezés.
 */
async function live (): Promise<Ban[]> {
  if (snapshot && Date.now() - snapshot.at < CACHE_MS) return snapshot.bans
  const rows = await query<Row>(
    `SELECT id::text, kind, subject, reason, source, automatic, risk_score, created_at, expires_at
       FROM edge_bans
      WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 10000`
  )
  const bans = rows.map(fromRow)
  snapshot = { at: Date.now(), bans }
  return bans
}

/** Egy tiltás kiadása után a gyorsítótár azonnal elavul. */
export function invalidate (): void { snapshot = null }

/**
 * Tiltott-e ez a kérés?
 *
 * Egy lekérdezés helyett egy memóriabeli szűrés. A hálózati (CIDR) tiltást az
 * adatbázis dönti el — `inet >>=` —, de csak akkor, ha van egyáltalán ilyen
 * tiltás: a legtöbb példányon nincs, és akkor a forró út nem kérdez semmit.
 */
export async function blocked (subject: {
  ip?: string | null
  userId?: string | null
  sessionId?: string | null
  apiKeyId?: string | null
}): Promise<Ban | null> {
  let bans: Ban[]
  try {
    bans = await live()
  } catch {
    // Az adatbázis hibája nem tilthat ki senkit, és nem is engedhet be
    // mindenkit vakon — a hívó dönt a fail-open/closed szabály szerint.
    throw new BanLookupFailed()
  }
  if (!bans.length) return null

  const exact = bans.find(ban =>
    (ban.kind === 'ip' && subject.ip != null && ban.subject === subject.ip) ||
    (ban.kind === 'user' && subject.userId != null && ban.subject === subject.userId) ||
    (ban.kind === 'session' && subject.sessionId != null && ban.subject === subject.sessionId) ||
    (ban.kind === 'api_key' && subject.apiKeyId != null && ban.subject === subject.apiKeyId))
  if (exact) return exact

  // Hálózati tiltás: csak akkor kérdezzük az adatbázist, ha van ilyen sor.
  if (subject.ip && bans.some(ban => ban.kind === 'network')) {
    const row = await queryOne<Row>(
      `SELECT id::text, kind, subject, reason, source, automatic, risk_score, created_at, expires_at
         FROM edge_bans
        WHERE kind = 'network' AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND subject_inet >>= $1::inet
        LIMIT 1`,
      [subject.ip]
    )
    if (row) return fromRow(row)
  }

  return null
}

/** A tiltáskeresés elhasalt. A hívó dönti el, mit jelent — lásd fail-open. */
export class BanLookupFailed extends Error {
  constructor () { super('ban lookup failed') }
}

/**
 * Tiltás kiadása.
 *
 * Idempotens az élő tiltásokra: ugyanarra az alanyra ugyanabból a forrásból
 * nem halmozunk sorokat, hanem MEGHOSSZABBÍTJUK a meglévőt. Enélkül egy
 * másodpercenként ismétlődő támadás másodpercenként egy sort írna.
 */
export async function ban (input: NewBan): Promise<Ban | null> {
  const expires = input.seconds && input.seconds > 0
    ? new Date(Date.now() + input.seconds * 1000)
    : null

  // `subject_inet` csak akkor, ha tényleg cím: a `::inet` cast egy
  // felhasználó-azonosítóra hibát dobna, és egy tiltás nem hasalhat el azon,
  // hogy milyen típusú alanyt tiltunk.
  const asInet = input.kind === 'ip' || input.kind === 'network' ? input.subject : null

  try {
    /*
     * EGY ALANY, EGY ÉLŐ TILTÁS.
     *
     * Enélkül a kétszer kiadott tiltás két élő sort hagyott — és ez nem
     * kozmetikai: a feloldás egy SORRA szól, tehát az operátor feloldotta,
     * amit a listában látott, a másik pedig maradt. A látogató ki volt zárva
     * úgy, hogy a panel szerint nincs rá tiltás. Ugyanez rontotta el az
     * automatikus tiltás fokozását is, ami a korábbi tiltások SZÁMÁT nézi:
     * a duplikátumok felfújták, és egy első fennakadás sokadikként büntetődött.
     *
     * Az ismételt tiltás ezért MEGHOSSZABBÍT, nem hozzáad. A hosszabb lejárat
     * nyer — egy egyórás tiltás fölé adott ötperces nem rövidíthet —, és a
     * végleges tiltás (`expires_at IS NULL`) mindent felülír.
     *
     * A tranzakció és a tanácsadó zár azért van, mert a hívás párhuzamos: két
     * egyszerre blokkolt kérés mindkét `autoBan`-je ugyanarra a címre fut, és
     * zár nélkül mindkettő „nincs élő tiltás"-t látna.
     */
    const row = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${input.kind}:${input.subject}`])

      const extended = await client.query<Row>(
        `UPDATE edge_bans SET
           expires_at = CASE WHEN $3::timestamptz IS NULL OR expires_at IS NULL
                             THEN NULL ELSE greatest(expires_at, $3::timestamptz) END,
           reason = $4,
           risk_score = coalesce($5::smallint, risk_score)
         WHERE kind = $1 AND subject = $2 AND lifted_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING id::text, kind, subject, reason, source, automatic, risk_score, created_at, expires_at`,
        [input.kind, input.subject, expires, input.reason, input.riskScore ?? null]
      )
      if (extended.rows[0]) return extended.rows[0]

      const fresh = await client.query<Row>(
        `INSERT INTO edge_bans
           (kind, subject, subject_inet, reason, source, risk_score, automatic, created_by, expires_at, notes)
         VALUES ($1, $2, $3::inet, $4, $5, $6, $7, $8, $9, $10::jsonb)
         RETURNING id::text, kind, subject, reason, source, automatic, risk_score, created_at, expires_at`,
        [
          input.kind, input.subject, asInet, input.reason,
          input.source ?? 'manual', input.riskScore ?? null,
          input.automatic ?? false, input.createdBy ?? null, expires,
          JSON.stringify(input.notes ?? {})
        ]
      )
      return fresh.rows[0]
    })

    invalidate()
    return row ? fromRow(row) : null
  } catch {
    return null
  }
}

/**
 * Automatikus tiltás, növekvő hosszal.
 *
 * Aki először akad fenn, rövid tiltást kap; aki sokadszor, hosszabbat. Az
 * első tiltás gyakran félreértés — egy elszabadult szkript, egy megosztott
 * hálózat —, és egy negyedóra elég ahhoz, hogy a hívó abbahagyja. A
 * visszatérő elkövetőnél viszont a rövid tiltás csak szünet.
 */
export async function autoBan (
  kind: BanKind,
  subject: string,
  reason: string,
  source: BanSource,
  riskScore: number,
  windows: { first: number, repeat: number, max: number }
): Promise<Ban | null> {
  const previous = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM edge_bans
      WHERE kind = $1 AND subject = $2 AND automatic
        AND created_at > now() - interval '30 days'`,
    [kind, subject]
  )
  const times = Number(previous?.n ?? 0)
  const seconds = Math.min(windows.max, times === 0 ? windows.first : windows.repeat * times)

  return await ban({ kind, subject, reason, source, seconds, riskScore, automatic: true })
}

/**
 * Feloldás. A sor marad — az előzmény attól előzmény, hogy nem tűnik el.
 *
 * A feloldás az ALANYRA szól, nem a megjelölt sorra. Egy sorra szóló feloldás
 * azt jelentette, hogy ha ugyanarra a címre valahogy mégis két élő tiltás
 * került, az operátor feloldotta az egyiket, a látogató pedig továbbra is ki
 * volt zárva — a panel szerint ok nélkül. A `ban` ma már nem hoz létre
 * másodikat, de a korábban keletkezett párokat is fel kell tudni oldani, és
 * „oldd fel ezt a címet" nem jelentheti azt, hogy „az egyiket".
 */
export async function lift (id: string, by: string | null, reason: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `WITH target AS (SELECT kind, subject FROM edge_bans WHERE id = $1)
     UPDATE edge_bans b SET lifted_at = now(), lifted_by = $2, lift_reason = $3
       FROM target t
      WHERE b.kind = t.kind AND b.subject = t.subject AND b.lifted_at IS NULL
      RETURNING b.id::text`,
    [id, by, reason]
  )
  invalidate()
  return rows.length > 0
}

/** A lejárt tiltások takarítása — a workerből. A lejárt sor nem tiltás. */
export async function pruneExpired (days = 90): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `WITH d AS (
       DELETE FROM edge_bans
        WHERE (expires_at IS NOT NULL AND expires_at < now() - ($1 || ' days')::interval)
           OR (lifted_at IS NOT NULL AND lifted_at < now() - ($1 || ' days')::interval)
        RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [days]
  )
  invalidate()
  return Number(row?.n ?? 0)
}
