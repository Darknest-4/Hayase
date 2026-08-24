// The Translation Feed extension, and the detail page that consumes it.
//
// The failure that matters is not a broken feed — that shows the same English
// text as before. It is a feed that overwrites a translation the catalogue
// already had, or one that attaches the wrong show's synopsis.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/translation-feed/', import.meta.url)
const URLS = { feed_url: 'https://feed.example.com/translations.json', language: 'hu', refresh_minutes: 60 }

const plain = value => JSON.parse(JSON.stringify(value))

/**
 * Run something with the clock moved forward.
 *
 * The refresh window is measured in minutes and floored at one, so waiting it
 * out for real would make this file take minutes. `Date.now` is a global, so
 * moving it moves it for the module under test too.
 */
async function advance (ms, fn) {
  const real = Date.now
  Date.now = () => real.call(Date) + ms
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

const FEED = {
  16498: {
    title: 'A támadó titánok',
    description: 'Több mint száz éve az emberiség fallal vette körül magát.',
    episodes: { 1: 'Neked, kétezer év múlva', 2: 'Aznap' }
  },
  21: { title: 'Egy darab' }
}

async function load (handler = () => ({ json: FEED }), { storage = new Map() } = {}) {
  const calls = []
  globalThis.yume = {
    async fetch (url, init = {}) {
      calls.push({ url: String(url), method: init.method ?? 'GET' })
      const body = handler(String(url), init)
      if (body === null || body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      if (body.throws) throw new Error('network')
      return { ok: (body.status ?? 200) < 400, status: body.status ?? 200, json: async () => body.json ?? {} }
    },
    storage: {
      get: async k => storage.get(k),
      set: async (k, v) => { storage.set(k, v) },
      remove: async k => { storage.delete(k) }
    },
    log () {}
  }
  // A fresh module each time: the feed cache is module state, and a test that
  // inherited the previous test's cache would prove nothing.
  const mod = await import(new URL('index.js?t=' + Math.random(), DIR))
  return { ext: mod.default, calls, storage }
}

describe('manifest', () => {
  it('passes the validator the publish endpoint uses', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const result = validateManifest(JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')))
    assert.equal(result.valid, true, result.errors.join('; '))
  })

  it('is a metadata extension, so the engine never asks it for a stream', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.equal(manifest.type, 'metadata')
  })

  it('declares exactly one host, so a feed URL elsewhere is refused', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.deepEqual(manifest.permissions['net:fetch'].hosts, ['feed.example.com'])
  })

  it('says in its own description that it does not import', () => {
    // People will install it expecting an importer. The store listing is the
    // only place that expectation can be corrected.
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.match(manifest.description, /does not write to the catalogue/)
  })
})

describe('what it returns', () => {
  it('returns a title and a description as flat records', async () => {
    const { ext } = await load()
    const records = await ext.metadata({ anilistId: 16498 }, URLS)
    const title = records.find(r => r.field === 'title')
    const description = records.find(r => r.field === 'description')
    assert.equal(title.kind, 'translation')
    assert.equal(title.text, 'A támadó titánok')
    assert.equal(title.language, 'hu')
    assert.match(description.text, /^Több mint száz éve/)
  })

  it('returns episode titles keyed by number', async () => {
    const { ext } = await load()
    const episodes = (await ext.metadata({ anilistId: 16498 }, URLS)).filter(r => r.field === 'episodeTitle')
    assert.equal(episodes.length, 2)
    assert.deepEqual(episodes.map(e => e.episode).sort((a, b) => a - b), [1, 2])
  })

  it('accepts the wrapped shape as well as the flat one', async () => {
    const { ext } = await load(() => ({ json: { language: 'hu', anime: FEED } }))
    assert.ok((await ext.metadata({ anilistId: 21 }, URLS)).length > 0)
  })

  it('lets the feed name its own language, over the installer guessing', async () => {
    const { ext } = await load(() => ({ json: { language: 'en', anime: { 21: { title: 'One Piece' } } } }))
    const [record] = await ext.metadata({ anilistId: 21 }, { ...URLS, language: 'hu' })
    assert.equal(record.language, 'en')
  })

  it('returns nothing for a title the feed does not cover', async () => {
    const { ext } = await load()
    assert.deepEqual(plain(await ext.metadata({ anilistId: 99999 }, URLS)), [])
  })
})

describe('refusing to guess', () => {
  it('asks nothing without an AniList id', async () => {
    // Matching by name would attach one show's synopsis to another.
    const { ext, calls } = await load()
    assert.deepEqual(plain(await ext.metadata({ titles: ['Shingeki no Kyojin'] }, URLS)), [])
    assert.equal(calls.length, 0)
  })

  it('asks nothing without a feed URL', async () => {
    const { ext, calls } = await load()
    assert.deepEqual(plain(await ext.metadata({ anilistId: 16498 }, { ...URLS, feed_url: '' })), [])
    assert.equal(calls.length, 0)
  })

  it('ignores feed keys that are not ids', async () => {
    const { ext } = await load(() => ({ json: { 'shingeki-no-kyojin': { title: 'x' }, 0: { title: 'y' }, '-3': { title: 'z' } } }))
    assert.deepEqual(plain(await ext.metadata({ anilistId: 16498 }, URLS)), [])
  })

  it('ignores an entry that is not an object', async () => {
    const { ext } = await load(() => ({ json: { 16498: 'A támadó titánok' } }))
    assert.deepEqual(plain(await ext.metadata({ anilistId: 16498 }, URLS)), [])
  })

  it('drops blank text rather than blanking the page with it', async () => {
    const { ext } = await load(() => ({ json: { 16498: { title: '   ', description: 'valódi' } } }))
    const records = await ext.metadata({ anilistId: 16498 }, URLS)
    assert.equal(records.filter(r => r.field === 'title').length, 0)
    assert.equal(records.filter(r => r.field === 'description').length, 1)
  })

  it('bounds a single description and the number of episode titles', async () => {
    const episodes = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [i + 1, 'cím ' + i]))
    const { ext } = await load(() => ({ json: { 16498: { description: 'x'.repeat(50000), episodes } } }))
    const records = await ext.metadata({ anilistId: 16498 }, URLS)
    assert.ok(records.find(r => r.field === 'description').text.length <= 8000)
    assert.ok(records.filter(r => r.field === 'episodeTitle').length <= 500)
  })
})

describe('failing safely', () => {
  it('returns nothing rather than throwing when the feed is down', async () => {
    const down = await load(() => ({ throws: true }))
    assert.deepEqual(plain(await down.ext.metadata({ anilistId: 16498 }, URLS)), [])

    const missing = await load(() => ({ status: 404 }))
    assert.deepEqual(plain(await missing.ext.metadata({ anilistId: 16498 }, URLS)), [])
  })

  it('treats a document that is not a feed as no feed', async () => {
    const { ext } = await load(() => ({ json: ['A támadó titánok'] }))
    assert.deepEqual(plain(await ext.metadata({ anilistId: 16498 }, URLS)), [])
  })

  it('falls back to the last stored entry when the feed is unreachable', async () => {
    const storage = new Map()
    const first = await load(undefined, { storage })
    assert.ok((await first.ext.metadata({ anilistId: 16498 }, URLS)).length > 0)

    const second = await load(() => ({ throws: true }), { storage })
    const records = await second.ext.metadata({ anilistId: 16498 }, URLS)
    assert.equal(records.find(r => r.field === 'title').text, 'A támadó titánok')
  })

  it('forgets a stored entry the feed has dropped', async () => {
    // Otherwise a translation withdrawn from the feed lives forever in the
    // browsers of everyone who ever opened that page.
    const storage = new Map()
    const first = await load(undefined, { storage })
    await first.ext.metadata({ anilistId: 16498 }, URLS)
    assert.ok(storage.size > 0)

    const second = await load(() => ({ json: { 21: { title: 'Egy darab' } } }), { storage })
    assert.deepEqual(plain(await second.ext.metadata({ anilistId: 16498 }, URLS)), [])
    assert.equal(storage.size, 0)
  })

  it('keeps serving the loaded feed after it goes down mid-session', async () => {
    let up = true
    const { ext } = await load(() => (up ? { json: FEED } : { throws: true }))
    await ext.metadata({ anilistId: 16498 }, URLS)
    up = false
    await advance(90 * 60 * 1000, () => ext.metadata({ anilistId: 21 }, { ...URLS, refresh_minutes: 1 }))
      .then(records => assert.ok(records.length > 0))
  })
})

describe('not fetching the feed once per page', () => {
  it('fetches once and answers many titles from it', async () => {
    // A library-sized feed re-fetched on every detail page would be a
    // megabyte per click.
    const { ext, calls } = await load()
    await ext.metadata({ anilistId: 16498 }, URLS)
    await ext.metadata({ anilistId: 21 }, URLS)
    await ext.metadata({ anilistId: 16498 }, URLS)
    assert.equal(calls.length, 1)
  })

  it('collapses concurrent first calls into one fetch', async () => {
    const { ext, calls } = await load()
    await Promise.all([
      ext.metadata({ anilistId: 16498 }, URLS),
      ext.metadata({ anilistId: 21 }, URLS)
    ])
    assert.equal(calls.length, 1)
  })

  it('re-fetches once the refresh window has passed', async () => {
    const { ext, calls } = await load()
    await ext.metadata({ anilistId: 16498 }, URLS)
    await advance(30 * 60 * 1000, () => ext.metadata({ anilistId: 16498 }, URLS))
    assert.equal(calls.length, 1, 'refetched inside the hour-long window')
    await advance(90 * 60 * 1000, () => ext.metadata({ anilistId: 16498 }, URLS))
    assert.equal(calls.length, 2)
  })

  it('will not be told to refresh more often than once a minute', async () => {
    // refresh_minutes: 0 is an operator asking for a fetch per page view; the
    // floor is what stops that from being possible.
    const { ext, calls } = await load()
    await ext.metadata({ anilistId: 16498 }, { ...URLS, refresh_minutes: 0 })
    await advance(30 * 1000, () => ext.metadata({ anilistId: 16498 }, { ...URLS, refresh_minutes: 0 }))
    assert.equal(calls.length, 1)
  })

  it('does not store the whole feed, which would not fit the 64 KB cap', async () => {
    const storage = new Map()
    const { ext } = await load(undefined, { storage })
    await ext.metadata({ anilistId: 16498 }, URLS)
    for (const value of storage.values()) {
      assert.ok(JSON.stringify(value).length < 64 * 1024)
      assert.equal(value.records.every(r => r.text !== 'Egy darab'), true)
    }
  })
})

describe('reporting itself up or down', () => {
  it('calls a document that is not a feed a failure, not a success', async () => {
    // An operator pointing this at their index page gets a 200 back; calling
    // that healthy hides the actual mistake.
    const { ext } = await load(() => ({ json: { hello: 'world' } }))
    assert.equal(await ext.test(URLS), false)
  })

  it('is up when the feed parses and has entries', async () => {
    const { ext } = await load()
    assert.equal(await ext.test(URLS), true)
  })

  it('is down with no URL configured, and when the host is unreachable', async () => {
    const blank = await load()
    assert.equal(await blank.ext.test({ ...URLS, feed_url: '' }), false)
    const down = await load(() => ({ throws: true }))
    assert.equal(await down.ext.test(URLS), false)
  })
})

describe('the detail page consumes it', () => {
  const source = readFileSync(new URL('../js/pages/anime.js', import.meta.url), 'utf8')

  it('applies a translation only where the catalogue has none', () => {
    // An extension overwriting editorial Hungarian text would be the extension
    // outranking the catalogue.
    assert.match(source, /media\._lang\?\.title !== wantLang/)
    assert.match(source, /media\._lang\?\.synopsis !== wantLang/)
  })

  it('only accepts a record in the language the viewer asked for', () => {
    assert.match(source, /r\.language === wantLang/)
  })

  it('drops the untranslated note once a translation replaces the text', () => {
    assert.match(source, /descNote\?\.remove\(\)/)
  })

  it('does not block the hero render on the network call', () => {
    assert.match(source, /_applyTranslations\(media, \{ titleEl, desc, descNote, wantLang \}\)\s*\n\s*\.catch/)
  })

  it('reuses the one metadata query the page already makes', () => {
    assert.match(source, /_applyTranslations[\s\S]{0,400}this\._extensionMetadata\(media\)/)
  })
})
