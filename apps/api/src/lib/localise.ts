// Resolving catalogue text into the language a viewer asked for.
//
// The catalogue is overwhelmingly English and will be for a long time — 25,703
// synopses, and a Hungarian one only exists once somebody writes it. So the
// job here is not "translate", it is "serve the best text available and be
// honest about which language it turned out to be".
//
// That honesty is the part worth arguing for. A Hungarian viewer who is shown
// an English synopsis with no explanation reads it as the site being broken.
// The same text labelled "this description is still in English" reads as a
// missing translation, which is what it is — and it can carry an offer to help
// write one. So every localised payload carries `_lang`, saying per field
// which language the value actually came from.

import type { UiLanguage } from './preferences.ts'

/** What a localised field resolved to. */
export type FieldLanguage = 'hu' | 'en' | 'romaji' | 'native' | 'unknown'

export interface Localised<T> {
  value: T
  language: FieldLanguage
}

/**
 * Pick the first non-empty candidate, and report where it came from.
 *
 * Candidates are given best-first. A blank string counts as absent: an empty
 * translation row is not a translation, and treating it as one is how a viewer
 * ends up with a blank description instead of the English it could have had.
 */
export function pick<T> (
  candidates: Array<[T | null | undefined, FieldLanguage]>,
  fallback: FieldLanguage = 'unknown'
): Localised<T | null> {
  for (const [value, language] of candidates) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' && !value.trim()) continue
    return { value, language }
  }
  return { value: null, language: fallback }
}

/**
 * The title, according to the viewer's `language.titles` preference.
 *
 * Falls back through what the catalogue actually has rather than failing:
 * requested form → romaji → the canonical title. Romaji sits in the middle
 * because it is what the community uses and what 25,670 of the rows contain,
 * so it is the least surprising thing to land on.
 */
export function resolveTitle (
  row: {
    canonical_title?: string | null
    title_romaji?: string | null
    title_english?: string | null
    title_native?: string | null
    title_hu?: string | null
  },
  preference: string
): Localised<string | null> {
  const byPreference: Record<string, Array<[string | null | undefined, FieldLanguage]>> = {
    hungarian: [[row.title_hu, 'hu'], [row.title_romaji, 'romaji'], [row.canonical_title, 'romaji']],
    english: [[row.title_english, 'en'], [row.title_romaji, 'romaji'], [row.canonical_title, 'romaji']],
    native: [[row.title_native, 'native'], [row.title_romaji, 'romaji'], [row.canonical_title, 'romaji']],
    romaji: [[row.title_romaji, 'romaji'], [row.canonical_title, 'romaji'], [row.title_english, 'en']]
  }
  return pick(byPreference[preference] ?? byPreference.romaji as Array<[string | null | undefined, FieldLanguage]>)
}

/**
 * The synopsis, in the requested language when a translation exists.
 *
 * Only Hungarian is ever overlaid: the base row is already English, so an
 * English "translation" row would be a second copy of the same text with two
 * places to edit it.
 */
export function resolveSynopsis (
  row: { synopsis?: string | null, synopsis_hu?: string | null },
  language: UiLanguage
): Localised<string | null> {
  if (language === 'hu') {
    return pick([[row.synopsis_hu, 'hu'], [row.synopsis, 'en']])
  }
  return pick([[row.synopsis, 'en'], [row.synopsis_hu, 'hu']])
}

/**
 * Apply both to a catalogue row and attach the provenance marker.
 *
 * Returns a new object; the row is not mutated, because callers hand the same
 * row to more than one consumer and a mutation here would leak between them.
 */
export function localiseAnime<Row extends Record<string, unknown>> (
  row: Row,
  opts: { language: UiLanguage, titles: string }
): Record<string, unknown> {
  const title = resolveTitle(row as never, opts.titles)
  const synopsis = resolveSynopsis(row as never, opts.language)

  const out: Record<string, unknown> = { ...row }

  // The joined columns are an implementation detail of this resolution, not
  // part of the record — leaving them in doubles the payload and invites
  // clients to reimplement the fallback themselves and get it subtly different.
  for (const key of ['title_hu', 'synopsis_hu', 'title_romaji', 'title_english', 'title_native']) {
    delete out[key]
  }

  out.canonical_title = title.value ?? row.canonical_title ?? null
  out.synopsis = synopsis.value
  out._lang = { title: title.language, synopsis: synopsis.language }
  return out
}

/** Same, for an episode row. */
export function localiseEpisode<Row extends Record<string, unknown>> (
  row: Row,
  language: UiLanguage
): Record<string, unknown> {
  const title = language === 'hu'
    ? pick<string>([[row.title_hu as string, 'hu'], [row.title as string, 'en']])
    : pick<string>([[row.title as string, 'en'], [row.title_hu as string, 'hu']])
  const synopsis = resolveSynopsis(row as never, language)

  const out: Record<string, unknown> = { ...row }
  delete out.title_hu
  delete out.synopsis_hu

  out.title = title.value
  out.synopsis = synopsis.value
  out._lang = { title: title.language, synopsis: synopsis.language }
  return out
}

/**
 * The SQL fragment that joins the Hungarian overlay onto a catalogue query.
 *
 * Exported as a string so every query localises the same way. `approved` is in
 * the join condition rather than a WHERE, so an unreviewed machine draft is
 * invisible without also dropping the anime from the results.
 */
export const ANIME_TRANSLATION_JOIN = `
  LEFT JOIN anime_translations tr
         ON tr.anime_id = a.id AND tr.language = $LANG AND tr.approved`

export const ANIME_TRANSLATION_COLUMNS = `
  tr.title    AS title_hu,
  tr.synopsis AS synopsis_hu`
