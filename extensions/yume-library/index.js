/* global yume */
// Yume Library — plays episodes from a server you run.
//
// ---------------------------------------------------------------------------
// What this is, and what it deliberately is not
// ---------------------------------------------------------------------------
// This resolves episodes from ONE host: the one the operator configures. Your
// own uploads, your own Hungarian subtitles, your own server. It does not
// search the internet, it has no list of sites, and it has no fallback to
// anywhere else — if your server does not have the file, this returns nothing.
//
// That is the shape the platform was built for. The sandbox only lets an
// extension reach hosts its manifest declares, so an extension that pointed
// somewhere else would have to say so in its manifest and be reviewed on it.
//
// ---------------------------------------------------------------------------
// Two ways to find a file
// ---------------------------------------------------------------------------
//   1. An index — a JSON file on your server mapping anime and episode to
//      files. Fetched once and cached. This is the one to use: it survives
//      irregular naming, multi-season splits and specials, all of which break
//      a path pattern.
//   2. A pattern — a path template with placeholders. Nothing to maintain, but
//      it only works when your filenames are perfectly regular.
//
// The index wins when both are configured.
//
// ---------------------------------------------------------------------------
// Index format
// ---------------------------------------------------------------------------
//   {
//     "21": {                                  // AniList id, as a string
//       "1": {
//         "url": "/one-piece/001.mp4",         // relative to baseUrl, or absolute
//         "quality": "1080",
//         "audio": "ja",                       // "hu" for a dub
//         "subtitles": [
//           { "url": "/one-piece/001.hu.vtt", "lang": "hu", "label": "Magyar" }
//         ]
//       }
//     }
//   }
//
// Everything except `url` is optional and falls back to the extension's
// options. An episode missing from the index simply is not offered.

const INDEX_CACHE_KEY = 'index'
const INDEX_TTL_MS = 10 * 60 * 1000

/** Join a possibly-relative path onto the configured base. */
function resolveUrl (baseUrl, path) {
  const value = String(path ?? '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return String(baseUrl ?? '').replace(/\/+$/, '') + (value.startsWith('/') ? value : '/' + value)
}

/** A filesystem-safe form of a title, for {slug}. */
function slugify (title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Fill a path template.
 *
 * Every value is encoded: a title with a slash in it would otherwise walk out
 * of the directory the operator meant, and titles containing slashes are
 * common enough that this is not hypothetical.
 */
function applyPattern (pattern, query) {
  const episode = Number(query?.episode) || 0
  const title = query?.titles?.[0] ?? ''
  const values = {
    anilistId: query?.anilistId ?? '',
    malId: query?.malId ?? '',
    episode: String(episode),
    episodePadded: String(episode).padStart(2, '0'),
    title,
    slug: slugify(title)
  }
  return String(pattern ?? '').replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? encodeURIComponent(String(values[key])) : whole
  )
}

/** Fetch the index, cached — it is the same file for every episode. */
async function loadIndex (baseUrl, indexPath) {
  if (!indexPath) return null

  try {
    const cached = await yume.storage.get(INDEX_CACHE_KEY)
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.data
  } catch (e) { /* cache miss is not an error */ }

  const res = await yume.fetch(resolveUrl(baseUrl, indexPath))
  if (!res.ok) throw new Error(`index returned ${res.status}`)
  const data = await res.json()

  try {
    await yume.storage.set(INDEX_CACHE_KEY, { at: Date.now(), data })
  } catch (e) { /* storage is a convenience, not a requirement */ }
  return data
}

/** The index entry for one episode, if the index has it. */
function fromIndex (index, query) {
  if (!index) return null
  const episode = String(Number(query?.episode) || 0)
  for (const key of [query?.anilistId, query?.malId]) {
    if (key == null) continue
    const show = index[String(key)]
    const entry = show?.[episode]
    if (entry?.url) return entry
  }
  return null
}

/**
 * Confirm a file is actually there.
 *
 * Without this a missing episode reaches the player as a candidate, the player
 * tries it, fails, and reports "no source would start" — which reads as the
 * site being broken rather than as one absent file. HEAD first because it
 * costs nothing; some static servers refuse it, so a ranged GET is the
 * fallback rather than treating a 405 as absence.
 */
async function exists (url) {
  try {
    const head = await yume.fetch(url, { method: 'HEAD' })
    if (head.ok) return true
    if (head.status !== 405 && head.status !== 501) return false
  } catch (e) { /* fall through to the ranged GET */ }

  try {
    const probe = await yume.fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    return probe.ok
  } catch (e) {
    return false
  }
}

/** Shape one result the way the streaming engine expects. */
function toResult (entry, opts, query) {
  const url = resolveUrl(opts.base_url, entry.url)
  if (!url) return null

  const audio = entry.audio ?? opts.audio_language ?? 'ja'
  const subtitles = (entry.subtitles ?? [])
    .filter(s => s && s.url)
    .map(s => ({
      url: resolveUrl(opts.base_url, s.url),
      lang: s.lang ?? opts.subtitle_language ?? 'hu',
      label: s.label ?? (s.lang ?? opts.subtitle_language ?? 'hu').toUpperCase()
    }))

  // The title carries the variant in words as well as in the `audio` field.
  // The engine trusts `audio` first, but a human reading the source list in
  // the player sees this, and a source that does not say which it is looks
  // like a gamble.
  const variant = audio === 'ja' ? (subtitles.length ? 'Sub' : 'Raw') : 'Dub'
  const label = `${query?.titles?.[0] ?? 'Episode'} — ${query?.episode ?? '?'} [${variant}]`

  return {
    title: label,
    url,
    quality: entry.quality ?? opts.quality ?? '1080',
    audio,
    container: entry.container,
    subtitles,
    accuracy: 'high',
    type: 'http'
  }
}

export default {
  /**
   * Is the configured server reachable?
   *
   * The store and the developer portal call this, and it is the difference
   * between "this extension is broken" and "your server is down", which are
   * very different things to be told.
   */
  async test (options) {
    const opts = options ?? {}
    if (!opts.base_url) return false
    try {
      const target = opts.index_path
        ? resolveUrl(opts.base_url, opts.index_path)
        : resolveUrl(opts.base_url, '/')
      const res = await yume.fetch(target, { method: 'HEAD' })
      return res.ok || res.status === 405 || res.status === 501
    } catch (e) {
      return false
    }
  },

  async single (query, options) {
    const opts = options ?? {}
    if (!opts.base_url) return []

    // Two different failures hide behind "the index gave nothing", and they
    // deserve opposite answers:
    //
    //   the index could not be read   → fall back to the pattern; the operator
    //                                   may well have the file
    //   the index was read and has no
    //   entry for this episode        → offer nothing; the index IS the
    //                                   operator's statement of what they
    //                                   have, and guessing past it produces a
    //                                   link to a file they never uploaded
    let entry = null
    let indexReadable = false
    if (opts.index_path) {
      try {
        const index = await loadIndex(opts.base_url, opts.index_path)
        indexReadable = index != null
        entry = fromIndex(index, query)
      } catch (e) {
        indexReadable = false
      }
      if (!entry && indexReadable) return []
    }

    if (!entry) {
      if (!opts.pattern) return []
      const url = applyPattern(opts.pattern, query)
      if (!url) return []
      entry = { url }
      if (opts.subtitle_pattern) {
        entry.subtitles = [{
          url: applyPattern(opts.subtitle_pattern, query),
          lang: opts.subtitle_language ?? 'hu'
        }]
      }
    }

    const result = toResult(entry, opts, query)
    if (!result) return []

    if (opts.verify !== false && !(await exists(result.url))) return []
    return [result]
  },

  // A library server holds single episodes; there is nothing to batch and no
  // separate movie path — a movie is episode 1. Declared so the host never
  // has to guess what an absent method means.
  async batch () { return [] },

  async movie (query, options) {
    return this.single({ ...query, episode: query?.episode ?? 1 }, options)
  }
}
