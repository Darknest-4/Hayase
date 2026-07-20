/* global window, localStorage, U, crypto */
// Local persistence: profiles + per-profile anime list, favourites, watch
// progress, history and settings. Everything is stored in localStorage so
// the site works without any account; when signed into a Yume account the
// profiles sync to the server.
//
// Multiple profiles (Netflix-style): a profile registry ('yume-profiles')
// plus an active profile id ('yume-active'). Every per-profile key is
// namespaced `{key}::{profileId}`. Legacy single-profile data ('animelist',
// 'favourites', 'settings') is migrated into a first "default" profile.

const Store = {
  // ---- raw localStorage helpers ----
  _read (key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (e) {
      return fallback
    }
  },

  _write (key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (e) { /* storage full or unavailable */ }
  },

  // ---- profiles ----

  _profileKey (key) {
    return `${key}::${this.activeProfileId()}`
  },

  profiles () {
    return this._read('yume-profiles', [])
  },

  activeProfileId () {
    return localStorage.getItem('yume-active') ?? this.profiles()[0]?.id ?? 'default'
  },

  activeProfile () {
    const id = this.activeProfileId()
    return this.profiles().find(p => p.id === id) ?? this.profiles()[0] ?? null
  },

  setActiveProfile (id) {
    if (this.profiles().some(p => p.id === id)) localStorage.setItem('yume-active', id)
  },

  createProfile ({ name, avatar, kids = false, nsfw = false } = {}) {
    const profiles = this.profiles()
    const id = (crypto?.randomUUID?.() ?? 'p' + Date.now() + Math.random().toString(36).slice(2))
    const profile = { id, name: (name || 'Profile').slice(0, 50), avatar: avatar ?? null, kids, nsfw, createdAt: Date.now() }
    profiles.push(profile)
    this._write('yume-profiles', profiles)
    return profile
  },

  updateProfile (id, patch) {
    const profiles = this.profiles()
    const p = profiles.find(x => x.id === id)
    if (!p) return
    Object.assign(p, patch)
    this._write('yume-profiles', profiles)
  },

  deleteProfile (id) {
    let profiles = this.profiles()
    if (profiles.length <= 1) return false // never delete the last profile
    profiles = profiles.filter(p => p.id !== id)
    this._write('yume-profiles', profiles)
    // drop that profile's namespaced data
    for (const key of Object.keys(localStorage)) {
      if (key.endsWith('::' + id)) localStorage.removeItem(key)
    }
    if (this.activeProfileId() === id) this.setActiveProfile(profiles[0].id)
    return true
  },

  // one-time migration: wrap any legacy single-profile data into a default profile
  ensureProfiles () {
    if (this.profiles().length) return
    const legacyName = this._read('settings', {})?.profileName ?? 'Dreamer'
    const profile = this.createProfile({ name: legacyName })
    localStorage.setItem('yume-active', profile.id)
    for (const legacyKey of ['animelist', 'favourites', 'settings']) {
      const raw = localStorage.getItem(legacyKey)
      if (raw != null) {
        localStorage.setItem(`${legacyKey}::${profile.id}`, raw)
        localStorage.removeItem(legacyKey)
      }
    }
    // migrate legacy watch positions too
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('watchpos:') && !key.includes('::')) {
        localStorage.setItem(`${key}::${profile.id}`, localStorage.getItem(key))
        localStorage.removeItem(key)
      }
    }
  },

  // ---- settings ----

  settings () {
    return this._read(this._profileKey('settings'), { theme: 'default', nsfw: false, titleLang: 'userPreferred' })
  },

  saveSettings (patch) {
    this._write(this._profileKey('settings'), { ...this.settings(), ...patch })
  },

  // ---- anime list ----
  // entries: { [mediaId]: { status, progress, score, updatedAt, media: <snapshot> } }

  list () {
    return this._read(this._profileKey('animelist'), {})
  },

  entry (mediaId) {
    return this.list()[mediaId]
  },

  // snapshot keeps just enough of the media object to render cards offline
  _snapshot (media) {
    return {
      id: media.id,
      idMal: media.idMal,
      title: media.title,
      coverImage: { large: media.coverImage?.large ?? media.coverImage?.extraLarge },
      bannerImage: media.bannerImage,
      format: media.format,
      status: media.status,
      episodes: media.episodes,
      averageScore: media.averageScore,
      season: media.season,
      seasonYear: media.seasonYear,
      startDate: media.startDate,
      nextAiringEpisode: media.nextAiringEpisode
    }
  },

  saveEntry (media, patch) {
    const list = this.list()
    const prev = list[media.id] ?? { status: 'PLANNING', progress: 0, score: 0 }
    list[media.id] = { ...prev, ...patch, media: this._snapshot(media), updatedAt: Date.now() }
    this._write(this._profileKey('animelist'), list)
    return list[media.id]
  },

  removeEntry (mediaId) {
    const list = this.list()
    delete list[mediaId]
    this._write(this._profileKey('animelist'), list)
  },

  setProgress (media, progress) {
    const total = media.episodes
    progress = Math.max(0, total ? Math.min(progress, total) : progress)
    const entry = this.entry(media.id)
    const before = entry?.progress ?? 0
    let status = entry?.status ?? 'CURRENT'
    if (total && progress >= total) status = 'COMPLETED'
    else if (status === 'COMPLETED' || status === 'PLANNING') status = 'CURRENT'
    const saved = this.saveEntry(media, { progress, status })
    if (progress > before) this.recordHistory(media, progress)
    return saved
  },

  // ---- per-profile watch history ----

  history () {
    return this._read(this._profileKey('history'), [])
  },

  recordHistory (media, episode) {
    const history = this.history()
    // collapse consecutive entries for the same anime
    if (history[0]?.id === media.id) history.shift()
    history.unshift({ id: media.id, episode, at: Date.now(), media: this._snapshot(media) })
    this._write(this._profileKey('history'), history.slice(0, 200))
  },

  clearHistory () {
    this._write(this._profileKey('history'), [])
  },

  // ids of entries being watched, most recently updated first (for "Continue Watching")
  continueIds () {
    return Object.values(this.list())
      .filter(e => e.status === 'CURRENT' || e.status === 'REPEATING')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(e => e.media.id)
  },

  planningIds () {
    return Object.values(this.list())
      .filter(e => e.status === 'PLANNING')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(e => e.media.id)
  },

  // ---- favourites ----

  favourites () {
    return this._read(this._profileKey('favourites'), [])
  },

  isFavourite (mediaId) {
    return this.favourites().includes(mediaId)
  },

  toggleFavourite (mediaId) {
    const favs = this.favourites()
    const index = favs.indexOf(mediaId)
    if (index === -1) favs.push(mediaId)
    else favs.splice(index, 1)
    this._write(this._profileKey('favourites'), favs)
    return index === -1
  },

  // ---- theme ----

  applyTheme () {
    // Yume design tokens: dark is the :root default, light is [data-theme='light'].
    // Older saved values ('default', 'catppuccin') map to dark.
    const { theme } = this.settings()
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  },

  clearCache () {
    // keep user data, drop API caches
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('cache:')) localStorage.removeItem(key)
    }
    U.toast('Cache cleared')
  },

  clearAll () {
    localStorage.clear()
  }
}

window.Store = Store
