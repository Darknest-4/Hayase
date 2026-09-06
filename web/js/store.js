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
      duration: media.duration,
      averageScore: media.averageScore,
      genres: media.genres ?? [],
      studios: media.studios ? { nodes: (media.studios.nodes ?? []).slice(0, 1) } : undefined,
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
    window.LibrarySync?.onEntry(media, list[media.id]) // mirror to the account when signed in
    return list[media.id]
  },

  removeEntry (mediaId) {
    const list = this.list()
    delete list[mediaId]
    this._write(this._profileKey('animelist'), list)
    window.LibrarySync?.onRemove(mediaId)
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

  // ---- per-profile resume positions (seconds), keyed "mediaId:episode" ----

  _resumeMap () {
    return this._read(this._profileKey('resume'), {})
  },

  getResume (mediaId, episode) {
    return Number(this._resumeMap()[`${mediaId}:${episode}`]) || 0
  },

  // `meta` carries what the server needs to interpret the position — the
  // episode's runtime. Optional, because a caller that does not know it (a
  // list screen marking progress) should still be able to save one.
  setResume (mediaId, episode, seconds, meta = {}) {
    const map = this._resumeMap()
    const key = `${mediaId}:${episode}`
    if (seconds > 5) map[key] = Math.floor(seconds)
    else delete map[key]
    this._write(this._profileKey('resume'), map)
    if (seconds > 5) window.LibrarySync?.onResume({ id: mediaId }, episode, seconds, meta)
  },

  clearResume (mediaId, episode) {
    const map = this._resumeMap()
    delete map[`${mediaId}:${episode}`]
    this._write(this._profileKey('resume'), map)
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

  // ---- notifications ----
  // Per-profile notification inbox. Some notifications are *generated* from
  // local state (airing episodes, stalled continue-watching, achievement
  // unlocks) with stable ids so their read/dismissed flags survive re-sync;
  // read/dismissed state is stored separately keyed by notification id.

  _notifState () {
    return this._read(this._profileKey('notif-state'), { read: {}, dismissed: {}, seenAch: null })
  },

  _saveNotifState (state) {
    this._write(this._profileKey('notif-state'), state)
  },

  // regenerate the notification set from current local data, preserving flags
  syncNotifications () {
    const state = this._notifState()
    const now = Date.now()
    const items = []

    // 1) airing episodes for anime in the library
    for (const entry of Object.values(this.list())) {
      const media = entry.media
      const air = media?.nextAiringEpisode
      if (!air?.airingAt) continue
      const at = air.airingAt * 1000
      const soon = at - now < 3 * 86400000 // within 3 days (future) …
      const recent = now - at < 2 * 86400000 // … or aired in the last 2 days
      if (!soon && !recent) continue
      const future = at > now
      items.push({
        id: `airing:${media.id}:${air.episode}`,
        type: 'airing',
        icon: '📺',
        title: U.title(media),
        body: future ? `Episode ${air.episode} airs ${U.relTime(new Date(at))}` : `Episode ${air.episode} just aired`,
        mediaId: media.id,
        href: `#/anime/${media.id}`,
        at
      })
    }

    // 2) stalled "continue watching" — started but untouched for 10+ days
    for (const entry of Object.values(this.list())) {
      if (entry.status !== 'CURRENT' && entry.status !== 'REPEATING') continue
      if (!entry.progress) continue
      const idle = now - (entry.updatedAt ?? now)
      if (idle < 10 * 86400000) continue
      items.push({
        id: `resume:${entry.media.id}:${entry.progress}`,
        type: 'resume',
        icon: '⏳',
        title: entry.media && U.title(entry.media),
        body: `You left off at episode ${entry.progress} — pick it back up?`,
        mediaId: entry.media.id,
        href: `#/watch/${entry.media.id}:${entry.progress + 1}`,
        at: entry.updatedAt ?? now
      })
    }

    // 3) achievement unlocks (diff against last-seen snapshot)
    if (window.PageAchievements) {
      const unlocked = window.PageAchievements.unlockedSlugs()
      const seen = state.seenAch
      for (const slug of unlocked) {
        const meta = window.PageAchievements.meta(slug)
        if (!meta) continue
        // once seen, keep showing as a (read) notification so the log persists
        items.push({
          id: `ach:${slug}`,
          type: 'achievement',
          icon: meta.icon,
          title: 'Achievement unlocked',
          body: `${meta.name} — ${meta.desc}`,
          href: '#/achievements',
          at: now,
          // brand-new unlocks (not in the previous snapshot) start unread
          fresh: seen !== null && !seen.includes(slug)
        })
      }
      state.seenAch = unlocked
      this._saveNotifState(state)
    }

    // honour per-type notification preferences (Settings › Notifications)
    const prefs = this.settings().notifPrefs ?? { airing: true, resume: true, achievement: true }

    // apply persisted read/dismissed flags
    return items
      .filter(n => prefs[n.type] !== false)
      .filter(n => !state.dismissed[n.id])
      .map(n => ({ ...n, read: n.fresh ? false : (state.read[n.id] ?? n.type === 'achievement') }))
      .sort((a, b) => b.at - a.at)
  },

  unreadCount () {
    return this.syncNotifications().filter(n => !n.read).length
  },

  markNotificationRead (id) {
    const state = this._notifState()
    state.read[id] = true
    this._saveNotifState(state)
  },

  markAllNotificationsRead () {
    const state = this._notifState()
    for (const n of this.syncNotifications()) state.read[n.id] = true
    this._saveNotifState(state)
  },

  dismissNotification (id) {
    const state = this._notifState()
    state.dismissed[id] = true
    this._saveNotifState(state)
  },

  clearNotifications () {
    const state = this._notifState()
    for (const n of this.syncNotifications()) state.dismissed[n.id] = true
    this._saveNotifState(state)
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
    const added = index === -1
    if (added) favs.push(mediaId)
    else favs.splice(index, 1)
    this._write(this._profileKey('favourites'), favs)
    // Favourites used to live in one browser and nowhere else — the only part
    // of the library that did not follow the account to a second device.
    window.LibrarySync?.onFavourite(mediaId, added)
    return added
  },

  /** Replace the favourites list wholesale — used by the sync pull. */
  setFavourites (ids) {
    this._write(this._profileKey('favourites'), [...new Set(ids)])
  },

  // ---- theme ----

  /**
   * A colour, and nothing that is not a colour.
   *
   * The values written here come from the site's theme table, which validates
   * them on the way in — but they travel through localStorage, and a custom
   * property is interpolated into a <style> element. Checking again where the
   * string is used costs a regex and removes the question.
   */
  _isColour (value) {
    if (typeof value !== 'string') return false
    const colour = value.trim()
    if (!colour || colour.length > 140 || /[;{}<>\\@]/.test(colour)) return false
    return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(colour) ||
      /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%,\s/+-]{1,120}\)$/i.test(colour) ||
      /^[a-z]{3,20}$/i.test(colour)
  },

  applyTheme () {
    // Theme engine: a base (dark | light) plus an optional custom accent.
    // dark is the :root default, light is [data-theme='light']. Legacy
    // saved values ('default'/'catppuccin' -> dark, 'light' -> light base).
    const s = this.settings()
    const base = s.themeBase ?? (s.theme === 'light' ? 'light' : 'dark')
    if (base === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')

    // accent + surface tint overrides via a single injected <style>
    let style = document.getElementById('theme-overrides')
    if (!style) {
      style = document.createElement('style')
      style.id = 'theme-overrides'
      document.head.append(style)
    }
    const rules = []
    if (s.themeAccent) {
      rules.push(`--accent:${s.themeAccent}`)
      rules.push(`--accent-hover:color-mix(in srgb, ${s.themeAccent} 82%, #000)`)
      rules.push(`--accent-soft:color-mix(in srgb, ${s.themeAccent} 14%, transparent)`)
    }
    if (s.themeTint) {
      // subtly tint the raised surfaces toward the accent for a richer look
      rules.push(`--bg-raised:color-mix(in srgb, ${s.themeAccent ?? 'var(--accent)'} 6%, var(--bg))`)
    }
    // Whatever else the chosen theme overrides. Themes used to be able to say
    // one thing — an accent — because that is all an extension returned; a
    // site theme can name any token, which is what a deployment with its own
    // palette needs.
    for (const [name, value] of Object.entries(s.themeTokens ?? {})) {
      if (/^--[a-z][a-z0-9-]{1,40}$/.test(name) && this._isColour(value)) rules.push(`${name}:${value}`)
    }
    style.textContent = rules.length ? `:root, [data-theme='light'] { ${rules.join(';')} }` : ''
  },

  setTheme ({ base, accent, tint, tokens, slug } = {}) {
    const patch = {}
    if (base !== undefined) { patch.themeBase = base; patch.theme = base } // keep legacy key in sync
    if (accent !== undefined) patch.themeAccent = accent || undefined
    if (tint !== undefined) patch.themeTint = tint
    if (tokens !== undefined) patch.themeTokens = tokens && Object.keys(tokens).length ? tokens : undefined
    // Which named theme this is, so the picker can show what is selected and
    // so a viewer who has chosen is not overwritten by a change of default.
    if (slug !== undefined) patch.themeSlug = slug || undefined
    this.saveSettings(patch)
    this.applyTheme()
  },

  /**
   * Has this viewer ever chosen a theme?
   *
   * The site's default applies to everyone who has not. Once somebody has
   * picked, an operator changing the default must not silently repaint their
   * app — that is their choice, not a preference we are free to reset.
   */
  hasChosenTheme () {
    const s = this.settings()
    return Boolean(s.themeSlug || s.themeBase || s.themeAccent || s.theme)
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
