/**
 * A REGISTRY — a YUME saját nyilvántartása arról, mit hozott létre a
 * Discordon.
 *
 * EZ A MODUL DÖNTI EL, MIT SZABAD HOZZÁÉRNI. Egy automatikus setup két
 * dolgot muszáj tudjon: mit hozott létre ŐMAGA, és mit nem. Név alapján ezt
 * eldönteni NEM lehet — egy „📢・bejelentesek" csatornát más is
 * létrehozhatott, és ha a takarítás a nevet nézné, előbb-utóbb idegen
 * tartalmat törölne.
 *
 * A LOGIKAI KULCS a mi nevünk az objektumra (`channel:uj-epizodok`), a
 * `discord_object_id` az, amit a Discord adott. Ez a leképezés teszi a
 * setupot idempotenssé: második futáskor a logikai kulcs már megvan, tehát
 * nem hoz létre másodikat.
 *
 * KÉT SZINTŰ TULAJDONLÁS. A `managed_by_yume` azt mondja meg, hogy kezeljük;
 * a `created_by_yume` azt, hogy MI hoztuk létre. Csak az utóbbit szabad
 * törölni — egy örökbe fogadott, évek óta használt csatorna nem a mi
 * tulajdonunk, még ha kezeljük is.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'

export type ObjectType = 'category' | 'channel' | 'role' | 'persistent_message'

export interface RegistryRow {
  id: string
  guild_id: string
  object_type: ObjectType
  logical_key: string
  discord_object_id: string | null
  parent_key: string | null
  managed_by_yume: boolean
  created_by_yume: boolean
  configuration_version: number
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type Action =
  | 'created' | 'adopted' | 'reused' | 'updated'
  | 'deleted' | 'orphaned' | 'failed' | 'skipped' | 'conflict'

/** Egy guild ÉLŐ sorai. A törölt sorok a történethez kellenek, nem ide. */
export async function list (guildId: string): Promise<RegistryRow[]> {
  return await query<RegistryRow>(
    `SELECT * FROM discord_registry
      WHERE guild_id = $1 AND deleted_at IS NULL
      ORDER BY object_type, logical_key`, [guildId])
}

export async function get (
  guildId: string, objectType: ObjectType, logicalKey: string
): Promise<RegistryRow | undefined> {
  return await queryOne<RegistryRow>(
    `SELECT * FROM discord_registry
      WHERE guild_id = $1 AND object_type = $2 AND logical_key = $3 AND deleted_at IS NULL`,
    [guildId, objectType, logicalKey])
}

/** A MIÉNK-E ez a Discord-objektum? Ezt kérdezi minden törlés előtt. */
export async function byObjectId (
  guildId: string, discordObjectId: string
): Promise<RegistryRow | undefined> {
  return await queryOne<RegistryRow>(
    `SELECT * FROM discord_registry
      WHERE guild_id = $1 AND discord_object_id = $2 AND deleted_at IS NULL`,
    [guildId, discordObjectId])
}

/**
 * Felvétel vagy frissítés — IDEMPOTENSEN.
 *
 * A DÖNTÉST AZ ADATBÁZIS HOZZA, nem egy előzetes lekérdezés. Két egyidejű
 * setup a „megnézem, van-e már" mintával MINDKETTŐNEK azt mondaná, hogy
 * nincs, és két csatorna jönne létre. A részleges egyedi index
 * (guild + típus + logikai kulcs, ahol nincs törölve) ezt kizárja.
 */
export async function upsert (mezok: {
  guildId: string
  objectType: ObjectType
  logicalKey: string
  discordObjectId: string | null
  parentKey?: string | null
  createdByYume: boolean
  version: number
}): Promise<RegistryRow> {
  const sor = await queryOne<RegistryRow>(
    `INSERT INTO discord_registry
            (guild_id, object_type, logical_key, discord_object_id, parent_key,
             created_by_yume, configuration_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (guild_id, object_type, logical_key) WHERE deleted_at IS NULL
     DO UPDATE SET discord_object_id     = excluded.discord_object_id,
                   parent_key            = excluded.parent_key,
                   configuration_version = excluded.configuration_version,
                   -- A TULAJDONLÁS NEM VÁLTOZIK egy újrafuttatástól. Ha
                   -- egyszer örökbe fogadtuk, attól nem lesz a miénk, hogy a
                   -- setup újra lefut.
                   updated_at            = now()
     RETURNING *`,
    [mezok.guildId, mezok.objectType, mezok.logicalKey, mezok.discordObjectId,
      mezok.parentKey ?? null, mezok.createdByYume, mezok.version])
  return sor!
}

/**
 * Egy sor lezárása.
 *
 * SOFT DELETE, mert a történet is válasz: ha valaki kézzel törölt egy
 * csatornát a Discordban, a sor megmarad, és a javítás tudja, hogy ez a MI
 * objektumunk volt — nem egy ismeretlen.
 */
export async function close (id: string): Promise<void> {
  await query('UPDATE discord_registry SET deleted_at = now(), updated_at = now() WHERE id = $1', [id])
}

/** A Discord-azonosító elengedése — az objektum eltűnt, a sor marad. */
export async function orphan (id: string): Promise<void> {
  await query(
    `UPDATE discord_registry SET discord_object_id = NULL, updated_at = now() WHERE id = $1`, [id])
}

/** Minden művelet naplózva. Ez az, amiből a „mi történt" kérdés megválaszolható. */
export async function event (mezok: {
  guildId: string
  objectType: string
  logicalKey: string
  discordObjectId?: string | null
  action: Action
  detail?: string | null
  actorId?: string | null
  runId?: string | number | null
}): Promise<void> {
  await query(
    `INSERT INTO discord_registry_events
            (guild_id, object_type, logical_key, discord_object_id, action, detail, actor_id, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [mezok.guildId, mezok.objectType, mezok.logicalKey, mezok.discordObjectId ?? null,
      mezok.action, mezok.detail ? String(mezok.detail).slice(0, 500) : null,
      mezok.actorId ?? null, mezok.runId ?? null])
}

export async function history (guildId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
  return await query(
    `SELECT e.object_type, e.logical_key, e.action, e.detail, e.at, u.username AS actor
       FROM discord_registry_events e
       LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.guild_id = $1
      ORDER BY e.at DESC LIMIT $2`, [guildId, limit])
}

// ---------------------------------------------------------------- futások

export async function startRun (
  guildId: string, mode: string, actorId: string | null
): Promise<string> {
  const sor = await queryOne<{ id: string }>(
    `INSERT INTO discord_setup_runs (guild_id, mode, actor_id) VALUES ($1, $2, $3) RETURNING id`,
    [guildId, mode, actorId])
  return String(sor!.id)
}

/**
 * Egy futás lezárása.
 *
 * A `partial` KÜLÖN ÁLLAPOT, és ez a lényeg: egy setup, amiből egy lépés nem
 * sikerült, NEM sikeres. A felület ezt pontosan kiírja, mert egy zöld pipa
 * egy félbehagyott szerver fölött rosszabb, mint egy piros.
 */
export async function finishRun (
  runId: string, status: 'ok' | 'partial' | 'failed', summary: unknown
): Promise<void> {
  await query(
    `UPDATE discord_setup_runs
        SET status = $2, finished_at = now(), summary = $3::jsonb
      WHERE id = $1`,
    [runId, status, JSON.stringify(summary ?? {})])
}

export async function runs (guildId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return await query(
    `SELECT r.id, r.mode, r.status, r.started_at, r.finished_at, r.summary, u.username AS actor
       FROM discord_setup_runs r
       LEFT JOIN users u ON u.id = r.actor_id
      WHERE r.guild_id = $1
      ORDER BY r.started_at DESC LIMIT $2`, [guildId, limit])
}
