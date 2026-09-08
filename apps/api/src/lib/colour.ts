// Is this string safe to interpolate into a CSS custom property?
//
// The theme editor lets an operator write a colour, and the client renders it
// as `--accent: <value>` inside a <style> element. The distance between a
// colour and a stylesheet is one closing brace: `red; } body { display: none`
// is a valid string and a working defacement of every page, and `url(...)`
// there is an outbound request to somebody else's server on every page load.
//
// So this is an allowlist, not a denylist. Denylists in this position fail the
// same way every time — somebody finds the spelling nobody thought of. What is
// permitted here is the grammar of a colour and nothing else, which is a small
// enough language to describe exactly.

/** Hex: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * The colour functions, with an argument list that cannot contain anything
 * but numbers, units and separators. No nested functions: `color-mix` and
 * `var` are how a value reaches outside itself, and a theme has no reason to.
 */
const FUNCTIONAL = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%,\s/+-]{1,120}\)$/i

/**
 * Named colours, as a shape rather than a list of 148.
 *
 * A bare word cannot carry a brace, a semicolon or a parenthesis, so the worst
 * a misspelling can do is name no colour — the browser drops the declaration
 * and the theme falls back to the token it was overriding. That is a better
 * failure than maintaining a copy of the CSS colour list.
 */
const NAMED = /^[a-z]{3,20}$/i

export function validColour (value: unknown): boolean {
  if (typeof value !== 'string') return false
  const colour = value.trim()
  if (!colour || colour.length > 140) return false
  // Belt and braces: none of the three patterns can match these, but a future
  // edit to one of them should not be able to quietly let them through.
  if (/[;{}<>\\@]/.test(colour)) return false
  return HEX.test(colour) || FUNCTIONAL.test(colour) || NAMED.test(colour)
}

/** A custom-property name a theme may override. */
const TOKEN_NAME = /^--[a-z][a-z0-9-]{1,40}$/

/**
 * Check a whole token map.
 *
 * Returns the offending entry, or null when every one is fine — the caller
 * turns that into a message naming what to fix, which is the difference
 * between a form that teaches and one that just says no.
 */
export function badToken (tokens: unknown): string | null {
  if (tokens === null || tokens === undefined) return null
  if (typeof tokens !== 'object' || Array.isArray(tokens)) return 'Tokens must be an object'
  const entries = Object.entries(tokens as Record<string, unknown>)
  if (entries.length > 40) return 'Too many token overrides (40 at most)'
  for (const [name, value] of entries) {
    if (!TOKEN_NAME.test(name)) return `"${name}" is not a custom-property name (expected --something)`
    if (!validColour(value)) return `The value of "${name}" is not a colour`
  }
  return null
}
