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
import { guildLanguage, settingsOf } from './guild-settings.ts'
import { YUME_URL } from './embed-kit.ts'
import {
  allapotSzoveg, animeGombok, cimkek, epizodErtek, episodeWithAnime, gombSor, ido, kartyaSzin,
  leirasDiscordra, masodlagosCimek, md, mufajSzoveg, nezesUrl, pontSzoveg, szezonSzoveg, tisztaSzoveg, vag,
  type AnimeCard, type EpizodAdat, type Mezo
} from './anime-card.ts'

import type { Nyelv } from './i18n.ts'

/** A bejelentés saját szövegei — a szerver nyelvén (lásd `guild-settings.ts`). */
const FELIRAT = {
  hu: { szerzo: 'YUME • Új epizód', lablec: 'YUME • Anime • Közösség • új rész elérhető' },
  en: { szerzo: 'YUME • New episode', lablec: 'YUME • Anime • Community • new episode out' }
}

/** A mostani anime-szezon: a hírfolyam „csak az aktuális szezon" szűrőjéhez. */
export function currentSeason (most: Date = new Date()): { year: number, season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL' } {
  const ho = most.getUTCMonth()
  return {
    year: most.getUTCFullYear(),
    season: ho < 3 ? 'WINTER' : ho < 6 ? 'SPRING' : ho < 9 ? 'SUMMER' : 'FALL'
  }
}

/** Meddig visszamenőleg jelentünk be. Egy hét után már nem újdonság. */
const MAX_KOR_ORA = Number(process.env.DISCORD_EPISODE_MAX_AGE_HOURS ?? 48)

/** Hány epizód mehet ki egy körben. A Discord korlátait tiszteletben tartva. */
const KOTEG = Number(process.env.DISCORD_EPISODE_BATCH ?? 5)

/** Egy rész, a hozzá tartozó cím teljes adatlapjával (`anime-card.ts`). */
export interface EpisodeRow {
  ep: EpizodAdat
  anime: AnimeCard
}

/**
 * A TELJES ADATLAP. A rész és a cím minden adata (nevek, képek, műfajok,
 * stúdió, előzetes) — a közös kártyabetöltőből, amit a parancsok is
 * használnak. A láthatóságot NEM szűri: a kiválasztás (`announceNew`, DM)
 * már csak nyilvánosat vesz.
 */
export async function episodeDetails (episodeId: string): Promise<EpisodeRow | undefined> {
  return await episodeWithAnime(episodeId, { csakNyilvanos: false })
}

/**
 * AZ EMBED — ez az, amit a felhasználó lát.
 *
 * MINDEN MEZŐ ELHAGYHATÓ. Egy frissen importált címnél lehet, hogy nincs
 * japán cím, borító vagy leírás; ilyenkor az a rész egyszerűen kimarad, nem
 * jelenik meg üresen vagy kitalált tartalommal.
 *
 * A BORÍTÓ KICSIBEN, a rész saját képe nagyban (ha nincs, a banner). A
 * pontszám egész százalék, ahogy az oldalon (eddig „82.0" állt itt); az
 * állapot a néző nyelvén (eddig nyersen: „RELEASING").
 *
 * FELNŐTT CÍMNÉL (csak DM-ben fordulhat elő — a csatornába nem megy ki)
 * nincs kép és leírás, lásd `anime-card.ts`.
 */
export function buildEpisodeEmbed (r: EpisodeRow, nyelv: Nyelv = 'hu', emlitett: string | null = null): unknown {
  const f = FELIRAT[nyelv]
  const c = cimkek(nyelv)
  const { ep, anime: k } = r
  const nezd = nezesUrl(ep.id)

  const mezok: Mezo[] = [{ name: c.epizod, value: epizodErtek(ep, k, nyelv), inline: true }]
  const tesz = (name: string, value: string | null, inline = true): void => {
    if (value) mezok.push({ name, value: value.slice(0, 1024), inline })
  }
  const hossz = ep.hossz ?? k.hossz
  tesz(c.hossz, hossz ? `**${c.perc(hossz)}**` : null)
  tesz(c.pont, k.pontszam !== null ? `**${pontSzoveg(k.pontszam)}**` : null)
  tesz(c.formatum, [k.format ? (c.format[k.format] ?? k.format) : null, szezonSzoveg(k, nyelv)].filter(Boolean).join(' · ') || null)
  tesz(c.allapot, allapotSzoveg(k.status, nyelv))
  tesz(c.adas, ep.adas ? ido(ep.adas, 'D') : null)
  tesz(c.studio, k.studiok.length ? k.studiok.map(md).join(', ') : null)
  tesz(c.mufajok, mufajSzoveg(k.mufajok, nyelv), false)
  // AZ EPIZÓD SAJÁT LEÍRÁSA külön mezőben — ez az, ami erről a RÉSZRŐL szól.
  tesz(c.errol, k.felnott ? null : leirasDiscordra(ep.leiras, 600) || null, false)

  /*
   * A MÁSODLAGOS CÍMEK. A japán (native) az, amit kértél; az angol csak
   * akkor kerül oda, ha tényleg más, mint a kanonikus — különben ugyanazt
   * írnánk ki kétszer.
   */
  const alcimek = masodlagosCimek(k)
  const sorozatLeiras = k.felnott ? '' : leirasDiscordra(k.leiras, 500)
  const nagyKep = ep.kep ?? k.banner

  return {
    /*
     * AZ ANIMÉNKÉNTI RANG — és CSAK az. Ha a szerveren ehhez a címhez rang
     * van beállítva, a bejelentés megemlíti; az `allowed_mentions` pontosan
     * ezt az egy rangot engedi, semmi mást (egy címben vagy leírásban álló
     * `@everyone` így sem szólna senkinek).
     */
    ...(emlitett ? { content: `<@&${emlitett}>` } : {}),
    embeds: [{
      color: kartyaSzin(k.felnott ? null : k.szin),
      author: { name: f.szerzo, icon_url: `${YUME_URL}/assets/yume.svg`, url: YUME_URL },
      title: vag(ep.cim ? `${k.cim} — ${tisztaSzoveg(ep.cim)}` : k.cim, 250),
      url: nezd,
      description: [
        alcimek.length ? `*${alcimek.map(a => md(vag(a, 120))).join(' · ')}*` : null,
        k.felnott ? c.felnott : null,
        sorozatLeiras || null
      ].filter(Boolean).join('\n\n') || undefined,
      fields: mezok,
      ...(k.borito ? { thumbnail: { url: k.borito } } : {}),
      ...(nagyKep ? { image: { url: nagyKep } } : {}),
      footer: { text: f.lablec }
    }],
    // A VEZÉRLŐPULT GOMBJA KIMARADT: 2026-09-29 óta csak jogosultsággal
    // nyílik, egy átlagos tagnak zsákutca. Helyette az előzetes, ha van.
    components: [gombSor([
      { label: c.megnezem, url: nezd, emoji: '▶️' },
      ...animeGombok(k, nyelv, { nezes: false })
    ])],
    allowed_mentions: emlitett ? { parse: [], roles: [emlitett] } : { parse: [] }
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

  /*
   * A SZERVER SZŰRŐI: műfaj (ha meg van adva, legalább az egyik) és „csak az
   * aktuális szezon". Ami kiesik, azt nem jelentjük be — és nem is foglaljuk
   * le: ha a szűrő 48 órán belül bővül, még kimehet.
   */
  const beall = await settingsOf(guildId)
  const szezon = currentSeason()
  const ujak = await query<{ id: string, anime_id: string }>(
    `SELECT e.id, e.anime_id
       FROM episodes e JOIN anime a ON a.id = e.anime_id
      WHERE e.visibility = 'public' AND a.visibility = 'public'
        -- FELNŐTT CÍM NEM MEGY KI A CSATORNÁBA (a borítója sem) — lásd
        -- anime-card.ts; az oldal katalógusa is alapból elrejti.
        AND NOT a.is_adult
        AND e.created_at > now() - ($2::int || ' hours')::interval
        AND NOT EXISTS (
          SELECT 1 FROM discord_episode_announcements d
           WHERE d.guild_id = $1 AND d.episode_id = e.id)
        AND (cardinality($4::text[]) = 0 OR EXISTS (
          SELECT 1 FROM anime_genres ag JOIN genres g ON g.id = ag.genre_id
           WHERE ag.anime_id = a.id AND g.slug = ANY($4::text[])))
        AND (NOT $5::boolean OR (a.season_year = $6 AND a.season::text = $7))
      ORDER BY e.created_at, e.id
      LIMIT $3`,
    [guildId, MAX_KOR_ORA, KOTEG, beall.feedGenres, beall.feedCurrentSeason, szezon.year, szezon.season])

  if (!ujak.length) return { sent: 0, failed: 0, skipped: 0 }

  const nyelv = await guildLanguage(guildId)
  const rangok = new Map((await query<{ anime_id: string, discord_role_id: string }>(
    'SELECT anime_id, discord_role_id FROM discord_anime_mentions WHERE guild_id = $1', [guildId]))
    .map(r => [r.anime_id, r.discord_role_id]))

  const kliens = createRestClient()
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const { id, anime_id: animeId } of ujak) {
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
      const kuldott = await kliens.send(csatorna.discord_object_id,
        buildEpisodeEmbed(reszletek, nyelv, rangok.get(animeId) ?? null))
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
