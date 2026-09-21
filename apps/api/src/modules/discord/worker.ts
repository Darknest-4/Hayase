/**
 * A tartós üzenetek frissítése — ütemezetten.
 *
 * A 10.7. PONT HIBRID STRATÉGIÁJA. Két erő húz ellentétes irányba: a
 * statisztikának frissnek kell lennie, a Discord viszont korlátozza a
 * kéréseket. A megoldás három fék, és mindhárom máshol fog:
 *
 *   * a MINIMÁLIS IDŐKÖZ (`MIN_INTERVAL_MS`) fékezi a gyakoriságot,
 *   * az UJJLENYOMAT kihagyja azt, ami úgysem változott,
 *   * a KÖTEGMÉRET korlátozza, hány üzenet megy egy futásban.
 *
 * EGY FUTÁS NEM DOLGOZZA FEL AZ ÖSSZESET. Száz guild százszor négy üzenete
 * egyetlen körben négyszáz Discord-kérés lenne — a korlátba futnánk, és a
 * végén lévők sosem frissülnének. Kötegenként megy, és a sorrend a
 * legrégebben frissített szerint halad: így mindegyik sorra kerül.
 *
 * A HIBA NEM ÁLLÍTJA MEG A TÖBBIT. Egy elromlott üzenet (törölt csatorna,
 * elvett jogosultság) nem foghatja meg a többi guild frissítését.
 */

import { createRestClient, isConfigured } from './rest-client.ts'
import { due, syncMessage } from './persistent-messages.ts'
import { renderMessage } from './render.ts'
import { query } from '../../infrastructure/database/index.ts'

import type { Job } from '../../infrastructure/queue/index.ts'

/** Hány üzenetet dolgozunk fel egy futásban. */
const BATCH = Number(process.env.DISCORD_PM_BATCH ?? 25)

/** Meddig őrizzük a frissítési előzményt. */
const EVENT_RETENTION_DAYS = Number(process.env.DISCORD_PM_EVENT_DAYS ?? 30)

export interface SyncSummary {
  processed: number
  outcomes: Record<string, number>
  skippedReason?: string
}

/**
 * Az esedékes üzenetek szinkronizálása.
 *
 * TOKEN NÉLKÜL NEM HAZUDIK SIKERT: ha a bot nincs beállítva, a feladat
 * azonnal visszatér, és megmondja, miért. Enélkül minden futás
 * kudarcszámlálót növelne minden üzenetnél, és pár perc alatt mindet
 * letiltaná — egy olyan hiba miatt, aminek semmi köze az üzenetekhez.
 */
export async function syncDueMessages (now: Date = new Date()): Promise<SyncSummary> {
  if (!isConfigured()) {
    return { processed: 0, outcomes: {}, skippedReason: 'nincs beállítva Discord bot token' }
  }

  const rows = await due(BATCH, now)
  const client = createRestClient()
  const outcomes: Record<string, number> = {}

  for (const row of rows) {
    try {
      const payload = await renderMessage(row.message_type, {
        guildId: row.guild_id,
        configuration: row.configuration
      })
      const result = await syncMessage(row, { client, payload, now })
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1
    } catch (error) {
      /*
       * EGY ELROMLOTT ÜZENET NEM FOGHATJA MEG A TÖBBIT. A renderelés is
       * hibázhat — például egy ismeretlen típusnál —, és az nem a többi
       * guild baja.
       */
      outcomes.render_failed = (outcomes.render_failed ?? 0) + 1
      console.warn(`[discord] a(z) ${row.message_type} renderelése elhasalt:`,
        String((error as Error)?.message ?? error).slice(0, 200))
    }
  }

  return { processed: rows.length, outcomes }
}

/** A frissítési előzmény nyesése. Naponta egyszer kell, nem percenként. */
export async function pruneEvents (): Promise<number> {
  const rows = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM persistent_message_events
        WHERE at < now() - ($1::int || ' days')::interval
        RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [EVENT_RETENTION_DAYS])
  return rows[0]?.n ?? 0
}

export async function handleDiscordJob (job: Job): Promise<void> {
  if (job.payload.prune === true) {
    const n = await pruneEvents()
    if (n > 0) console.info(`[discord] ${n} régi frissítési esemény törölve`)
    return
  }
  const summary = await syncDueMessages()
  if (summary.skippedReason) return
  if (summary.processed > 0) {
    console.info('[discord] tartós üzenetek:', JSON.stringify(summary.outcomes))
  }
}
