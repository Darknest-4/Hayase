/* global yume */
// AniSkip — opening and ending intervals for an episode.
//
// ---------------------------------------------------------------------------
// Why this exists as an extension
// ---------------------------------------------------------------------------
// The client used to call api.aniskip.com directly from the page, with a raw
// fetch, hardcoded in the watch route. That worked, and it also meant the
// feature could not be turned off, could not be replaced by another provider,
// bypassed the sandbox's host allowlist and request proxy, and its failures
// were invisible to the developer portal.
//
// As a metadata extension it is ordinary: declared host, proxied requests,
// reported errors, and someone can ship a different skip provider without
// touching the client.
//
// ---------------------------------------------------------------------------
// What it returns
// ---------------------------------------------------------------------------
// Flat metadata records, which is the only shape that crosses the sandbox:
//
//   { kind: 'skip', skipType: 'op' | 'ed', start: 12.5, end: 102.3 }
//
// The player turns those into the skip button and the auto-skip setting.

const TYPE_PARAMS = {
  op_ed: ['op', 'ed'],
  op: ['op'],
  ed: ['ed']
}

const BASE = 'https://api.aniskip.com/v2/skip-times'

/**
 * AniSkip is keyed on MyAnimeList ids and nothing else.
 *
 * A title without one gets no skip data, and that is the honest answer —
 * guessing an id from a title name would produce intervals from a different
 * show, which is far worse than no skip button.
 */
function malId (query) {
  const id = Number(query?.malId)
  return Number.isInteger(id) && id > 0 ? id : null
}

export default {
  /**
   * Is the service answering?
   *
   * A known id is used rather than a HEAD on the root: AniSkip answers the
   * root with a redirect whatever its database is doing, so probing it proves
   * nothing about whether lookups work.
   */
  async test () {
    try {
      const res = await yume.fetch(`${BASE}/1/1?types[]=op&episodeLength=0`)
      // 404 means "no entry for that episode", which is a working service.
      return res.ok || res.status === 404
    } catch (e) {
      return false
    }
  },

  async metadata (query, options) {
    const opts = options ?? {}
    const id = malId(query)
    if (!id) return []

    const episode = Number(query?.episode)
    if (!Number.isFinite(episode) || episode < 1) return []

    const types = TYPE_PARAMS[opts.types] ?? TYPE_PARAMS.op_ed
    const params = types.map(t => `types[]=${t}`).join('&')
    // episodeLength=0 asks AniSkip not to filter on runtime. The player knows
    // the real duration and clamps against it, and passing a wrong length here
    // silently returns nothing.
    const url = `${BASE}/${id}/${episode}?${params}&episodeLength=0`

    let payload
    try {
      const res = await yume.fetch(url)
      if (!res.ok) return []
      payload = await res.json()
    } catch (e) {
      return []
    }

    if (!payload?.found || !Array.isArray(payload.results)) return []

    const minLength = Number(opts.min_length)
    const floor = Number.isFinite(minLength) && minLength >= 0 ? minLength : 5

    return payload.results
      .map(row => {
        const start = Number(row?.interval?.startTime)
        const end = Number(row?.interval?.endTime)
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null
        if (end <= start) return null
        // A one-second "opening" is a bad submission, and a skip button that
        // jumps nowhere is worse than no button.
        if (end - start < floor) return null
        return {
          kind: 'skip',
          skipType: row?.skipType === 'ed' ? 'ed' : 'op',
          start,
          end
        }
      })
      .filter(Boolean)
  }
}
