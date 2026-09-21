// arm.haglund.dev — az elsődleges leképező.
//
// MIÉRT EZ AZ ELSŐ. Egyetlen kérésre mind a négy azonosítót visszaadja,
// gyorsan, és ÉVADONKÉNT KÜLÖNBÖZŐT. Mérve:
//
//   anilist=16498 (1. évad)  → anidb 9541,  kitsu 7442,  myanimelist 16498
//   anilist=99147 (3. évad)  → anidb 13241, kitsu 13569
//
// Ez az, amiért a leképezés egyáltalán van: a cím a két évadnál majdnem
// azonos, az azonosító nem.
//
// VÁLASZIDŐ, mérve: 45–135 ms. Ismeretlen azonosítóra 400-at ad (a sémája
// tartományt is ellenőriz), nem 404-et — ezért a 4xx-et NEM hibának
// tekintjük, hanem „nem ismeri" válasznak.

import { noIds, type ExternalIds, type MappingUpstream } from '../types.ts'

const BASE = 'https://arm.haglund.dev/api/v2/ids'

/**
 * Melyik azonosítóval kérdezzünk.
 *
 * A sorrend nem véletlen: az AniList a legjobban lefedett, az AniDB a
 * legpontosabb az évadokra. Egyet kérdezünk — a szolgáltatás a többit adja.
 */
function forras (known: ExternalIds): { source: string, id: number } | null {
  if (known.anilistId != null) return { source: 'anilist', id: known.anilistId }
  if (known.malId != null) return { source: 'myanimelist', id: known.malId }
  if (known.anidbId != null) return { source: 'anidb', id: known.anidbId }
  if (known.kitsuId != null) return { source: 'kitsu', id: known.kitsuId }
  return null
}

interface ArmValasz {
  anilist?: number
  myanimelist?: number
  kitsu?: number
  anidb?: number
}

export const armUpstream: MappingUpstream = {
  id: 'arm',

  async lookup (known, signal): Promise<Partial<ExternalIds>> {
    const q = forras(known)
    if (!q) return noIds()

    const res = await fetch(`${BASE}?source=${q.source}&id=${q.id}`, {
      headers: { accept: 'application/json', 'user-agent': 'YUME/1.0 (+https://animehub.hu)' },
      signal
    })

    /*
     * A 4xx NEM HIBA. A szolgáltatás ismeretlen vagy tartományon kívüli
     * azonosítóra 400-at ad (mérve: `FST_ERR_VALIDATION`), 404-et pedig a
     * nem létezőre. Egyik sem azt jelenti, hogy „nem tudtam megkérdezni" —
     * azt jelenti, hogy megkérdeztem, és nem ismeri. Ha hibának vennénk, egy
     * ismeretlen cím kizárná az egész leképezőt.
     */
    if (res.status >= 400 && res.status < 500) return noIds()
    if (!res.ok) throw new Error(`arm: HTTP ${res.status}`)

    const body = await res.json() as ArmValasz | null
    if (!body || typeof body !== 'object') return noIds()

    return {
      anilistId: body.anilist ?? null,
      malId: body.myanimelist ?? null,
      kitsuId: body.kitsu ?? null,
      anidbId: body.anidb ?? null
    }
  }
}
