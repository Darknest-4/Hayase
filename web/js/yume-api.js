/* global window, fetch, localStorage */
// Yume backend adapter. The client works standalone (AniList/Jikan direct),
// but when a Yume API is reachable it powers platform features: accounts,
// comments/community and the extension store.
// Configure the endpoint in Settings; default assumes local development.

const YumeAPI = {
  base () {
    return localStorage.getItem('yume-api') ?? 'http://localhost:4000'
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

  _saveTokens (tokens) {
    if (tokens) localStorage.setItem('yume-auth', JSON.stringify(tokens))
    else localStorage.removeItem('yume-auth')
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

  async _request (path, { method = 'GET', body, auth = false, retry = true } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    if (auth) {
      const tokens = this._tokens()
      if (!tokens) throw new Error('Sign in to your Yume account first')
      headers.Authorization = 'Bearer ' + tokens.accessToken
    }

    const res = await fetch(this.base() + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })

    // expired access token → refresh once and retry
    if (res.status === 401 && auth && retry && this._tokens()?.refreshToken) {
      await this._refresh()
      return this._request(path, { method, body, auth, retry: false })
    }

    if (res.status === 204) return null
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.detail ?? json?.title ?? `API ${res.status}`)
    return json
  },

  async _refresh () {
    const tokens = this._tokens()
    if (!tokens?.refreshToken) throw new Error('Not signed in')
    try {
      const fresh = await this._request('/v1/auth/refresh', { method: 'POST', body: { refreshToken: tokens.refreshToken } })
      this._saveTokens(fresh)
    } catch (e) {
      this._saveTokens(null) // refresh token rejected → signed out
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
    const tokens = await this._request('/v1/auth/register', { method: 'POST', body: { email, username, password } })
    this._saveTokens(tokens)
    this._perms = null
    return this.user()
  },

  async login (identifier, password) {
    const tokens = await this._request('/v1/auth/login', { method: 'POST', body: { identifier, password } })
    this._saveTokens(tokens)
    this._perms = null
    return this.user()
  },

  async logout () {
    this._perms = null
    const tokens = this._tokens()
    if (tokens) {
      await this._request('/v1/auth/logout', { method: 'POST', body: { refreshToken: tokens.refreshToken }, auth: true }).catch(() => {})
    }
    this._saveTokens(null)
  },

  // ---- catalogue bridge (AniList id → Yume id) ----

  _resolveCache: {},

  async yumeAnimeId (media, { create = false } = {}) {
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

  admin: {
    users: (query, status) => {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (status) params.set('status', status)
      return YumeAPI._request('/v1/admin/users?' + params.toString(), { auth: true })
    },
    setUserStatus: (id, status, reason) =>
      YumeAPI._request(`/v1/admin/users/${id}/status`, { method: 'POST', auth: true, body: { status, reason } }),
    reports: (status = 'open') =>
      YumeAPI._request(`/v1/admin/reports?status=${status}`, { auth: true }),
    resolveReport: (id, action, reason) =>
      YumeAPI._request(`/v1/admin/reports/${id}/resolve`, { method: 'POST', auth: true, body: { action, reason } }),
    overview: () =>
      YumeAPI._request('/v1/admin/analytics/overview', { auth: true })
  },

  // ---- extension store ----

  extensions (type, sort = 'installs') {
    const params = new URLSearchParams({ sort })
    if (type) params.set('type', type)
    return this._request('/v1/extensions?' + params.toString())
  },

  extension (slug) {
    return this._request('/v1/extensions/' + encodeURIComponent(slug))
  }
}

window.YumeAPI = YumeAPI
