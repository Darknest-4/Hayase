/* global window, fetch, localStorage */
// Yume backend adapter. The client works standalone (AniList/Jikan direct),
// but when a Yume API is reachable it powers platform features — today the
// extension store, later auth/library sync.
// Configure the endpoint in Settings; default assumes local development.

const YumeAPI = {
  base () {
    return localStorage.getItem('yume-api') ?? 'http://localhost:4000'
  },

  setBase (url) {
    localStorage.setItem('yume-api', url.replace(/\/+$/, ''))
  },

  async _get (path) {
    const res = await fetch(this.base() + path, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`API ${res.status}`)
    return res.json()
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

  extensions (type, sort = 'installs') {
    const params = new URLSearchParams({ sort })
    if (type) params.set('type', type)
    return this._get('/v1/extensions?' + params.toString())
  },

  extension (slug) {
    return this._get('/v1/extensions/' + encodeURIComponent(slug))
  }
}

window.YumeAPI = YumeAPI
