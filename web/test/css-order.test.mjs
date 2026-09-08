// Stylesheet ordering.
//
// A media query carries no extra specificity. A rule written after one, with
// the same selector, wins outright — so a responsive override placed above the
// component it overrides silently does nothing.
//
// That is what happened here: the responsive block sat in the middle of
// style.css and four of its rules were dead, three of them the watch page. On
// a phone `.watch-side` kept `position: sticky` from its later rule, so the
// episode panel floated over the page instead of stacking under the player,
// and the content behind it was squeezed into a strip a few characters wide.
// Nothing errored; it just looked broken.
//
// The block lives at the end of the file now. This keeps it there.
//
// The second thing checked here has the same shape: a mistake that changes
// what the page looks like and reports nothing. `var(--text-dim)` is not an
// error — CSS resolves an undefined custom property to nothing and the
// declaration is simply dropped — so a plausible-looking token that was never
// defined produces unstyled text rather than a failure. Fifteen of them
// shipped in one sitting before this existed.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(here, '../css/style.css'), 'utf8')

/**
 * Every rule in the sheet, tagged with whether it sits inside a media query.
 *
 * Brace counting rather than a parser: the sheet has no nested at-rules beyond
 * media queries, and a real CSS parser is a dependency this repository does
 * not otherwise need.
 */
function rules (css) {
  const found = []
  let depth = 0
  let mediaDepth = -1
  let line = 0
  for (const raw of css.split('\n')) {
    line++
    const text = raw.trim()
    const opens = (text.match(/\{/g) ?? []).length
    const closes = (text.match(/\}/g) ?? []).length

    if (/^@media[^{]*\{/.test(text)) {
      // A single-line query — `@media (…) { .x { … } }` — opens and closes on
      // this line. Skipping the brace count here left the scanner believing
      // every later rule sat inside it, which is how it reported a rule at
      // line 109 as a shadowed breakpoint when it is an ordinary rule.
      mediaDepth = depth
      depth += opens - closes
      if (depth <= mediaDepth) mediaDepth = -1
      continue
    }

    const match = /^([.#][^{@]+?)\s*\{/.exec(text)
    if (match) found.push({ line, selector: match[1].trim(), inMedia: mediaDepth >= 0 })
    depth += opens - closes
    if (mediaDepth >= 0 && depth <= mediaDepth) mediaDepth = -1
  }
  return found
}

describe('responsive overrides are not shadowed', () => {
  const all = rules(CSS)

  it('parses a plausible number of rules', () => {
    // A brace-counting scan that quietly matches nothing would pass the real
    // assertion below while checking nothing.
    assert.ok(all.length > 200, `expected hundreds of rules, found ${all.length}`)
    assert.ok(all.some(r => r.inMedia), 'media-query rules must be recognised')
  })

  it('no media-query rule is overridden by a later rule with the same selector', () => {
    const plain = new Map()
    for (const rule of all.filter(r => !r.inMedia)) {
      if (!plain.has(rule.selector)) plain.set(rule.selector, [])
      plain.get(rule.selector).push(rule.line)
    }

    const shadowed = []
    for (const rule of all.filter(r => r.inMedia)) {
      const later = (plain.get(rule.selector) ?? []).find(l => l > rule.line)
      if (later !== undefined) {
        shadowed.push(`${rule.selector} at line ${rule.line} is overridden at line ${later}`)
      }
    }
    assert.deepEqual(shadowed, [], 'dead responsive rules:\n  ' + shadowed.join('\n  '))
  })

  it('the responsive block really is at the end', () => {
    // The property above holds trivially if there are no breakpoints left, so
    // this checks the arrangement that makes it hold.
    const lastMedia = Math.max(...all.filter(r => r.inMedia).map(r => r.line))
    const lastPlain = Math.max(...all.filter(r => !r.inMedia).map(r => r.line))
    assert.ok(lastMedia > lastPlain, `last breakpoint (${lastMedia}) must come after the last component rule (${lastPlain})`)
  })
})

describe('design tokens the stylesheet asks for', () => {
  const TOKENS = readFileSync(join(here, '../css/tokens.css'), 'utf8')

  /**
   * Every custom property *defined* anywhere the browser will see.
   *
   * The client scripts count too: a value that only exists per element — a
   * progress ring's percentage, a card's own accent — is set as an inline
   * style rather than in the sheet, and it is no less defined for that.
   */
  const inlineSources = readdirSync(join(here, '../js'), { recursive: true })
    .filter(name => String(name).endsWith('.js') && !String(name).startsWith('vendor'))
    .map(name => readFileSync(join(here, '../js', String(name)), 'utf8'))

  const defined = new Set(
    [TOKENS, CSS, ...inlineSources]
      .flatMap(source => [...source.matchAll(/(--[a-z0-9-]+)\s*:/gi)])
      .map(m => m[1])
  )

  it('defines a palette at all', () => {
    // Without this the assertion below passes by finding nothing to check.
    assert.ok(defined.size > 30, `only ${defined.size} custom properties found`)
  })

  it('never reads a token nothing defines', () => {
    const missing = new Map()
    // `var(--x, fallback)` is deliberate and fine — the fallback is the
    // author saying what to do when it is absent. Only a bare reference is a
    // claim that the token exists.
    for (const match of CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
      const name = match[1]
      if (defined.has(name)) continue
      const line = CSS.slice(0, match.index).split('\n').length
      if (!missing.has(name)) missing.set(name, line)
    }
    assert.deepEqual(
      [...missing].map(([name, line]) => `${name} (style.css:${line})`),
      [],
      'these resolve to nothing and silently drop the declaration'
    )
  })
})
