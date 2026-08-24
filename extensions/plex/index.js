/* global yume */
// Plex — plays episodes from a Plex Media Server the viewer has access to.
//
// ---------------------------------------------------------------------------
// How Plex differs from Jellyfin, and why this is its own package
// ---------------------------------------------------------------------------
// Jellyfin and Emby share an API, so one extension serves both. Plex does not:
// different auth header, different paths, results wrapped in a MediaContainer,
// XML unless you ask for JSON, and — the part that actually matters — the file
// is reached through a Part key rather than a stream endpoint.
//
//   Jellyfin   /Videos/{id}/stream?static=true
//   Plex       {Part.key}?X-Plex-Token=…       ← the original file, no transcode
//
// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
// Plex records external ids on a show, and for anime libraries the HAMA agent
// records AniDB ids in the legacy `guid` field:
//
//   com.plexapp.agents.hama://anidb-1234?lang=en
//
// Newer agents use a `Guid` array with tvdb://, tmdb://, imdb:// entries. Both
// are read. An id match is exact and reports `high`; a title match is a guess —
// seasons are separate items and Plex's search is fuzzy — and reports `medium`.

const CACHE_TTL_MS = 30 * 60 * 1000

const trimSlash = value => String(value ?? '').replace(/\/+$/, '')

/** Build a Plex URL. The token goes in the query: Plex accepts it either way,
 *  and the media URL below has no choice, so both are consistent. */
function plexUrl (opts, path, params = {}) {
  const url = new URL(trimSlash(opts.server_url) + path)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Call the Plex API.
 *
 * The token is a header here so it stays out of URLs that do not need it; the
 * Accept header is what makes Plex answer JSON instead of XML.
 */
async function api (opts, path, params) {
  const res = await yume.fetch(plexUrl(opts, path, params), {
    headers: { 'X-Plex-Token': opts.token, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Plex returned ${res.status} for ${path}`)
  const body = await res.json()
  return body?.MediaContainer ?? {}
}

/**
 * External ids Plex knows about this item.
 *
 * Two formats, because Plex changed agents and libraries built under the old
 * one are still everywhere.
 */
function externalIds (item) {
  const out = {}

  // Legacy agent guid — HAMA is what anime libraries use, and it carries AniDB.
  const legacy = String(item?.guid ?? '')
  const anidb = /anidb-?(\d+)/i.exec(legacy)
  if (anidb) out.anidbId = anidb[1]
  const tvdbLegacy = /thetvdb:\/\/(\d+)/i.exec(legacy)
  if (tvdbLegacy) out.tvdbId = tvdbLegacy[1]

  // Newer agents: a Guid array of scheme://id entries.
  for (const entry of item?.Guid ?? []) {
    const match = /^(\w+):\/\/(.+)$/.exec(String(entry?.id ?? ''))
    if (!match) continue
    const [, scheme, value] = match
    if (scheme === 'tvdb') out.tvdbId = value
    else if (scheme === 'tmdb') out.tmdbId = value
    else if (scheme === 'imdb') out.imdbId = value
    else if (scheme === 'anidb') out.anidbId = value
  }
  return out
}

/** Show libraries to search — all of them, or just the configured one. */
async function showSections (opts) {
  if (opts.section) return [String(opts.section)]
  const container = await api(opts, '/library/sections')
  return (container?.Directory ?? [])
    .filter(dir => dir?.type === 'show')
    .map(dir => String(dir.key))
    .slice(0, 10)
}

/**
 * Find the show.
 *
 * An id match is exact; a title match is a guess. `matchedBy` travels with the
 * result so the caller reports honest accuracy rather than claiming exactness.
 */
async function findShow (opts, query) {
  const cacheKey = `show:${query?.anilistId ?? query?.malId ?? query?.titles?.[0] ?? ''}`
  try {
    const cached = await yume.storage.get(cacheKey)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  } catch (e) { /* a cache miss is not an error */ }

  const sections = await showSections(opts)
  const wanted = { anidbId: query?.anidbId, tvdbId: query?.tvdbId }
  const hasWanted = Object.values(wanted).some(v => v != null)

  let byId = null
  let byTitle = null

  for (const section of sections) {
    for (const title of (query?.titles ?? []).slice(0, 3)) {
      let container
      try {
        container = await api(opts, `/library/sections/${encodeURIComponent(section)}/all`, {
          type: 2, // 2 = show
          title,
          includeGuids: 1
        })
      } catch (e) {
        continue
      }
      const items = container?.Metadata ?? []
      if (!byTitle && items[0]) byTitle = items[0]
      if (!hasWanted) continue
      for (const item of items) {
        const ids = externalIds(item)
        const hit = Object.entries(wanted).some(([field, value]) => value != null && ids[field] === String(value))
        if (hit) { byId = item; break }
      }
      if (byId) break
    }
    if (byId) break
  }

  const found = byId
    ? { item: byId, matchedBy: 'id' }
    : (byTitle ? { item: byTitle, matchedBy: 'title' } : null)

  if (found) {
    try {
      await yume.storage.set(cacheKey, { at: Date.now(), value: found })
    } catch (e) { /* storage is a convenience */ }
  }
  return found
}

/**
 * One episode of a show.
 *
 * `allLeaves` returns every episode across every season as a flat list, which
 * is the right shape here: the query carries an absolute number and Plex's
 * `index` is per season. For a single-season show the two agree; for a split
 * season they can disagree, which is why a title match only claims `medium`.
 */
async function findEpisode (opts, ratingKey, episode) {
  const container = await api(opts, `/library/metadata/${encodeURIComponent(ratingKey)}/allLeaves`)
  const items = container?.Metadata ?? []
  const wanted = Number(episode)
  return items.find(item => Number(item?.index) === wanted) ?? null
}

/** Plex reports ISO 639-2; the platform speaks two-letter codes. */
function normaliseLanguage (value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const map = { hun: 'hu', hu: 'hu', jpn: 'ja', ja: 'ja', eng: 'en', en: 'en' }
  return map[raw] ?? raw.slice(0, 3)
}

/** The direct file URL — the original, not a transcode. */
function fileUrl (opts, part) {
  return plexUrl(opts, String(part?.key ?? ''), { 'X-Plex-Token': opts.token })
}

/**
 * Subtitle tracks Plex can serve as text.
 *
 * Only external/sidecar tracks have a `key` to fetch; an embedded track has no
 * URL of its own, and an image-based one could not render in a <track> anyway.
 * Offering either would produce a subtitle button that does nothing.
 */
function subtitleTracks (opts, part) {
  return (part?.Stream ?? [])
    .filter(stream => Number(stream?.streamType) === 3 && stream?.key)
    .slice(0, 20)
    .map(stream => ({
      url: plexUrl(opts, String(stream.key), { 'X-Plex-Token': opts.token }),
      lang: normaliseLanguage(stream.languageCode ?? stream.language),
      label: stream.displayTitle || stream.language || 'Subtitles',
      format: /^(srt|vtt|ass|ssa)$/i.test(String(stream.codec ?? '')) ? String(stream.codec).toLowerCase() : 'srt'
    }))
}

/** The language of the audio track Plex would play by default. */
function defaultAudioLanguage (part) {
  const audio = (part?.Stream ?? []).filter(stream => Number(stream?.streamType) === 2)
  if (!audio.length) return null
  const preferred = audio.find(stream => stream?.selected || stream?.default) ?? audio[0]
  return normaliseLanguage(preferred.languageCode ?? preferred.language)
}

function toResult (opts, show, episode, media, part, matchedBy) {
  const url = fileUrl(opts, part)
  if (!url) return null

  const subtitles = subtitleTracks(opts, part)
  const audio = defaultAudioLanguage(part)
  const variant = !audio || audio === 'ja' ? (subtitles.length ? 'Sub' : 'Raw') : 'Dub'
  const name = show?.title ?? episode?.grandparentTitle ?? 'Episode'

  return {
    title: `${name} — ${episode?.index ?? '?'} [${variant}] · Plex`,
    url,
    accuracy: matchedBy === 'id' ? 'high' : 'medium',
    quality: String(media?.videoResolution ?? opts.max_height ?? '1080'),
    audio,
    container: media?.container ? `video/${media.container}` : undefined,
    subtitles,
    type: 'http'
  }
}

export default {
  /**
   * Is the server reachable and the token accepted?
   *
   * `/identity` answers without a token, so `/library/sections` is used
   * instead — it needs one, and that is the difference between "server down"
   * and "token wrong".
   */
  async test (options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.token) return false
    try {
      const container = await api(opts, '/library/sections')
      return Array.isArray(container?.Directory)
    } catch (e) {
      return false
    }
  },

  async single (query, options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.token) return []

    let show
    try {
      show = await findShow(opts, query)
    } catch (e) {
      return []
    }
    if (!show?.item?.ratingKey) return []

    let episode
    try {
      episode = await findEpisode(opts, show.item.ratingKey, query?.episode)
    } catch (e) {
      return []
    }
    if (!episode) return []

    // One candidate per Part: the same episode may exist as two files, and
    // both are legitimate for the engine to rank.
    const results = []
    for (const media of (episode.Media ?? []).slice(0, 5)) {
      for (const part of (media?.Part ?? []).slice(0, 3)) {
        const result = toResult(opts, show.item, episode, media, part, show.matchedBy)
        if (result) results.push(result)
      }
    }
    return results
  },

  async batch () { return [] },

  async movie (query, options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.token) return []
    try {
      const container = await api(opts, '/search', { query: query?.titles?.[0] ?? '', limit: 10 })
      const item = (container?.Metadata ?? []).find(row => row?.type === 'movie')
      const media = item?.Media?.[0]
      const part = media?.Part?.[0]
      if (!item || !part) return []
      const ids = externalIds(item)
      const exact = query?.anidbId != null && ids.anidbId === String(query.anidbId)
      const result = toResult(opts, item, { ...item, index: 1 }, media, part, exact ? 'id' : 'title')
      return result ? [result] : []
    } catch (e) {
      return []
    }
  }
}
