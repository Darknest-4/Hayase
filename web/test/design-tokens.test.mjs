// The shared design tokens must not drift from the ones the client renders.
//
// They had. `packages/design-tokens/` called itself the single source of
// truth while nothing imported it, and `web/css/tokens.css` — the file every
// surface actually renders from — had moved ahead: seven tokens missing from
// the package, and `--card-w` holding two different values in the two places.
// A native surface reading the package would have drawn a different layout
// from the web one and nothing would have said why.
//
// The direction is now inverted: the client stylesheet is the source, the
// package is generated from it, and this test is what stops them separating
// again.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { readTokens, CSS_OUT, JSON_OUT } = await import(
  new URL('../../packages/design-tokens/build.mjs', import.meta.url)
)

const parse = css => Object.fromEntries(
  [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
)

/**
 * Parse only the base block.
 *
 * Several tokens are deliberately redefined for the light theme, so parsing
 * the whole file flat returns the light value for those and the dark one for
 * everything else — which compares against neither palette.
 */
const parseRoot = css => parse(css.slice(0, css.indexOf("[data-theme='light']")))

describe('design tokens', () => {
  const source = readTokens()

  it('reads a full palette out of the client stylesheet', () => {
    assert.ok(Object.keys(source.dark).length > 60, `only ${Object.keys(source.dark).length} tokens found`)
    assert.equal(source.dark['--accent'], 'var(--rose-500)')
  })

  it('has a generated CSS file that matches it', () => {
    // Not a string comparison: formatting is the generator's business, the
    // values are the contract.
    const generated = parseRoot(readFileSync(CSS_OUT, 'utf8'))
    for (const [key, value] of Object.entries(source.dark)) {
      assert.equal(generated[key], value, `${key} differs — run: node packages/design-tokens/build.mjs`)
    }
  })

  it('has a generated JSON file that matches it', () => {
    const json = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    assert.deepEqual(Object.keys(json).sort(), ['dark', 'light'])
    for (const [key, value] of Object.entries(source.dark)) {
      assert.equal(json.dark[key], value, `${key} differs — run: node packages/design-tokens/build.mjs`)
    }
  })

  it('resolves the light theme as a full palette, not only the overrides', () => {
    // A native surface asking for the light theme wants every token, not the
    // dozen that happen to differ.
    const json = JSON.parse(readFileSync(JSON_OUT, 'utf8'))
    assert.equal(Object.keys(json.light).length, Object.keys(json.dark).length)
    assert.notEqual(json.light['--bg'], json.dark['--bg'])
  })

  it('leaves no token defined only in the package', () => {
    // The package is generated, so anything in it that is not in the source
    // is a hand edit that the next build silently deletes.
    const generated = parse(readFileSync(CSS_OUT, 'utf8'))
    const extra = Object.keys(generated).filter(k => !(k in source.dark) && !(k in source.lightOverrides))
    assert.deepEqual(extra, [])
  })

  it('is referenced by the stylesheet that consumes it', () => {
    const style = readFileSync(join(here, '../css/style.css'), 'utf8')
    assert.match(style, /tokens/i)
  })
})
