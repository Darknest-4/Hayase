/**
 * SZEMÉLYES ÉRTESÍTÉS DM-BEN — új rész jelent meg a könyvtárad egy címéhez.
 *
 * BEKAPCSOLHATÓ, ALAPBÓL KI: a felhasználó a főoldal Beállítások → Fiók fülén
 * kapcsolja be, az összekötött Discord-fiókjához. Csak azokról a címekről
 * szól, amelyek a könyvtárában „nézem", „tervezem" vagy „újranézem"
 * állapotúak — egy befejezett vagy abbahagyott sorozat új része nem hír neki.
 * És csak arról, ami a bekapcsolás UTÁN és a cím felvétele UTÁN jelent meg: a
 * bekapcsolás nem zúdítja rá az elmúlt két nap összes részét.
 *
 * EPIZÓDONKÉNT EGYSZER: az elsődleges kulcs (felhasználó + epizód) a
 * foglalás, és a küldés ELŐTT foglalunk — ugyanaz a minta, mint a
 * hírfolyamnál: két worker sem küldheti ugyanazt kétszer, és egy elhasalt
 * küldés után sem megy ki másodszor.
 *
 * HA A DM NEM MEGY KI (a tag letiltotta a szerveren kívüli üzeneteket, vagy
 * nincs közös szerver a bottal), háromszor egymás után, a kapcsoló magától
 * kikapcsol — nem próbálkozunk minden új résznél a végtelenségig.
 *
 * A NYELV a felhasználó YUME-beli felületi nyelve (`language.ui`).
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { isConfigured, lastError, sendDirectMessage } from './rest-client.ts'
import { buildEpisodeEmbed, episodeDetails } from './episode-feed.ts'
import { YUME_URL } from './embed-kit.ts'

import type { Nyelv } from './i18n.ts'

const MAX_KOR_ORA = Number(process.env.DISCORD_DM_MAX_AGE_HOURS ?? 48)
/** Egy körben ennyi DM mehet ki — kettő Discord-hívás mindegyik. */
const KOTEG = Number(process.env.DISCORD_DM_BATCH ?? 20)
/** Ennyi egymás utáni sikertelen kézbesítés után a kapcsoló kikapcsol. */
export const MAX_HIBA = 3

const FEJ = {
  hu: (url: string) => `📬 Új rész jelent meg a könyvtáradból. (Kikapcsolás: ${url})`,
  en: (url: string) => `📬 A new episode is out from your library. (Turn off: ${url})`
}

export interface DmResult { sent: number, failed: number, disabled: number }

export async function notifyNew (): Promise<DmResult> {
  const eredmeny: DmResult = { sent: 0, failed: 0, disabled: 0 }
  if (!isConfigured()) return eredmeny

  /*
   * KIVÁLASZTÁS ÉS FOGLALÁS EGY UTASÍTÁSBAN. Két külön lépésben (előbb
   * megnézem, mi jár, aztán lefoglalom) két egyszerre futó kör ugyanazt
   * választhatná ki; itt az elsődleges kulcs dönt: amit egy másik kör már
   * lefoglalt, azt az `ON CONFLICT DO NOTHING` kihagyja, és csak a SAJÁT
   * foglalásunk jön vissza. Dupla küldés így szerkezetileg nem lehetséges.
   */
  const jeloltek = await query<{ user_id: string, discord_user_id: string, episode_id: string, nyelv: string | null }>(
    `WITH jelolt AS (
       SELECT l.user_id, e.id AS episode_id
         FROM discord_links l
         JOIN user_profiles p ON p.user_id = l.user_id
         JOIN library_entries le ON le.profile_id = p.id AND le.status IN ('WATCHING', 'PLANNING', 'REWATCHING')
         JOIN episodes e ON e.anime_id = le.anime_id
         JOIN anime a ON a.id = e.anime_id
        WHERE l.dm_new_episodes
          AND e.visibility = 'public' AND a.visibility = 'public'
          AND e.created_at > now() - ($1::int || ' hours')::interval
          AND e.created_at > l.dm_enabled_at
          AND e.created_at > le.created_at
          AND NOT EXISTS (
            SELECT 1 FROM discord_dm_deliveries d WHERE d.user_id = l.user_id AND d.episode_id = e.id)
        ORDER BY e.created_at, e.id
        LIMIT $2
     ), foglalt AS (
       INSERT INTO discord_dm_deliveries (user_id, episode_id)
       SELECT user_id, episode_id FROM jelolt
       ON CONFLICT DO NOTHING
       RETURNING user_id, episode_id
     )
     SELECT f.user_id, f.episode_id, l.discord_user_id,
            (SELECT s.value #>> '{}' FROM user_settings s JOIN user_profiles p ON p.id = s.profile_id
              WHERE p.user_id = f.user_id AND s.key = 'language.ui' LIMIT 1) AS nyelv
       FROM foglalt f JOIN discord_links l ON l.user_id = f.user_id`,
    [MAX_KOR_ORA, KOTEG])

  for (const j of jeloltek) {
    const reszletek = await episodeDetails(j.episode_id)
    if (!reszletek) {
      await query('UPDATE discord_dm_deliveries SET error = $3 WHERE user_id = $1 AND episode_id = $2',
        [j.user_id, j.episode_id, 'az epizód időközben eltűnt'])
      continue
    }

    const nyelv: Nyelv = j.nyelv === 'en' ? 'en' : 'hu'
    const uzenet = {
      ...(buildEpisodeEmbed(reszletek, nyelv) as Record<string, unknown>),
      content: FEJ[nyelv](`${YUME_URL}/#/settings?tab=account`)
    }

    if (await sendDirectMessage(j.discord_user_id, uzenet)) {
      await query('UPDATE discord_links SET dm_failures = 0 WHERE user_id = $1 AND dm_failures > 0', [j.user_id])
      eredmeny.sent++
      continue
    }

    eredmeny.failed++
    await query('UPDATE discord_dm_deliveries SET error = $3 WHERE user_id = $1 AND episode_id = $2',
      [j.user_id, j.episode_id, String(lastError() ?? 'ismeretlen hiba').slice(0, 300)])
    // A SET minden kifejezése a RÉGI sort látja: az új számláló `dm_failures + 1`.
    const kikapcsolva = await queryOne<{ dm_new_episodes: boolean }>(
      `UPDATE discord_links
          SET dm_failures = dm_failures + 1,
              dm_new_episodes = dm_failures + 1 < $2
        WHERE user_id = $1
        RETURNING dm_new_episodes`, [j.user_id, MAX_HIBA])
    if (kikapcsolva && !kikapcsolva.dm_new_episodes) eredmeny.disabled++
  }

  return eredmeny
}

/** A felhasználó DM-kapcsolója — a főoldal Beállítások → Fiók fülén. */
export async function setDm (userId: string, be: boolean): Promise<boolean> {
  const sor = await queryOne(
    `UPDATE discord_links
        SET dm_new_episodes = $2,
            dm_enabled_at = CASE WHEN $2 THEN now() ELSE dm_enabled_at END,
            dm_failures = 0
      WHERE user_id = $1 RETURNING 1`, [userId, be])
  return Boolean(sor)
}
