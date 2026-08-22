/* global window, localStorage, YumeAPI, Store */
// Library sync: when signed into a Yume account, mirror the local per-profile
// library (status + episode progress) and resume positions to the server, and
// pull the account's library back on sign-in so it follows the user across
// devices. Everything is best-effort and debounced — the site keeps working
// offline / signed-out, and a failed sync never blocks the UI.
//
// Two id worlds are bridged here:
//   * anime: the client is AniList-id centric; the server keys on Yume UUIDs.
//     YumeAPI.yumeAnimeId(media, {create}) resolves AniList → UUID (caching).
//   * profile: local Store profiles vs the account's user_profiles. Sync uses
//     the account's default server profile (created on first sign-in).

const LibrarySync = {
  // AniList-style client statuses ↔ server library_status enum
  STATUS_TO_DB: { CURRENT: 'WATCHING', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED', REPEATING: 'REWATCHING' },
  STATUS_FROM_DB: { WATCHING: 'CURRENT', PLANNING: 'PLANNING', COMPLETED: 'COMPLETED', PAUSED: 'PAUSED', DROPPED: 'DROPPED', REWATCHING: 'REPEATING' },

  _profileId: null, // server user_profiles.id used for sync
  _muted: false, // true while pulling, so we don't echo writes back
  _timers: {}, // per-key debounce handles
  _epCache: {}, // animeUuid → [{ id, number }] episode lookup cache
  status: 'off', // off | syncing | synced | error (for the Settings UI)

  enabled () {
    return !!(window.YumeAPI?.user() && this._profileId)
  },

  // server request scoped to the sync profile
  _req (path, opts = {}) {
    return YumeAPI._request(path, { auth: true, ...opts, headers: { 'X-Profile-Id': this._profileId, ...(opts.headers ?? {}) } })
  },

  // ---- lifecycle ----

  // resolve (or create) the account's sync profile, then pull the library
  async init () {
    if (!window.YumeAPI?.user()) { this._profileId = null; this.status = 'off'; return }
    this.status = 'syncing'
    try {
      const { data } = await YumeAPI._request('/v1/profiles', { auth: true })
      let profile = data.find(p => p.is_default) ?? data[0]
      if (!profile) {
        const local = Store.activeProfile()
        const emoji = /\p{Emoji}/u.test(local?.avatar ?? '') ? local.avatar : undefined
        profile = await YumeAPI._request('/v1/profiles', { method: 'POST', auth: true, body: { displayName: (local?.name || 'Me').slice(0, 50), avatarEmoji: emoji } })
      }
      this._profileId = profile.id
      localStorage.setItem('yume-db-profile', profile.id)
      await this.pull()
      this.status = 'synced'
    } catch (e) {
      this._profileId = null
      this.status = 'error'
    }
  },

  reset () {
    this._profileId = null
    this._epCache = {}
    this.status = 'off'
    localStorage.removeItem('yume-db-profile')
  },

  // ---- pull: server → local (newest wins) ----

  async pull () {
    if (!this.enabled()) return
    let rows
    try { ({ data: rows } = await this._req('/v1/me/library')) } catch (e) { return }
    this._muted = true
    let changed = false
    try {
      for (const row of rows) {
        if (!row.anilist_id) continue // can't map back to an AniList id → skip
        const id = row.anilist_id
        const local = Store.entry(id)
        const dbAt = new Date(row.updated_at).getTime()
        if (local && (local.updatedAt ?? 0) >= dbAt) continue // local is newer → it wins (and will push)
        const media = local?.media ?? {
          id,
          title: { userPreferred: row.canonical_title },
          coverImage: {},
          format: row.format,
          episodes: row.episode_count
        }
        Store.saveEntry(media, { status: this.STATUS_FROM_DB[row.status] ?? 'PLANNING', progress: Number(row.progress) || 0 })
        changed = true
      }
    } finally {
      this._muted = false
    }
    if (changed) window.dispatchEvent(new CustomEvent('library-synced'))
  },

  // ---- push: local → server (debounced, best-effort) ----

  _debounce (key, fn, ms = 800) {
    clearTimeout(this._timers[key])
    this._timers[key] = setTimeout(fn, ms)
  },

  // a library entry was created/updated locally
  onEntry (media, entry) {
    if (this._muted || !this.enabled() || !media) return
    this._debounce('entry:' + media.id, async () => {
      try {
        const uuid = await YumeAPI.yumeAnimeId(media, { create: true })
        if (!uuid) return
        await this._req(`/v1/me/library/${uuid}`, {
          method: 'PUT',
          body: { status: this.STATUS_TO_DB[entry.status] ?? 'PLANNING', progress: Number(entry.progress) || 0 }
        })
      } catch (e) { /* offline / unresolved — stays local */ }
    })
  },

  // a library entry was removed locally
  onRemove (mediaId) {
    if (this._muted || !this.enabled()) return
    this._debounce('entry:' + mediaId, async () => {
      try {
        const uuid = await YumeAPI.yumeAnimeId({ id: mediaId }, { create: false })
        if (uuid) await this._req(`/v1/me/library/${uuid}`, { method: 'DELETE' })
      } catch (e) { /* nothing on the server yet */ }
    })
  },

  // a resume position was saved locally (fires ~every 5s during playback)
  onResume (media, episode, seconds) {
    if (this._muted || !this.enabled() || !media || seconds <= 5) return
    this._debounce(`resume:${media.id}:${episode}`, async () => {
      try {
        const episodeId = await this._episodeId(media, episode)
        if (!episodeId) return
        await this._req(`/v1/me/progress/${episodeId}`, { method: 'PATCH', body: { positionSec: Math.floor(seconds) } })
      } catch (e) { /* stub anime without episode rows, or offline */ }
    }, 4000)
  },

  // resolve an episode number to its server UUID (cached per anime)
  async _episodeId (media, episode) {
    const uuid = await YumeAPI.yumeAnimeId(media, { create: false })
    if (!uuid) return null
    if (!this._epCache[uuid]) {
      try { const { data } = await YumeAPI._request(`/v1/anime/${uuid}/episodes`); this._epCache[uuid] = data } catch (e) { this._epCache[uuid] = [] }
    }
    return this._epCache[uuid].find(e => Number(e.number) === Number(episode))?.id ?? null
  }
}

window.LibrarySync = LibrarySync
