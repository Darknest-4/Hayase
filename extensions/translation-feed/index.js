/* global yume */
// Translation Feed — Hungarian titles and descriptions from a feed you publish.
//
// ---------------------------------------------------------------------------
// What this is, and what it deliberately is not
// ---------------------------------------------------------------------------
// It is a *display* extension. It reads a JSON document you host and hands the
// detail page a Hungarian title and synopsis for titles the catalogue has none
// for.
//
// It is not an importer. Extensions run in the viewer's browser inside a
// worker with no database access, so nothing here can write to
// `anime_translations` — that is a server-side job and pretending otherwise
// would produce text that vanishes on the next reload. What this gives you is
// a way to try a translation set out, or to serve one that lives somewhere
// other than the catalogue, without a migration.
//
// ---------------------------------------------------------------------------
// Why the feed is held in memory rather than in storage
// ---------------------------------------------------------------------------
// `storage:local` caps a stored value at 64 KB, and a feed covering a real
// library is far larger than that. So the parsed feed lives in a module
// variable — the worker survives for the session, so this is one fetch per
// session — and only the single entry a page actually used is written to
// storage. That entry is what makes the title readable on the next visit
// before the feed has finished loading, and it fits the cap comfortably.

const DEFAULT_REFRESH_MINUTES = 60
const MAX_TEXT = 8000
const MAX_EPISODE_TITLES = 500

// Survives across calls within a session; lost when the worker is torn down.
let feed = null
let feedAt = 0
let feedUrl = ''
let inflight = null

const text = (value, max = MAX_TEXT) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : ''

const refreshMs = value => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH_MINUTES * 60 * 1000
  return Math.min(24 * 60, Math.max(1, Math.round(n))) * 60 * 1000
}

/**
 * Accept either shape a hand-written feed tends to take.
 *
 * Flat:   { "16498": { "title": "...", "description": "..." } }
 * Wrapped: { "language": "hu", "anime": { "16498": { ... } } }
 *
 * Rejecting one of them would be a support burden for no gain — both are
 * unambiguous, since the wrapper key and a numeric id cannot collide.
 */
function parseFeed (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const entries = body.anime ?? body.titles ?? body
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
  const map = new Map()
  for (const [key, value] of Object.entries(entries)) {
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    map.set(id, value)
  }
  // A feed whose declared language disagrees with the option is the operator's
  // mistake, but the feed knows better than the checkbox, so it wins.
  return { language: text(body.language, 8), entries: map }
}

async function loadFeed (url, ttlMs) {
  if (feed && feedUrl === url && Date.now() - feedAt < ttlMs) return feed
  // Two tabs opening at once should cost one fetch, not two.
  if (inflight && feedUrl === url) return inflight

  feedUrl = url
  inflight = (async () => {
    try {
      const res = await yume.fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`feed returned ${res.status}`)
      const parsed = parseFeed(await res.json())
      if (!parsed) throw new Error('feed is not a map of ids to translations')
      feed = parsed
      feedAt = Date.now()
      return feed
    } catch (e) {
      yume.log?.('translation feed unavailable: ' + e.message)
      // Keep whatever was loaded earlier. A feed that has gone down should not
      // blank out text that is already on screen.
      return feed
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** One feed entry into the flat records the sandbox lets across. */
function toRecords (entry, language) {
  const records = []
  const title = text(entry.title ?? entry.name, 400)
  if (title) records.push({ kind: 'translation', field: 'title', language, text: title })

  const description = text(entry.description ?? entry.synopsis ?? entry.summary)
  if (description) records.push({ kind: 'translation', field: 'description', language, text: description })

  const episodes = entry.episodes
  if (episodes && typeof episodes === 'object' && !Array.isArray(episodes)) {
    let taken = 0
    for (const [key, value] of Object.entries(episodes)) {
      if (taken >= MAX_EPISODE_TITLES) break
      const number = Number(key)
      if (!Number.isInteger(number) || number <= 0) continue
      const epTitle = text(typeof value === 'string' ? value : value?.title, 400)
      if (!epTitle) continue
      records.push({ kind: 'translation', field: 'episodeTitle', language, episode: number, text: epTitle })
      taken++
    }
  }
  return records
}

export default {
  /**
   * Is the feed there and shaped like a feed?
   *
   * Reachability alone is not the question — a 200 that returns the operator's
   * index page would pass a liveness check and produce nothing, which is the
   * failure that actually happens.
   */
  async test (options) {
    const url = text(options?.feed_url, 2000)
    if (!url) return false
    try {
      const res = await yume.fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) return false
      const parsed = parseFeed(await res.json())
      return !!parsed && parsed.entries.size > 0
    } catch (e) {
      return false
    }
  },

  async metadata (query, options) {
    const opts = options ?? {}
    const anilistId = Number(query?.anilistId)
    if (!Number.isInteger(anilistId) || anilistId <= 0) return []

    const url = text(opts.feed_url, 2000)
    if (!url) return []

    const language = text(opts.language, 8) || 'hu'
    const cacheKey = `t:${anilistId}`

    const loaded = await loadFeed(url, refreshMs(opts.refresh_minutes))
    const entry = loaded?.entries.get(anilistId)

    if (!entry) {
      // The feed answered and has nothing for this title: that is a real
      // answer, and a stale cached entry would contradict it.
      if (loaded) {
        try { await yume.storage.remove(cacheKey) } catch (e) { /* nothing to lose */ }
        return []
      }
      // The feed is unreachable — last visit's text beats no text.
      try {
        const cached = await yume.storage.get(cacheKey)
        if (cached?.records?.length) return cached.records
      } catch (e) { /* a cache miss is not an error */ }
      return []
    }

    const records = toRecords(entry, loaded.language || language)
    if (records.length) {
      try {
        await yume.storage.set(cacheKey, { at: Date.now(), records })
      } catch (e) { /* over the 64 KB cap, or storage is full; the text still shows */ }
    }
    return records
  }
}
