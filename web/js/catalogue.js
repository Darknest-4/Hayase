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
      // Which language each field actually resolved to, straight from the
      // server. The UI uses it to say so rather than silently showing English
      // to somebody who asked for Hungarian — see PageAnime.
      _lang: row._lang ?? null,
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
   * Cast, staff and recommendations for a catalogue title, in the shape the
   * anime page already draws.
   *
   * The page was written against AniList's response, so these translate rather
   * than invent a second format: a cast entry is an `edges[]` of
   * `{ role, node: { name: { userPreferred }, image: { large } } }`, and a
   * recommendation is a card record like every other card on the site.
   *
   * Each returns an empty array when there is nothing — the caller's fallback
   * an empty tab is then the same code path as "no backend".
   */
  async characters (yumeId) {
    const rows = await YumeAPI.catalogueCharacters(yumeId)
    if (!rows?.length) return []
    return rows.map(r => ({
      role: r.role,
      node: {
        id: r.id,
        name: { userPreferred: r.name, native: r.native_name },
        image: { large: r.image_key ?? '' }
      },
      // Voice credits are per language, so a dubbed show carries both actors
      // rather than one replacing the other.
      voiceActors: (r.voices ?? []).map(v => ({
        id: v.id,
        name: { userPreferred: v.name, native: v.nativeName },
        image: { large: v.imageKey ?? '' },
        languageV2: v.language
      }))
    }))
  },

  async staff (yumeId) {
    const rows = await YumeAPI.catalogueStaff(yumeId)
    if (!rows?.length) return []
    return rows.map(r => ({
      role: r.role,
      node: { id: r.id, name: { userPreferred: r.name, native: r.native_name }, image: { large: r.image_key ?? '' } }
    }))
  },

  async recommendations (yumeId) {
    const rows = await YumeAPI.catalogueRecommendations(yumeId)
    if (!rows?.length) return []
    return rows.map(r => this.toCard(r)).filter(Boolean)
  },

  /**
   * Where one episode can be played from.
   *
   * References an operator registered, in the order they chose. Only the
   * catalogue can answer this — an external metadata provider knows what an
   * episode is, not where this deployment plays it from.
   */
  async episodeSources (episodeId) {
    const rows = await YumeAPI.episodeSources(episodeId)
    if (!rows?.length) return []
    return rows.map(row => ({
      // The engine's own shape: `url` is what it normalises from, and the
      // source block is what the player shows as the provider's name.
      url: row.ref,
      title: row.title ?? row.provider ?? 'Registered source',
      quality: row.resolution ? Number(row.resolution) : null,
      variant: row.variant ?? null,
      audioLang: row.language ?? null,
      isBatch: Boolean(row.is_batch),
      seeders: row.seeders ?? null,
      size: row.size_bytes ?? null,
      source: {
        slug: 'catalogue:' + row.id,
        name: row.provider ?? 'Catalogue',
        // Registered by hand by somebody who runs this deployment — that is a
        // stronger claim about "this is the right episode" than a search
        // result, and the engine ranks on it.
        accuracy: 'high',
        health: 'unknown'
      }
    }))
  },

  /**
   * Opening and ending intervals for one episode.
   *
   * `skip_segments` has been in the schema since the beginning and was read by
   * nothing: the player called api.aniskip.com
   * from the page. So a deployment that had corrected a wrong interval had
   * nowhere to put the correction.
   *
   * Mapped to the shape the player already draws — a label and two times —
   * with the kinds it has a button for. `recap` and `preview` are in the table
   * and are not offered: skipping the recap of last week is a different
   * feature, and inventing a label for it here would be guessing.
   */
  async skips (episodeId) {
    const rows = await YumeAPI.episodeSkips(episodeId)
    if (!rows?.length) return []
    return rows
      .filter(r => r.kind === 'intro' || r.kind === 'outro')
      .map(r => ({ kind: r.kind, start: Number(r.start_sec), end: Number(r.end_sec) }))
      .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
  },

  /**
   * Subtitle tracks for one episode.
   *
   * A track is either hosted by us or referenced elsewhere; the player wants
   * one address either way.
   */
  async subtitles (episodeId) {
    const rows = await YumeAPI.episodeSubtitles(episodeId)
    if (!rows?.length) return []
    return rows
      .map(r => ({
        url: r.url ?? r.object_key ?? '',
        lang: r.language,
        label: `${String(r.language).toUpperCase()}${r.kind && r.kind !== 'subtitles' ? ' · ' + r.kind : ''}`,
        format: r.format
      }))
      .filter(t => t.url)
  },

  /**
   * The franchise this title belongs to, in release order.
   *
   * Only the catalogue can answer it: it needs a walk over our own relation
   * graph, and an external provider returns the immediate neighbours only.
   * `{ data: [], truncated: false }` when there is nothing, so the caller has
   * one shape to read rather than two.
   */
  async franchise (yumeId) {
    const result = await YumeAPI.catalogueFranchise(yumeId)
    return { data: result?.data ?? [], truncated: Boolean(result?.truncated) }
  },

  // ------------------------------------------------------------- browsing

  /**
   * A catalogue row in the shape a card draws.
   *
   * Cards read title, coverImage, averageScore, episodes, format and
   * seasonYear and nothing else, so the browse endpoints return exactly those
   * rather than whole records — fetching every synonym and tag to render a
   * cover would be a large waste on the busiest screens.
   */
  toCard (row) {
    if (!row) return null
    return {
      id: row.anilist_id ?? row.id,
      yumeId: row.id,
      anilistId: row.anilist_id ?? null,
      title: {
        userPreferred: row.romaji ?? row.english ?? row.canonical_title,
        romaji: row.romaji ?? row.canonical_title,
        english: row.english ?? null
      },
      coverImage: { large: row.cover_key ?? '', extraLarge: row.cover_key ?? '', color: row.cover_color ?? null },
      format: row.format ?? null,
      status: row.status ?? null,
      seasonYear: row.season_year ?? null,
      episodes: row.episode_count ?? null,
      averageScore: row.average_score ?? null,
      isAdult: row.is_adult ?? false,
      _fromCatalogue: true
    }
  },

  /** AniList sort values -> the catalogue's own. Unknown ones fall through. */
  SORTS: {
    TRENDING_DESC: 'trending',
    POPULARITY_DESC: 'popularity',
    SCORE_DESC: 'score',
    START_DATE_DESC: 'newest',
    TITLE_ROMAJI: 'title'
  },

  /**
   * AniList's search variables, answered from the catalogue.
   *
   * The pages were written against `API.search(variables) -> { media }`, so
   * this presents the same interface and routes each shape of request to the
   * endpoint that can serve it:
   *
   *   { ids }              -> the batch lookup, order preserved
   *   { search }           -> full-text over titles and synonyms
   *   { season, genre... } -> the filtered browse
   *
   * Returns null - never a partial answer - when the catalogue cannot serve
   * the request, so the caller falls back to AniList with its own variables
   * intact. A half-populated catalogue must degrade to the old behaviour
   * rather than to an empty rail.
   */
  async search (variables = {}) {
    const first = value => (Array.isArray(value) ? value[0] : value) ?? null
    const limit = Math.min(50, variables.perPage ?? 25)

    // ---- by ids: a rail resolving library entries into cards ----
    if (Array.isArray(variables.ids) && variables.ids.length) {
      const rows = await YumeAPI.catalogueByAniListIds(variables.ids.slice(0, 50))
      // No rows at all means the catalogue does not hold this rail; a partial
      // answer would silently shorten it, so that falls back too.
      if (!rows?.length) return null
      return { media: rows.map(r => this.toCard(r)) }
    }

    // ---- free text ----
    if (variables.search) {
      const rows = await YumeAPI.searchCatalogue(variables.search, {
        genre: first(variables.genre) ?? undefined,
        season: first(variables.season) ?? undefined,
        year: variables.seasonYear ?? undefined,
        format: first(variables.format) ?? undefined,
        status: first(variables.status) ?? undefined,
        limit
      })
      if (!rows?.length) return null
      return { media: rows.map(r => this.toCard(r)) }
    }

    // ---- filtered / sorted browse ----
    const answer = await YumeAPI.browseCatalogue({
      season: first(variables.season) ?? undefined,
      year: variables.seasonYear ?? undefined,
      genre: first(variables.genre) ?? undefined,
      format: first(variables.format) ?? undefined,
      status: first(variables.status) ?? undefined,
      sort: this.SORTS[first(variables.sort)] ?? undefined,
      limit
    })
    if (!answer?.data?.length) return null
    return { media: answer.data.map(r => this.toCard(r)), cursor: answer.cursor ?? null }
  },

  /**
   * The airing calendar for a window, catalogue first.
   *
   * Only published episodes appear, which is the point: a schedule listing an
   * episode nobody can watch yet is worse than one that waits.
   */
  async schedule (from, to) {
    const rows = await YumeAPI.catalogueSchedule(from, to)
    if (!rows?.length) return null
    return rows
  },

  /**
   * `search()` with the fallback applied — what the pages call.
   *
   * Kept separate from `search()` so the catalogue-only path stays testable
   * without a network, and so the fallback is one decision in one place rather
   * than a `?? API.search(...)` repeated at a dozen call sites where one of
   * them would eventually be forgotten.
   */
  async searchOrAniList (variables = {}) {
    return (await this.search(variables)) ?? API.search(variables)
  },

  /** `schedule()` with the fallback applied. */
  async scheduleOrAniList (from, to) {
    // The pages pass Date objects, because that is what API.schedule takes.
    const iso = value => (value instanceof Date ? value.toISOString() : new Date(value).toISOString())
    const rows = await this.schedule(iso(from), iso(to))
    if (rows) {
      // The catalogue answers with episode rows; the schedule page draws media
      // cards with an episode number attached, so they are shaped here.
      return rows.map(row => ({
        episode: Number(row.episode),
        airingAt: Math.floor(new Date(row.air_date).getTime() / 1000),
        media: this.toCard({
          id: row.anime_id,
          anilist_id: row.anilist_id ?? null,
          canonical_title: row.canonical_title,
          format: row.format,
          is_adult: row.is_adult,
          cover_key: row.cover_key
        })
      }))
    }
    return API.schedule(from, to)
  },

  /**
   * Episodes, catalogue first.
   *
   * An empty answer from the catalogue means one of two opposite things, and
   * they need opposite handling:
   *
   *   total = 0  we hold no episode data. Our silence is ignorance, so falling
   *              back to ani.zip is right — returning [] would show the user
   *              an empty tab instead of the truth.
   *
   *   total > 0  we hold episodes and publish none of them. Our silence is a
   *              decision, and falling back would fetch them from ani.zip and
   *              show them anyway — the publishing controls would be
   *              decoration. So an empty list is served as an empty list.
   *
   * This is why the endpoint reports a total rather than just a list.
   */
  async episodes (media) {
    const yumeId = media?.yumeId
    if (yumeId) {
      const answer = await YumeAPI.catalogueEpisodes(yumeId)
      const rows = answer?.data ?? []

      // We hold episodes but publish none: that is an answer, not a gap.
      if (answer && !rows.length && answer.total > 0) return []

      if (rows.length) {
        return rows.map(e => ({
          // episodes.number is `numeric` — deliberately, because specials are
          // numbered 5.5 — and pg serialises numeric as a string ('1.0'). The
          // external path produces real numbers, so this coerces rather than
          // leaving two shapes for the UI to guess between.
          episode: Number(e.number),
          title: e.title ?? null,
          image: e.thumbnail_key ?? null,
          summary: e.synopsis ?? null,
          airdate: e.air_date ?? null,
          runtime: e.duration ?? null,
          rating: null,
          filler: Boolean(e.is_filler),
          // The episode's row id, so the player can ask for its sources.
          yumeId: e.id,
          // How many registered sources this episode has. Undefined — not
          // zero — when the episodes came from ani.zip: we do not know, and
          // "unknown" and "none" must not gate the same way.
          sourceCount: Number(e.source_count ?? 0)
        }))
      }
    }

    // Fall back to ani.zip/Jikan, which needs an AniList id to ask with.
    if (media?.id) return API.episodes(media)
    return []
  }
}

window.Catalogue = Catalogue
