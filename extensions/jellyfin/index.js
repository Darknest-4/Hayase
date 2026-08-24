/* global yume */
// Jellyfin / Emby — plays episodes from a server the viewer has an account on.
//
// ---------------------------------------------------------------------------
// One extension, two servers
// ---------------------------------------------------------------------------
// Jellyfin forked from Emby and kept its API: the same /Items search, the same
// /Shows/{id}/Episodes walk, the same /Videos/{id}/stream endpoint, and the
// same X-Emby-Token header — Jellyfin still calls it that. Shipping a second,
// near-identical package would double the surface to keep in step for no
// behavioural gain, so this serves both and the operator points it at whichever
// they run.
//
// ---------------------------------------------------------------------------
// What it does
// ---------------------------------------------------------------------------
// Connects to one Jellyfin server, finds the show, finds the episode, and
// returns the real stream URL plus every audio and subtitle track the file
// carries. Nothing is searched for on the open internet: the only host it can
// reach is the one in its manifest, and the sandbox enforces that.
//
// ---------------------------------------------------------------------------
// Matching, and why it is done in that order
// ---------------------------------------------------------------------------
// Jellyfin stores external ids on each series (`ProviderIds`), so when its
// metadata agent has filled them in we can match on AniList/AniDB/TVDB/MAL —
// which is exact, and the only thing that justifies claiming `high` accuracy.
// A title search is the fallback, and it is genuinely worse: "Attack on Titan"
// matches four series, seasons are separate items, and Jellyfin's fuzzy search
// happily returns a documentary. So a title match reports `medium` and the
// engine ranks it accordingly.
//
// The sandbox derives an accuracy ceiling from which query fields the code
// actually reads, so claiming more than the match supports does not work.
//
// ---------------------------------------------------------------------------
// About the API key in URLs
// ---------------------------------------------------------------------------
// API calls send the key as a header. The stream and subtitle URLs cannot: a
// <video> element fetches those itself and browsers give no way to attach
// headers to it, so Jellyfin's own `api_key` query parameter is the only
// option. Those URLs stay inside the viewer's own browser and point at the
// viewer's own server, but it is a credential in a URL, and that is worth
// knowing rather than discovering.

const CACHE_TTL_MS = 30 * 60 * 1000

/** Provider id keys Jellyfin plugins write, mapped to the query field. */
const PROVIDER_KEYS = {
  anilist: 'anilistId',
  anidb: 'anidbId',
  myanimelist: 'malId',
  mal: 'malId'
}

const trimSlash = value => String(value ?? '').replace(/\/+$/, '')

/** Build an API URL with the query string Jellyfin expects. */
function apiUrl (opts, path, params = {}) {
  const url = new URL(trimSlash(opts.server_url) + path)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Call the Jellyfin API.
 *
 * The key travels as a header here — only the media URLs below have to put it
 * in the query string, and keeping it out of the ones that do not is free.
 */
async function api (opts, path, params) {
  const res = await yume.fetch(apiUrl(opts, path, params), {
    headers: {
      'X-Emby-Token': opts.api_key,
      Accept: 'application/json'
    }
  })
  if (!res.ok) throw new Error(`Jellyfin returned ${res.status} for ${path}`)
  return res.json()
}

/** Read a provider id off an item, whatever case the plugin wrote it in. */
function providerIds (item) {
  const out = {}
  for (const [key, value] of Object.entries(item?.ProviderIds ?? {})) {
    const field = PROVIDER_KEYS[String(key).toLowerCase()]
    if (field && value) out[field] = String(value)
  }
  return out
}

/**
 * Find the series.
 *
 * Two passes, and the order is the point: an id match is exact, a title match
 * is a guess. `matchedBy` travels with the result so the caller can report
 * honest accuracy instead of claiming exactness it does not have.
 */
async function findSeries (opts, query) {
  const cacheKey = `series:${query?.anilistId ?? query?.malId ?? query?.titles?.[0] ?? ''}`
  try {
    const cached = await yume.storage.get(cacheKey)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  } catch (e) { /* a cache miss is not an error */ }

  const base = {
    IncludeItemTypes: 'Series',
    Recursive: true,
    Fields: 'ProviderIds',
    Limit: 25,
    userId: opts.user_id
  }

  let found = null

  // Pass 1 — exact, by external id.
  const wanted = { anilistId: query?.anilistId, malId: query?.malId, anidbId: query?.anidbId }
  if (wanted.anilistId || wanted.malId || wanted.anidbId) {
    for (const title of (query?.titles ?? []).slice(0, 2)) {
      const page = await api(opts, '/Items', { ...base, searchTerm: title })
      for (const item of page?.Items ?? []) {
        const ids = providerIds(item)
        const hit = Object.entries(wanted).some(([field, value]) =>
          value != null && ids[field] === String(value))
        if (hit) { found = { item, matchedBy: 'id' }; break }
      }
      if (found) break
    }
  }

  // Pass 2 — a title search, which is a guess and says so.
  if (!found) {
    for (const title of (query?.titles ?? []).slice(0, 3)) {
      const page = await api(opts, '/Items', { ...base, searchTerm: title })
      const item = (page?.Items ?? [])[0]
      if (item) { found = { item, matchedBy: 'title' }; break }
    }
  }

  if (found) {
    try {
      await yume.storage.set(cacheKey, { at: Date.now(), value: found })
    } catch (e) { /* storage is a convenience */ }
  }
  return found
}

/**
 * Find one episode of a series.
 *
 * Jellyfin numbers episodes within a season, while the query carries an
 * absolute number. Where a series has one season the two agree; where it does
 * not, `IndexNumber` across the flat episode list is the closest honest
 * reading, so specials and split seasons can mismatch. That is exactly why
 * this reports `medium` for a title match — a wrong episode is worse than none.
 */
async function findEpisode (opts, seriesId, episode) {
  const page = await api(opts, `/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
    userId: opts.user_id,
    Fields: 'MediaSources,MediaStreams,Path'
  })
  const items = page?.Items ?? []
  const wanted = Number(episode)
  return items.find(item => Number(item?.IndexNumber) === wanted) ?? null
}

/** The direct stream URL for an episode, as the <video> element will fetch it. */
function streamUrl (opts, item, source) {
  const params = {
    api_key: opts.api_key,
    static: opts.allow_transcode ? undefined : 'true',
    mediaSourceId: source?.Id
  }
  if (opts.allow_transcode) {
    params.maxHeight = opts.max_height
    params.videoCodec = 'h264'
    params.audioCodec = 'aac'
  }
  return apiUrl(opts, `/Videos/${encodeURIComponent(item.Id)}/stream`, params)
}

/**
 * Subtitle tracks, as URLs the player can attach.
 *
 * Only text subtitles are offered. An image-based track (PGS, VOBSUB) cannot
 * be turned into a <track> at all, and offering one produces a subtitle button
 * that does nothing — worse than not listing it.
 */
function subtitleTracks (opts, item, source) {
  const format = opts.subtitle_format === 'srt' ? 'srt' : 'vtt'
  return (source?.MediaStreams ?? [])
    .filter(s => s?.Type === 'Subtitle' && s.IsTextSubtitleStream !== false)
    .slice(0, 20)
    .map(stream => ({
      url: apiUrl(
        opts,
        `/Videos/${encodeURIComponent(item.Id)}/${encodeURIComponent(source.Id)}/Subtitles/${Number(stream.Index)}/Stream.${format}`,
        { api_key: opts.api_key }
      ),
      lang: normaliseLanguage(stream.Language),
      label: stream.DisplayTitle || stream.Language || 'Subtitles'
    }))
}

/**
 * Jellyfin reports ISO 639-2 ("hun", "jpn", "eng"); the rest of the platform
 * speaks two-letter codes. Mapping the three that matter here and passing
 * anything else through keeps this honest rather than guessing.
 */
function normaliseLanguage (value) {
  const raw = String(value ?? '').trim().toLowerCase()
  const map = { hun: 'hu', hu: 'hu', jpn: 'ja', jpa: 'ja', ja: 'ja', eng: 'en', en: 'en' }
  return map[raw] ?? raw.slice(0, 3)
}

/** The language of the audio track Jellyfin would play by default. */
function defaultAudioLanguage (source) {
  const audio = (source?.MediaStreams ?? []).filter(s => s?.Type === 'Audio')
  if (!audio.length) return null
  const preferred = audio.find(s => s.IsDefault) ?? audio[0]
  return normaliseLanguage(preferred.Language)
}

function toResult (opts, series, item, source, matchedBy) {
  const url = streamUrl(opts, item, source)
  const subtitles = subtitleTracks(opts, item, source)
  const audio = defaultAudioLanguage(source)

  const height = source?.MediaStreams?.find(s => s?.Type === 'Video')?.Height
  const variant = !audio || audio === 'ja' ? (subtitles.length ? 'Sub' : 'Raw') : 'Dub'
  const name = series?.Name ?? item?.SeriesName ?? 'Episode'

  return {
    title: `${name} — ${item.IndexNumber ?? '?'} [${variant}] · Jellyfin`,
    url,
    // A title match is a guess: seasons are separate items and Jellyfin's
    // search is fuzzy, so the engine should rank an id match above it.
    accuracy: matchedBy === 'id' ? 'high' : 'medium',
    quality: String(height ?? opts.max_height ?? '1080'),
    audio,
    container: source?.Container ? `video/${source.Container}` : undefined,
    subtitles,
    type: 'http'
  }
}

export default {
  /**
   * Is the server reachable and the key accepted?
   *
   * /System/Info requires authentication, so this distinguishes "server down"
   * from "key wrong" — which look identical from a failed episode lookup and
   * are fixed in completely different places.
   */
  async test (options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.api_key) return false
    try {
      const info = await api(opts, '/System/Info')
      return Boolean(info?.Version || info?.Id)
    } catch (e) {
      return false
    }
  },

  async single (query, options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.api_key) return []

    let series
    try {
      series = await findSeries(opts, query)
    } catch (e) {
      // A server that is down or a key that was revoked must produce no
      // sources, not a broken player — the engine simply moves on.
      return []
    }
    if (!series?.item?.Id) return []

    let episode
    try {
      episode = await findEpisode(opts, series.item.Id, query?.episode)
    } catch (e) {
      return []
    }
    if (!episode?.Id) return []

    // One result per media source: the same episode may exist as a 1080p and a
    // 720p file, and both are legitimate candidates for the engine to rank.
    const sources = episode.MediaSources ?? []
    if (!sources.length) return []

    return sources
      .slice(0, 5)
      .map(source => toResult(opts, series.item, episode, source, series.matchedBy))
      .filter(Boolean)
  },

  // Jellyfin serves one episode at a time; there is no batch concept.
  async batch () { return [] },

  async movie (query, options) {
    const opts = options ?? {}
    if (!opts.server_url || !opts.api_key) return []

    // A movie is a single item rather than a series with episodes, so the
    // series/episode walk above does not apply to it.
    try {
      for (const title of (query?.titles ?? []).slice(0, 3)) {
        const page = await api(opts, '/Items', {
          IncludeItemTypes: 'Movie',
          Recursive: true,
          Fields: 'MediaSources,MediaStreams,ProviderIds',
          Limit: 10,
          searchTerm: title,
          userId: opts.user_id
        })
        const item = (page?.Items ?? [])[0]
        const source = item?.MediaSources?.[0]
        if (item && source) {
          const ids = providerIds(item)
          const exact = (query?.anilistId != null && ids.anilistId === String(query.anilistId)) ||
                        (query?.malId != null && ids.malId === String(query.malId))
          return [toResult(opts, item, { ...item, IndexNumber: 1 }, source, exact ? 'id' : 'title')]
        }
      }
    } catch (e) { /* fall through to no sources */ }
    return []
  }
}
