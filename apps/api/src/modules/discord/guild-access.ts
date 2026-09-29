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
 *   2. A DISCORD GUILD-JOGOSULTSÁGA az összekötött fiókon át. A tagságot
 *      az összekötés (OAuth) tölti fel; ha lejárt, a BOT kérdezi le újra a
 *      saját tokenjével (`refreshMembership`). Ha a bot sem tudja megmondani,
 *      a lejárt adat nem jogosít: inkább senki, mint tévesen valaki.
 *
 * A FRONTEND ELREJTÉSE NEM VÉDELEM. Ez a modul a szerveroldali kapu; a
 * felület legfeljebb kényelmi okból rejt el gombokat.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { can, parsePermissions, type Capability } from './permissions.ts'
import { memberAccess } from './rest-client.ts'

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
  /** A lejárt tagság frissítése. Alapból a bot tokenjével — lásd `refreshMembership`. */
  refresh?: (discordUserId: string, guildId: string) => Promise<Refreshed>
}

// Típusalias, nem interface: a `queryOne` sorparamétere csak ezt fogadja el.
type MemberRow = { owner: boolean, permissions: string, fetched_at: Date }

/** A frissítés kimenete: friss sor, „nem tag", vagy `null` = nem tudjuk. */
export type Refreshed = MemberRow | 'not_member' | null

/**
 * Egy sikertelen frissítés után ennyi ideig nem kérdezzük újra a Discordot.
 *
 * Ha a Discord nem válaszol, minden kérés a teljes időkorlátig (10 s) várna
 * rá, és a vezérlőpult minden kattintása ennyit állna. Így a kapu azonnal
 * nemet mond — a lejárt adat úgysem jogosít —, és fél perc múlva próbálja újra.
 */
const RETRY_AFTER_MS = Number(process.env.DISCORD_MEMBERSHIP_RETRY_MS ?? 30_000)
const inFlight = new Map<string, Promise<Refreshed>>()
const failedAt = new Map<string, number>()

/** Teszthez: felejtse el a sikertelen frissítéseket. */
export function forgetMembershipRefreshes (): void { failedAt.clear() }

/**
 * A LEJÁRT TAGSÁG FRISSÍTÉSE — a bot tokenjével, OAuth nélkül.
 *
 * Eddig a tagságot csak az összekötés írta, és öt perc után semmi nem
 * frissítette: aki nem `discord.manage`-es, az kizáródott, amíg újra nem
 * kötött. Most lejárt adatnál a bot kérdezi meg a Discordot
 * (`memberAccess`), és a friss jog kerül a sorba.
 *
 * CSAK MEGLÉVŐ SORT FRISSÍT (`UPDATE`, nem `INSERT`): ha közben bontották az
 * összekötést, egy frissítés nem támaszthatja fel a tagságát.
 *
 * EGY GUILDRE EGYSZERRE EGY: a vezérlőpult egy nézethez több kérést indít
 * egyszerre, és mind ugyanarra a frissítésre vár — nem mind a Discordra.
 */
export async function refreshMembership (discordUserId: string, guildId: string): Promise<Refreshed> {
  const key = `${discordUserId}:${guildId}`
  const running = inFlight.get(key)
  if (running) return await running
  const failed = failedAt.get(key)
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return null

  const work = (async (): Promise<Refreshed> => {
    const fresh = await memberAccess(guildId, discordUserId)
    if (fresh.status === 'unknown') {
      failedAt.set(key, Date.now())
      return null
    }
    failedAt.delete(key)
    if (fresh.status === 'not_member') {
      // Kilépett, vagy kitették: a tagsága nem maradhat ott.
      await query('DELETE FROM discord_guild_members WHERE discord_user_id = $1 AND guild_id = $2',
        [discordUserId, guildId])
      return 'not_member'
    }
    return await queryOne<MemberRow>(
      `UPDATE discord_guild_members
          SET owner = $3, permissions = $4, guild_name = coalesce($5, guild_name), fetched_at = now()
        WHERE discord_user_id = $1 AND guild_id = $2
        RETURNING owner, permissions, fetched_at`,
      [discordUserId, guildId, fresh.owner, fresh.permissions.toString(), fresh.guildName]) ?? null
  })().finally(() => { inFlight.delete(key) })

  inFlight.set(key, work)
  return await work
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

  let member: MemberRow | undefined = await queryOne<MemberRow>(
    `SELECT owner, permissions, fetched_at
       FROM discord_guild_members
      WHERE discord_user_id = $1 AND guild_id = $2`,
    [link.discord_user_id, guildId])
  if (!member) return { allowed: false, reason: 'not_member' }

  /*
   * A LEJÁRT ADAT NEM JOGOSÍT. Ez az a pont, ahol a legkönnyebb engedni —
   * „hát tegnap még admin volt" —, és pont ezért van kimondva a 7.2.
   * pontban. Egy elvett jog nem érvényesülne soha.
   *
   * Lejárt adatnál ezért FRISSÍTÜNK, nem elhiszünk: a bot megkérdezi a
   * Discordot. Ha nem tudja megmondani, a válasz nem.
   */
  const now = deps.now ?? Date.now()
  if (now - new Date(member.fetched_at).getTime() > MEMBERSHIP_TTL_MS) {
    const fresh = await (deps.refresh ?? refreshMembership)(link.discord_user_id, guildId)
    if (fresh === 'not_member') return { allowed: false, reason: 'not_member' }
    if (!fresh) return { allowed: false, reason: 'stale' }
    member = fresh
  }

  const ok = can({ owner: member.owner, permissions: parsePermissions(member.permissions) }, capability)
  return ok
    ? { allowed: true, reason: 'discord_permission' }
    : { allowed: false, reason: 'insufficient' }
}
