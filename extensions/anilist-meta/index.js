/* global yume */
// AniList Extras — cast, staff and recommendations for the detail page.
//
// ---------------------------------------------------------------------------
// What it is for
// ---------------------------------------------------------------------------
// The anime detail page has Characters and Recommendations tabs that say "No
// character data." and "No recommendations yet." for anything served from the
// local catalogue, because the catalogue has never held either — `people`,
// `characters`, `anime_characters`, `anime_staff` and `anime_recommendations`
// are all tables with no code path.
//
// This fills those tabs from AniList's public API.
//
// ---------------------------------------------------------------------------
// One request, three answers
// ---------------------------------------------------------------------------
// Characters, staff and recommendations all hang off the same Media node, so
// they come back in a single query rather than three. AniList rate-limits by
// request count, not by response size, so asking once for everything is
// strictly cheaper than asking three times for a third each.
//
// Results are cached for a day. A detail page is re-opened constantly and none
// of this changes hour to hour; spending a rate-limited request on every visit
// would exhaust the budget on nothing.

const ENDPOINT = 'https://graphql.anilist.co'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * One query for everything the page can show.
 *
 * `role` and `name.userPreferred` match the shapes the detail page already
 * renders for AniList-served media, so nothing downstream has to learn a
 * second format.
 */
const QUERY = `
  query ($id: Int, $perPage: Int) {
    Media(id: $id, type: ANIME) {
      id
      characters(sort: [ROLE, RELEVANCE], perPage: $perPage) {
        edges {
          role
          node { id name { userPreferred } image { large } }
          voiceActors(language: JAPANESE) { id name { userPreferred } image { large } }
        }
      }
      staff(perPage: $perPage) {
        edges { role node { id name { userPreferred } image { large } } }
      }
      recommendations(sort: RATING_DESC, perPage: $perPage) {
        nodes {
          mediaRecommendation {
            id
            title { userPreferred romaji english native }
            coverImage { large }
            format
            averageScore
            episodes
          }
        }
      }
    }
  }`

const clampLimit = value => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 24
  return Math.min(50, Math.max(1, Math.round(n)))
}

async function fetchMedia (anilistId, perPage) {
  const res = await yume.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: anilistId, perPage } })
  })
  if (!res.ok) throw new Error(`AniList returned ${res.status}`)
  const body = await res.json()
  // A GraphQL error arrives with HTTP 200, so the status alone proves nothing.
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message ?? 'query failed'))
  return body?.data?.Media ?? null
}

export default {
  /**
   * Is AniList answering?
   *
   * A trivial query rather than a HEAD: the endpoint only speaks POST, and a
   * HEAD on it proves nothing about whether queries work.
   */
  async test () {
    try {
      const res = await yume.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ Media(id: 1, type: ANIME) { id } }' })
      })
      return res.ok
    } catch (e) {
      return false
    }
  },

  async metadata (query, options) {
    const opts = options ?? {}
    const anilistId = Number(query?.anilistId)
    // No id, no lookup. Searching by title would return a different show's
    // cast, which is worse than an empty tab.
    if (!Number.isInteger(anilistId) || anilistId <= 0) return []

    const perPage = clampLimit(opts.limit)
    const cacheKey = `meta:${anilistId}:${perPage}`

    try {
      const cached = await yume.storage.get(cacheKey)
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.records
    } catch (e) { /* a cache miss is not an error */ }

    let media
    try {
      media = await fetchMedia(anilistId, perPage)
    } catch (e) {
      return []
    }
    if (!media) return []

    const records = []

    if (opts.characters !== false) {
      for (const edge of media.characters?.edges ?? []) {
        const node = edge?.node
        if (!node?.name?.userPreferred) continue
        const actor = edge?.voiceActors?.[0]
        records.push({
          kind: 'character',
          anilistId: Number(node.id) || 0,
          name: node.name.userPreferred,
          role: edge.role ?? '',
          image: node.image?.large ?? '',
          // The Japanese voice actor, when AniList has one. Flat rather than
          // nested because only primitives cross the sandbox boundary.
          voiceActor: actor?.name?.userPreferred ?? '',
          voiceActorImage: actor?.image?.large ?? ''
        })
      }
    }

    if (opts.staff !== false) {
      for (const edge of media.staff?.edges ?? []) {
        const node = edge?.node
        if (!node?.name?.userPreferred) continue
        records.push({
          kind: 'staff',
          anilistId: Number(node.id) || 0,
          name: node.name.userPreferred,
          role: edge.role ?? '',
          image: node.image?.large ?? ''
        })
      }
    }

    if (opts.recommendations !== false) {
      for (const node of media.recommendations?.nodes ?? []) {
        const rec = node?.mediaRecommendation
        if (!rec?.id) continue
        records.push({
          kind: 'recommendation',
          anilistId: Number(rec.id),
          title: rec.title?.userPreferred ?? rec.title?.romaji ?? '',
          titleRomaji: rec.title?.romaji ?? '',
          titleEnglish: rec.title?.english ?? '',
          image: rec.coverImage?.large ?? '',
          format: rec.format ?? '',
          score: Number(rec.averageScore) || 0,
          episodes: Number(rec.episodes) || 0
        })
      }
    }

    if (records.length) {
      try {
        await yume.storage.set(cacheKey, { at: Date.now(), records })
      } catch (e) { /* storage is a convenience */ }
    }
    return records
  }
}
