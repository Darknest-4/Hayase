/**
 * ÚJ EPIZÓD BEJELENTÉSE — epizódonként egy üzenet, a teljes adatlappal.
 *
 * MIÉRT NEM TARTÓS ÜZENET. A tartós üzenet EGY üzenetet tart kint, és azt
 * szerkeszti újra. Egy epizódbejelentés ennek az ellentéte: kimegy egyszer,
 * és soha többé nem változik — a tegnapi epizód bejelentése akkor is
 * érdekes, amikor ma jött egy újabb.
 *
 * A DEDUPLIKÁCIÓ AZ ADATBÁZIS KULCSÁBAN VAN. Az elsődleges kulcs (guild +
 * epizód) kizárja, hogy ugyanaz az epizód kétszer kimenjen — akkor is, ha
 * két worker egyszerre ébred. Egy „megnézem, ment-e már" minta mindkettőnek
 * azt mondaná, hogy nem.
 *
 * ÉS A FOGLALÁS A KÜLDÉS ELŐTT TÖRTÉNIK. Ha a Discord-hívás elhasal, a sor
 * `error`-ral marad, és nem próbáljuk újra a végtelenségig. Fordított
 * sorrendben egy elhasalt kiírás után az epizód másodszor is kimenne — és a
 * csatornában két egyforma bejelentés állna.
 */

import { query, queryOne } from '../../infrastructure/database/index.ts'
import { createRestClient, isConfigured } from './rest-client.ts'
import * as registry from './registry.ts'
import {
  DASHBOARD_URL, LABLEC, SZIN, YUME_URL, gombok, rovidit
} from './embed-kit.ts'

/** Meddig visszamenőleg jelentünk be. Egy hét után már nem újdonság. */
const MAX_KOR_ORA = Number(process.env.DISCORD_EPISODE_MAX_AGE_HOURS ?? 48)

/** Hány epizód mehet ki egy körben. A Discord korlátait tiszteletben tartva. */
const KOTEG = Number(process.env.DISCORD_EPISODE_BATCH ?? 5)

export interface EpisodeRow {
  id: string
  anime_id: string
  number: string
  ep_cim: string | null
  ep_leiras: string | null
  air_date: Date | null
  duration: number | null
  cim: string
  romaji: string | null
  english: string | null
  native: string | null
  leiras: string | null
  borito: string | null
  banner: string | null
  status: string | null
  ev: number | null
  pontszam: string | null
  osszes_ep: number | null
}

/**
 * A TELJES ADATLAP EGY LEKÉRDEZÉSBŐL.
 *
 * A címek és a képek külön táblában élnek (`anime_titles`, `anime_images`),
 * mert egy animének több neve és többféle képe van. Aloldalas
 * lekérdezésekkel egyetlen körben megvan mind — epizódonként öt külön
 * kérdés helyett.
 */
export async function episodeDetails (episodeId: string): Promise<EpisodeRow | undefined> {
  return await queryOne<EpisodeRow>(
    `SELECT e.id, e.anime_id,
            CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END AS number,
            e.title AS ep_cim, e.synopsis AS ep_leiras, e.air_date, e.duration,
            a.canonical_title AS cim, a.synopsis AS leiras, a.status,
            a.season_year AS ev, a.average_score AS pontszam, a.episode_count AS osszes_ep,
            (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'romaji')  AS romaji,
            (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'english') AS english,
            (SELECT t.title FROM anime_titles t WHERE t.anime_id = a.id AND t.kind = 'native')  AS native,
            (SELECT i.object_key FROM anime_images i WHERE i.anime_id = a.id AND i.kind = 'cover'  LIMIT 1) AS borito,
            (SELECT i.object_key FROM anime_images i WHERE i.anime_id = a.id AND i.kind = 'banner' LIMIT 1) AS banner
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.id = $1`, [episodeId])
}

/**
 * AZ EMBED — ez az, amit a felhasználó lát.
 *
 * MINDEN MEZŐ ELHAGYHATÓ. Egy frissen importált címnél lehet, hogy nincs
 * japán cím, borító vagy leírás; ilyenkor az a rész egyszerűen kimarad, nem
 * jelenik meg üresen vagy kitalált tartalommal.
 *
 * A KÉPEK A SZOLGÁLTATÓ CDN-JÉRŐL jönnek (`object_key` teljes URL-t tárol),
 * tehát a Discord közvetlenül tölti be őket — nem mi szolgáljuk ki.
 */
export function buildEpisodeEmbed (r: EpisodeRow): unknown {
  const link = `${YUME_URL}/#/anime/${r.anime_id}`
  const nezd = `${YUME_URL}/#/watch/${r.id}`

  /*
   * A MÁSODLAGOS CÍMEK. A japán (native) az, amit kértél; az angol csak
   * akkor kerül oda, ha tényleg más, mint a kanonikus — különben ugyanazt
   * írnánk ki kétszer.
   */
  const alcimek = [
    r.native,
    r.english && r.english !== r.cim ? r.english : null,
    r.romaji && r.romaji !== r.cim && r.romaji !== r.english ? r.romaji : null
  ].filter(Boolean)

  const mezok: Array<Record<string, unknown>> = [
    {
      name: '🎬 Epizód',
      value: `**${r.number}. rész**${r.osszes_ep ? ` / ${r.osszes_ep}` : ''}`,
      inline: true
    }
  ]

  if (r.duration) mezok.push({ name: '⏱️ Hossz', value: `**${r.duration} perc**`, inline: true })
  if (r.pontszam) mezok.push({ name: '⭐ Pontszám', value: `**${Number(r.pontszam).toFixed(1)}**`, inline: true })
  if (r.status) mezok.push({ name: '📡 Állapot', value: String(r.status), inline: true })
  if (r.ev) mezok.push({ name: '📅 Év', value: String(r.ev), inline: true })
  if (r.air_date) {
    const mikor = Math.floor(new Date(r.air_date).getTime() / 1000)
    mezok.push({ name: '🗓️ Adás', value: `<t:${mikor}:D>`, inline: true })
  }

  // AZ EPIZÓD SAJÁT LEÍRÁSA külön mezőben — ez az, ami erről a RÉSZRŐL szól.
  const epLeiras = rovidit(r.ep_leiras, 900)
  if (epLeiras) {
    mezok.push({ name: '📝 Erről a részről', value: epLeiras, inline: false })
  }

  const sorozatLeiras = rovidit(r.leiras, 600)

  return {
    embeds: [{
      color: SZIN,
      author: { name: 'YUME • Új epizód', icon_url: `${YUME_URL}/assets/yume.svg`, url: YUME_URL },
      title: rovidit(r.ep_cim ? `${r.cim} — ${r.ep_cim}` : r.cim, 250),
      url: nezd,
      description: [
        alcimek.length ? `*${alcimek.join(' · ')}*` : null,
        sorozatLeiras || null
      ].filter(Boolean).join('\n\n') || undefined,
      fields: mezok,
      // A BORÍTÓ KICSIBEN, a banner nagyban — ahogy egy adatlap kinéz.
      ...(r.borito ? { thumbnail: { url: r.borito } } : {}),
      ...(r.banner ? { image: { url: r.banner } } : {}),
      footer: { text: `${LABLEC.text} • új rész elérhető` }
    }],
    components: gombok([
      { label: 'Megnézem', url: nezd, emoji: '▶️' },
      { label: 'Adatlap', url: link, emoji: '📖' },
      { label: 'Vezérlőpult', url: DASHBOARD_URL, emoji: '⚙️' }
    ]),
    allowed_mentions: { parse: [] }
  }
}

export interface AnnounceResult {
  sent: number
  failed: number
  skipped: number
  reason?: string
}

/**
 * A KIMENŐ KÖR.
 *
 * Csak azokat az epizódokat jelenti be, amik a megőrzési ablakon belül
 * kerültek be, és amikről még nem szólt. A csatornát a registry adja: ha a
 * setup még nem futott le, nincs hova írni — és ezt megmondjuk, nem
 * hallgatjuk el.
 */
export async function announceNew (guildId: string): Promise<AnnounceResult> {
  if (!isConfigured()) return { sent: 0, failed: 0, skipped: 0, reason: 'nincs bot token' }

  const csatorna = await registry.get(guildId, 'channel', 'channel:uj-epizodok')
  if (!csatorna?.discord_object_id) {
    return { sent: 0, failed: 0, skipped: 0, reason: 'nincs „uj-epizodok" csatorna — futtasd a setupot' }
  }

  const ujak = await query<{ id: string }>(
    `SELECT e.id
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.visibility = 'public' AND a.visibility = 'public'
        AND e.created_at > now() - ($2::int || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1 FROM discord_episode_announcements d
           WHERE d.guild_id = $1 AND d.episode_id = e.id)
      ORDER BY e.created_at, e.id
      LIMIT $3`,
    [guildId, MAX_KOR_ORA, KOTEG])

  if (!ujak.length) return { sent: 0, failed: 0, skipped: 0 }

  const kliens = createRestClient()
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const { id } of ujak) {
    /*
     * ELŐBB FOGLALUNK. Az `ON CONFLICT DO NOTHING` azt jelenti: ha közben
     * egy másik példány már elkezdte, mi kihagyjuk. Így két worker sem tud
     * ugyanarról az epizódról kétszer szólni.
     */
    const foglalas = await queryOne<{ episode_id: string }>(
      `INSERT INTO discord_episode_announcements (guild_id, episode_id, channel_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING episode_id`,
      [guildId, id, csatorna.discord_object_id])
    if (!foglalas) { skipped++; continue }

    const reszletek = await episodeDetails(id)
    if (!reszletek) {
      await query(
        'UPDATE discord_episode_announcements SET error = $3 WHERE guild_id = $1 AND episode_id = $2',
        [guildId, id, 'az epizód időközben eltűnt'])
      failed++
      continue
    }

    try {
      const kuldott = await kliens.send(csatorna.discord_object_id, buildEpisodeEmbed(reszletek))
      await query(
        'UPDATE discord_episode_announcements SET message_id = $3 WHERE guild_id = $1 AND episode_id = $2',
        [guildId, id, kuldott.id])
      sent++
    } catch (error) {
      await query(
        'UPDATE discord_episode_announcements SET error = $3 WHERE guild_id = $1 AND episode_id = $2',
        [guildId, id, String((error as Error)?.message ?? error).slice(0, 300)])
      failed++
    }
  }

  return { sent, failed, skipped }
}

/** Előnézet — a Discordot MEG SEM SZÓLÍTJA. */
export async function preview (episodeId: string): Promise<unknown | null> {
  const r = await episodeDetails(episodeId)
  return r ? buildEpisodeEmbed(r) : null
}

/** A legutóbbi bejelentések — a felületnek. */
export async function log (guildId: string, limit = 25): Promise<Array<Record<string, unknown>>> {
  return await query(
    `SELECT d.episode_id, d.message_id, d.error, d.at,
            a.canonical_title AS anime,
            CASE WHEN e.number = trunc(e.number) THEN trunc(e.number)::int::text ELSE e.number::text END AS number
       FROM discord_episode_announcements d
       JOIN episodes e ON e.id = d.episode_id
       JOIN anime a ON a.id = e.anime_id
      WHERE d.guild_id = $1 ORDER BY d.at DESC LIMIT $2`, [guildId, limit])
}
