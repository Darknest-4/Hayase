/* global window, fetch, localStorage, WebSocket */
// Yume backend adapter. The client works standalone (AniList/Jikan direct),
// but when a Yume API is reachable it powers platform features: accounts,
// comments/community, themes and playback data.
// Configure the endpoint in Settings; default assumes local development.

/** One of our own ids, as opposed to an AniList id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const YumeAPI = {
  base () {
    const saved = localStorage.getItem('yume-api')
    if (saved) return saved
    // served over http(s) → the API is same-origin (single-container deploy);
    // opened from file:// → assume a local dev API on :4000
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.origin
    }
    return 'http://localhost:4000'
  },

  setBase (url) {
    localStorage.setItem('yume-api', url.replace(/\/+$/, ''))
  },

  // ---- token storage ----

  _tokens () {
    try {
      return JSON.parse(localStorage.getItem('yume-auth') ?? 'null')
    } catch (e) {
      return null
    }
  },

  /**
   * Keep the access token. Never keep the refresh token.
   *
   * The refresh token is a thirty-day credential and it used to sit in
   * localStorage, where any script on the origin could read it and keep the
   * account long after leaving the page. It now arrives as an HttpOnly cookie
   * the browser stores and this code cannot see, so the field is dropped on
   * the way in — a server that still sends it (a rolling deploy, an older
   * build) simply has its copy ignored.
   *
   * The access token stays here. It is fifteen minutes long and the client
   * needs it synchronously — `user()` decides what to draw before anything is
   * fetched — so putting it out of reach would mean a signed-out flash on
   * every reload while a refresh is in flight. Fifteen minutes readable is a
   * very different exposure from thirty days.
   */
  _saveTokens (tokens) {
    if (!tokens) { localStorage.removeItem('yume-auth'); return }
    const { refreshToken, ...keep } = tokens
    localStorage.setItem('yume-auth', JSON.stringify(keep))
  },

  user () {
    // access token payload carries { sub, username }
    const tokens = this._tokens()
    if (!tokens?.accessToken) return null
    try {
      const payload = JSON.parse(atob(tokens.accessToken.split('.')[1]))
      return { id: payload.sub, username: payload.username }
    } catch (e) {
      return null
    }
  },

  // ---- request helpers ----

  /**
   * `auth: true` means "this call is useless without a token", not "this is
   * the only kind of call that sends one".
   *
   * The token used to be attached only when a call asked for it, so every read
   * — the catalogue, the community feed, the forum, the chat rooms, the
   * development log — went out anonymously. That is fine on a public instance
   * and wrong on a private one, where the server refuses everything under /v1
   * without a live token: signed in, holding a perfectly good token, the
   * client asked anonymously and was told to sign in. Reported from a phone
   * with the account's own name at the top of the screen.
   *
   * So the header goes on whenever there is one to send. `auth` keeps its
   * other job: failing early, with a sentence a person can act on, rather than
   * sending a request that cannot succeed.
   */
  async _request (path, { method = 'GET', body, auth = false, retry = true, anonymous = false, credentials, headers: extra } = {}) {
    const headers = { Accept: 'application/json', ...extra }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    // `anonymous` is for the one call that must not carry a token: the refresh
    // itself authenticates with the refresh token in its body, and attaching
    // the expired access token to it would put the refresh inside the
    // refresh-and-retry path below — a request that answers 401 by refreshing,
    // which is the request that just failed.
    const tokens = anonymous ? null : this._tokens()
    if (auth && !tokens) throw new Error('Sign in to your Yume account first')
    if (tokens?.accessToken) headers.Authorization = 'Bearer ' + tokens.accessToken

    const res = await fetch(this.base() + path, {
      method,
      headers,
      // Only the auth calls ask for this. Sending cookies on every request
      // would attach the refresh cookie to catalogue reads, and it is scoped
      // to /v1/auth on the server precisely so that cannot happen.
      ...(credentials ? { credentials } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    })

    // Expired access token → refresh once and retry. Keyed on having sent a
    // token rather than on `auth`, or a stale token would turn a public read
    // into a 401 the client never tried to recover from. A refresh that fails
    // clears the tokens, so the retry goes out anonymously and a public
    // instance still answers it.
    if (res.status === 401 && retry && tokens?.accessToken) {
      await this._refresh().catch(() => {})
      return this._request(path, { method, body, auth: auth && !!this._tokens(), retry: false, headers: extra })
    }

    if (res.status === 204) return null
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this._apiError(json, res.status)
    return json
  },

  /**
   * The failure, with the two things a person can act on attached.
   *
   * This used to be `new Error(detail)` and nothing else. The server has
   * always answered a 500 with "Request <id> failed — quote this id when
   * reporting it" and a problem+json body carrying that id, and the client
   * dropped it on the floor: the message reached the screen, the id did not,
   * so nobody could quote anything and no operator could look anything up.
   *
   * `code` is the stable part (YUME-CATALOGUE-500 — which component, which
   * class of failure) and `requestId` is the specific one. Both are properties
   * rather than text in the message, so a caller that wants to render them
   * separately can, and one that just prints `e.message` is no worse off.
   */
  _apiError (problem, status) {
    const error = new Error(problem?.detail ?? problem?.title ?? `API ${status}`)
    error.status = status
    if (problem?.code) error.code = problem.code
    if (problem?.instance) error.requestId = problem.instance
    return error
  },

  /**
   * Trade the refresh cookie for a new access token.
   *
   * No body: the credential is the cookie, which the browser attaches and this
   * code cannot read. `credentials: 'include'` is what makes it do so on a
   * cross-origin deployment — same-origin, which is what the container serves,
   * would send it anyway.
   */
  async _refresh () {
    try {
      const fresh = await this._request('/v1/auth/refresh', {
        method: 'POST',
        body: {},
        anonymous: true,
        credentials: 'include',
        retry: false
      })
      this._saveTokens(fresh)
    } catch (e) {
      this._saveTokens(null) // refresh refused → signed out
      throw e
    }
  },

  async available () {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      const res = await fetch(this.base() + '/v1/health', { signal: controller.signal })
      clearTimeout(timer)
      return res.ok
    } catch (e) {
      return false
    }
  },

  // ---- auth ----

  async register (email, username, password) {
    const tokens = await this._request('/v1/auth/register', { method: 'POST', body: { email, username, password }, credentials: 'include' })
    this._saveTokens(tokens)
    this._perms = null
    return this.user()
  },

  async login (identifier, password) {
    const tokens = await this._request('/v1/auth/login', { method: 'POST', body: { identifier, password }, credentials: 'include' })
    this._saveTokens(tokens)
    this._perms = null
    return this.user()
  },

  async logout () {
    this._perms = null
    const tokens = this._tokens()
    if (tokens) {
      // No body: the server revokes the session the access token names, and
      // the cookie it was given. Sending a refresh token is no longer possible
      // from here, which is the point.
      await this._request('/v1/auth/logout', { method: 'POST', body: {}, auth: true, credentials: 'include' }).catch(() => {})
    }
    this._saveTokens(null)
  },

  // ---- catalogue bridge (AniList id → Yume id) ----

  _resolveCache: {},

  /**
   * Our own id for a title, whatever kind of id the caller is holding.
   *
   * A card built by the catalogue already carries it as `yumeId`, and for a
   * title AniList has never heard of `media.id` *is* that uuid — `toCard`
   * falls back to it when there is no AniList mapping. Both were being sent
   * to the AniList-id route, which answers 400; `create` then posted the uuid
   * as `anilistId` and 400'd too. Two failed requests, and on every
   * catalogue-only title the comment section under the detail panel never
   * loaded — the trailer button on the home page opened a panel whose
   * discussion was permanently a spinner.
   *
   * So: answer from what the caller already has, and never ask the
   * AniList-id route about something that is not an AniList id.
   */
  async yumeAnimeId (media, { create = false } = {}) {
    if (media?.yumeId) return media.yumeId
    if (UUID.test(String(media?.id ?? ''))) return String(media.id)
    if (!Number.isFinite(Number(media?.id))) return null

    const cached = this._resolveCache[media.id]
    if (cached) return cached

    try {
      const found = await this._request('/v1/anime/by-anilist/' + media.id)
      this._resolveCache[media.id] = found.id
      return found.id
    } catch (e) {
      if (!create) return null
    }

    const created = await this._request('/v1/anime/resolve', {
      method: 'POST',
      auth: true,
      body: {
        anilistId: media.id,
        title: media.title?.userPreferred ?? media.title?.romaji ?? 'Unknown',
        format: media.format ?? undefined,
        status: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'].includes(media.status) ? media.status : undefined,
        episodes: media.episodes ?? undefined,
        isAdult: media.isAdult ?? undefined
      }
    })
    this._resolveCache[media.id] = created.id
    return created.id
  },

  /**
   * A single-use ticket for the WebSocket handshake.
   *
   * A browser cannot set headers on a WebSocket upgrade, so whatever
   * authenticates it ends up in the URL — and therefore in proxy access logs
   * and browser history. A ticket is worth nothing once used and expires in
   * seconds, so that is what goes there instead of the access token.
   */
  async wsTicket () {
    const { ticket } = await this._request('/v1/auth/ws-ticket', { method: 'POST', auth: true })
    return ticket
  },

  /**
   * Open an authenticated socket, and wait until it is actually open.
   *
   * It used to hand back a socket in CONNECTING and claim in its own comment
   * to have waited. Both callers then attached an `open` listener to the
   * socket they were given — and on a fast connection, a local one especially,
   * the socket can open in the gap between the constructor returning and the
   * listener being attached. The event is gone by then, so the listener never
   * runs and the `join` it was going to send is never sent: the chat room goes
   * quiet, and watch-together waits for a `joined` that cannot arrive.
   *
   * Resolving on `open` makes the comment true and removes the race from both
   * of them, because after this there is no gap left to lose an event in.
   */
  async openSocket ({ timeoutMs = 10_000 } = {}) {
    const ticket = await this.wsTicket()
    const url = this.base().replace(/^http/, 'ws') + '/ws?ticket=' + encodeURIComponent(ticket)
    const socket = new WebSocket(url)

    if (socket.readyState === WebSocket.OPEN) return socket
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { cleanup(); socket.close(); reject(new Error('The connection timed out')) }, timeoutMs)
      const cleanup = () => {
        window.clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onFail)
        socket.removeEventListener('close', onFail)
      }
      const onOpen = () => { cleanup(); resolve() }
      // `close` as well as `error`: a socket refused before it opens fires
      // close, and waiting on error alone would hang until the timeout.
      const onFail = () => { cleanup(); reject(new Error('The connection failed')) }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onFail)
      socket.addEventListener('close', onFail)
    })
    return socket
  },

  // ---- catalogue reads ----
  //
  // These return null — never throw — when the backend is unreachable, so the
  // client stays usable standalone and the caller falls through to AniList.
  // A 404 is also null: "we do not have it" and "we cannot be asked" lead to
  // the same next step.

  /**
   * The full catalogue record, by Yume id (uuid) or AniList id (numeric).
   *
   * `full=true` on the AniList path returns the record in one round trip
   * rather than resolving the id and then fetching it.
   */
  async catalogueMedia (id) {
    const path = UUID.test(String(id))
      ? '/v1/anime/' + id
      : '/v1/anime/by-anilist/' + Number(id) + '?full=true'
    try {
      return await this._request(path)
    } catch (e) {
      return null
    }
  },

  /**
   * Published episodes, plus how many we hold in total.
   *
   * The total is what lets the caller tell "we have no episode data" from "we
   * have episodes and publish none" — see Catalogue.episodes. Returns null
   * only when the backend could not be reached at all.
   */
  async catalogueEpisodes (yumeId) {
    try {
      const { data, total } = await this._request(`/v1/anime/${yumeId}/episodes`)
      return { data, total: total ?? data.length }
    } catch (e) {
      return null
    }
  },

  /** Many catalogue entries by AniList id, order preserved. */
  async catalogueByAniListIds (ids) {
    if (!ids?.length) return []
    try {
      const { data } = await this._request('/v1/anime/by-anilist?ids=' + ids.join(','))
      return data
    } catch (e) {
      return null
    }
  },

  /** Filtered, sorted browse over the catalogue. */
  async browseCatalogue (filters = {}) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== null && v !== '') params.set(k, v)
    try {
      return await this._request('/v1/anime/?' + params.toString())
    } catch (e) {
      return null
    }
  },

  /** Published episodes airing in a window. */
  async catalogueSchedule (from, to) {
    try {
      const { data } = await this._request(`/v1/anime/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      return data
    } catch (e) {
      return null
    }
  },

  async catalogueRelations (yumeId) {
    try {
      const { data } = await this._request(`/v1/anime/${yumeId}/relations`)
      return data
    } catch (e) {
      return null
    }
  },

  /**
   * The themes this deployment offers.
   *
   * Public and unauthenticated: the colours are the same for everyone, and a
   * signed-out visitor seeing the wrong ones until they sign in is a worse
   * answer than serving a list of hex values to anybody who asks.
   */
  async themes () {
    try {
      const { data } = await this._request('/v1/themes')
      return data
    } catch (e) {
      return null
    }
  },

  /** Opening/ending intervals this deployment holds for one episode. */
  async episodeSkips (episodeId) {
    try {
      const { data } = await this._request(`/v1/anime/episodes/${episodeId}/skips`)
      return data
    } catch (e) {
      return null
    }
  },

  /** Subtitle tracks this deployment holds for one episode. */
  async episodeSubtitles (episodeId) {
    try {
      const { data } = await this._request(`/v1/anime/episodes/${episodeId}/subtitles`)
      return data
    } catch (e) {
      return null
    }
  },

  /** The registered, enabled sources of one episode. */
  async episodeSources (episodeId) {
    try {
      const { data } = await this._request(`/v1/anime/episodes/${episodeId}/sources`)
      return data
    } catch (e) {
      return null
    }
  },

  /**
   * The franchise this title belongs to, in release order.
   *
   * Separate from the relations call because it answers a different question:
   * relations are the immediate neighbours, a franchise is the whole run —
   * season three does not link to season one, so the graph alone cannot say
   * where you are in it.
   */
  async catalogueFranchise (yumeId) {
    try {
      return await this._request(`/v1/anime/${yumeId}/franchise`)
    } catch (e) {
      return null
    }
  },

  /*
   * Cast, staff and recommendations from the catalogue.
   *
   * Fetched when the tab is opened rather than with the record: most visits to
   * an anime page never open any of them, and three extra requests on every
   * detail load to fill tabs nobody looks at is a poor trade.
   *
   * Each returns null on failure rather than throwing, because every caller's
   * answer to a failure is the same — show the tab empty rather than broken.
   */
  async catalogueCharacters (yumeId) {
    try {
      const { data } = await this._request(`/v1/anime/${yumeId}/characters`)
      return data
    } catch (e) {
      return null
    }
  },

  async catalogueStaff (yumeId) {
    try {
      const { data } = await this._request(`/v1/anime/${yumeId}/staff`)
      return data
    } catch (e) {
      return null
    }
  },

  async catalogueRecommendations (yumeId, limit = 20) {
    try {
      const { data } = await this._request(`/v1/anime/${yumeId}/recommendations?limit=${limit}`)
      return data
    } catch (e) {
      return null
    }
  },

  // ---- catalogue search ----
  // Tiered ranking over the Yume catalogue (canonical titles, romaji/english/
  // native titles and synonyms). The client stays usable without a backend —
  // callers fall back to AniList when these return null.

  /**
   * Returns `{ data, hasMore }`, not a bare array.
   *
   * It used to return just `data`, which threw away the only signal about
   * whether another page existed — so every catalogue-backed search stopped at
   * its first page. `null` still means the backend could not answer and the
   * caller should use AniList.
   */
  async searchCatalogue (query, filters = {}) {
    const params = new URLSearchParams({ q: query })
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '' && v !== false) params.set(k, v)
    try {
      const { data, hasMore } = await this._request('/v1/anime/search?' + params.toString())
      return { data, hasMore: hasMore ?? false }
    } catch (e) {
      return null // backend unreachable — the caller uses AniList instead
    }
  },

  // ---- announcements ----
  // One message, written by an operator, read by everybody. The read is
  // authenticated like everything else on a private instance; `dismissed`
  // comes back resolved per profile so the client does not have to ask twice
  // or risk showing something already closed on another device.

  async announcements () {
    try {
      const { data } = await this._request('/v1/announcements', { auth: true })
      return data
    } catch (e) {
      return null // never let the news break the page it sits on
    }
  },

  async dismissAnnouncement (id) {
    try {
      await this._request(`/v1/announcements/${id}/dismiss`, { method: 'POST', auth: true })
      return true
    } catch (e) {
      return false
    }
  },

  async suggest (query, limit = 8) {
    try {
      const { data } = await this._request(`/v1/anime/suggest?q=${encodeURIComponent(query)}&limit=${limit}`)
      return data
    } catch (e) {
      return null
    }
  },

  // ---- the account's own profile ----

  profile: {
    _api: null,

    get () { return this._api._request('/v1/profiles/me', { auth: true }) },
    update (patch) { return this._api._request('/v1/profiles/me', { method: 'PATCH', auth: true, body: patch }) },
    artwork ({ kind = 'avatar', q, limit = 30 } = {}) {
      const query = new URLSearchParams({ kind, limit: String(limit) })
      if (q) query.set('q', q)
      return this._api._request(`/v1/profiles/artwork?${query}`, { auth: true })
    }
  },

  // ---- forum ----
  //
  // Namespaced rather than flat because there are a dozen of them and they all
  // start with the same word; `YumeAPI.forum.topics(slug)` reads as what it is.

  forum: {
    _api: null, // set below, once YumeAPI exists to point at

    list () { return this._api._request('/v1/forum') },
    get (slug) { return this._api._request(`/v1/forum/${encodeURIComponent(slug)}`) },
    create (name, description) {
      return this._api._request('/v1/forum', { method: 'POST', auth: true, body: { name, description: description || undefined } })
    },
    update (id, patch) { return this._api._request(`/v1/forum/${id}`, { method: 'PATCH', auth: true, body: patch }) },
    remove (id) { return this._api._request(`/v1/forum/${id}`, { method: 'DELETE', auth: true }) },

    topics (slug, { limit = 30, offset = 0 } = {}) {
      return this._api._request(`/v1/forum/${encodeURIComponent(slug)}/topics?limit=${limit}&offset=${offset}`)
    },
    createTopic (slug, title, body) {
      return this._api._request(`/v1/forum/${encodeURIComponent(slug)}/topics`, { method: 'POST', auth: true, body: { title, body } })
    },
    topic (id) { return this._api._request(`/v1/forum/topics/${id}`) },
    updateTopic (id, patch) { return this._api._request(`/v1/forum/topics/${id}`, { method: 'PATCH', auth: true, body: patch }) },
    removeTopic (id) { return this._api._request(`/v1/forum/topics/${id}`, { method: 'DELETE', auth: true }) },

    posts (topicId, { limit = 50, offset = 0 } = {}) {
      return this._api._request(`/v1/forum/topics/${topicId}/posts?limit=${limit}&offset=${offset}`)
    },
    reply (topicId, body) {
      return this._api._request(`/v1/forum/topics/${topicId}/posts`, { method: 'POST', auth: true, body: { body } })
    },
    editPost (id, body) { return this._api._request(`/v1/forum/posts/${id}`, { method: 'PATCH', auth: true, body: { body } }) },
    removePost (id) { return this._api._request(`/v1/forum/posts/${id}`, { method: 'DELETE', auth: true }) }
  },

  // ---- live chat ----
  //
  // Only the parts a socket cannot do: what rooms exist, becoming a member of
  // one, and what was said before you arrived. Sending goes over the socket.

  chat: {
    _api: null,

    rooms () { return this._api._request('/v1/chat/rooms') },
    join (slug) { return this._api._request(`/v1/chat/rooms/${encodeURIComponent(slug)}/join`, { method: 'POST', auth: true }) },
    messages (slug, { limit = 50, before } = {}) {
      const query = new URLSearchParams({ limit: String(limit) })
      if (before) query.set('before', String(before))
      return this._api._request(`/v1/chat/rooms/${encodeURIComponent(slug)}/messages?${query}`)
    },
    removeMessage (id) { return this._api._request(`/v1/chat/messages/${id}`, { method: 'DELETE', auth: true }) }
  },

  // ---- development log ----

  changelog: {
    _api: null,

    list (status) { return this._api._request('/v1/changelog' + (status ? `?status=${status}` : '')) },
    // A szerkesztő nézete: a nem publikus kiadásokat is tartalmazza, és ezért
    // jogosultsághoz kötött (changelog.manage).
    all () { return this._api._request('/v1/changelog/all', { auth: true }) },
    get (version) { return this._api._request(`/v1/changelog/${encodeURIComponent(version)}`) },
    create (release) { return this._api._request('/v1/changelog', { method: 'POST', auth: true, body: release }) },
    update (id, patch) { return this._api._request(`/v1/changelog/${id}`, { method: 'PATCH', auth: true, body: patch }) },
    remove (id) { return this._api._request(`/v1/changelog/${id}`, { method: 'DELETE', auth: true }) }
  },

  // ---- comments ----

  comments (subjectType, subjectId) {
    return this._request(`/v1/comments?subjectType=${subjectType}&subjectId=${subjectId}`)
  },

  recentComments () {
    return this._request('/v1/comments/recent')
  },

  postComment (subjectType, subjectId, body, { parentId, spoiler } = {}) {
    return this._request('/v1/comments', {
      method: 'POST',
      auth: true,
      body: { subjectType, subjectId, body, parentId: parentId ?? undefined, spoiler: spoiler ?? false }
    })
  },

  likeComment (id) {
    return this._request(`/v1/comments/${id}/like`, { method: 'POST', auth: true })
  },

  /** Public readiness aggregate — safe for any signed-in view. */
  async readiness () {
    try {
      return await this._request('/v1/health/ready')
    } catch (e) {
      return null
    }
  },

  // ---- site config / feature flags ----

  async config () {
    try {
      return await this._request('/v1/config')
    } catch (e) {
      return null // backend unreachable — the client falls back to "all on"
    }
  },

  // ---- permissions (cached per session) ----

  _perms: null,

  async myPermissions () {
    if (!this.user()) return []
    if (this._perms) return this._perms
    try {
      const { permissions } = await this._request('/v1/auth/permissions', { auth: true })
      this._perms = permissions
      return permissions
    } catch (e) {
      return []
    }
  },

  // ---- reports & moderation ----

  report (subjectType, subjectId, reason, details) {
    return this._request('/v1/reports', { method: 'POST', auth: true, body: { subjectType, subjectId, reason, details } })
  },

  /**
   * The notification inbox.
   *
   * Both of these were called and neither existed. `GET /v1/me/notifications`
   * and `POST /v1/me/notifications/read` have been on the server the whole
   * time; the client asked for `YumeAPI.notifications(...)` and got
   * "is not a function", which threw out of PageNotifications.render() and
   * left the entire Notifications route showing its error state. The admin
   * panel's bell called the same missing method through optional chaining, so
   * it failed silently and always showed the local count.
   *
   * Returns the rows, not the envelope: every caller maps or counts them.
   */
  notifications ({ unreadOnly = false, limit = 50 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (unreadOnly) params.set('unreadOnly', 'true')
    return this._request('/v1/me/notifications?' + params.toString(), { auth: true })
      .then(res => res.data ?? [])
  },

  /** Mark some notifications read, or all of them when given no ids. */
  markNotificationsRead (ids) {
    return this._request('/v1/me/notifications/read', {
      method: 'POST',
      auth: true,
      body: ids?.length ? { ids } : {}
    })
  },

  admin: {
    // ---- announcements ----
    // Authoring lives under /v1/announcements rather than /v1/admin, because
    // the resource is the same one the read serves; only the permission
    // differs. `allAnnouncements` is the authoring view — it includes messages
    // whose window has not opened yet and ones that have closed.
    allAnnouncements: () => YumeAPI._request('/v1/announcements/all', { auth: true }),
    createAnnouncement: body => YumeAPI._request('/v1/announcements', { method: 'POST', auth: true, body }),
    updateAnnouncement: (id, body) => YumeAPI._request(`/v1/announcements/${id}`, { method: 'PATCH', auth: true, body }),
    deleteAnnouncement: id => YumeAPI._request(`/v1/announcements/${id}`, { method: 'DELETE', auth: true }),

    users: ({ query, status, role, sort, limit, offset } = {}) => {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (status) params.set('status', status)
      if (role) params.set('role', role)
      if (sort) params.set('sort', sort)
      if (limit) params.set('limit', String(limit))
      if (offset) params.set('offset', String(offset))
      return YumeAPI._request('/v1/admin/users?' + params.toString(), { auth: true })
    },
    // Everything recorded about one account, in one request.
    user: id => YumeAPI._request(`/v1/admin/users/${id}`, { auth: true }),
    setUserStatus: (id, status, reason) =>
      YumeAPI._request(`/v1/admin/users/${id}/status`, { method: 'POST', auth: true, body: { status, reason } }),
    setUserRole: (id, role, granted, reason) =>
      YumeAPI._request(`/v1/admin/users/${id}/roles`, { method: 'POST', auth: true, body: { role, granted, reason } }),
    revokeUserSessions: (id, reason) =>
      YumeAPI._request(`/v1/admin/users/${id}/sessions/revoke`, { method: 'POST', auth: true, body: { reason } }),
    reports: ({ status = 'open', subjectType, limit = 50, offset = 0 } = {}) => {
      const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) })
      if (subjectType) params.set('subjectType', subjectType)
      return YumeAPI._request('/v1/admin/reports?' + params.toString(), { auth: true })
    },
    resolveReport: (id, action, reason) =>
      YumeAPI._request(`/v1/admin/reports/${id}/resolve`, { method: 'POST', auth: true, body: { action, reason } }),
    overview: () =>
      YumeAPI._request('/v1/admin/analytics/overview', { auth: true }),

    // The counts the section rail puts on its own items. Each figure is null
    // when this account holds no permission over it.
    badges: () => YumeAPI._request('/v1/admin/badges', { auth: true }),

    // Everything the overview screen draws, in one round trip. `days` is the
    // window every comparison on it is measured over, so the captions on the
    // cards are all true of the same period.
    dashboard: (days = 7) =>
      YumeAPI._request(`/v1/admin/analytics/dashboard?days=${days}`, { auth: true }),

    // Hungarian catalogue text. `queue` is the only one an editor opens
    // deliberately — everything else follows from picking something in it.
    translations: {
      progress: () => YumeAPI._request('/v1/admin/translations/progress', { auth: true }),
      queue: ({ limit = 25, offset = 0, publishedOnly = true } = {}) =>
        YumeAPI._request(`/v1/admin/translations/queue?limit=${limit}&offset=${offset}&publishedOnly=${publishedOnly}`, { auth: true }),
      get: id => YumeAPI._request(`/v1/admin/translations/anime/${id}`, { auth: true }),
      put: (id, language, body) =>
        YumeAPI._request(`/v1/admin/translations/anime/${id}/${language}`, { method: 'PUT', auth: true, body }),
      remove: (id, language) =>
        YumeAPI._request(`/v1/admin/translations/anime/${id}/${language}`, { method: 'DELETE', auth: true })
    },
    // webhooks
    webhookEvents: () => YumeAPI._request('/v1/admin/webhooks/events', { auth: true }),
    webhooks: () => YumeAPI._request('/v1/admin/webhooks', { auth: true }),
    createWebhook: body => YumeAPI._request('/v1/admin/webhooks', { method: 'POST', auth: true, body }),
    updateWebhook: (id, body) => YumeAPI._request(`/v1/admin/webhooks/${id}`, { method: 'PATCH', auth: true, body }),
    deleteWebhook: id => YumeAPI._request(`/v1/admin/webhooks/${id}`, { method: 'DELETE', auth: true }),
    testWebhook: id => YumeAPI._request(`/v1/admin/webhooks/${id}/test`, { method: 'POST', auth: true, body: {} }),
    webhookDeliveries: id => YumeAPI._request(`/v1/admin/webhooks/${id}/deliveries`, { auth: true }),
    // site config / feature flags
    config: () => YumeAPI._request('/v1/admin/config', { auth: true }),
    setFlag: (key, body) => YumeAPI._request(`/v1/admin/config/flags/${encodeURIComponent(key)}`, { method: 'PATCH', auth: true, body }),
    setSetting: (key, value) => YumeAPI._request(`/v1/admin/config/settings/${encodeURIComponent(key)}`, { method: 'PATCH', auth: true, body: { value } }),
    // roles & permissions
    roles: () => YumeAPI._request('/v1/admin/roles', { auth: true }),
    permissionCatalog: () => YumeAPI._request('/v1/admin/roles/permissions', { auth: true }),
    setRolePermission: (roleId, slug, granted) => YumeAPI._request(`/v1/admin/roles/${roleId}/permissions`, { method: 'POST', auth: true, body: { slug, granted } }),
    // VPS health & monitoring (system.metrics.view)
    monitoring: {
      current: () => YumeAPI._request('/v1/admin/monitoring/current', { auth: true }),
      history: (metric, hours = 24) => YumeAPI._request(`/v1/admin/monitoring/history?metric=${encodeURIComponent(metric)}&hours=${hours}`, { auth: true }),
      thresholds: () => YumeAPI._request('/v1/admin/monitoring/thresholds', { auth: true }),
      queues: () => YumeAPI._request('/v1/admin/monitoring/queues', { auth: true }),
      // The component registry: what the platform is made of, what each part
      // depends on, and a measured status for each.
      components: () => YumeAPI._request('/v1/admin/monitoring/components', { auth: true }),
      alerts: () => YumeAPI._request('/v1/admin/monitoring/alerts', { auth: true }),
      diagnostics: () => YumeAPI._request('/v1/admin/monitoring/diagnostics', { auth: true }),
      diagnostic: id => YumeAPI._request('/v1/admin/monitoring/diagnostics/' + id, { auth: true }),
      runDiagnostic: () => YumeAPI._request('/v1/admin/monitoring/diagnostics', { method: 'POST', auth: true, body: {} })
    },
    // catalogue management (anime + episodes, sees hidden entries)
    catalogue: {
      list: (params = {}) => {
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v)
        return YumeAPI._request('/v1/admin/catalogue?' + qs.toString(), { auth: true })
      },
      get: id => YumeAPI._request(`/v1/admin/catalogue/${id}`, { auth: true }),
      create: body => YumeAPI._request('/v1/admin/catalogue', { method: 'POST', auth: true, body }),
      update: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}`, { method: 'PATCH', auth: true, body }),
      remove: id => YumeAPI._request(`/v1/admin/catalogue/${id}`, { method: 'DELETE', auth: true }),
      episodes: id => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes`, { auth: true }),
      addEpisode: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes`, { method: 'POST', auth: true, body }),
      updateEpisode: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}`, { method: 'PATCH', auth: true, body }),
      removeEpisode: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}`, { method: 'DELETE', auth: true }),
      // Publish or take down a whole range at once: { visibility, from?, to? }
      episodeVisibility: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes/visibility`, { method: 'POST', auth: true, body }),
      // Ugyanaz az egész katalógusra: { visibility }. Csak publikus címek
      // epizódjait érinti.
      episodeVisibilityAll: body => YumeAPI._request('/v1/admin/catalogue/episodes/visibility/all', { method: 'POST', auth: true, body }),
      // metadata provenance & duplicate handling
      unlock: (id, fields) => YumeAPI._request(`/v1/admin/catalogue/${id}/unlock`, { method: 'POST', auth: true, body: { fields } }),
      // `exact` by default, matching the server. The `similar` pass compares
      // every title against every other in its year and format, which takes a
      // minute on a catalogue this size — so it is a button somebody presses,
      // not what happens when the tab opens.
      duplicates: ({ mode = 'exact', threshold = 0.86, limit = 50 } = {}) =>
        YumeAPI._request(`/v1/admin/catalogue/duplicates?mode=${mode}&threshold=${threshold}&limit=${limit}`, { auth: true }),
      merge: (id, sourceId) => YumeAPI._request(`/v1/admin/catalogue/${id}/merge`, { method: 'POST', auth: true, body: { sourceId } }),

      // where an episode plays from — registered by an operator, any provider
      sources: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/sources`, { auth: true }),
      addSource: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/sources`, { method: 'POST', auth: true, body }),
      updateSource: (sid, body) => YumeAPI._request(`/v1/admin/catalogue/sources/${sid}`, { method: 'PATCH', auth: true, body }),
      removeSource: sid => YumeAPI._request(`/v1/admin/catalogue/sources/${sid}`, { method: 'DELETE', auth: true }),

      // the rest of what an episode needs to play well: skip intervals and
      // subtitle tracks, both of which the catalogue now holds itself
      skips: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/skips`, { auth: true }),
      addSkip: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/skips`, { method: 'POST', auth: true, body }),
      removeSkip: sid => YumeAPI._request(`/v1/admin/catalogue/skips/${sid}`, { method: 'DELETE', auth: true }),
      subtitles: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/subtitles`, { auth: true }),
      addSubtitle: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/subtitles`, { method: 'POST', auth: true, body }),
      removeSubtitle: sid => YumeAPI._request(`/v1/admin/catalogue/subtitles/${sid}`, { method: 'DELETE', auth: true })
    },

    // metadata synchronisation — coverage, runs, and the id collisions the
    // importers could not resolve on their own
    metadata: {
      status: () => YumeAPI._request('/v1/admin/catalogue/metadata', { auth: true }),
      start: body => YumeAPI._request('/v1/admin/catalogue/metadata/runs', { method: 'POST', auth: true, body }),
      cancel: id => YumeAPI._request(`/v1/admin/catalogue/metadata/runs/${id}/cancel`, { method: 'POST', auth: true, body: {} }),
      conflicts: () => YumeAPI._request('/v1/admin/catalogue/metadata/conflicts', { auth: true }),
      resolveConflict: (id, resolution) =>
        YumeAPI._request(`/v1/admin/catalogue/metadata/conflicts/${id}/resolve`, { method: 'POST', auth: true, body: { resolution } })
    },

    // themes — the colours viewers may choose from
    themes: {
      list: () => YumeAPI._request('/v1/admin/themes', { auth: true }),
      create: body => YumeAPI._request('/v1/admin/themes', { method: 'POST', auth: true, body }),
      update: (id, body) => YumeAPI._request(`/v1/admin/themes/${id}`, { method: 'PATCH', auth: true, body }),
      remove: id => YumeAPI._request(`/v1/admin/themes/${id}`, { method: 'DELETE', auth: true })
    },

    // error triage — list groups, open one for its stack, change its status
    errors: (status = 'open') => YumeAPI._request(`/v1/admin/errors?status=${status}&limit=100`, { auth: true }),
    error: id => YumeAPI._request(`/v1/admin/errors/${id}`, { auth: true }),
    // Look up the failure a user is quoting. The 500 they saw told them to
    // quote the request id; this is where it is quoted to.
    errorByRequest: requestId =>
      YumeAPI._request(`/v1/admin/errors/by-request/${encodeURIComponent(requestId)}`, { auth: true }),
    setErrorStatus: (id, status) => YumeAPI._request(`/v1/admin/errors/${id}`, { method: 'PATCH', auth: true, body: { status } }),

    // Emergency controls. Each switch has an enforcement point in the server
    // and the GET says which — see apps/api/src/modules/security/routes.ts.
    security: () => YumeAPI._request('/v1/admin/security', { auth: true }),
    // The posture: every entry inspects something and says what it found.
    posture: () => YumeAPI._request('/v1/admin/security/posture', { auth: true }),
    // A sebességkorlátok átírása. Ugyanaz a jogosultság, ami a
    // vészkapcsolókat is nyitja, és ugyanúgy auditált.
    setRateLimits: body => YumeAPI._request('/v1/admin/security/limits', { method: 'PATCH', auth: true, body }),
    setControl: (key, value, reason) =>
      YumeAPI._request(`/v1/admin/security/${encodeURIComponent(key)}`, {
        method: 'POST', auth: true, body: { value, reason }
      }),
    revokeAllSessions: reason =>
      YumeAPI._request('/v1/admin/security/revoke-all-sessions', {
        method: 'POST', auth: true, body: { reason }
      }),

    // audit trail — who changed what, and when
    audit: ({ subjectType, subjectId, actorId, actor, action, since, limit = 50, offset = 0 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (subjectType) params.set('subjectType', subjectType)
      if (subjectId) params.set('subjectId', subjectId)
      if (actorId) params.set('actorId', actorId)
      if (actor) params.set('actor', actor)
      if (action) params.set('action', action)
      if (since) params.set('since', since)
      return YumeAPI._request('/v1/admin/audit?' + params.toString(), { auth: true })
    },

    /**
     * The code audit — findings, severities, and where each one lives.
     *
     * A different thing from `audit` above, which is the trail of what people
     * did. The route is /audit/report rather than /audit because that name was
     * already this one's; see YUME-AUDIT-0013.
     *
     * Deliberately not caught here. The page has to be able to tell "no report
     * has been generated" (503) from "the report is not readable" (500) from
     * "you may not see this" (404), and it renders a different thing for each,
     * so swallowing the failure into an empty result would be the one outcome
     * a page like this must never produce.
     */
    auditReport: () => YumeAPI._request('/v1/admin/audit/report', { auth: true })
  }
}

// The namespaces above call back into the object that holds them. Assigning it
// here rather than reaching for a bare `YumeAPI` inside each method keeps them
// usable if one is ever pulled out on its own, and avoids every method
// depending on the module's own binding still being in scope.
for (const namespace of [YumeAPI.profile, YumeAPI.forum, YumeAPI.chat, YumeAPI.changelog]) namespace._api = YumeAPI
