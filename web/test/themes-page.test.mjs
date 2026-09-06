// The theme picker.
//
// Themes used to come from two places that could not see each other: a
// hard-coded list in this file, and whatever `theme` extensions returned over
// the sandbox message channel. So an operator could not add a palette without
// publishing a package to a store, and the two lists could disagree about a
// slug with nothing to arbitrate between them.
//
// They come from one table now. These are the properties that survived the
// move, plus the two that are new — and they are checked against the source
// rather than by driving the page, because the page is a DOM builder and the
// interesting claims here are about which values it will and will not accept.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const SOURCE = readFileSync(new URL('../js/pages/themes.js', import.meta.url), 'utf8')
const STORE = readFileSync(new URL('../js/store.js', import.meta.url), 'utf8')
const APP = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')

describe('the theme picker', () => {
  it('reads the site theme list', () => {
    assert.match(SOURCE, /YumeAPI\.themes\(\)/)
  })

  it('refuses a base the stylesheet has no rules for', () => {
    // A theme claiming base 'solarized' would set data-theme="solarized" and
    // render an unstyled page — no error, just a broken screen.
    assert.match(SOURCE, /row\?\.base === 'dark' \|\| row\?\.base === 'light'/)
  })

  it('replaces the fallback grid rather than drawing a second one', () => {
    // Two grids of near-identical swatches is not a choice, it is a puzzle.
    assert.match(SOURCE, /grid\.replaceChildren\(\)/)
  })

  it('does not let an unreachable server take the page down', () => {
    // A theme is cosmetic. It is never worth an error state.
    assert.match(SOURCE, /catch \(e\) \{\s*return\s*\}/)
  })

  it('keeps a fallback list so a fresh page is not an empty box', () => {
    assert.match(SOURCE, /PRESETS: \[/)
    const presets = SOURCE.slice(SOURCE.indexOf('PRESETS: ['))
    assert.ok(presets.split('slug:').length > 5, 'the fallback should be a real grid, not a token one')
  })
})

describe('applying a theme', () => {
  it('validates every colour again where it is used', () => {
    // The values come from the site's table, which validates on the way in —
    // but they travel through localStorage, and a custom property is
    // interpolated into a <style> element. Checking again costs a regex.
    assert.match(STORE, /_isColour \(value\)/)
    assert.match(STORE, /\[;\{\}<>/)
  })

  it('accepts only custom-property names as token overrides', () => {
    // Without the name check, a key of `color: red; --x` smuggles a second
    // declaration into the stylesheet.
    assert.match(STORE, /\^--\[a-z\]\[a-z0-9-\]/)
  })

  it('remembers which named theme was chosen', () => {
    // So the picker can show what is selected, and so a change of default does
    // not repaint somebody who has already chosen.
    assert.match(STORE, /themeSlug/)
    assert.match(STORE, /hasChosenTheme \(\)/)
  })

  it('applies the site default only to a viewer who never chose', () => {
    assert.match(APP, /applyDefaultTheme/)
    assert.match(APP, /hasChosenTheme\?\.\(\)\) return/)
  })
})
