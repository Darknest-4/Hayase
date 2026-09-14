// Carrying pre-namespace keys across, on a browser whose storage is nearly full.
//
// This is the check that was missing when the site went blank. The migration
// wrote the namespaced copy before deleting the bare key, so for one moment a
// library needed room for itself twice — and the founder's library, which is
// the whole catalogue, does not have that room. localStorage threw
// QuotaExceededError out of `Store.ensureProfiles()`, which is the first
// statement of `App.init()`, so the router never ran: an empty <main>, every
// asset a 200 and nothing in the server log.
//
// The quota is the interesting part, so the fake storage here has one. A test
// against an unbounded Map cannot tell the two spellings apart.

import assert from 'node:assert/strict'
import { describe, it, beforeEach, mock } from 'node:test'

import { install } from './support/browser.mjs'

install()
const { Store } = await import('../src/shared/state/store.js')

/**
 * A Storage that refuses to hold more than `quota` characters, as a browser does.
 *
 * The stored keys are own enumerable properties, because `ensureProfiles`
 * finds the resume positions with `Object.keys(localStorage)` and a real
 * Storage answers that with its keys. The shared stub in support/browser.mjs
 * keeps them in a Map only, which answers with its own method names instead —
 * so that loop would appear to work here while doing nothing.
 */
function boundedStorage (quota) {
  const map = new Map()
  const api = ['map', 'getItem', 'setItem', 'removeItem', 'clear', 'key', 'length']
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0)
  const store = {
    map,
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem (key, value) {
      const k = String(key)
      const v = String(value)
      if (api.includes(k)) throw new Error(`this stub cannot hold a key named ${k}`)
      const after = used() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + v.length
      if (after > quota) {
        const error = new Error(`Setting the value of '${k}' exceeded the quota.`)
        error.name = 'QuotaExceededError'
        throw error
      }
      map.set(k, v)
      Object.defineProperty(store, k, { value: v, enumerable: true, configurable: true, writable: true })
    },
    removeItem (key) {
      const k = String(key)
      map.delete(k)
      if (!api.includes(k)) delete store[k]
    },
    clear () { for (const k of [...map.keys()]) store.removeItem(k) },
    key: i => [...map.keys()][i] ?? null,
    get length () { return map.size }
  }
  // `map` and the methods must not show up as stored keys.
  for (const name of api) Object.defineProperty(store, name, { ...Object.getOwnPropertyDescriptor(store, name), enumerable: false })
  return store
}

/** A library big enough to matter, as one JSON string. */
const library = entries => JSON.stringify(
  Object.fromEntries(Array.from({ length: entries }, (_, i) => [
    100000 + i,
    { status: 'COMPLETED', progress: 12, media: { id: 100000 + i, title: { romaji: 'Title number ' + i } } }
  ]))
)

describe('carrying pre-namespace keys to their viewer id', () => {
  const VIEWER = 'viewer-1'

  beforeEach(() => {
    mock.restoreAll()
    mock.method(Store, '_viewerId', () => VIEWER)
  })

  it('carries a library that only fits in the quota once', () => {
    const raw = library(2000)
    // Room for the value and its slightly longer key, and not a byte more:
    // the old copy-then-delete needed twice this and threw.
    const storage = boundedStorage(raw.length + `animelist::${VIEWER}`.length)
    install({ localStorage: storage })
    storage.setItem('animelist', raw)

    assert.doesNotThrow(() => Store.ensureProfiles())
    assert.equal(storage.getItem('animelist'), null, 'the bare key should be gone')
    assert.equal(storage.getItem(`animelist::${VIEWER}`), raw, 'the library should have arrived intact')
  })

  it('starts the application even when the value cannot be carried at all', () => {
    // Nothing frees enough room here — the namespaced key is longer than the
    // bare one and there is no slack. The application still has to start.
    const raw = library(2000)
    const storage = boundedStorage(raw.length + 'animelist'.length)
    install({ localStorage: storage })
    storage.setItem('animelist', raw)

    assert.doesNotThrow(() => Store.ensureProfiles())
    assert.equal(storage.getItem('animelist'), raw, 'a rename that failed must put the value back')
  })

  it('keeps the namespaced value when both spellings exist', () => {
    const storage = boundedStorage(1e6)
    install({ localStorage: storage })
    storage.setItem('animelist', library(2))
    storage.setItem(`animelist::${VIEWER}`, library(5))

    Store.ensureProfiles()
    assert.equal(storage.getItem('animelist'), null)
    assert.equal(Object.keys(JSON.parse(storage.getItem(`animelist::${VIEWER}`))).length, 5,
      'the bare key can only be older, so it must not overwrite')
  })

  it('carries resume positions too', () => {
    const storage = boundedStorage(1e6)
    install({ localStorage: storage })
    storage.setItem('watchpos:123:4', '512.5')
    storage.setItem(`watchpos:999:1::${VIEWER}`, '10')

    Store.ensureProfiles()
    assert.equal(storage.getItem('watchpos:123:4'), null)
    assert.equal(storage.getItem(`watchpos:123:4::${VIEWER}`), '512.5')
    assert.equal(storage.getItem(`watchpos:999:1::${VIEWER}`), '10', 'already namespaced, left alone')
  })
})
