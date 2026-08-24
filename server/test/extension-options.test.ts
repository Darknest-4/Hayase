// Install options: the values that reach extension code, and the packages the
// store publishes on boot.
//
// `extension_installs.options` is handed straight to the sandbox, so this is
// the only place the values are checked. The failure that matters is a value
// that is accepted after being quietly converted — `Number('')` is 0 and
// `Boolean('false')` is true, and either one is a setting nobody chose.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { coerceOptions, defaultOptions, MAX_OPTION_LENGTH, validateManifest } from '../src/lib/extension-manifest.ts'

const SCHEMA = {
  server_url: { type: 'string' as const },
  api_token: { type: 'string' as const },
  page_size: { type: 'number' as const, default: 25 },
  prefer_dub: { type: 'boolean' as const, default: false },
  types: { type: 'select' as const, default: 'op_ed', choices: ['op_ed', 'op', 'ed'] }
}

describe('coercing options', () => {
  it('accepts values of the declared type', () => {
    const result = coerceOptions(SCHEMA, {
      server_url: 'https://media.example.com',
      page_size: 50,
      prefer_dub: true,
      types: 'op'
    })
    assert.equal(result.valid, true, result.errors.join('; '))
    assert.deepEqual(result.options, { server_url: 'https://media.example.com', page_size: 50, prefer_dub: true, types: 'op' })
  })

  it('rejects an undeclared option rather than dropping it', () => {
    // Silently discarding it turns a typo into "the setting does nothing and
    // nothing said why".
    const result = coerceOptions(SCHEMA, { server_ur: 'https://x' })
    assert.equal(result.valid, false)
    assert.match(result.errors[0]!, /unknown option "server_ur"/)
  })

  it('refuses to convert a value into the declared type', () => {
    for (const input of [{ page_size: '25' }, { prefer_dub: 'true' }, { server_url: 42 }, { page_size: NaN }]) {
      assert.equal(coerceOptions(SCHEMA, input).valid, false, JSON.stringify(input))
    }
  })

  it('refuses a choice the manifest never offered', () => {
    assert.equal(coerceOptions(SCHEMA, { types: 'op' }).valid, true)
    assert.equal(coerceOptions(SCHEMA, { types: 'ova' }).valid, false)
  })

  it('treats null as clearing the option, not as storing null', () => {
    // An extension reading `options.api_token` should see nothing there, not
    // a null it has to special-case.
    const result = coerceOptions(SCHEMA, { api_token: null, server_url: 'https://x' })
    assert.equal(result.valid, true)
    assert.ok(!('api_token' in result.options))
  })

  it('bounds a string, since an option holds a URL or a token', () => {
    assert.equal(coerceOptions(SCHEMA, { api_token: 'x'.repeat(MAX_OPTION_LENGTH) }).valid, true)
    assert.equal(coerceOptions(SCHEMA, { api_token: 'x'.repeat(MAX_OPTION_LENGTH + 1) }).valid, false)
  })

  it('rejects anything that is not an object', () => {
    for (const input of [null, 'options', 42, ['a']]) {
      assert.equal(coerceOptions(SCHEMA, input).valid, false, String(input))
    }
  })

  it('rejects every option when the extension declares none', () => {
    assert.equal(coerceOptions(undefined, {}).valid, true)
    assert.equal(coerceOptions(undefined, { anything: 1 }).valid, false)
  })

  it('does not accept a prototype key as an option', () => {
    // `__proto__` is not a declared option, so the undeclared-key rule already
    // covers it — this pins that it stays covered.
    const result = coerceOptions(SCHEMA, JSON.parse('{"__proto__": {"admin": true}}'))
    assert.equal(result.valid, false)
    assert.equal(({} as Record<string, unknown>).admin, undefined)
  })

  it('collects every error rather than stopping at the first', () => {
    const result = coerceOptions(SCHEMA, { page_size: 'a', types: 'nope', nonsense: 1 })
    assert.equal(result.errors.length, 3)
  })
})

describe('starting from the declared defaults', () => {
  it('returns the defaults an install should begin with', () => {
    assert.deepEqual(defaultOptions(SCHEMA), { page_size: 25, prefer_dub: false, types: 'op_ed' })
  })

  it('leaves out options with no default, so nothing is invented', () => {
    // A server URL has no sensible default; inventing one would make the
    // extension look configured when it is not.
    assert.ok(!('server_url' in defaultOptions(SCHEMA)))
  })

  it('copes with an extension that declares no options', () => {
    assert.deepEqual(defaultOptions(undefined), {})
    assert.deepEqual(defaultOptions(null), {})
  })

  it('produces options its own validator then accepts', () => {
    const defaults = defaultOptions(SCHEMA)
    assert.equal(coerceOptions(SCHEMA, defaults).valid, true)
  })
})

describe('the packages that ship with the project', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions')
  const slugs = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)

  it('has packages to publish at all', () => {
    // The publish step runs on every boot; an empty directory means an empty
    // store and nothing to explain it.
    assert.ok(slugs.length >= 8, `only found ${slugs.length}`)
  })

  for (const slug of slugs) {
    describe(slug, () => {
      const manifest = JSON.parse(readFileSync(join(dir, slug, 'manifest.json'), 'utf8'))

      it('passes the validator the publish step uses', () => {
        const result = validateManifest(manifest)
        assert.equal(result.valid, true, result.errors.join('; '))
      })

      it('is named after its directory, which is the slug the store uses', () => {
        assert.equal(manifest.id, slug)
      })

      it('declares defaults its own option schema accepts', () => {
        // A default the validator rejects means an install that is invalid the
        // moment it is created, and a settings form that cannot be saved.
        const defaults = defaultOptions(manifest.options)
        const result = coerceOptions(manifest.options, defaults)
        assert.equal(result.valid, true, result.errors.join('; '))
      })
    })
  }
})
