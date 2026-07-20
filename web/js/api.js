/* global window, localStorage, fetch, Store */
// Data layer. Same sources as the original app, called directly from the browser:
//  - AniList GraphQL  (metadata, search, schedule)   https://graphql.anilist.co
//  - Jikan v4         (episode lists via MAL id)     https://api.jikan.moe
//  - ani.zip          (episode images/titles + id mappings)
//  - filler-scrape    (filler episode markers)

const API = {
  AL_URL: 'https://graphql.anilist.co',
  JIKAN_URL: 'https://api.jikan.moe/v4',
  ANIZIP_URL: 'https://api.ani.zip',

  _memCache: new Map(),

  // ---------- generic cached fetch ----------

  async _cached (key, ttlMs, loader) {
    if (this._memCache.has(key)) return this._memCache.get(key)

    try {
      const raw = localStorage.getItem('cache:' + key)
      if (raw) {
        const { expires, data } = JSON.parse(raw)
        if (expires > Date.now()) {
          this._memCache.set(key, data)
          return data
        }
        localStorage.removeItem('cache:' + key)
      }
    } catch (e) { /* corrupted cache entry */ }

    const data = await loader()
    this._memCache.set(key, data)
    try {
      localStorage.setItem('cache:' + key, JSON.stringify({ expires: Date.now() + ttlMs, data }))
    } catch (e) {
      // storage full: evict all cache entries and carry on from memory
      for (const k of Object.keys(localStorage)) if (k.startsWith('cache:')) localStorage.removeItem(k)
    }
    return data
  },

  // ---------- AniList ----------

  MEDIA_FRAGMENT: `
    fragment med on Media {
      id
      idMal
      title { userPreferred romaji english native }
      coverImage { extraLarge large color }
      bannerImage
      season
      seasonYear
      format
      status
      episodes
      duration
      averageScore
      genres
      isAdult
      synonyms
      description
      trailer { id site }
      nextAiringEpisode { episode airingAt }
      startDate { year month day }
      studios(isMain: true) { nodes { name } }
      relations { edges { relationType node { id status } } }
    }`,

  async al (query, variables = {}) {
    // drop null/undefined variables so AniList treats them as unset
    const vars = Object.fromEntries(Object.entries(variables).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)))

    const res = await fetch(this.AL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: vars })
    })

    if (res.status === 429) {
      // rate limited: wait for the window to reset, then retry once
      const wait = (Number(res.headers.get('Retry-After')) || 30) * 1000
      await new Promise(resolve => setTimeout(resolve, wait))
      return this.al(query, variables)
    }

    const json = await res.json()
    if (json.errors?.length) throw new Error(json.errors[0].message)
    return json.data
  },

  SEARCH_QUERY: null, // built below to reuse the fragment

  async search (variables = {}) {
    const { nsfw } = Store.settings()
    const vars = { perPage: 25, ...variables }
    if (!nsfw) vars.isAdult = false

    const key = 'al:search:' + JSON.stringify(vars)
    return this._cached(key, 30 * 60 * 1000, async () => {
      const data = await this.al(this.SEARCH_QUERY, vars)
      return data.Page
    })
  },

  async media (id) {
    const key = 'al:media:' + id
    return this._cached(key, 60 * 60 * 1000, async () => {
      const data = await this.al(/* GraphQL */`
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            ...med
            source
            countryOfOrigin
            favourites
            meanScore
            popularity
            externalLinks { url site type icon color }
            relations {
              edges {
                relationType(version: 2)
                node { ...med }
              }
            }
            recommendations(perPage: 12, sort: RATING_DESC) {
              nodes { mediaRecommendation { ...med } }
            }
            characters(perPage: 12, sort: [ROLE, RELEVANCE]) {
              edges {
                role
                node { id name { userPreferred } image { large } }
              }
            }
            streamingEpisodes { title thumbnail url site }
          }
        }
        ${this.MEDIA_FRAGMENT}`, { id })
      return data.Media
    })
  },

  async schedule (fromDate, toDate) {
    const from = Math.floor(+fromDate / 1000)
    const to = Math.floor(+toDate / 1000)
    const key = `al:schedule:${from}:${to}`

    return this._cached(key, 30 * 60 * 1000, async () => {
      const { nsfw } = Store.settings()
      const all = []
      for (let page = 1; page <= 4; page++) {
        const data = await this.al(/* GraphQL */`
          query ($page: Int, $from: Int, $to: Int) {
            Page(page: $page, perPage: 50) {
              pageInfo { hasNextPage }
              airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
                episode
                airingAt
                media { ...med }
              }
            }
          }
          ${this.MEDIA_FRAGMENT}`, { page, from, to })

        all.push(...data.Page.airingSchedules.filter(s => s.media && (nsfw || !s.media.isAdult)))
        if (!data.Page.pageInfo.hasNextPage) break
      }
      return all
    })
  },

  // ---------- Jikan (MyAnimeList) ----------

  _jikanQueue: Promise.resolve(),

  // Jikan allows ~3 req/s — serialise requests with a small delay
  _jikan (path) {
    const run = this._jikanQueue.then(async () => {
      const res = await fetch(this.JIKAN_URL + path)
      if (!res.ok) throw new Error(`Jikan ${res.status}`)
      return res.json()
    })
    this._jikanQueue = run.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, 400)))
    return run
  },

  async jikanEpisodes (malId, maxPages = 4) {
    if (!malId) return []
    const key = 'jikan:eps:' + malId
    return this._cached(key, 6 * 60 * 60 * 1000, async () => {
      const episodes = []
      for (let page = 1; page <= maxPages; page++) {
        const json = await this._jikan(`/anime/${malId}/episodes?page=${page}`)
        episodes.push(...(json.data ?? []))
        if (!json.pagination?.has_next_page) break
      }
      return episodes
    })
  },

  // ---------- ani.zip (episode images, titles, id mappings) ----------

  async aniZip (anilistId) {
    const key = 'anizip:' + anilistId
    try {
      return await this._cached(key, 6 * 60 * 60 * 1000, async () => {
        const res = await fetch(`${this.ANIZIP_URL}/mappings?anilist_id=${anilistId}`)
        if (!res.ok) throw new Error(`ani.zip ${res.status}`)
        return res.json()
      })
    } catch (e) {
      return null
    }
  },

  // ---------- filler episodes (same source as the original app) ----------

  _filler: null,

  async filler (anilistId) {
    try {
      this._filler ??= fetch('https://raw.githubusercontent.com/ThaUnknown/filler-scrape/master/filler.json').then(r => r.json())
      const map = await this._filler
      return map[anilistId] ?? []
    } catch (e) {
      return []
    }
  },

  // ---------- combined episode list ----------
  // Merges AniList count/airing info + ani.zip metadata + Jikan fallback,
  // the same way makeEpisodeList() works in the original extensions module.

  async episodes (media) {
    const airing = media.nextAiringEpisode?.episode
    let count = media.episodes ?? (airing ? airing - 1 : 0)
    if (airing && media.status === 'RELEASING') count = Math.min(count, airing - 1) || airing - 1

    const [zip, filler] = await Promise.all([this.aniZip(media.id), this.filler(media.id)])

    let jikan = []
    const zipEpisodes = zip?.episodes ?? {}
    const zipCount = Object.keys(zipEpisodes).filter(k => /^\d+$/.test(k)).length
    if (!zipCount && media.idMal) {
      try {
        jikan = await this.jikanEpisodes(media.idMal)
      } catch (e) { /* jikan down */ }
    }

    if (!count) count = zipCount || jikan.length || (media.status === 'FINISHED' ? 1 : 0)

    const list = []
    for (let ep = 1; ep <= count; ep++) {
      const z = zipEpisodes[ep]
      const j = jikan[ep - 1]
      list.push({
        episode: ep,
        title: z?.title?.en ?? z?.title?.['x-jat'] ?? j?.title ?? null,
        image: z?.image ?? null,
        summary: z?.overview ?? null,
        airdate: z?.airdate ?? j?.aired ?? null,
        runtime: z?.runtime ?? z?.length ?? null,
        rating: z?.rating ?? (j?.score ? String(j.score) : null),
        filler: filler.includes(ep) || !!j?.filler
      })
    }
    return list
  }
}

API.SEARCH_QUERY = /* GraphQL */`
  query ($page: Int = 1, $perPage: Int = 25, $search: String, $sort: [MediaSort] = [TRENDING_DESC], $genre: [String], $season: MediaSeason, $seasonYear: Int, $format: [MediaFormat], $status: [MediaStatus], $ids: [Int], $isAdult: Boolean) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(type: ANIME, search: $search, sort: $sort, genre_in: $genre, season: $season, seasonYear: $seasonYear, format_in: $format, status_in: $status, id_in: $ids, isAdult: $isAdult) {
        ...med
      }
    }
  }
  ${API.MEDIA_FRAGMENT}`

window.API = API
