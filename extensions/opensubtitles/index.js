/* global yume */
// OpenSubtitles — subtitle tracks for the episode being watched.
//
// ---------------------------------------------------------------------------
// Why it returns text rather than a URL
// ---------------------------------------------------------------------------
// A <track> element fetches its own src, so the file has to be CORS-readable
// from the page, and browsers render only WebVTT there while most of the world
// ships SubRip. Handing over a download link would satisfy neither condition.
//
// This extension already has a proxied fetch, so it downloads the file itself
// and returns the text. The engine converts SubRip to WebVTT and gives the
// player a blob URL. Both problems disappear, and every other subtitle
// provider written against this contract gets the same treatment for free.
//
// ---------------------------------------------------------------------------
// About the quota
// ---------------------------------------------------------------------------
// Downloads count against the account's daily allowance, and this runs on
// every episode. So it asks for ONE track per configured language rather than
// everything it can find, and it remembers what it resolved: re-opening an
// episode must not spend quota twice.

const API = 'https://api.opensubtitles.com/api/v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Codes OpenSubtitles uses, from the ones the rest of the platform speaks. */
const LANGUAGE_ALIASES = { hu: 'hu', hun: 'hu', en: 'en', eng: 'en', ja: 'ja', jpn: 'ja' }

const languageList = value =>
  String(value ?? 'hu,en')
    .split(',')
    .map(part => LANGUAGE_ALIASES[part.trim().toLowerCase()] ?? part.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 4)

function headers (opts) {
  return {
    'Api-Key': opts.api_key,
    // OpenSubtitles requires a client identifier and rejects requests without
    // one, which reads as an authentication failure if you have not seen it.
    'User-Agent': String(opts.user_agent || 'Yume v1.0').slice(0, 100),
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
}

async function search (opts, query, language) {
  const params = new URLSearchParams({ languages: language, type: 'episode' })

  // The title alone is a weak key — this is why the extension reports
  // `medium` accuracy rather than claiming to have matched exactly.
  params.set('query', query?.titles?.[0] ?? '')
  // An episode number without the title matches every show that has one, so
  // the two always travel together.
  if (Number.isFinite(Number(query?.episode))) params.set('episode_number', String(Number(query.episode)))
  if (opts.trusted_only) params.set('trusted_sources', 'only')

  const res = await yume.fetch(`${API}/subtitles?${params.toString()}`, { headers: headers(opts) })
  if (!res.ok) throw new Error(`search returned ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

/**
 * Pick one candidate.
 *
 * Download count is the only quality signal the API gives that correlates with
 * the file being correctly timed, so the most-downloaded match wins. It is a
 * weak signal, which is why this extension reports `medium` accuracy.
 */
function best (items) {
  let winner = null
  let bestCount = -1
  for (const item of items) {
    const attrs = item?.attributes
    const fileId = attrs?.files?.[0]?.file_id
    if (!fileId) continue
    const count = Number(attrs?.download_count) || 0
    if (count > bestCount) {
      bestCount = count
      winner = { fileId, attrs }
    }
  }
  return winner
}

/** Exchange a file id for a temporary download link. This spends quota. */
async function downloadLink (opts, fileId) {
  const res = await yume.fetch(`${API}/download`, {
    method: 'POST',
    headers: headers(opts),
    body: JSON.stringify({ file_id: fileId })
  })
  if (!res.ok) throw new Error(`download returned ${res.status}`)
  const body = await res.json()
  return body?.link ?? null
}

export default {
  /**
   * Is the key accepted?
   *
   * /infos/user needs authentication, so this separates "service down" from
   * "key wrong" — and it does not spend a download.
   */
  async test (options) {
    const opts = options ?? {}
    if (!opts.api_key) return false
    try {
      const res = await yume.fetch(`${API}/infos/user`, { headers: headers(opts) })
      return res.ok
    } catch (e) {
      return false
    }
  },

  async subtitles (query, options) {
    const opts = options ?? {}
    if (!opts.api_key) return []

    const languages = languageList(opts.languages)
    if (!languages.length) return []

    const cacheKey = `subs:${query?.malId ?? query?.anilistId ?? query?.titles?.[0] ?? ''}:${query?.episode ?? 0}`
    try {
      const cached = await yume.storage.get(cacheKey)
      // Re-opening an episode must not spend quota again.
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tracks
    } catch (e) { /* a cache miss is not an error */ }

    const tracks = []
    for (const language of languages) {
      try {
        const pick = best(await search(opts, query, language))
        if (!pick) continue

        const link = await downloadLink(opts, pick.fileId)
        if (!link) continue

        const label = pick.attrs?.release
          ? `${language.toUpperCase()} · ${String(pick.attrs.release).slice(0, 40)}`
          : language.toUpperCase()
        const format = /\.vtt(\?|$)/i.test(link) ? 'vtt' : 'srt'

        // Fetch the file here rather than handing the player a link.
        //
        // A <track> fetches its own src, so a link would have to be
        // CORS-readable from the page, and browsers render only WebVTT there
        // while OpenSubtitles serves SubRip. Downloading it through the proxy
        // and returning the text sidesteps both — the engine converts and
        // hands the player a blob.
        //
        // If the link lands on a host this extension has not declared, the
        // proxy blocks it and the URL is offered instead. That may not render,
        // which is worse than text but better than nothing, and it is visible
        // in the picker rather than silent.
        try {
          const file = await yume.fetch(link)
          if (file.ok) {
            const text = await file.text()
            if (text && text.trim()) {
              tracks.push({ content: text, lang: language, label, format })
              continue
            }
          }
        } catch (e) { /* fall through to offering the link */ }

        tracks.push({ url: link, lang: language, label, format })
      } catch (e) {
        // One language failing must not deny the others — a Hungarian track
        // is still worth having when the English search errored.
        continue
      }
    }

    if (tracks.length) {
      try {
        await yume.storage.set(cacheKey, { at: Date.now(), tracks })
      } catch (e) { /* storage is a convenience */ }
    }
    return tracks
  }
}
