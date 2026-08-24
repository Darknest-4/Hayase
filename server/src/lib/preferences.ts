// Viewer preferences — one declarative table, and everything else derives.
//
// This is the single source of truth for what a preference is called, what it
// may hold, and what it falls back to. Routes validate against it, the client
// receives it from GET /v1/config and renders its settings screen from it, and
// the onboarding wizard writes into it. Adding a preference is one entry here;
// nothing else has to learn about it.
//
// ---------------------------------------------------------------------------
// Why language is four settings and not one
// ---------------------------------------------------------------------------
// A Hungarian anime viewer typically wants a Hungarian interface and Hungarian
// subtitles — but romaji titles, because that is how the community refers to
// shows. One "Hungarian" switch would take the titles away from them. So the
// axes are independent:
//
//   language.ui        the interface       fully ours, always complete
//   language.titles    which title form    the data mostly exists
//   language.content   synopses            sparse; falls back to English
//   playback.*         subtitles and dub   depends on what a source offers
//
// Everything is a flat scalar. user_settings is a (profile_id, key, value)
// table, so flat keys map onto it directly, and a single preference can be
// patched without read-modify-write on a nested blob.

/** Language tags used across the platform. Kept short deliberately — this is
 *  a Hungarian site with an English fallback, not a general i18n framework. */
export const UI_LANGUAGES = ['hu', 'en'] as const
export type UiLanguage = typeof UI_LANGUAGES[number]

export const DEFAULT_LANGUAGE: UiLanguage = 'hu'

export type PreferenceValue = string | boolean

export interface PreferenceSpec {
  /** Storage key in user_settings, and the key the client patches. */
  key: string
  /** Allowed values. A preference without an enum is a boolean. */
  values?: readonly string[]
  default: PreferenceValue
  /** Shown in the settings UI. Translated client-side via the `T()` key. */
  label: string
  /** Grouping in the settings UI; also the wizard step that offers it. */
  group: 'language' | 'playback' | 'content'
  /** Offered during onboarding. Everything else lives in settings only. */
  onboarding?: boolean
  description?: string
}

export const PREFERENCES: readonly PreferenceSpec[] = [
  {
    key: 'language.ui',
    values: UI_LANGUAGES,
    default: DEFAULT_LANGUAGE,
    label: 'Interface language',
    group: 'language',
    onboarding: true,
    description: 'Buttons, menus and messages.'
  },
  {
    key: 'language.titles',
    // 'hungarian' is included even though almost no Hungarian titles exist
    // yet: the preference is what makes them appear as they are written, and
    // it falls back per title, not per viewer.
    values: ['romaji', 'english', 'hungarian', 'native'],
    default: 'romaji',
    label: 'Title language',
    group: 'content',
    onboarding: true,
    description: 'How show titles are written. Romaji is what most of the community uses.'
  },
  {
    key: 'language.content',
    values: UI_LANGUAGES,
    default: DEFAULT_LANGUAGE,
    label: 'Description language',
    group: 'content',
    description: 'Synopses and episode descriptions, where a translation exists.'
  },
  {
    key: 'content.adult',
    default: false,
    label: 'Show adult content',
    group: 'content',
    onboarding: true,
    description: 'Off unless you turn it on.'
  },
  {
    // The sub/dub switch. Primary because it is how viewers actually think
    // about it — they ask for "dub", not for "Hungarian audio".
    key: 'playback.variant',
    values: ['sub', 'dub', 'any'],
    default: 'sub',
    label: 'Subtitled or dubbed',
    group: 'playback',
    onboarding: true,
    description: 'Which version to start first when a source offers both.'
  },
  {
    key: 'playback.subtitles',
    values: ['hu', 'en', 'off'],
    default: DEFAULT_LANGUAGE,
    label: 'Subtitle language',
    group: 'playback',
    description: 'Preferred subtitle track.'
  },
  {
    key: 'playback.audio',
    values: ['ja', 'hu', 'en'],
    default: 'ja',
    label: 'Audio language',
    group: 'playback',
    description: 'Preferred audio track when a dub is available.'
  },
  {
    key: 'notifications.episodes',
    default: true,
    label: 'New episode alerts',
    group: 'content',
    onboarding: true,
    description: 'Tell me when a show I follow gets a new episode.'
  }
] as const

/** Fast lookup, built once. */
const BY_KEY = new Map(PREFERENCES.map(spec => [spec.key, spec]))

export function specFor (key: string): PreferenceSpec | undefined {
  return BY_KEY.get(key)
}

export function isPreferenceKey (key: string): boolean {
  return BY_KEY.has(key)
}

/** Every preference at its default. */
export function defaults (): Record<string, PreferenceValue> {
  return Object.fromEntries(PREFERENCES.map(spec => [spec.key, spec.default]))
}

/**
 * Coerce one value, falling back to the default rather than throwing.
 *
 * Preferences are cosmetic: a bad value should never fail a request or leave
 * the viewer with a broken screen. Rejection happens at the route boundary for
 * unknown *keys* — that is a client bug worth surfacing — while a known key
 * with a nonsense value quietly becomes the default.
 */
export function coerce (key: string, value: unknown): PreferenceValue | undefined {
  const spec = BY_KEY.get(key)
  if (!spec) return undefined

  if (spec.values) {
    return typeof value === 'string' && spec.values.includes(value) ? value : spec.default
  }
  // Booleans arrive as real booleans from JSONB, but a client that sends
  // "true" should not silently get `false`.
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return spec.default
}

/** Apply stored rows over the defaults, dropping anything unrecognised. */
export function resolve (stored: Record<string, unknown> = {}): Record<string, PreferenceValue> {
  const out = defaults()
  for (const [key, value] of Object.entries(stored)) {
    const coerced = coerce(key, value)
    if (coerced !== undefined) out[key] = coerced
  }
  return out
}

// ---------------------------------------------------------------------------
// Accept-Language
// ---------------------------------------------------------------------------

/**
 * Pick the best supported language from an Accept-Language header.
 *
 * Deliberately small: full RFC 9110 negotiation is more machinery than a
 * two-language site needs. Quality values are honoured because browsers send
 * them and ignoring them picks the wrong language for anyone whose first
 * choice we do not speak.
 *
 * Returns null when the header expresses no preference we can serve, so the
 * caller decides the fallback — a viewer's stored setting must win over a
 * header, and only an anonymous first visit falls through to the site default.
 */
export function negotiate (header: string | undefined | null): UiLanguage | null {
  if (!header) return null

  const ranked = String(header)
    .split(',')
    .map(part => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params
        .map(p => /^\s*q=([\d.]+)\s*$/i.exec(p))
        .find(Boolean)
      return {
        // 'hu-HU' and 'hu' both mean Hungarian here.
        tag: tag.trim().toLowerCase().split('-')[0] ?? '',
        // A malformed q is treated as absent (1.0) rather than as zero, which
        // would silently discard the entry.
        q: q?.[1] !== undefined && Number.isFinite(Number(q[1])) ? Number(q[1]) : 1
      }
    })
    .filter(entry => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q)

  for (const entry of ranked) {
    if (entry.tag === '*') return DEFAULT_LANGUAGE
    if ((UI_LANGUAGES as readonly string[]).includes(entry.tag)) return entry.tag as UiLanguage
  }
  return null
}

/**
 * The language to serve a request, in precedence order:
 *   1. an explicit ?lang= override (used by the client after a switch)
 *   2. the viewer's stored preference
 *   3. Accept-Language
 *   4. the site default
 */
export function requestLanguage (opts: {
  explicit?: string | null
  stored?: string | null
  header?: string | null
}): UiLanguage {
  for (const candidate of [opts.explicit, opts.stored]) {
    if (typeof candidate === 'string' && (UI_LANGUAGES as readonly string[]).includes(candidate)) {
      return candidate as UiLanguage
    }
  }
  return negotiate(opts.header) ?? DEFAULT_LANGUAGE
}
