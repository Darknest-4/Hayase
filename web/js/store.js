/* global window, localStorage, U */
// Local persistence: anime list, favourites, watch progress and settings.
// This mirrors the "local" auth provider of the original app — everything
// is stored in localStorage so the site works without any account.

const Store = {
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

  // ---- settings ----

  settings () {
    return this._read('settings', { theme: 'default', nsfw: false, titleLang: 'userPreferred' })
  },

  saveSettings (patch) {
    this._write('settings', { ...this.settings(), ...patch })
  },

  // ---- anime list ----
  // entries: { [mediaId]: { status, progress, score, updatedAt, media: <snapshot> } }

  list () {
    return this._read('animelist', {})
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
    this._write('animelist', list)
    return list[media.id]
  },

  removeEntry (mediaId) {
    const list = this.list()
    delete list[mediaId]
    this._write('animelist', list)
  },

  setProgress (media, progress) {
    const total = media.episodes
    progress = Math.max(0, total ? Math.min(progress, total) : progress)
    const entry = this.entry(media.id)
    let status = entry?.status ?? 'CURRENT'
    if (total && progress >= total) status = 'COMPLETED'
    else if (status === 'COMPLETED' || status === 'PLANNING') status = 'CURRENT'
    return this.saveEntry(media, { progress, status })
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
    return this._read('favourites', [])
  },

  isFavourite (mediaId) {
    return this.favourites().includes(mediaId)
  },

  toggleFavourite (mediaId) {
    const favs = this.favourites()
    const index = favs.indexOf(mediaId)
    if (index === -1) favs.push(mediaId)
    else favs.splice(index, 1)
    this._write('favourites', favs)
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
