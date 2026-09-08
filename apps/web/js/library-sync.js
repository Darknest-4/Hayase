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
    await this.pullResume()
    await this.pullFavourites()
    if (changed) window.dispatchEvent(new CustomEvent('library-synced'))
  },

  /**
   * Bring the account's favourites down.
   *
   * Union rather than replace. Two devices with different favourites are two
   * halves of one person's list, not a conflict to resolve — and picking a
   * winner would silently delete whichever half was older. Anything only the
   * browser knows about is pushed back up so the two ends converge.
   */
  async pullFavourites () {
    let rows
    try { ({ data: rows } = await this._req('/v1/me/favorites')) } catch (e) { return }
    if (!Array.isArray(rows)) return

    const remote = new Set(rows.map(r => Number(r.anilist_id)).filter(Boolean))
    const local = new Set(Store.favourites().map(Number))

    this._muted = true
    try {
      Store.setFavourites([...new Set([...remote, ...local])])
    } finally {
      this._muted = false
    }

    // Push what only this browser had. Deliberately after the merge, so a
    // failure here leaves the viewer with the complete list either way.
    for (const id of local) {
      if (!remote.has(id)) this.onFavourite(id, true)
    }
  },

  /**
   * Bring back where each episode was left off.
   *
   * The library pull restored *which* episode you were on and never the
   * position inside it, so opening the same episode on a second device
   * started from zero. `/v1/me/continue-watching` has always returned exactly
   * this and nothing called it — the resume map was written to the server and
   * never read back.
   *
   * Only fills gaps: a local position always wins. It is either newer than
   * what the server knows, or it is the same position, and overwriting a
   * live playback position from a background sync is how a viewer gets
   * yanked backwards mid-episode.
   */
  async pullResume () {
    let rows
    try { ({ data: rows } = await this._req('/v1/me/continue-watching')) } catch (e) { return }
    if (!Array.isArray(rows) || !rows.length) return

    // The server keys on its own anime UUIDs; the client keys on AniList ids.
    // The library rows just pulled are the mapping, so this costs no request.
    this._muted = true
    try {
      for (const row of rows) {
        const anilistId = Number(row.anilist_id)
        const episode = Number(row.episode)
        const seconds = Number(row.position_sec)
        if (!anilistId || !episode || !(seconds > 5)) continue
        if (Store.getResume(anilistId, episode)) continue // a local position wins
        Store.setResume(anilistId, episode, seconds)
      }
    } finally {
      this._muted = false
    }
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
  //
  // `durationSec` is sent alongside the position because the server needs it
  // to make sense of one: 400 seconds into a 24-minute episode and 400 into a
  // 2-hour film are not the same progress. It was never sent, which is also
  // why the server's own completion rule could never fire.
  onResume (media, episode, seconds, meta = {}) {
    if (this._muted || !this.enabled() || !media || seconds <= 5) return
    this._debounce(`resume:${media.id}:${episode}`, async () => {
      try {
        const episodeId = await this._episodeId(media, episode)
        if (!episodeId) return
        await this._req(`/v1/me/progress/${episodeId}`, {
          method: 'PATCH',
          body: {
            positionSec: Math.floor(seconds),
            ...(Number.isFinite(meta.durationSec) && meta.durationSec > 0 ? { durationSec: Math.floor(meta.durationSec) } : {})
          }
        })
      } catch (e) { /* stub anime without episode rows, or offline */ }
    }, 4000)
  },

  /**
   * An episode was actually watched — the measured verdict, not a position.
   *
   * Sent immediately rather than through the debounce: this is the last thing
   * that happens before somebody closes the tab, and it is the only event that
   * writes history and XP on the server. A 4-second wait would lose it exactly
   * when it matters.
   */
  onEpisodeCompleted (media, episode, seconds, durationSec) {
    if (this._muted || !this.enabled() || !media) return
    // Cancel a pending resume for the same episode: it carries an older
    // position and no verdict, and arriving second it would say less.
    const key = `resume:${media.id}:${episode}`
    if (this._timers[key]) { clearTimeout(this._timers[key]); delete this._timers[key] }

    return (async () => {
      try {
        const episodeId = await this._episodeId(media, episode)
        if (!episodeId) return
        await this._req(`/v1/me/progress/${episodeId}`, {
          method: 'PATCH',
          body: {
            positionSec: Math.floor(seconds),
            ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationSec: Math.floor(durationSec) } : {}),
            completed: true
          }
        })
      } catch (e) { /* offline, or an anime with no episode rows yet */ }
    })()
  },

  /**
   * A favourite was added or removed locally.
   *
   * Debounced per title: the star is a toggle, and somebody who taps it twice
   * should cost one request carrying the final state, not two racing ones.
   */
  onFavourite (mediaId, added) {
    if (this._muted || !this.enabled() || !mediaId) return
    this._debounce(`fav:${mediaId}`, async () => {
      try {
        // Never create a catalogue row from here: this path knows the id and
        // nothing else, so a stub made from it would be titled "Unknown". The
        // library push resolves with the full media object; a favourite on a
        // title that is not in the catalogue yet simply waits for that.
        const uuid = await YumeAPI.yumeAnimeId({ id: mediaId }, { create: false })
        if (!uuid) return
        await this._req(`/v1/me/favorites/${uuid}`, { method: added ? 'PUT' : 'DELETE' })
      } catch (e) { /* offline, or a title with no catalogue row yet */ }
    }, 600)
  },

  /**
   * The account's own numbers, computed on the server from watch history.
   *
   * Returns null when signed out, offline, or when the server has nothing —
   * every caller falls back to the browser's own tally, which is what it used
   * before this existed.
   */
  async stats () {
    if (!this.enabled()) return null
    try {
      const row = await this._req('/v1/me/stats')
      return row && typeof row === 'object' ? row : null
    } catch (e) {
      return null
    }
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
