// The theme pack, and the theme-type consumer that makes it mean anything.
//
// The `theme` type has been valid in the manifest validator since the store
// existed and nothing ever consumed it, so a theme pack could be published,
// installed, and then do nothing at all. These tests cover both halves: the
// pack producing well-formed themes, and the Theme Engine drawing them.
//
// The interesting failure is a theme that "works" — nothing errors — and
// renders an unstyled page, because a base the stylesheet has no rules for
// still sets a data-theme attribute.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/yume-themes/', import.meta.url)

const plain = value => JSON.parse(JSON.stringify(value))

async function load () {
  // A theme pack reaches nothing, so there is no host to fake — the absence
  // of a `yume` global is itself part of what is being asserted.
  delete globalThis.yume
  const mod = await import(new URL('index.js?t=' + Math.random(), DIR))
  return mod.default
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('asks for no permissions at all', async () => {
    // A theme is pure data. Anything it requested would be unjustifiable, and
    // this is the reference other theme packs get copied from.
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.deepEqual(validateManifest(manifest).permissions, [])
    assert.ok(!manifest.permissions)
  })

  it('is a theme extension, so the engine never asks it for a stream', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.equal(manifest.type, 'theme')
  })
})

describe('the themes it offers', () => {
  it('returns theme records the engine can use', async () => {
    const ext = await load()
    const themes = await ext.theme(undefined, {})
    assert.ok(themes.length >= 8)
    for (const theme of themes) {
      assert.equal(theme.kind, 'theme')
      assert.ok(theme.slug && theme.name)
      assert.ok(['dark', 'light'].includes(theme.base), `${theme.slug} has base ${theme.base}`)
    }
  })

  it('gives every accent as a parseable colour', async () => {
    // The engine interpolates the accent straight into CSS custom properties,
    // so a malformed value produces no error and no colour.
    const ext = await load()
    for (const theme of await ext.theme(undefined, {})) {
      assert.match(theme.accent, /^hsl\(\s*[\d.]+\s+[\d.]+%\s+[\d.]+%\s*\)$/, `${theme.slug}: ${theme.accent}`)
    }
  })

  it('keeps light-base accents darker than dark-base ones', async () => {
    // The same hue at the same lightness that reads well on black is washed
    // out on white, so this is a real constraint rather than a preference.
    const ext = await load()
    const themes = await ext.theme(undefined, {})
    const lightness = accent => Number(/([\d.]+)%\s*\)$/.exec(accent)[1])
    const light = themes.filter(t => t.base === 'light').map(t => lightness(t.accent))
    const dark = themes.filter(t => t.base === 'dark').map(t => lightness(t.accent))
    assert.ok(Math.max(...light) <= Math.min(...dark) + 10,
      `light accents reach ${Math.max(...light)}% while dark ones start at ${Math.min(...dark)}%`)
  })

  it('uses a distinct slug for each theme', async () => {
    const ext = await load()
    const slugs = (await ext.theme(undefined, {})).map(t => t.slug)
    assert.equal(new Set(slugs).size, slugs.length)
  })

  it('does not collide with the themes already built into the engine', async () => {
    const ext = await load()
    const source = readFileSync(new URL('../js/pages/themes.js', import.meta.url), 'utf8')
    const builtIn = [...source.matchAll(/slug: '([^']+)'/g)].map(m => m[1])
    assert.ok(builtIn.length >= 5, `only found ${builtIn.length} built-in themes to compare against`)
    for (const theme of await ext.theme(undefined, {})) {
      assert.ok(!builtIn.includes(theme.slug), `${theme.slug} shadows a built-in theme`)
    }
  })

  it('can leave out the light themes', async () => {
    const ext = await load()
    const themes = await ext.theme(undefined, { include_light: false })
    assert.ok(themes.length > 0)
    assert.ok(!themes.some(t => t.base === 'light'))
  })

  it('reports itself available, having nothing to reach', async () => {
    // Returning false to mean "nothing configured" would make the portal
    // report a fault where there is none.
    const ext = await load()
    assert.equal(await ext.test(), true)
  })

  it('never touches a host API', async () => {
    // Proven by the absence of the global: any call would throw.
    const ext = await load()
    assert.equal(globalThis.yume, undefined)
    assert.doesNotThrow(() => plain(ext))
    assert.ok((await ext.theme(undefined, {})).length > 0)
  })
})

describe('the Theme Engine consumes them', () => {
  const source = readFileSync(new URL('../js/pages/themes.js', import.meta.url), 'utf8')

  it('asks only theme extensions, and for themes', () => {
    assert.match(source, /collect\('theme',\s*undefined,\s*\{\s*types:\s*\['theme'\]\s*\}\)/)
  })

  it('refuses a base the stylesheet has no rules for', () => {
    // A theme claiming base 'solarized' would set data-theme="solarized" and
    // render an unstyled page — no error, just a broken screen.
    assert.match(source, /row\.base === 'dark' \|\| row\.base === 'light'/)
  })

  it('draws extension themes under their own heading rather than merging them', () => {
    // A viewer should be able to tell which themes came from where, and an
    // extension should not be able to shadow a built-in by reusing its slug.
    assert.match(source, /From extensions/)
  })

  it('does not let a broken extension take the page down', () => {
    assert.match(source, /catch \(e\) \{\s*return\s*\}/)
  })
})
