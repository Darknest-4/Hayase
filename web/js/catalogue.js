/* global window, YumeAPI, API */
// The catalogue resolver — which source answers a request for an anime.
//
// The database has held a full catalogue schema for a long time: titles,
// synonyms, genres, tags, images, relations, mappings, episodes, plus
// per-field provenance in metadata_sources and manual locks in locked_fields.
// The detail page did not use any of it. It called API.media(), which goes
// straight to graphql.anilist.co from the browser, and API.episodes(), which
// goes to ani.zip and Jikan. Only quick search consulted the catalogue.
//
// So the catalogue behaved as a search index, not as a source of truth, and
// the consequence was concrete: if AniList was down or rate-limiting, the
// detail page failed even for a title whose every field was sitting in our own
// database.
//
// This layer inverts that. The catalogue answers first; the external providers
// are the fallback, which is what they should have been all along.
//
// **Shape.** The whole UI is written against AniList's Media shape, and
// rewriting it would be a large change with no user-visible benefit. So the
// catalogue record is mapped INTO that shape here, in one place. This module
// is the only thing that knows both vocabularies.
//
// **Identity.** `#/anime/:id` accepts either an AniList id (numeric) or a Yume
// catalogue id (uuid). Existing links keep working, and an anime that exists
// only in our catalogue — no AniList mapping — is now reachable, which it was
// not: search dropped those rows because the route could not link to them.

const Catalogue = {
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,

  isYumeId (id) {
    return this.UUID.test(String(id))
  },

  // ---------------------------------------------------------------- mapping

  /**
   * A catalogue image list → AniList's coverImage/bannerImage.
   *
   * object_key holds the provider's CDN URL rather than a storage key — the
   * importer and the AniList worker both write it that way — so it is used
   * directly.
   */
  _images (images) {
    const list = Array.isArray(images) ? images : []
    const cover = list.find(i => i.kind === 'cover')
    const banner = list.find(i => i.kind === 'banner')
    return {
      coverImage: {
        extraLarge: cover?.key ?? '',
        large: cover?.key ?? '',
        color: cover?.color ?? null
      },
      bannerImage: banner?.key ?? null
    }
  },

  /** `2024-04-07` (or a Date) → AniList's `{ year, month, day }`. */
  _fuzzyDate (value) {
    if (!value) return { year: null, month: null, day: null }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return { year: null, month: null, day: null }
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
  },

  /**
   * Catalogue record → AniList Media shape.
   *
   * The enums line up exactly — anime_format, anime_status and anime_season
   * were defined with AniList's own values — so format, status and season pass
   * through untranslated. Only naming and nesting differ.
   */
  toMedia (row) {
    if (!row) return null
    const titles = row.titles ?? {}
    const { coverImage, bannerImage } = this._images(row.images)
    const mappings = row.mappings ?? {}

    return {
      // `id` is the identifier this app navigates and stores by — the library,
      // favourites, resume points and the #/watch route all key off it. It
      // falls back to the catalogue uuid so a title with no AniList mapping
      // still has a stable key instead of a null that breaks all of them
      // silently. Both the router and the watch route accept either form.
      id: mappings.anilist_id ?? row.id,
      yumeId: row.id,
      // The real provider ids, for links that must point at the provider. Null
      // when we have no mapping — the UI omits the link rather than building a
      // broken one.
      anilistId: mappings.anilist_id ?? null,
      idMal: mappings.mal_id ?? null,

      title: {
        userPreferred: titles.romaji ?? titles.english ?? row.canonical_title,
        romaji: titles.romaji ?? row.canonical_title,
        english: titles.english ?? null,
        native: titles.native ?? null
      },
      synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],

      coverImage,
      bannerImage,

      format: row.format ?? null,
      status: row.status ?? null,
      season: row.season ?? null,
      seasonYear: row.season_year ?? null,
      episodes: row.episode_count ?? null,
      duration: row.episode_duration ?? null,
      averageScore: row.average_score ?? null,
      isAdult: row.is_adult ?? false,
      description: row.synopsis ?? null,
      countryOfOrigin: row.country ?? null,
      source: row.source_material ?? null,

      genres: Array.isArray(row.genres) ? row.genres : [],
      // The catalogue keeps a rank per tag; the UI only draws names, but the
      // rank decides the order they are drawn in.
      tags: (Array.isArray(row.tags) ? row.tags : []).map(t => ({ name: t.name, rank: t.rank })),

      studios: {
        nodes: (Array.isArray(row.companies) ? row.companies : [])
          .filter(c => c.role === 'studio' || c.isMain)
          .map(c => ({ name: c.name }))
      },

      startDate: this._fuzzyDate(row.start_date),
      endDate: this._fuzzyDate(row.end_date),

      nextAiringEpisode: row.next_airing_at
        ? { episode: row.next_airing_ep ?? null, airingAt: Math.floor(new Date(row.next_airing_at).getTime() / 1000) }
        : null,

      // Relations are a separate request; an empty set here keeps the shape
      // stable for callers that read it without checking.
      relations: { edges: [] },
      trailer: null,

      // Provenance, so the UI can say where a field came from if it wants to.
      // Nothing renders it yet; it costs nothing to carry and it is the whole
      // reason metadata_sources exists.
      _sources: row.metadata_sources ?? {},
      _fromCatalogue: true
    }
  },

  // ---------------------------------------------------------------- reading

  /**
   * Fetch one anime, catalogue first.
   *
   * Returns null only when neither source has it. A catalogue miss on a
   * numeric id falls through to AniList; a catalogue miss on a uuid cannot,
   * because AniList has never heard of our identifiers.
   */
  async media (id) {
    const row = await YumeAPI.catalogueMedia(id)
    if (row) {
      const media = this.toMedia(row)
      // Relations live in their own endpoint and only matter once the record
      // is known to exist, so they are fetched here rather than inlined into
      // the detail query for every caller that never reads them.
      const relations = await YumeAPI.catalogueRelations(row.id)
      if (relations?.length) {
        media.relations = {
          edges: relations.map(r => ({
            relationType: r.relation,
            // same rule as the parent record: navigate by whichever id exists
            node: { id: r.anilist_id ?? r.id, yumeId: r.id, anilistId: r.anilist_id ?? null, title: { userPreferred: r.canonical_title }, status: r.status, format: r.format, coverImage: { large: r.cover_key ?? '' } }
          }))
        }
      }
      return media
    }

    // Not in the catalogue. A uuid has nowhere else to go.
    if (this.isYumeId(id)) return null
    return API.media(Number(id))
  },

  /**
   * Episodes, catalogue first.
   *
   * The catalogue answers only when it actually holds episode rows: an empty
   * episodes table for a series that has aired is a gap in our import, not a
   * statement that the series has no episodes, and returning [] there would
   * show the user an empty tab instead of the truth.
   */
  async episodes (media) {
    const yumeId = media?.yumeId
    if (yumeId) {
      const rows = await YumeAPI.catalogueEpisodes(yumeId)
      if (rows?.length) {
        return rows.map(e => ({
          episode: e.number,
          title: e.title ?? null,
          image: e.thumbnail_key ?? null,
          summary: e.synopsis ?? null,
          airdate: e.air_date ?? null,
          runtime: e.duration ?? null,
          rating: null,
          filler: Boolean(e.is_filler)
        }))
      }
    }

    // Fall back to ani.zip/Jikan, which needs an AniList id to ask with.
    if (media?.id) return API.episodes(media)
    return []
  }
}

window.Catalogue = Catalogue
