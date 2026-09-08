// Library sync: the parts where "merge" and "replace" are different answers.
//
// Two of these were real defects. Resume positions were pushed to the server
// and never read back, so a second device started every episode from zero.
// Favourites were never sent at all — the one part of the library that stayed
// in a single browser.
//
// The dangerous fix for both is the obvious one: let the server replace what
// the browser holds. That silently deletes whichever half is older, so these
// tests pin the merge rules instead.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

// The module builds its objects inside the vm realm, so deepEqual compares
// them against a different Object.prototype and fails on identical data.
const plain = value => JSON.parse(JSON.stringify(value))

let context, LibrarySync, store, requests

before(() => {
  const window = {}
  context = {
    window,
    document: { createElement: () => ({ style: {}, dataset: {}, append () {}, setAttribute () {} }) },
    console,
    localStorage: { getItem: () => null, setItem () {}, removeItem () {} },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 1)),
    clearTimeout,
    CustomEvent: class { constructor (type) { this.type = type } }
  }
  context.globalThis = context
  context.window.addEventListener = () => {}
  context.window.dispatchEvent = () => {}
  runInNewContext(readFileSync(join(here, '../js/library-sync.js'), 'utf8'), context)
  LibrarySync = window.LibrarySync
  assert.ok(LibrarySync, 'library-sync.js must expose LibrarySync')
})

beforeEach(() => {
  // A debounced push scheduled by the previous test would otherwise land in
  // the middle of this one and be counted as its request. Resetting the timer
  // map is not enough — the callbacks are already scheduled.
  for (const timer of Object.values(LibrarySync?._timers ?? {})) clearTimeout(timer)
  requests = []
  store = {
    favourites: [],
    resume: {},
    entries: {}
  }
  context.Store = {
    favourites: () => store.favourites,
    setFavourites: ids => { store.favourites = ids },
    getResume: (id, ep) => store.resume[`${id}:${ep}`] ?? 0,
    setResume: (id, ep, seconds) => { store.resume[`${id}:${ep}`] = seconds },
    entry: () => null,
    saveEntry: () => {}
  }
  // The module reaches for `window.YumeAPI` in enabled() and bare `YumeAPI`
  // elsewhere; in a vm those are two different lookups, so both are set.
  const api = {
    user: () => ({ id: 'u1' }),
    yumeAnimeId: async media => 'uuid-for-' + media.id,
    // The episode lookup the progress path makes before it can PATCH.
    _request: async () => ({ data: [{ id: 'episode-uuid', number: 1 }] })
  }
  context.YumeAPI = api
  context.window.YumeAPI = api
  LibrarySync._profileId = 'server-profile'
  LibrarySync._muted = false
  LibrarySync._timers = {}
  LibrarySync._epCache = {}
  LibrarySync._req = async (path, opts = {}) => {
    requests.push({ path, method: opts.method ?? 'GET', body: opts.body })
    return context.__reply?.(path) ?? { data: [] }
  }
})

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('favourites', () => {
  it('unions the two sides instead of letting one win', async () => {
    // Two devices with different favourites are two halves of one list.
    store.favourites = [1, 2]
    context.__reply = () => ({ data: [{ anilist_id: 2 }, { anilist_id: 3 }] })
    await LibrarySync.pullFavourites()
    assert.deepEqual(plain(store.favourites).sort((a, b) => a - b), [1, 2, 3])
  })

  it('pushes what only the browser had', async () => {
    store.favourites = [1, 2]
    context.__reply = () => ({ data: [{ anilist_id: 2 }] })
    await LibrarySync.pullFavourites()
    await settle()
    const puts = requests.filter(r => r.method === 'PUT')
    assert.equal(puts.length, 1)
    assert.match(puts[0].path, /uuid-for-1$/)
  })

  it('does not echo the merge back as new writes', async () => {
    // The pull calls setFavourites, which would otherwise fire onFavourite
    // for every title and push the whole list back up.
    store.favourites = []
    context.__reply = () => ({ data: [{ anilist_id: 7 }, { anilist_id: 8 }] })
    await LibrarySync.pullFavourites()
    await settle()
    assert.equal(requests.filter(r => r.method === 'PUT').length, 0)
  })

  it('sends a removal as a DELETE', async () => {
    LibrarySync.onFavourite(42, false)
    await settle()
    const call = requests.find(r => r.method === 'DELETE')
    assert.ok(call, 'no DELETE was sent')
    assert.match(call.path, /uuid-for-42$/)
  })

  it('collapses a double tap into one request', async () => {
    LibrarySync.onFavourite(42, true)
    LibrarySync.onFavourite(42, false)
    await settle()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'DELETE')
  })

  it('never creates a catalogue row from an id alone', async () => {
    // This path knows the id and nothing else, so a stub made here would be
    // titled "Unknown" — the library push resolves with the full media object.
    let asked = null
    context.YumeAPI.yumeAnimeId = async (media, opts) => { asked = opts; return 'uuid' }
    LibrarySync.onFavourite(42, true)
    await settle()
    assert.equal(asked.create, false)
  })

  it('stays quiet when signed out', async () => {
    LibrarySync._profileId = null
    LibrarySync.onFavourite(42, true)
    await settle()
    assert.equal(requests.length, 0)
  })

  it('survives the server being unreachable', async () => {
    store.favourites = [5]
    context.__reply = () => { throw new Error('offline') }
    await LibrarySync.pullFavourites()
    assert.deepEqual(plain(store.favourites), [5], 'a failed pull must not empty the local list')
  })
})

describe('resume positions', () => {
  it('fills in only the episodes the browser has no position for', async () => {
    // Overwriting a live position from a background sync yanks the viewer
    // backwards mid-episode.
    store.resume['16498:1'] = 300
    context.__reply = () => ({
      data: [
        { anilist_id: 16498, episode: 1, position_sec: 60 },
        { anilist_id: 16498, episode: 2, position_sec: 120 }
      ]
    })
    await LibrarySync.pullResume()
    assert.equal(store.resume['16498:1'], 300, 'a local position must win')
    assert.equal(store.resume['16498:2'], 120)
  })

  it('ignores rows it cannot map back to a title', async () => {
    context.__reply = () => ({ data: [{ anilist_id: null, episode: 1, position_sec: 90 }] })
    await LibrarySync.pullResume()
    assert.deepEqual(plain(store.resume), {})
  })

  it('ignores a position too short to be worth resuming', async () => {
    context.__reply = () => ({ data: [{ anilist_id: 1, episode: 1, position_sec: 3 }] })
    await LibrarySync.pullResume()
    assert.deepEqual(plain(store.resume), {})
  })

  it('does not push the positions it just pulled back up', async () => {
    context.__reply = () => ({ data: [{ anilist_id: 1, episode: 1, position_sec: 500 }] })
    await LibrarySync.pullResume()
    await settle()
    assert.equal(requests.filter(r => r.method === 'PATCH').length, 0)
  })
})

describe('progress reporting', () => {
  it('sends the runtime with the position', async () => {
    // Without it the server cannot tell 400 seconds into an episode from 400
    // into a film, which is why its completion rule could never fire.
    LibrarySync.onResume({ id: 1 }, 1, 400, { durationSec: 1440 })
    await settle()
    const call = requests.find(r => r.method === 'PATCH')
    assert.equal(call.body.positionSec, 400)
    assert.equal(call.body.durationSec, 1440)
  })

  it('reports a measured completion immediately, not on the debounce', async () => {
    // This is the last thing that happens before a tab closes.
    LibrarySync.onEpisodeCompleted({ id: 1 }, 1, 1400, 1440)
    await settle()
    const call = requests.find(r => r.body?.completed === true)
    assert.ok(call, 'no completion was sent')
    assert.equal(call.body.durationSec, 1440)
  })

  it('cancels a pending position update when the completion supersedes it', async () => {
    LibrarySync.onResume({ id: 1 }, 1, 100, { durationSec: 1440 })
    LibrarySync.onEpisodeCompleted({ id: 1 }, 1, 1400, 1440)
    await settle()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.completed, true)
  })

  it('omits a duration it does not have rather than sending a zero', async () => {
    LibrarySync.onResume({ id: 1 }, 1, 400, {})
    await settle()
    const call = requests.find(r => r.method === 'PATCH')
    assert.ok(!('durationSec' in call.body))
  })
})
