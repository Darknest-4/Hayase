// A leképezés-feloldó.
//
//   YUME anime
//      ↓  anime_mappings
//   hiányzik azonosító?
//      ↓  leképező szolgáltatások, sorban
//   normalizált azonosítók
//      ↓  vissza az anime_mappings-be
//   adapter
//
// NÉGY DOLGOT CSINÁL, ÉS MINDEGYIK AZÉRT VAN, MERT NÉLKÜLE FÁJ:
//
//   1. NEM KÉRDEZ, HA NEM KELL. Ha a táblában mind a négy azonosító megvan,
//      nincs külső hívás. Ez a leggyakoribb eset, és nulla késleltetést jelent.
//
//   2. EGY KÉRÉS, NEM HÚSZ. Ha húsz lejátszásindítás ugyanarra a címre fut,
//      egyetlen közös kérés megy ki, és mind a húsz azt várja meg. Enélkül
//      egy népszerű cím megjelenése húsz egyforma kérést küldene egy ingyenes,
//      önkéntes szolgáltatásnak.
//
//   3. A HIÁNYT IS MEGJEGYZI. Ha egy címet egyik leképező sem ismer, azt
//      RÖVID ideig megjegyezzük — különben minden egyes lejátszásindítás
//      újrakérdezné ugyanazt a nemleges választ.
//
//   4. A MEGLÉVŐ ADATOT NEM BÁNTJA. A leképezés kiegészít, nem javít: amit a
//      táblánk tud, az marad. Egy külső szolgáltatás tévedése nem írhatja
//      felül azt, amit valaki beírt.

import { query, queryOne } from '../../../infrastructure/database/index.ts'
import { armUpstream } from './upstreams/arm.ts'
import { malsyncUpstream } from './upstreams/malsync.ts'
import { hasAnchor, isComplete, merge, noIds, type ExternalIds, type MappingUpstream } from './types.ts'

/** A leképezők, próbálkozási sorrendben. Lásd az `arm.ts` fejlécét. */
const UPSTREAMS: MappingUpstream[] = [armUpstream, malsyncUpstream]

/** Ennyi idő után feladjuk egy leképezőnél. */
const TIMEOUT_MS = 6_000

/**
 * Meddig hisszük el, amit megtudtunk.
 *
 * A pozitív válasz sokáig érvényes: egy AniList-azonosító nem változik. A
 * NEMLEGES viszont rövid ideig, mert az azt jelentheti, hogy a leképező még
 * nem tud az új címről — és egy friss évadnál ez néhány nap alatt megváltozik.
 */
const POSITIVE_TTL_MS = 6 * 60 * 60_000   // 6 óra
const NEGATIVE_TTL_MS = 10 * 60_000       // 10 perc

interface CacheEntry { until: number, ids: ExternalIds }

const cache = new Map<string, CacheEntry>()
/** Az ÉPP FUTÓ kérések — ez a húsz-kérés-helyett-egy. */
const inFlight = new Map<string, Promise<ExternalIds>>()

/** Csak tesztekhez. */
export function clearMappingCache (): void {
  cache.clear()
  inFlight.clear()
}

/** Mérőszámok az adminfelületnek és a teszteknek. */
export interface MappingStats {
  cached: number
  inFlight: number
}
export function mappingStats (): MappingStats {
  return { cached: cache.size, inFlight: inFlight.size }
}

/** Amit a táblánk tud. */
async function fromTable (animeId: string): Promise<ExternalIds> {
  const row = await queryOne<{
    anilist_id: number | null, mal_id: number | null, kitsu_id: number | null, anidb_id: number | null
  }>(
    'SELECT anilist_id, mal_id, kitsu_id, anidb_id FROM anime_mappings WHERE anime_id = $1',
    [animeId]
  )
  if (!row) return noIds()
  return {
    anilistId: row.anilist_id ?? null,
    malId: row.mal_id ?? null,
    kitsuId: row.kitsu_id ?? null,
    anidbId: row.anidb_id ?? null
  }
}

/**
 * A megtudott azonosítók visszaírása.
 *
 * CSAK A HIÁNYZÓKAT tölti — a `COALESCE` iránya ezt jelenti: ami a sorban már
 * van, az marad.
 *
 * AZ EGYEDI MEGSZORÍTÁS A KÉNYES RÉSZ. Az `anilist_id`, `mal_id` és `anidb_id`
 * oszlopon UNIQUE áll. Ha egy leképező olyan azonosítót ad, ami MÁR EGY MÁSIK
 * címhez tartozik — egy téves leképezés, vagy két YUME-sor ugyanarról a
 * műről —, az írás megsértené a megszorítást. Ilyenkor NEM hasalunk el: a
 * kiegészítés kényelem, nem az a dolga, hogy egy lejátszásindítást
 * megbuktasson. A hibát naplózzuk, és a memóriában megtudott azonosítókkal
 * megyünk tovább.
 */
async function persist (animeId: string, ids: ExternalIds): Promise<void> {
  try {
    await query(
      `INSERT INTO anime_mappings (anime_id, anilist_id, mal_id, kitsu_id, anidb_id)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (anime_id) DO UPDATE
              SET anilist_id = COALESCE(anime_mappings.anilist_id, EXCLUDED.anilist_id),
                  mal_id     = COALESCE(anime_mappings.mal_id,     EXCLUDED.mal_id),
                  kitsu_id   = COALESCE(anime_mappings.kitsu_id,   EXCLUDED.kitsu_id),
                  anidb_id   = COALESCE(anime_mappings.anidb_id,   EXCLUDED.anidb_id),
                  updated_at = now()`,
      [animeId, ids.anilistId, ids.malId, ids.kitsuId, ids.anidbId]
    )
  } catch (error) {
    console.warn(
      `a leképezés nem írható be (${animeId}) — valószínűleg egy azonosító már más címhez tartozik:`,
      (error as Error)?.message
    )
  }
}

/** Egy leképező megkérdezése, időkorláttal. */
async function ask (up: MappingUpstream, known: ExternalIds): Promise<Partial<ExternalIds>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    return await up.lookup(known, ac.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** A tényleges munka — egy címre, egyszer. */
async function work (animeId: string): Promise<ExternalIds> {
  const base = await fromTable(animeId)

  // 1. Megvan minden → nincs mit kérdezni.
  if (isComplete(base)) return base

  // 2. Nincs mire támaszkodni → nincs mit kérdezni. Egy leképező azonosítóból
  //    indul; cím szerint keresni épp az a tévedés, amit el akarunk kerülni.
  if (!hasAnchor(base)) return base

  let ids = base
  for (const up of UPSTREAMS) {
    if (isComplete(ids)) break
    try {
      const extra = await ask(up, ids)
      ids = merge(ids, extra)
    } catch (error) {
      // Egy leképező hibája nem a néző hibája: megyünk a következőre.
      console.warn(`a(z) ${up.id} leképező nem válaszolt:`, (error as Error)?.message)
    }
  }

  // 3. Csak akkor írunk, ha tényleg megtudtunk valamit.
  const valtozott =
    ids.anilistId !== base.anilistId || ids.malId !== base.malId ||
    ids.kitsuId !== base.kitsuId || ids.anidbId !== base.anidbId
  if (valtozott) await persist(animeId, ids)

  return ids
}

/**
 * Egy cím külső azonosítói — a tábláből, szükség esetén kiegészítve.
 *
 * SOHA NEM DOB. Egy leképező hibája nem állíthatja meg a lejátszást: ilyenkor
 * az jön vissza, amit a tábla tud.
 */
export async function resolveExternalIds (animeId: string): Promise<ExternalIds> {
  const now = Date.now()

  const hit = cache.get(animeId)
  if (hit && hit.until > now) return hit.ids
  if (hit) cache.delete(animeId)

  // EGY KÉRÉS, NEM HÚSZ: aki ugyanarra vár, ugyanazt az ígéretet kapja.
  const futo = inFlight.get(animeId)
  if (futo) return await futo

  const promise = work(animeId)
    .then(ids => {
      /*
       * A TELJES eredmény sokáig érvényes, a RÉSZLEGES rövid ideig. Egy
       * hiányzó azonosító lehet, hogy holnap már megvan a leképezőnél — egy
       * meglévő viszont nem fog megváltozni.
       */
      const ttl = isComplete(ids) ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
      cache.set(animeId, { until: Date.now() + ttl, ids })
      return ids
    })
    .catch(error => {
      // Ide csak akkor jutunk, ha a TÁBLA olvasása hasalt el.
      console.error('a leképezés feloldása elhasalt', error)
      return noIds()
    })
    .finally(() => { inFlight.delete(animeId) })

  inFlight.set(animeId, promise)
  return await promise
}
