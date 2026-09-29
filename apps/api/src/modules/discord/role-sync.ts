/**
 * SZEREPKÖR-SZINKRON — a YUME-fiók állapota a Discord-rangokban.
 *
 * Kétféle rangot kezel, szerverenként beállítva (vezérlőpult → Szerver-
 * beállítások):
 *
 *   * az ÖSSZEKÖTÖTT tagok rangja: aki a Discord-fiókját YUME-fiókhoz kötötte,
 *     megkapja;
 *   * a YUME-szerepkörök rangjai: aki a YUME-ban birtokolja a megfeleltetett
 *     szerepkört (pl. moderátor), megkapja a hozzá rendelt Discord-rangot.
 *
 * A BEÁLLÍTOTT RANGOKAT A BOT KEZELI: akinek nem jár, attól leveszi — akkor is,
 * ha kézzel kapta. Ezért csak olyan rangot érdemes beállítani, amit kizárólag
 * erre használnak; a vezérlőpult ezt ki is mondja. Egy felfüggesztett vagy
 * kitiltott YUME-fiók egyiket sem kapja.
 *
 * CSAK ISMERT ÁLLAPOTNÁL NYÚL HOZZÁ: ha a tag rangjait nem tudjuk lekérdezni
 * (a Discord nem válaszol), a körben semmit nem változtatunk rajta.
 *
 * KÖRÖNKÉNT KEVESET: tagonként egy lekérdezés és a szükséges rang-műveletek,
 * a legrégebben szinkronizáltakkal kezdve — így mindenki sorra kerül. Akinek
 * a Discord-fiókja közben levált a YUME-ról, attól a kezelt rangokat leveszi,
 * és kikerül a nyilvántartásból.
 */

import { query } from '../../infrastructure/database/index.ts'
import { addMemberRole, fetchMemberRoles, isConfigured, removeMemberRole } from './rest-client.ts'

const KOTEG = Number(process.env.DISCORD_ROLE_SYNC_BATCH ?? 25)

export interface RoleSyncResult { checked: number, added: number, removed: number, failed: number }

/** Egy tag elvárt rangjai — tiszta függvény, hogy mérhető legyen. */
export function desiredRoles (
  tag: { active: boolean, yumeRoles: string[] },
  beall: { linkedRoleId: string | null, mappings: Array<{ yumeRole: string, discordRoleId: string }> }
): Set<string> {
  const kell = new Set<string>()
  if (!tag.active) return kell
  if (beall.linkedRoleId) kell.add(beall.linkedRoleId)
  for (const m of beall.mappings) if (tag.yumeRoles.includes(m.yumeRole)) kell.add(m.discordRoleId)
  return kell
}

export async function syncRoles (): Promise<RoleSyncResult> {
  const e: RoleSyncResult = { checked: 0, added: 0, removed: 0, failed: 0 }
  if (!isConfigured()) return e

  const guildek = await query<{ guild_id: string, linked_role_id: string | null }>(
    `SELECT s.guild_id, s.linked_role_id FROM discord_guild_settings s
      WHERE s.linked_role_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM discord_role_mappings m WHERE m.guild_id = s.guild_id)`)

  for (const g of guildek) {
    const mappings = (await query<{ yume_role_slug: string, discord_role_id: string }>(
      'SELECT yume_role_slug, discord_role_id FROM discord_role_mappings WHERE guild_id = $1', [g.guild_id]))
      .map(m => ({ yumeRole: m.yume_role_slug, discordRoleId: m.discord_role_id }))
    const beall = { linkedRoleId: g.linked_role_id, mappings }
    const kezelt = new Set([...(g.linked_role_id ? [g.linked_role_id] : []), ...mappings.map(m => m.discordRoleId)])
    const okBol = `YUME szerepkör-szinkron`

    // ---- az összekötött tagok ----
    const tagok = await query<{ discord_user_id: string, active: boolean, yume_roles: string[] }>(
      `SELECT l.discord_user_id, u.status = 'active' AS active,
              coalesce(array(SELECT r.slug FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS yume_roles
         FROM discord_links l JOIN users u ON u.id = l.user_id
         LEFT JOIN discord_role_sync s ON s.guild_id = $1 AND s.discord_user_id = l.discord_user_id
        ORDER BY s.synced_at NULLS FIRST, l.discord_user_id
        LIMIT $2`, [g.guild_id, KOTEG])

    for (const t of tagok) {
      e.checked++
      const most = await fetchMemberRoles(g.guild_id, t.discord_user_id)
      if (most.status === 'unknown') { e.failed++; continue }
      let hiba: string | null = null
      if (most.status === 'ok') {
        const kell = desiredRoles({ active: t.active, yumeRoles: t.yume_roles }, beall)
        for (const r of kell) {
          if (most.roles.includes(r)) continue
          if (await addMemberRole(g.guild_id, t.discord_user_id, r, okBol)) e.added++
          else { e.failed++; hiba = `nem sikerült felrakni: ${r}` }
        }
        for (const r of most.roles) {
          if (!kezelt.has(r) || kell.has(r)) continue
          if (await removeMemberRole(g.guild_id, t.discord_user_id, r, okBol)) e.removed++
          else { e.failed++; hiba = `nem sikerült levenni: ${r}` }
        }
      }
      await query(
        `INSERT INTO discord_role_sync (guild_id, discord_user_id, synced_at, error) VALUES ($1, $2, now(), $3)
         ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET synced_at = now(), error = excluded.error`,
        [g.guild_id, t.discord_user_id, most.status === 'not_member' ? 'nem tagja a szervernek' : hiba])
    }

    // ---- akik közben leváltak: a kezelt rangok le, a nyilvántartásból ki ----
    const levaltak = await query<{ discord_user_id: string }>(
      `SELECT s.discord_user_id FROM discord_role_sync s
        WHERE s.guild_id = $1
          AND NOT EXISTS (SELECT 1 FROM discord_links l WHERE l.discord_user_id = s.discord_user_id)
        LIMIT $2`, [g.guild_id, KOTEG])
    for (const l of levaltak) {
      const most = await fetchMemberRoles(g.guild_id, l.discord_user_id)
      if (most.status === 'unknown') { e.failed++; continue }
      let rendben = true
      if (most.status === 'ok') {
        for (const r of most.roles) {
          if (!kezelt.has(r)) continue
          if (await removeMemberRole(g.guild_id, l.discord_user_id, r, okBol)) e.removed++
          else { e.failed++; rendben = false }
        }
      }
      if (rendben) {
        await query('DELETE FROM discord_role_sync WHERE guild_id = $1 AND discord_user_id = $2', [g.guild_id, l.discord_user_id])
      }
    }
  }
  return e
}
