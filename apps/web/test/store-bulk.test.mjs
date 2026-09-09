// Applying a whole library at once.
//
// `saveEntry` reads the list, adds one entry and writes the list back. That is
// right for the one title somebody just added and quadratic for a sync: 4,000
// entries applied that way measured at 67 seconds of a locked tab, and the
// founder's account holds 25,703.
//
// The other half is the quota. localStorage gives a page a few megabytes and a
// full catalogue does not fit; `_write` swallows the failure, so the library
// would have been silently half-saved with nothing to say so.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { install, storage } from './support/browser.mjs'

install()
const { Store } = await import('../src/shared/state/store.js')

const media = id => ({ id, title: { userPreferred: 'Title ' + id }, coverImage: {}, format: 'TV', episodes: 12 })
const rows = (from, to) =>
  Array.from({ length: to - from }, (_, i) => ({ media: media(from + i), patch: { status: 'COMPLETED', progress: 12 } }))

describe('Store.saveEntries', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('applies many entries and reports what it stored', () => {
    const result = Store.saveEntries(rows(1, 501))
    assert.equal(result.applied, 500)
    assert.equal(result.stored, 500)
    assert.equal(result.trimmed, 0)
    assert.equal(Object.keys(Store.list()).length, 500)
  })

  it('writes once, however many entries it is given', () => {
    // The point of the method. Counting writes is the only way to assert it:
    // the cost is invisible in the result.
    let writes = 0
    const real = globalThis.localStorage.setItem.bind(globalThis.localStorage)
    globalThis.localStorage.setItem = (key, value) => { if (key.startsWith('animelist')) writes++; real(key, value) }
    try {
      Store.saveEntries(rows(1, 1001))
    } finally {
      globalThis.localStorage.setItem = real
    }
    assert.equal(writes, 1, `wrote the list ${writes} times`)
  })

  it('merges into what is already there rather than replacing it', () => {
    Store.saveEntries([{ media: media(1), patch: { status: 'CURRENT', progress: 3, score: 8 } }])
    Store.saveEntries([{ media: media(1), patch: { status: 'COMPLETED', progress: 12 } }])
    const entry = Store.entry(1)
    assert.equal(entry.status, 'COMPLETED')
    assert.equal(entry.progress, 12)
    assert.equal(entry.score, 8, 'a field the patch does not mention must survive')
  })

  it('keeps the timestamp the caller gives it', () => {
    // The sync passes the server's timestamp. Stamping these with now() would
    // make every pulled entry look newer than the account it came from, and
    // the next pull would skip all of them.
    Store.saveEntries([{ media: media(7), patch: { status: 'COMPLETED', updatedAt: 1000 } }])
    assert.equal(Store.entry(7).updatedAt, 1000)
  })

  it('ignores a row with no id instead of writing an "undefined" entry', () => {
    const result = Store.saveEntries([{ media: {}, patch: { status: 'COMPLETED' } }, { media: media(2), patch: {} }])
    assert.equal(result.applied, 1)
    assert.deepEqual(Object.keys(Store.list()), ['2'])
  })

  it('keeps the newest entries when the browser runs out of room', () => {
    // A quota that refuses anything over ~40 entries' worth, so the trim path
    // runs in a test the way it runs on a phone with a full catalogue.
    const small = storage()
    const LIMIT = 4000
    const guarded = {
      ...small,
      setItem: (key, value) => {
        if (String(key).startsWith('animelist') && String(value).length > LIMIT) {
          const error = new Error('QuotaExceededError')
          error.name = 'QuotaExceededError'
          throw error
        }
        small.setItem(key, value)
      }
    }
    Object.defineProperty(globalThis, 'localStorage', { value: guarded, configurable: true, writable: true })
    try {
      const entries = rows(1, 401).map((row, i) => ({ ...row, patch: { ...row.patch, updatedAt: i } }))
      const result = Store.saveEntries(entries)
      assert.equal(result.applied, 400)
      assert.ok(result.trimmed > 0, 'it should have reported the loss')
      assert.ok(result.stored > 0, 'it should have kept what fits')
      assert.equal(result.stored + result.trimmed, 400)

      // What survived is the newest, because that is what somebody opening the
      // library is looking for.
      const kept = Object.values(Store.list()).map(e => e.updatedAt)
      assert.equal(Math.min(...kept), 400 - kept.length, 'the oldest entries are the ones dropped')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: small, configurable: true, writable: true })
    }
  })
})
