// Regenerate the shared design tokens from the client's stylesheet.
//
//   node packages/design-tokens/build.mjs
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// This package described itself as the single source of truth, and it was not
// one: nothing imports it, the client's own `web/css/tokens.css` is what every
// surface actually renders from, and the two had already drifted — seven
// tokens missing here, and `--card-w` holding two different values.
//
// So the direction is inverted to match reality. `web/css/tokens.css` is the
// source, because it is the file that is used; this package is generated from
// it, for surfaces that cannot read CSS (a native client, a design tool).
//
// `web/test/design-tokens.test.mjs` fails when the two disagree, so drift
// cannot land again without somebody being told about it.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const SOURCE = join(here, '..', '..', 'web', 'css', 'tokens.css')
export const CSS_OUT = join(here, 'tokens.css')
export const JSON_OUT = join(here, 'tokens.json')

/**
 * Pull the declarations out of one CSS block.
 *
 * A regex rather than a parser: the source is a token file — a flat list of
 * `--name: value;` lines inside two blocks — and a dependency to read it would
 * cost more than it explains.
 */
function block (css, selector) {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in the token source`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
  )
}

export function readTokens (source = SOURCE) {
  const css = readFileSync(source, 'utf8')
  // The dark palette is the base (`:root`); the light one overrides a subset.
  const dark = block(css, ':root')
  // the source spells it with single quotes; match either
  const lightOverrides = block(css, css.includes("[data-theme='light']") ? "[data-theme='light']" : '[data-theme="light"]')
  return { dark, light: { ...dark, ...lightOverrides }, lightOverrides }
}

function render ({ dark, lightOverrides }) {
  const line = ([k, v]) => `  ${k}: ${v};`
  return `/* ===========================================================================
   Yume Design Tokens — for surfaces that cannot read the client stylesheet.

   GENERATED FILE. Do not edit by hand: run
     node packages/design-tokens/build.mjs
   The source is web/css/tokens.css, which is what the web client renders
   from. web/test/design-tokens.test.mjs fails if this file falls behind it.
   =========================================================================== */

:root {
${Object.entries(dark).map(line).join('\n')}
}

[data-theme='light'] {
${Object.entries(lightOverrides).map(line).join('\n')}
}
`
}

// Only write when run directly, so the test can import readTokens() without
// the act of testing rewriting the thing under test.
if (process.argv[1] && process.argv[1].endsWith('build.mjs')) {
  const tokens = readTokens()
  writeFileSync(CSS_OUT, render(tokens))
  writeFileSync(JSON_OUT, JSON.stringify({ dark: tokens.dark, light: tokens.light }, null, 2) + '\n')
  console.log(`design tokens: ${Object.keys(tokens.dark).length} dark, ${Object.keys(tokens.lightOverrides).length} light overrides`)
}
