// The artwork and mapping pass.
//
// One request per title fills five external ids, up to four artworks and a
// Hungarian series title where somebody has written one. Same shape as the
// AniList passes — `onProgress`, `shouldStop` between batches — so the run
// machinery and the admin panel need nothing new to drive it.
//
// Five in flight, not more. The measurement that justified this pass was taken
// at five, and ani.zip is a free service run by volunteers: the difference
// between five minutes and four is not worth being the reason it rate-limits.

import { asId, fetchMapping, IMAGE_KIND, usableUrl } from './client.ts'
import type { AniZipRecord } from './client.ts'
import { query, transaction } from '../../infrastructure/database/index.ts'

import type pg from 'pg'

const CONCURRENCY = 5
const BATCH = 50

export interface ArtworkCounts {
  examined: number
  mapped: number
  images: number
  titles: number
  episodes: number
  /** A szolgáltatásnak nincs erről a címről semmije. Ez rendben van. */
  absent: number
  /** Fojtás vagy hiba — a munka elveszett, nem elvégeztük. Ez nincs rendben. */
  refused: number
}

interface Candidate { anime_id: string, anilist_id: number }

/**
 * Fill mappings, artwork and Hungarian titles from ani.zip.
 *
 * `onlyMissing` selects titles with no logo yet, which is the cheapest honest
 * proxy for "this one has not been through the pass": every ani.zip record
 * that has any artwork has a Clearlogo, and the catalogue had zero logos
 * before this existed.
 */
export async function syncArtwork (opts: {
  limit?: number
  onlyMissing?: boolean
  onProgress?: (done: number, total: number, counts: ArtworkCounts) => void | Promise<void>
  shouldStop?: () => boolean | Promise<boolean>
} = {}): Promise<ArtworkCounts> {
  const counts: ArtworkCounts = { examined: 0, mapped: 0, images: 0, titles: 0, episodes: 0, absent: 0, refused: 0 }
  // Ütemezés. Az első futás 20 510 címet kérdezett meg három perc alatt —
  // ~114 kérés másodpercenként egy ingyenes, önkéntesek üzemeltette
  // szolgáltatás felé —, és 18 152-t elvesztett. Nem az adat hiányzott, hanem
  // túl gyorsan kérdeztünk.
  //
  // A késleltetés a válaszokból tanul: minden elutasítás lassít, minden
  // sikeres köteg óvatosan gyorsít vissza. Így egy jó napon gyors marad, egy
  // rosszon pedig nem vész el a munka.
  let delayMs = 120
  const slower = () => { delayMs = Math.min(4000, Math.round(delayMs * 2)) }
  const faster = () => { delayMs = Math.max(120, Math.round(delayMs * 0.85)) }
  const pause = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms))

  // „Ami még hiányzik" két dolgot jelent, mert a passz kettőt tölt: artworköt
  // és epizódtartalmat. Egy cím, ami már kapott logót, de az epizódjai
  // címtelenek, még nem készült el — a korábbi feltétel kihagyta volna.
  const where = opts.onlyMissing === false
    ? ''
    : `AND (NOT EXISTS (SELECT 1 FROM anime_images i WHERE i.anime_id = m.anime_id AND i.kind = 'logo')
           OR EXISTS (SELECT 1 FROM episodes e WHERE e.anime_id = m.anime_id AND e.title IS NULL))`

  const candidates = await query<Candidate>(
    `SELECT m.anime_id, m.anilist_id
       FROM anime_mappings m
      WHERE m.anilist_id IS NOT NULL ${where}
      ORDER BY m.anime_id
      ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`
  )

  const total = candidates.length
  for (let i = 0; i < total; i += BATCH) {
    if (await opts.shouldStop?.()) break
    const slice = candidates.slice(i, i + BATCH)

    // Fetched five-wide, written one transaction per title. A single
    // transaction for the batch would roll back forty-nine good titles
    // because the fiftieth had a malformed URL.
    for (let j = 0; j < slice.length; j += CONCURRENCY) {
      const group = slice.slice(j, j + CONCURRENCY)
      const outcomes = await Promise.all(group.map(async c => ({ c, out: await fetchMapping(c.anilist_id) })))

      let refusedHere = 0
      for (const { c, out } of outcomes) {
        counts.examined++
        if (out.kind === 'absent') { counts.absent++; continue }
        if (out.kind === 'refused') { counts.refused++; refusedHere++; continue }
        try {
          await writeOne(c, out.record, counts)
        } catch {
          // Egy cím rossz adata nem állíthatja meg a passzt. Elutasításnak
          // számít, hogy az összegek stimmeljenek.
          counts.refused++
        }
      }

      // A csoport eredménye szabja a következő tempót.
      if (refusedHere) slower()
      else faster()
      await pause(delayMs)
    }
    await opts.onProgress?.(Math.min(i + BATCH, total), total, counts)
  }

  return counts
}

async function writeOne (c: Candidate, rec: AniZipRecord, counts: ArtworkCounts): Promise<void> {
  const m = rec.mappings ?? {}

  await transaction(async (client: pg.PoolClient) => {
    // ---- external ids ----
    // COALESCE keeps whatever is already there: this pass is a source of new
    // ids, not an authority over ids somebody else wrote.
    const ids = {
      tvdb: asId(m.thetvdb_id),
      tmdb: asId(m.themoviedb_id),
      anidb: asId(m.anidb_id),
      kitsu: asId(m.kitsu_id)
    }
    const imdb = typeof m.imdb_id === 'string' && /^tt\d+$/.test(m.imdb_id) ? m.imdb_id : null

    if (ids.tvdb ?? ids.tmdb ?? ids.anidb ?? ids.kitsu ?? imdb) {
      const { rowCount } = await client.query(
        `UPDATE anime_mappings
            SET tvdb_id  = COALESCE(tvdb_id, $2),
                tmdb_id  = COALESCE(tmdb_id, $3),
                anidb_id = COALESCE(anidb_id, $4),
                kitsu_id = COALESCE(kitsu_id, $5),
                imdb_id  = COALESCE(imdb_id, $6),
                updated_at = now()
          WHERE anime_id = $1
            AND (tvdb_id IS NULL OR tmdb_id IS NULL OR anidb_id IS NULL
                 OR kitsu_id IS NULL OR imdb_id IS NULL)`,
        [c.anime_id, ids.tvdb, ids.tmdb, ids.anidb, ids.kitsu, imdb]
      )
      if (rowCount) counts.mapped++
    }

    // ---- artwork ----
    // Only the kinds the catalogue is short of. Overwriting the cover that
    // AniList supplied — the one the per-title accent is derived from — with
    // a different poster would change the look of a page for no gain.
    for (const img of rec.images ?? []) {
      const kind = IMAGE_KIND[img.coverType ?? '']
      const url = usableUrl(img.url)
      if (!url || !kind || kind === 'cover' || kind === 'banner') continue
      const { rowCount } = await client.query(
        `INSERT INTO anime_images (anime_id, kind, object_key, is_primary)
         VALUES ($1, $2, $3, false)
         ON CONFLICT DO NOTHING`,
        [c.anime_id, kind, url]
      )
      if (rowCount) counts.images++
    }

    // ---- epizódtartalom ----
    //
    // A váz megvan: 364 064 epizódsor, 341 407 dátummal és 359 947 hosszal —
    // de **nulla** címmel, leírással és bélyegképpel. Az epizódlista ezért
    // néz ki üresnek, nem azért, mert nincs epizód.
    //
    // Ugyanez a válasz hozza őket, amit az artwork miatt amúgy is lekérünk.
    // Csak NULL mezőket tölt: ami már ott van, az valakié, és nem ezé a
    // passzé felülírni.
    for (const [key, ep] of Object.entries(rec.episodes ?? {})) {
      const number = Number(ep.episodeNumber ?? key)
      if (!Number.isFinite(number)) continue
      const title = ep.title?.hu?.trim() || ep.title?.en?.trim() || null
      const synopsis = (ep.overview ?? ep.summary ?? '').trim() || null
      const thumb = usableUrl(ep.image)
      if (!title && !synopsis && !thumb) continue
      const { rowCount } = await client.query(
        `UPDATE episodes
            SET title         = COALESCE(title, $3),
                synopsis      = COALESCE(synopsis, $4),
                thumbnail_key = COALESCE(thumbnail_key, $5),
                tvdb_eid      = COALESCE(tvdb_eid, $6),
                anidb_eid     = COALESCE(anidb_eid, $7),
                updated_at    = now()
          WHERE anime_id = $1 AND number = $2
            AND (title IS NULL OR synopsis IS NULL OR thumbnail_key IS NULL)`,
        [c.anime_id, number, title, synopsis, thumb, asId(ep.tvdbId), asId(ep.anidbEid)]
      )
      if (rowCount) counts.episodes++
    }

    // ---- a Hungarian title, where a person has written one ----
    // approved = true, unlike a machine translation: these are human titles
    // carried by the mapping service, and the localisation join only shows
    // approved rows.
    const hu = rec.titles?.hu?.trim()
    if (hu) {
      const { rowCount } = await client.query(
        `INSERT INTO anime_translations (anime_id, language, title, source, approved)
         VALUES ($1, 'hu', $2, 'anizip', true)
         ON CONFLICT (anime_id, language) DO UPDATE
            SET title = COALESCE(anime_translations.title, excluded.title),
                updated_at = now()
          WHERE anime_translations.title IS NULL`,
        [c.anime_id, hu]
      )
      if (rowCount) counts.titles++
    }
  })
}
