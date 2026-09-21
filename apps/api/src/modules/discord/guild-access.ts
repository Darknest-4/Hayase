/**
 * Ki férhet hozzá egy guild adataihoz — és MINDEN kérésnél újra.
 *
 * A 7.2. pont kimondja: „Ne támaszkodj kizárólag a korábban elmentett
 * permission adatokra." Ennek oka van: a Discord oldalán bármikor elvehetik
 * a jogot, és egy örökre eltárolt „ő admin" sor onnantól hazudik. Ezért a
 * tárolt tagság LEJÁR, és a lejárt adat nem jogosít.
 *
 * KÉT ÚT VEZET BE, és ez szándékos:
 *
 *   1. A YUME SAJÁT JOGOSULTSÁGA (`discord.manage`). Az oldal üzemeltetője a
 *      saját rendszerében adminisztrál; ehhez nem kell Discord-fiókot
 *      kötnie. Ez az út MA IS működik.
 *
 *   2. A DISCORD GUILD-JOGOSULTSÁGA a összekötött fiókon át. Ehhez Discord
 *      OAuth kell, ami ma nincs bekötve — a tábla üres, tehát ezen az úton
 *      jelenleg senki nem jut be. Ez helyes viselkedés: inkább senki, mint
 *      tévesen valaki.
 *
 * A FRONTEND ELREJTÉSE NEM VÉDELEM. Ez a modul a szerveroldali kapu; a
 * felület legfeljebb kényelmi okból rejt el gombokat.
 */

import { queryOne } from '../../infrastructure/database/index.ts'
import { can, parsePermissions, type Capability } from './permissions.ts'

/**
 * Meddig számít frissnek egy tárolt tagság.
 *
 * Öt perc: elég rövid ahhoz, hogy egy visszavont jog gyorsan érvényesüljön,
 * és elég hosszú ahhoz, hogy egy vezérlőpult-munkamenet ne kérdezze újra a
 * Discordot minden kattintásnál.
 */
export const MEMBERSHIP_TTL_MS = Number(process.env.DISCORD_MEMBERSHIP_TTL_MS ?? 5 * 60_000)

export interface AccessDecision {
  allowed: boolean
  /** Miért. A naplóba és az üzemeltetőnek — a válaszba csak a rövid ok megy. */
  reason: 'yume_permission' | 'discord_permission' | 'no_link' | 'stale' | 'insufficient' | 'not_member'
}

export interface AccessDeps {
  /** Van-e a YUME-felhasználónak ez a jogosultsága. */
  hasPermission: (slug: string) => boolean | Promise<boolean>
  userId: string
  now?: number
}

/**
 * Hozzáférhet-e ez a felhasználó ehhez a guildhez.
 *
 * A SORREND FONTOS: előbb a YUME-jogosultság, mert az olcsó (memóriából) és
 * mert az oldal üzemeltetője mindig bejut. Csak utána megyünk adatbázishoz.
 */
export async function guildAccess (
  guildId: string,
  capability: Capability,
  deps: AccessDeps
): Promise<AccessDecision> {
  if (await deps.hasPermission('discord.manage')) {
    return { allowed: true, reason: 'yume_permission' }
  }

  const link = await queryOne<{ discord_user_id: string }>(
    'SELECT discord_user_id FROM discord_links WHERE user_id = $1', [deps.userId])
  if (!link) return { allowed: false, reason: 'no_link' }

  const member = await queryOne<{ owner: boolean, permissions: string, fetched_at: Date }>(
    `SELECT owner, permissions, fetched_at
       FROM discord_guild_members
      WHERE discord_user_id = $1 AND guild_id = $2`,
    [link.discord_user_id, guildId])
  if (!member) return { allowed: false, reason: 'not_member' }

  /*
   * A LEJÁRT ADAT NEM JOGOSÍT. Ez az a pont, ahol a legkönnyebb engedni —
   * „hát tegnap még admin volt" —, és pont ezért van kimondva a 7.2.
   * pontban. Egy elvett jog nem érvényesülne soha.
   */
  const now = deps.now ?? Date.now()
  if (now - new Date(member.fetched_at).getTime() > MEMBERSHIP_TTL_MS) {
    return { allowed: false, reason: 'stale' }
  }

  const ok = can({ owner: member.owner, permissions: parsePermissions(member.permissions) }, capability)
  return ok
    ? { allowed: true, reason: 'discord_permission' }
    : { allowed: false, reason: 'insufficient' }
}
