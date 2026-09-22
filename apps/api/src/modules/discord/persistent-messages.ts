/**
 * Tartós Discord-üzenetek — egy üzenet, ami frissül, nem szaporodik.
 *
 * A FELADAT EGY MONDATBAN: egy statisztikaüzenetet egyszer küldünk el, és
 * utána MÓDOSÍTJUK. Ami ebben nehéz, az nem a hívás, hanem a négy hibaeset:
 *
 *   1. NE KÜLDJÖN FELESLEGESEN. Ha a tartalom nem változott, a Discordot meg
 *      sem szólítjuk. Egy percenként frissülő statisztika így napi 1440 kérés
 *      helyett annyi, ahányszor tényleg változott valami.
 *
 *   2. NE DUPLIKÁLJON. Több bot-példány mellett két folyamat egyszerre
 *      próbálhatna üzenetet létrehozni ugyanahhoz a rekordhoz — abból két
 *      üzenet lenne, és a második örökre árván maradna. Ezt elosztott zár
 *      akadályozza meg, az adatbázisban.
 *
 *   3. NE PRÓBÁLKOZZON VÉGTELENÜL. Egy jogosultsági hiba nem múlik el attól,
 *      hogy percenként újrapróbáljuk — csak a naplót tölti meg és a Discord
 *      korlátait meríti ki.
 *
 *   4. EGY TÖRÖLT ÜZENETET HOZZON VISSZA — DE KONTROLLÁLTAN. Ez a
 *      legveszélyesebb ág: ha a „nincs meg" hibát rosszul osztályozzuk, a
 *      rendszer percenként küld egy új üzenetet, és a csatorna megtelik.
 *
 * A MÓDOSÍTÁST NEM ELŐZI MEG LÉTEZÉS-ELLENŐRZÉS. Kézenfekvő volna előbb
 * lekérdezni, hogy megvan-e az üzenet — de az MEGDUPLÁZZA a kérésszámot, és
 * közben semmit nem garantál: a két hívás között is törölhetik. Helyette a
 * módosítás hibáját olvassuk: ha „nincs meg", akkor hozunk létre újat.
 */

import { createHash } from 'node:crypto'

import { query, queryOne } from '../../infrastructure/database/index.ts'

import type { DiscordClient, DiscordError, ErrorKind } from './types.ts'

/** Meddig tartja a zárat egy futó frissítés. */
export const LOCK_MS = Number(process.env.DISCORD_PM_LOCK_MS ?? 30_000)

/**
 * Hány egymás utáni kudarc után áll le a próbálkozás.
 *
 * Nem „örökre": a számláló az első sikerrel nullázódik, és az üzemeltető a
 * felületről újraindíthatja. A cél nem a végleges letiltás, hanem az, hogy egy
 * elromlott beállítás ne égesse a Discord korlátait.
 */
export const MAX_FAILURES = Number(process.env.DISCORD_PM_MAX_FAILURES ?? 5)

/** A visszalépés alapja és teteje. */
export const BACKOFF_BASE_MS = Number(process.env.DISCORD_PM_BACKOFF_MS ?? 60_000)
export const BACKOFF_MAX_MS = Number(process.env.DISCORD_PM_BACKOFF_MAX_MS ?? 60 * 60_000)

/** Két frissítés között eltelt minimális idő. A 10.7. pont szerinti fék. */
export const MIN_INTERVAL_MS = Number(process.env.DISCORD_PM_MIN_INTERVAL_MS ?? 45_000)

export interface PersistentMessage {
  id: string
  guild_id: string
  channel_id: string
  message_id: string | null
  message_type: string
  configuration: Record<string, unknown>
  enabled: boolean
  last_rendered_hash: string | null
  last_updated_at: Date | null
  last_success_at: Date | null
  last_error: string | null
  failure_count: number
  locked_until: Date | null
  locked_by: string | null
  version: number
}

export type Outcome =
  | 'created' | 'edited' | 'skipped' | 'recreated'
  | 'failed' | 'locked_out' | 'disabled' | 'too_soon' | 'no_permission'

export interface SyncResult {
  outcome: Outcome
  messageId?: string | null
  detail?: string
}

// ---------------------------------------------------------------- ujjlenyomat

/**
 * A tartalom ujjlenyomata.
 *
 * STABIL KULCSSORRENDDEL. Egy `JSON.stringify` a beszúrás sorrendjében írja
 * ki a kulcsokat, tehát két SZEMANTIKAILAG AZONOS objektum különböző
 * ujjlenyomatot kapna, ha máshogy épült fel — és onnantól minden frissítés
 * „változásnak" látszana. Pont azt a felesleges forgalmat okozná, ami ellen
 * az ujjlenyomat készült.
 */
export function contentHash (payload: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stable((value as Record<string, unknown>)[key])
      }
      return out
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex')
}

// ---------------------------------------------------------------- hibák

/**
 * Egy hiba besorolása.
 *
 * A `kind` mező az elsődleges: ha a kliens megmondta, elhisszük. Szövegre
 * csak akkor esünk vissza, ha nem mondta meg — és ez tudatosan a GYENGÉBB
 * út: a Discord egyetlen szövegváltoztatása elrontaná, ezért nem erre
 * építünk.
 */
export function classifyError (error: unknown): { kind: ErrorKind, retryAfterMs: number | null } {
  const e = error as DiscordError | undefined
  if (e?.kind) return { kind: e.kind, retryAfterMs: e.retryAfterMs ?? null }

  const text = String(e?.message ?? error ?? '').toLowerCase()
  if (text.includes('unknown message')) return { kind: 'message_not_found', retryAfterMs: null }
  if (text.includes('unknown channel')) return { kind: 'channel_not_found', retryAfterMs: null }
  if (text.includes('missing permissions') || text.includes('forbidden')) {
    return { kind: 'forbidden', retryAfterMs: null }
  }
  if (text.includes('rate limit')) return { kind: 'rate_limited', retryAfterMs: null }
  return { kind: 'unknown', retryAfterMs: null }
}

/** Érdemes-e újra megpróbálni ezt a hibát. */
export function isRetryable (kind: ErrorKind): boolean {
  // A `forbidden` és a `channel_not_found` NEM múlik el újrapróbálástól: az
  // egyikhez jogot kell adni, a másikhoz csatornát. Az újrapróbálás ezeknél
  // csak a naplót tölti és a korlátokat meríti.
  return kind === 'transient' || kind === 'rate_limited' || kind === 'unknown'
}

/**
 * Meddig várjunk a következő próbálkozásig.
 *
 * Exponenciális, felső korláttal. A `rate_limited` a Discord saját
 * várakozási idejét használja, ha megmondta — az pontosabb, mint a mi
 * becslésünk, és nem tiszteletben tartani egyenesen ellenséges.
 */
export function backoffMs (failures: number, retryAfterMs: number | null = null): number {
  if (retryAfterMs != null && retryAfterMs > 0) return Math.min(retryAfterMs, BACKOFF_MAX_MS)
  const n = Math.max(0, failures)
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, n), BACKOFF_MAX_MS)
}

/**
 * Esedékes-e ez a rekord.
 *
 * HÁROM FÉK EGYMÁS UTÁN: a letiltás, a kudarcszámláló és a minimális
 * időköz. A sorrend számít — egy letiltott rekordot nem érdekel, mikor
 * frissült utoljára.
 */
export function isDue (row: Pick<PersistentMessage,
'enabled' | 'failure_count' | 'last_updated_at'>, now: number = Date.now()): boolean {
  if (!row.enabled) return false
  if (row.failure_count >= MAX_FAILURES) return false
  if (!row.last_updated_at) return true
  const elapsed = now - new Date(row.last_updated_at).getTime()
  const wait = row.failure_count > 0 ? backoffMs(row.failure_count) : MIN_INTERVAL_MS
  return elapsed >= wait
}

// ---------------------------------------------------------------- zár

/**
 * Zár megszerzése EGY utasításban.
 *
 * A „megnézem, szabad-e, aztán lefoglalom" minta versenyben mindkét
 * folyamatnak igazat mondana. Itt a feltétel a `WHERE`-ben van: az
 * adatbázis dönt, és pontosan egy sor frissül.
 */
export async function acquireLock (id: string, owner: string, now: Date = new Date()): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE persistent_messages
        SET locked_until = $3::timestamptz + ($4::int || ' milliseconds')::interval,
            locked_by = $2,
            updated_at = now()
      WHERE id = $1
        AND (locked_until IS NULL OR locked_until < $3::timestamptz)
      RETURNING id`,
    [id, owner, now.toISOString(), LOCK_MS])
  return rows.length === 1
}

export async function releaseLock (id: string, owner: string): Promise<void> {
  await query(
    `UPDATE persistent_messages
        SET locked_until = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1 AND locked_by = $2`,
    [id, owner])
}

// ---------------------------------------------------------------- napló

async function logEvent (id: string, event: string, detail: string | null, ms: number | null): Promise<void> {
  await query(
    'INSERT INTO persistent_message_events (message_id, event, detail, duration_ms) VALUES ($1, $2, $3, $4)',
    [id, event, detail ? detail.slice(0, 500) : null, ms])
}

// ---------------------------------------------------------------- a motor

export interface SyncOptions {
  client: DiscordClient
  /** A kirenderelt tartalom. A motor nem tudja, mi van benne — csak elküldi. */
  payload: unknown
  /** Ki dolgozik rajta. Több példánynál ez különbözteti meg őket. */
  owner?: string
  now?: Date
  /** Igaz esetén az időköz-fék és az ujjlenyomat-egyezés is kihagyható. */
  force?: boolean
}

/**
 * Egy tartós üzenet szinkronizálása.
 *
 * A LÉPÉSEK SORRENDJE VÉDELEM, NEM STÍLUS:
 *   letiltás → esedékesség → zár → ujjlenyomat → küldés/módosítás → naplózás
 *
 * Az ujjlenyomat a zár UTÁN dől el, mert két példány egyszerre ugyanazt a
 * „nem változott" döntést hozná, és a zár nélkül mindkettő írna.
 */
export async function syncMessage (row: PersistentMessage, options: SyncOptions): Promise<SyncResult> {
  const now = options.now ?? new Date()
  const owner = options.owner ?? `pid-${process.pid}`

  if (!row.enabled) return { outcome: 'disabled' }
  if (!options.force && !isDue(row, now.getTime())) return { outcome: 'too_soon' }

  if (!await acquireLock(row.id, owner, now)) {
    await logEvent(row.id, 'locked_out', 'egy másik példány épp dolgozik rajta', null)
    return { outcome: 'locked_out' }
  }

  const started = Date.now()
  try {
    const hash = contentHash(options.payload)

    /*
     * NINCS VÁLTOZÁS → NINCS KÉRÉS.
     *
     * A `last_updated_at` ilyenkor is frissül: enélkül a rekord azonnal újra
     * esedékes lenne, és a ciklus percenként újraszámolná ugyanazt.
     */
    if (!options.force && row.message_id && row.last_rendered_hash === hash) {
      await query(
        'UPDATE persistent_messages SET last_updated_at = $2, updated_at = now() WHERE id = $1',
        [row.id, now.toISOString()])
      await logEvent(row.id, 'skipped', 'a tartalom nem változott', Date.now() - started)
      return { outcome: 'skipped', messageId: row.message_id }
    }

    // ---- nincs még üzenet: létrehozás ----
    if (!row.message_id) {
      if (!await options.client.canPost(row.channel_id)) {
        await failRecord(row, 'a botnak nincs joga írni ebbe a csatornába', now)
        await logEvent(row.id, 'failed', 'nincs jogosultság', Date.now() - started)
        return { outcome: 'no_permission' }
      }
      const sent = await options.client.send(row.channel_id, options.payload)
      await succeedRecord(row, sent.id, hash, now)
      await logEvent(row.id, 'created', null, Date.now() - started)
      return { outcome: 'created', messageId: sent.id }
    }

    // ---- van üzenet: módosítás ----
    try {
      const edited = await options.client.edit(row.channel_id, row.message_id, options.payload)
      await succeedRecord(row, edited.id, hash, now)
      await logEvent(row.id, 'edited', null, Date.now() - started)
      return { outcome: 'edited', messageId: edited.id }
    } catch (error) {
      const { kind, retryAfterMs } = classifyError(error)

      /*
       * A TÖRÖLT ÜZENET AZ EGYETLEN ÁG, AMI ÚJRALÉTREHOZÁSHOZ VEZET — és
       * pontosan ezért kell szigorúan osztályozni. Ha egy jogosultsági
       * hibát is ide engednénk, a rendszer percenként küldene egy új
       * üzenetet, és a csatorna megtelne.
       */
      if (kind === 'message_not_found') {
        if (!await options.client.canPost(row.channel_id)) {
          await failRecord(row, 'az üzenetet törölték, és nincs jogunk újat küldeni', now)
          await logEvent(row.id, 'failed', 'törölve, nincs jogosultság', Date.now() - started)
          return { outcome: 'no_permission' }
        }
        const sent = await options.client.send(row.channel_id, options.payload)
        await succeedRecord(row, sent.id, hash, now)
        await logEvent(row.id, 'recreated', 'az üzenetet törölték, újra létrehozva', Date.now() - started)
        return { outcome: 'recreated', messageId: sent.id }
      }

      const uzenet = String((error as Error)?.message ?? error).slice(0, 300)
      await failRecord(row, uzenet, now, isRetryable(kind) ? null : MAX_FAILURES)
      await logEvent(row.id, 'failed', `${kind}: ${uzenet}`, Date.now() - started)
      return {
        outcome: 'failed',
        detail: retryAfterMs != null ? `${kind} (${retryAfterMs} ms)` : kind
      }
    }
  } catch (error) {
    const { kind } = classifyError(error)
    const uzenet = String((error as Error)?.message ?? error).slice(0, 300)
    await failRecord(row, uzenet, now, isRetryable(kind) ? null : MAX_FAILURES)
    await logEvent(row.id, 'failed', `${kind}: ${uzenet}`, Date.now() - started)
    return { outcome: 'failed', detail: kind }
  } finally {
    await releaseLock(row.id, owner)
  }
}

async function succeedRecord (row: PersistentMessage, messageId: string, hash: string, now: Date): Promise<void> {
  await query(
    `UPDATE persistent_messages
        SET message_id = $2, last_rendered_hash = $3,
            last_updated_at = $4, last_success_at = $4,
            last_error = NULL, failure_count = 0,
            version = version + 1, updated_at = now()
      WHERE id = $1`,
    [row.id, messageId, hash, now.toISOString()])
}

/**
 * @param forceCount ha meg van adva, a kudarcszámláló EZ lesz — így egy nem
 *   újrapróbálható hiba (jogosultság, hiányzó csatorna) azonnal leállítja a
 *   próbálkozást, ahelyett hogy ötször futna bele ugyanabba a falba.
 */
async function failRecord (row: PersistentMessage, detail: string, now: Date, forceCount: number | null = null): Promise<void> {
  await query(
    `UPDATE persistent_messages
        SET last_updated_at = $2, last_error = $3,
            failure_count = COALESCE($4::int, failure_count + 1),
            updated_at = now()
      WHERE id = $1`,
    [row.id, now.toISOString(), detail.slice(0, 500), forceCount])
}

// ------------------------------------------------------- újralétrehozás

/**
 * KÉZI ÚJRALÉTREHOZÁS — a felület „Újra kiküldés" gombja.
 *
 * MIÉRT KELL, ha a motor a törölt üzenetet magától visszahozza. Mert az
 * automatika egyetlen helyzetet kezel: az üzenet MÁR NINCS MEG. Az
 * üzemeltetőnek viszont van egy másik baja is — az üzenet megvan, csak nem
 * ott, ahol kellene: lejjebb csúszott ötszáz üzenettel, vagy egy fél
 * szerkesztés maradt benne. Ilyenkor nem módosítani akar, hanem új üzenetet
 * a csatorna aljára.
 *
 * ELŐBB TÖRÖL, AZTÁN KÜLD, és ez a sorrend a lényeg. Fordítva — vagy a
 * törlés kihagyásával — pontosan az jönne létre, ami ellen az egész modul
 * készült: KÉT üzenet ugyanarról. A törlés a saját üzenetünkre vonatkozik,
 * nem a csatorna tartalmára; másét ez soha nem bántja.
 *
 * A TÖRLÉS KUDARCA NEM ÁLLÍTJA MEG A KÜLDÉST, de nem is hallgatjuk el: a
 * `removedOld` mezőben megy vissza, és a felület kiírja. Egy kézzel már
 * letörölt üzenetnél ez a normális állapot.
 */
export async function recreateMessage (
  row: PersistentMessage,
  options: SyncOptions
): Promise<SyncResult & { removedOld: boolean | null }> {
  const now = options.now ?? new Date()

  let removedOld: boolean | null = null
  if (row.message_id) {
    if (options.client.remove === undefined) {
      removedOld = null
    } else {
      try {
        await options.client.remove(row.channel_id, row.message_id)
        removedOld = true
      } catch (error) {
        // A „nincs meg" nem kudarc: pont ez a kívánt végállapot.
        removedOld = classifyError(error).kind === 'message_not_found'
      }
    }
  }

  /*
   * A NYILVÁNTARTÁS ELŐBB FELEJT. Ha a küldés elhasal, a rekord akkor sem
   * mutathat a régi — időközben törölt — üzenetre: a következő ciklus egy
   * nem létező üzenetet próbálna módosítani.
   */
  await query(
    `UPDATE persistent_messages
        SET message_id = NULL, last_rendered_hash = NULL,
            failure_count = 0, last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [row.id])
  await logEvent(row.id, 'recreate_requested',
    removedOld === true ? 'a régi üzenet törölve' : removedOld === false ? 'a régi üzenetet nem sikerült törölni' : null,
    null)

  const friss = await findById(row.id)
  if (!friss) return { outcome: 'failed', detail: 'a rekord időközben eltűnt', removedOld }

  const result = await syncMessage(friss, { ...options, now, force: true })
  return { ...result, removedOld }
}

// ---------------------------------------------------------------- olvasás

export async function findById (id: string): Promise<PersistentMessage | undefined> {
  return await queryOne<PersistentMessage>('SELECT * FROM persistent_messages WHERE id = $1', [id])
}

export async function listForGuild (guildId: string): Promise<PersistentMessage[]> {
  return await query<PersistentMessage>(
    'SELECT * FROM persistent_messages WHERE guild_id = $1 ORDER BY message_type', [guildId])
}

/** A frissítésre esedékes rekordok. A szűrés a `isDue` szabályait tükrözi. */
export async function due (limit = 50, now: Date = new Date()): Promise<PersistentMessage[]> {
  const rows = await query<PersistentMessage>(
    `SELECT * FROM persistent_messages
      WHERE enabled AND failure_count < $2
        AND (locked_until IS NULL OR locked_until < $3::timestamptz)
      ORDER BY last_updated_at NULLS FIRST
      LIMIT $1`,
    [limit, MAX_FAILURES, now.toISOString()])
  return rows.filter(r => isDue(r, now.getTime()))
}
