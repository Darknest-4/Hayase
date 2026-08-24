/* global window, localStorage, YumeAPI, Store */
// Viewer preferences on the client.
//
// Same shape as the server's lib/preferences.ts, and the same storage story as
// the rest of this client: localStorage is the source of truth for reading, so
// the site works signed out and offline, and the server is mirrored to when an
// account is present. Nothing here blocks a render waiting for the network.
//
// Per profile, matching Store's existing namespacing — a household can have a
// Hungarian child profile and an English adult profile on one login.
//
// ---------------------------------------------------------------------------
// About the duplicated defaults
// ---------------------------------------------------------------------------
// DEFAULTS below repeats what server/src/lib/preferences.ts declares. That
// duplication is deliberate: the client has to answer `Prefs.get()` before it
// has ever spoken to a server, so it cannot wait for the spec to arrive. It is
// pinned by web/test/prefs.test.mjs, which reads the server file and asserts
// the two agree — so they can be wrong together but never drift apart quietly.

const Prefs = {
  STORAGE_KEY: 'yume-prefs',

  DEFAULTS: {
    'language.ui': 'hu',
    'language.titles': 'romaji',
    'language.content': 'hu',
    'content.adult': false,
    'playback.variant': 'sub',
    'playback.subtitles': 'hu',
    'playback.audio': 'ja',
    'notifications.episodes': true
  },

  /** Allowed values, mirrored for the same reason as DEFAULTS. */
  VALUES: {
    'language.ui': ['hu', 'en'],
    'language.titles': ['romaji', 'english', 'hungarian', 'native'],
    'language.content': ['hu', 'en'],
    'playback.variant': ['sub', 'dub', 'any'],
    'playback.subtitles': ['hu', 'en', 'off'],
    'playback.audio': ['ja', 'hu', 'en']
  },

  /** Spec from the server. Drives the settings screen and the wizard. */
  _spec: null,

  /**
   * The preference spec, from whichever source has it.
   *
   * GET /v1/config carries it and is public, so this answers for a signed-out
   * viewer too; the authenticated settings endpoint returns the same list and
   * fills _spec on sign-in. Without this the wizard rendered raw keys like
   * `content.adult` as labels for anyone who was not signed in.
   */
  get spec () {
    return this._spec ?? window.App?.config?.preferences ?? null
  },

  set spec (value) {
    this._spec = value
  },

  _cache: null,
  _listeners: new Set(),

  // ---------------------------------------------------------------- storage

  _key () {
    return `${this.STORAGE_KEY}::${Store.activeProfileId()}`
  },

  _read () {
    try {
      return JSON.parse(localStorage.getItem(this._key()) ?? '{}') ?? {}
    } catch (e) {
      return {}
    }
  },

  _write (values) {
    try {
      localStorage.setItem(this._key(), JSON.stringify(values))
    } catch (e) { /* storage full or unavailable — preferences are not worth throwing over */ }
  },

  // ---------------------------------------------------------------- reading

  /** Coerce one value, falling back to the default. Mirrors the server. */
  coerce (key, value) {
    if (!(key in this.DEFAULTS)) return undefined
    const allowed = this.VALUES[key]
    if (allowed) return allowed.includes(value) ? value : this.DEFAULTS[key]
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return this.DEFAULTS[key]
  },

  /** Every preference, defaults filled in. */
  all () {
    if (this._cache) return this._cache
    const stored = this._read()
    const out = { ...this.DEFAULTS }
    for (const [key, value] of Object.entries(stored)) {
      const coerced = this.coerce(key, value)
      if (coerced !== undefined) out[key] = coerced
    }
    this._cache = out
    return out
  },

  get (key) {
    return this.all()[key]
  },

  /** The interface language — the one read often enough to deserve a name. */
  language () {
    return this.get('language.ui')
  },

  /**
   * Has this profile been through onboarding?
   *
   * The question is "does this profile have a language preference", not "did
   * this account just register". Those differ exactly where it matters: an
   * account created before this feature existed, or a registration finished on
   * another device, both need the wizard and neither is a fresh registration.
   */
  onboarded () {
    try {
      return localStorage.getItem(`${this.STORAGE_KEY}-onboarded::${Store.activeProfileId()}`) === '1'
    } catch (e) {
      return true // storage unavailable: never trap the viewer in a wizard
    }
  },

  markOnboarded () {
    try {
      localStorage.setItem(`${this.STORAGE_KEY}-onboarded::${Store.activeProfileId()}`, '1')
    } catch (e) { /* ignore */ }
  },

  // ---------------------------------------------------------------- writing

  /**
   * Set one or more preferences. Local first so the UI reacts immediately;
   * the server write is best-effort and never blocks.
   */
  set (patch, { sync = true } = {}) {
    const stored = this._read()
    const changed = {}
    for (const [key, value] of Object.entries(patch)) {
      const coerced = this.coerce(key, value)
      if (coerced === undefined) continue
      if (stored[key] !== coerced) changed[key] = coerced
      stored[key] = coerced
    }
    if (!Object.keys(changed).length) return {}

    this._write(stored)
    this._cache = null
    this._emit(changed)
    if (sync) this.push(changed).catch(() => {})
    return changed
  },

  /** Restore defaults for this profile. */
  reset () {
    this._write({})
    this._cache = null
    this._emit(this.DEFAULTS)
    if (window.YumeAPI?.user()) {
      this._req('/v1/me/settings', { method: 'DELETE' }).catch(() => {})
    }
  },

  // ---------------------------------------------------------------- events

  /** Called whenever a preference changes; returns an unsubscribe function. */
  onChange (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  },

  _emit (changed) {
    for (const fn of this._listeners) {
      try {
        fn(changed)
      } catch (e) {
        // one broken listener must not stop the others, or a settings change
        // half-applies across the UI
        console.warn('[prefs] listener failed:', e)
      }
    }
  },

  // ---------------------------------------------------------------- server

  _serverProfileId () {
    try {
      return localStorage.getItem('yume-db-profile')
    } catch (e) {
      return null
    }
  },

  _req (path, opts = {}) {
    const profileId = this._serverProfileId()
    if (!profileId) return Promise.reject(new Error('no server profile'))
    return YumeAPI._request(path, {
      auth: true,
      ...opts,
      headers: { 'X-Profile-Id': profileId, ...(opts.headers ?? {}) }
    })
  },

  /**
   * Pull the account's stored preferences and adopt them.
   *
   * Called on sign-in. The server wins here because it represents a choice the
   * viewer made — possibly on another device — while the local values may be
   * nothing more than untouched defaults.
   */
  async pull () {
    if (!window.YumeAPI?.user()) return null
    try {
      const { settings, onboarding, spec } = await this._req('/v1/me/settings')
      if (Array.isArray(spec)) this.spec = spec
      if (settings) {
        this._write(settings)
        this._cache = null
        this._emit(settings)
      }
      if (onboarding?.done) this.markOnboarded()
      return { settings, onboarding }
    } catch (e) {
      return null
    }
  },

  /** Mirror a change up. Failures are silent — the local value already applied. */
  async push (settings, onboarding) {
    if (!window.YumeAPI?.user()) return
    try {
      const body = { settings }
      if (onboarding) body.onboarding = onboarding
      await this._req('/v1/me/settings', { method: 'PATCH', body })
    } catch (e) { /* best effort, exactly like library sync */ }
  },

  // ---------------------------------------------------------------- bootstrap

  /**
   * First-visit language guess.
   *
   * The wizard shows this pre-selected, which turns the question into a
   * confirmation for the overwhelming majority — a Hungarian browser gets
   * Hungarian already chosen and the step is one click.
   */
  guessLanguage () {
    const tags = [window.navigator?.language, ...(window.navigator?.languages ?? [])]
    for (const tag of tags) {
      if (typeof tag !== 'string') continue
      const base = tag.toLowerCase().split('-')[0]
      if (this.VALUES['language.ui'].includes(base)) return base
    }
    // No usable signal: this is a Hungarian site, so Hungarian is the guess.
    return this.DEFAULTS['language.ui']
  }
}

if (typeof window !== 'undefined') window.Prefs = Prefs
if (typeof module !== 'undefined' && module.exports) module.exports = Prefs
