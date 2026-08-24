// The AniSkip extension.
//
// It feeds a button that seeks the video, so the failure that matters is a bad
// interval getting through: a skip that jumps backwards, or a one-second
// "opening" from a bad submission, produces a button that moves the playhead
// somewhere the viewer did not ask for.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const DIR = new URL('../../extensions/aniskip/', import.meta.url)
const OPTIONS = { types: 'op_ed', min_length: 5 }
const QUERY = { malId: 16498, episode: 3, titles: ['Shingeki no Kyojin'] }

const plain = value => JSON.parse(JSON.stringify(value))

async function load (handler = () => null) {
  const calls = []
  globalThis.yume = {
    async fetch (url) {
      calls.push(String(url))
      const body = handler(new URL(String(url)))
      if (body === null || body === undefined) return { ok: false, status: 404, json: async () => ({}) }
      if (body.throws) throw new Error('network')
      return { ok: (body.status ?? 200) < 400, status: body.status ?? 200, json: async () => body.json ?? {} }
    },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    log () {}
  }
  const mod = await import(new URL('index.js?t=' + Math.random(), DIR))
  return { ext: mod.default, calls }
}

const found = results => () => ({ json: { found: true, results } })
const interval = (skipType, startTime, endTime) => ({ skipType, interval: { startTime, endTime } })

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

  it('declares only the host it talks to', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'))
    assert.deepEqual(manifest.permissions['net:fetch'].hosts, ['api.aniskip.com'])
    // No storage permission: intervals are cheap to fetch and caching them
    // would mean holding stale data for an episode that got corrected.
    assert.ok(!('storage:local' in manifest.permissions))
  })
})

describe('returning intervals', () => {
  it('returns skip records the player can use', async () => {
    const { ext } = await load(found([interval('op', 12.5, 102.3)]))
    const out = await ext.metadata(QUERY, OPTIONS)
    assert.deepEqual(plain(out), [{ kind: 'skip', skipType: 'op', start: 12.5, end: 102.3 }])
  })

  it('returns both an opening and an ending', async () => {
    const { ext } = await load(found([interval('op', 0, 90), interval('ed', 1300, 1400)]))
    const out = await ext.metadata(QUERY, OPTIONS)
    assert.deepEqual(plain(out).map(r => r.skipType), ['op', 'ed'])
  })

  it('asks only for the interval types the option selects', async () => {
    const { ext, calls } = await load(found([]))
    await ext.metadata(QUERY, { ...OPTIONS, types: 'op' })
    assert.match(calls[0], /types\[\]=op/)
    assert.ok(!calls[0].includes('types[]=ed'))
  })

  it('leaves runtime filtering to the player', async () => {
    // Passing a wrong episodeLength makes AniSkip return nothing at all; the
    // player knows the real duration and clamps against it.
    const { ext, calls } = await load(found([]))
    await ext.metadata(QUERY, OPTIONS)
    assert.match(calls[0], /episodeLength=0/)
  })
})

describe('refusing bad data', () => {
  it('drops an interval that ends before it starts', async () => {
    // The button seeks to `end`; a backwards interval moves the viewer
    // backwards without being asked.
    const { ext } = await load(found([interval('op', 100, 40)]))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('drops an interval shorter than the floor', async () => {
    // A one-second opening is a bad submission, and a skip button that jumps
    // nowhere is worse than no button.
    const { ext } = await load(found([interval('op', 10, 11)]))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('honours a custom floor, including zero', async () => {
    const { ext } = await load(found([interval('op', 10, 11)]))
    assert.equal((await ext.metadata(QUERY, { ...OPTIONS, min_length: 0 })).length, 1)
  })

  it('drops an interval with unusable numbers', async () => {
    const { ext } = await load(found([
      { skipType: 'op', interval: { startTime: 'x', endTime: 90 } },
      { skipType: 'op', interval: {} },
      { skipType: 'op' }
    ]))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('treats an unrecognised skip type as an opening rather than passing it through', async () => {
    const { ext } = await load(found([interval('recap', 0, 90)]))
    assert.equal((await ext.metadata(QUERY, OPTIONS))[0].skipType, 'op')
  })
})

describe('when it cannot answer', () => {
  it('asks nothing at all without a MyAnimeList id', async () => {
    // Guessing an id from a title would produce intervals from a different
    // show, which is far worse than no skip button.
    const { ext, calls } = await load(found([interval('op', 0, 90)]))
    assert.deepEqual(plain(await ext.metadata({ ...QUERY, malId: undefined }, OPTIONS)), [])
    assert.equal(calls.length, 0)
  })

  it('rejects a malformed id instead of putting it in a URL', async () => {
    const { ext, calls } = await load(found([]))
    for (const malId of [0, -5, 'abc', null, 1.5]) {
      await ext.metadata({ ...QUERY, malId }, OPTIONS)
    }
    assert.equal(calls.length, 0)
  })

  it('returns nothing for a missing episode number', async () => {
    const { ext, calls } = await load(found([]))
    assert.deepEqual(plain(await ext.metadata({ ...QUERY, episode: 0 }, OPTIONS)), [])
    assert.equal(calls.length, 0)
  })

  it('returns nothing when the database has no entry', async () => {
    const { ext } = await load(() => ({ json: { found: false } }))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])
  })

  it('returns nothing rather than throwing when the service is down', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.deepEqual(plain(await ext.metadata(QUERY, OPTIONS)), [])

    const errored = await load(() => ({ status: 500 }))
    assert.deepEqual(plain(await errored.ext.metadata(QUERY, OPTIONS)), [])
  })
})

describe('test()', () => {
  it('counts a 404 as a working service', async () => {
    // 404 means "no entry for that episode", which proves lookups work.
    const { ext } = await load(() => ({ status: 404 }))
    assert.equal(await ext.test(), true)
  })

  it('reports down when the service is unreachable', async () => {
    const { ext } = await load(() => ({ throws: true }))
    assert.equal(await ext.test(), false)
  })
})
