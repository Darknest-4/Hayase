// api.malsync.moe — másodlagos leképező.
//
// MIT TUD, ÉS MIT NEM. Mérve: a `/mal/anime/<id>` válasza `id`, `type`,
// `title`, `url`, `total`, `image`, `anidbId`, `Sites` — vagyis AniDB-t ad,
// AniList-et NEM. Ezért másodlagos: akkor van haszna, ha az elsődleges nem
// ismerte a címet, de MAL-azonosítónk van, és az AniDB hiányzik.
//
// Csak MAL-azonosítóval kérdezhető — más forrásra nincs végpontja ebben az
// alakban. Ha nincs MAL-azonosítónk, nem szólítjuk meg.
//
// Ismeretlen azonosítóra 404 (`EntityNotFoundError`), mérve.

import { noIds, type ExternalIds, type MappingUpstream } from '../types.ts'

const BASE = 'https://api.malsync.moe/mal/anime'

interface MalsyncValasz {
  id?: number
  anidbId?: number
}

export const malsyncUpstream: MappingUpstream = {
  id: 'malsync',

  async lookup (known, signal): Promise<Partial<ExternalIds>> {
    if (known.malId == null) return noIds()

    const res = await fetch(`${BASE}/${known.malId}`, {
      headers: { accept: 'application/json', 'user-agent': 'YUME/1.0 (+https://animehub.hu)' },
      signal
    })

    // Lásd az `arm`-nál: a 4xx „nem ismeri", nem „nem tudtam megkérdezni".
    if (res.status >= 400 && res.status < 500) return noIds()
    if (!res.ok) throw new Error(`malsync: HTTP ${res.status}`)

    const body = await res.json() as MalsyncValasz | null
    if (!body || typeof body !== 'object') return noIds()

    return {
      malId: body.id ?? known.malId,
      anidbId: body.anidbId ?? null
    }
  }
}
