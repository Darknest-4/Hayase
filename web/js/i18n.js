/* global window, document */
// Translation for a framework-free client.
//
// ---------------------------------------------------------------------------
// The key is the English string
// ---------------------------------------------------------------------------
//   T('Start Watching')  →  'Megnézem'
//
// Not an invented identifier like `watch.start.button`. Three reasons, and the
// first is the one that decided it:
//
//   1. A missing translation renders the key, which IS the English text. There
//      is no state where the interface shows `watch.start.button` or an empty
//      button — the worst case is exactly today's behaviour. That makes the
//      migration safe to do one page at a time with the site live throughout.
//   2. No naming scheme to invent, agree on, or keep tidy as pages move.
//   3. The call site reads as the sentence it renders, so a translator and a
//      developer are looking at the same thing.
//
// The cost is real and worth stating: two different meanings that share an
// English spelling collide. `T(text, context)` is the escape hatch, used only
// where a collision actually exists rather than pre-emptively everywhere.
//
//   T('Home', 'nav')  →  looks up 'Home' + NUL + 'nav', falls back to 'Home'
//
// And an English string edited in place silently orphans its translation.
// web/test/i18n.test.mjs lists orphans so that stays visible.

const I18n = {
  /** Registered dictionaries: { hu: { 'Start Watching': 'Megnézem' } } */
  _dicts: Object.create(null),

  /** Current language. Kept here rather than read from Prefs on every T(). */
  _lang: 'hu',

  /**
   * Separator between a key and its context.
   *
   * NUL, written as an escape rather than as a literal byte: a literal one is
   * invisible in an editor and survives copy-paste only by luck. A printable
   * separator such as a space would collide with a genuine key — 'Home nav'
   * is a plausible English string in its own right.
   */
  CONTEXT_SEP: '\u0000',

  /**
   * Locales for date and number formatting.
   *
   * The client used to pass `undefined`, which means "whatever the browser is
   * set to" — so a viewer who chose Hungarian still got English dates. The
   * chosen language has to be passed explicitly for the choice to mean
   * anything.
   */
  LOCALES: { hu: 'hu-HU', en: 'en-GB' },

  // ---------------------------------------------------------------- registry

  /** Called by web/i18n/<lang>.js at load time. */
  register (lang, entries) {
    this._dicts[lang] = Object.assign(this._dicts[lang] ?? Object.create(null), entries)
  },

  dictionary (lang) {
    return this._dicts[lang] ?? null
  },

  // ---------------------------------------------------------------- language

  language () {
    return this._lang
  },

  locale () {
    return this.LOCALES[this._lang] ?? this.LOCALES.hu
  },

  /**
   * Switch language. Updates <html lang> because screen readers and the
   * browser's own spell-checker read it, and it was hardcoded to "en".
   */
  setLanguage (lang) {
    if (!this._dicts[lang] && lang !== 'en') return this._lang
    this._lang = lang
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', lang)
    }
    return this._lang
  },

  // ---------------------------------------------------------------- lookup

  /**
   * Translate. `key` is the English source text.
   *
   * Never throws and never returns empty: a translation layer that can break
   * the interface is worse than no translation layer.
   */
  t (key, context) {
    if (typeof key !== 'string' || !key) return key ?? ''
    const dict = this._dicts[this._lang]
    if (!dict) return key
    if (context) {
      const scoped = dict[key + this.CONTEXT_SEP + context]
      if (typeof scoped === 'string' && scoped) return scoped
    }
    const hit = dict[key]
    return typeof hit === 'string' && hit ? hit : key
  },

  /**
   * Translate with substitutions:
   *   I18n.f('Episode {n}', { n: 4 })  →  '4. rész'
   *
   * Placeholders are named, not positional, because word order differs
   * between the two languages and a positional format string would force the
   * Hungarian translation to keep the English order.
   */
  f (key, values = {}, context) {
    return this.t(key, context).replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
    )
  },

  // ---------------------------------------------------------------- formatting

  date (value, options = { year: 'numeric', month: 'short', day: 'numeric' }) {
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(this.locale(), options)
  },

  time (value, options = { hour: '2-digit', minute: '2-digit' }) {
    const d = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString(this.locale(), options)
  },

  number (value) {
    return Number(value ?? 0).toLocaleString(this.locale())
  },

  // ---------------------------------------------------------------- bootstrap

  /**
   * Adopt the viewer's stored language and follow it afterwards.
   *
   * Re-rendering is handed in rather than reached for, so this module has no
   * opinion about the router and stays testable without one.
   */
  init (onLanguageChange) {
    const prefs = window.Prefs
    if (prefs) {
      this.setLanguage(prefs.language())
      prefs.onChange(changed => {
        if (!('language.ui' in changed)) return
        this.setLanguage(changed['language.ui'])
        if (typeof onLanguageChange === 'function') onLanguageChange(this._lang)
      })
    }
    return this._lang
  }
}

/**
 * The single text lookup for the whole client.
 *
 * It serves two call styles, because the codebase already had both and
 * running two parallel text systems would be worse than serving both here:
 *
 *   T('nav.community')   a dotted path into web/copy.js — the pre-existing
 *                        central copy catalog. Resolved to its English string
 *                        first, then translated.
 *   T('Start Watching')  an English source string, translated directly.
 *
 * A dotted key that is not in the catalog falls through to the second form,
 * so neither style can shadow the other by accident.
 *
 * `fallback` is kept from the original signature: callers pass it to supply a
 * default when a catalog key is missing.
 */
function T (key, fallbackOrContext) {
  const fromCatalog = typeof key === 'string' && key.includes('.')
    ? String(key).split('.').reduce((o, k) => (o == null ? undefined : o[k]), (typeof window !== 'undefined' ? window.Copy : undefined))
    : undefined

  if (typeof fromCatalog === 'string') return I18n.t(fromCatalog)

  // Not a catalog hit. Treat the key as English source text; a second argument
  // is a context for disambiguation, or a fallback for a missing catalog key.
  const translated = I18n.t(key, fallbackOrContext)
  if (translated !== key) return translated
  return fromCatalog ?? (typeof fallbackOrContext === 'string' && key.includes('.') ? fallbackOrContext : translated)
}

if (typeof window !== 'undefined') {
  window.I18n = I18n
  window.T = T
}
if (typeof module !== 'undefined' && module.exports) module.exports = { I18n, T }
