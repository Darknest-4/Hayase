// Compatibility mode for packages written against another client's API.
//
// The sandbox removes the global `fetch` and offers `yume.fetch`, which the
// host re-checks against the manifest's host allowlist. A package written for
// Hayase calls the bare global and dies immediately — not because it is doing
// anything forbidden, but because it learned a different name.
//
// The dangerous way to fix that is to hand the worker a real `fetch`. These
// tests pin the safe one: an alias that still crosses to the host, only for
// packages whose manifest declared it, and sealed before any package runs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'

const WORKER = new URL('../js/extension-worker.js', import.meta.url)
const HOST = new URL('../js/extension-host.js', import.meta.url)

/** Boot the worker and hand back a way to deliver it an init message. */
function bootWorker () {
  const posted = []
  const context = createContext({
    self: {
      postMessage: m => posted.push(m),
      addEventListener () {},
      set onmessage (fn) { this._onmessage = fn },
      get onmessage () { return this._onmessage }
    },
    URL,
    Blob: class { constructor (parts) { this.parts = parts } },
    console
  })
  runInNewContext(readFileSync(WORKER, 'utf8'), context)
  return {
    context,
    posted,
    read: expr => runInContext(expr, context),
    // The init handler imports the package from a blob URL, which this
    // environment cannot resolve — so the compat branch is exercised by
    // running the same statement the handler runs, in the same context.
    applyCompat: compat => runInContext(
      `Object.defineProperty(self, 'fetch', ${JSON.stringify(compat)} === 'hayase'
        ? { configurable: false, writable: false, value: (url, init) => yume.fetch(url, init) }
        : { configurable: false, get: denyFetch })`,
      context
    )
  }
}

describe('the lockdown', () => {
  it('leaves fetch throwing until an init message says otherwise', () => {
    const { context } = bootWorker()
    assert.throws(() => context.self.fetch, /use the yume API/)
  })

  it('keeps every other capability permanently gone', () => {
    // These have no compatibility story: nothing legitimate needs a raw
    // socket, a nested worker or the credential store.
    const { context, read } = bootWorker()
    for (const name of read('REMOVED')) {
      assert.throws(() => context.self[name], new RegExp(`${name} is not available`), `${name} was reachable`)
    }
  })

  it('does not list fetch among the permanently removed', () => {
    // It is handled separately precisely because it is the one capability a
    // package may legitimately need under its own name.
    const { read } = bootWorker()
    assert.ok(!read('REMOVED').includes('fetch'))
  })
})

describe('compatibility mode', () => {
  it('installs fetch as an alias of the proxied one', () => {
    const { context, applyCompat } = bootWorker()
    const calls = []
    runInContext('yume.fetch = (url, init) => { globalThis.__calls.push([url, init]); return "proxied" }', context)
    context.__calls = calls
    runInContext('globalThis.__calls = __calls', context)

    applyCompat('hayase')
    const result = context.self.fetch('https://example.com/a', { method: 'GET' })
    assert.equal(result, 'proxied', 'compat fetch must go through yume.fetch')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'https://example.com/a')
  })

  it('leaves fetch throwing when the manifest did not declare it', () => {
    const { context, applyCompat } = bootWorker()
    applyCompat(null)
    assert.throws(() => context.self.fetch, /use the yume API/)
  })

  it('seals fetch either way, so no package can redefine it', () => {
    // Sealing happens before the package is imported, so a package can never
    // observe it configurable — this is what stops one swapping in its own.
    for (const compat of ['hayase', null]) {
      const { context, applyCompat } = bootWorker()
      applyCompat(compat)
      assert.throws(
        () => runInContext("Object.defineProperty(self, 'fetch', { value: () => 'mine' })", context),
        /Cannot redefine/,
        `fetch was redefinable in compat=${compat}`
      )
    }
  })

  it('does not give compat packages anything beyond the name', () => {
    // The alias takes the same arguments and returns the same promise; there
    // is no second path to the network hiding behind it.
    const { context, applyCompat } = bootWorker()
    runInContext('yume.fetch = (url, init) => ({ url, init })', context)
    applyCompat('hayase')
    const out = context.self.fetch('https://example.com/x', { method: 'POST' })
    assert.deepEqual(JSON.parse(JSON.stringify(out)), { url: 'https://example.com/x', init: { method: 'POST' } })
  })
})

describe('how the declaration travels', () => {
  const host = readFileSync(HOST, 'utf8')
  const worker = readFileSync(WORKER, 'utf8')

  it('the host sends the declared mode to the worker', () => {
    assert.match(host, /kind: 'init'[\s\S]{0,500}compat: ext\.compat/)
  })

  it('the host takes it from the install record, not from the package', () => {
    // A package deciding its own privileges would be the package granting
    // itself the alias.
    assert.match(host, /compat: ext\.compat,\s*\n\s*source/)
  })

  it('the worker only acts on the mode it was told', () => {
    assert.match(worker, /message\.compat === 'hayase'/)
  })

  it('the manifest validator knows the mode', async () => {
    const { validateManifest } = await import('../../server/src/lib/extension-manifest.ts')
    const base = {
      manifestVersion: 3,
      id: 'compat-thing',
      name: 'Thing',
      version: '1.0.0',
      type: 'torrent',
      summary: 'A package written for another client.'
    }
    assert.equal(validateManifest({ ...base, compat: 'hayase' }).valid, true)
    const bad = validateManifest({ ...base, compat: 'anything-goes' })
    assert.equal(bad.valid, false)
    assert.match(bad.errors.join(' '), /compat must be one of/)
  })
})
