// A külső azonosítók leképezése — a modell és a felfelé menő szerződés.
//
// MIÉRT KELL EZ A RÉTEG. Egy szolgáltató azon az azonosítón talál meg egy
// címet, amit ő ismer: van, aki AniList szerint katalogizál, van, aki MAL
// vagy AniDB szerint. A YUME `anime_mappings` táblája mind a négyet tárolja —
// de csak azt, amit valaha beírtunk. Ami hiányzik, azt eddig egy adapter cím
// szerint próbálta pótolni, és ott téved a legnagyobbat: két évad címe
// gyakran majdnem azonos.
//
// Mérve, az `arm.haglund.dev`-en: a Shingeki no Kyojin 1. évadához
// `anidb: 9541, kitsu: 7442`, a 3. évadhoz `anidb: 13241, kitsu: 13569`
// tartozik. Az azonosító megkülönbözteti őket; a cím alig.

/**
 * A négy azonosító, amit a YUME tárol és egy adapternek átad.
 *
 * MIND SZÁM. A séma (`anime_mappings`) mind a négyet `integer`-ként tárolja,
 * a `kitsu_id`-t is — ezért itt sem sztring. A séma az igazságforrás.
 */
export interface ExternalIds {
  anilistId: number | null
  malId: number | null
  kitsuId: number | null
  anidbId: number | null
}

/** Üres készlet — egy helyen leírva. */
export function noIds (): ExternalIds {
  return { anilistId: null, malId: null, kitsuId: null, anidbId: null }
}

/** Van-e legalább egy azonosító, amin el lehet indulni? */
export function hasAnchor (ids: ExternalIds): boolean {
  return ids.anilistId != null || ids.malId != null || ids.anidbId != null || ids.kitsuId != null
}

/** Megvan mind a négy? Ha igen, nincs mit kérdezni. */
export function isComplete (ids: ExternalIds): boolean {
  return ids.anilistId != null && ids.malId != null && ids.kitsuId != null && ids.anidbId != null
}

/**
 * Egy leképező szolgáltató.
 *
 * SZÁNDÉKOSAN UGYANAZ A MINTA, mint az `AnimeProvider`-nél: az `id` a
 * naplóba kerül, a `lookup` pedig vagy ad valamit, vagy DOB. Üres eredmény =
 * „megkérdeztem, és nem ismeri"; kivétel = „nem tudtam megkérdezni". A kettő
 * különbsége dönti el, hogy továbblépünk-e a következő szolgáltatóra.
 */
export interface MappingUpstream {
  readonly id: string
  /**
   * Amit a szolgáltató tud arról, amit ismerünk.
   *
   * A `known` legalább egy azonosítót tartalmaz (lásd `hasAnchor`), különben
   * a hívó meg sem szólítja.
   */
  lookup (known: ExternalIds, signal: AbortSignal): Promise<Partial<ExternalIds>>
}

/**
 * Két készlet összefésülése — A MEGLÉVŐ ADAT NYER.
 *
 * Ez nem stílus: a saját táblánkban lévő azonosítót valaki beírta vagy egy
 * metaadat-futás töltötte fel, és egy leképező szolgáltatás tévedése nem
 * írhatja felül. A leképezés KIEGÉSZÍT, nem javít.
 */
export function merge (base: ExternalIds, extra: Partial<ExternalIds>): ExternalIds {
  const szam = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  }
  return {
    anilistId: base.anilistId ?? szam(extra.anilistId),
    malId: base.malId ?? szam(extra.malId),
    kitsuId: base.kitsuId ?? szam(extra.kitsuId),
    anidbId: base.anidbId ?? szam(extra.anidbId)
  }
}
