// Error grouping decides whether the admin view shows one actionable bug or a
// thousand indistinguishable rows, so the fingerprint rules are pinned here.
// fingerprint() is pure — no database needed.

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { fingerprint } from '../src/lib/errors.ts'

const stackIn = (file: string, line = 42): string =>
  `Error: boom\n    at handler (file:///app/server/src/routes/${file}:${line}:11)\n    at run (node_modules/fastify/lib/x.js:1:1)`

describe('grouping', () => {
  test('the same fault from the same place is one group', () => {
    assert.equal(
      fingerprint('api', 'connection refused', stackIn('anime.ts')),
      fingerprint('api', 'connection refused', stackIn('anime.ts', 99)),
      'a different line in the same file is still the same bug'
    )
  })

  test('ids that vary per request do not split a group', () => {
    const a = fingerprint('api', 'anime 3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d not found', stackIn('anime.ts'))
    const b = fingerprint('api', 'anime 99999999-1111-4222-8333-444444444444 not found', stackIn('anime.ts'))
    assert.equal(a, b)
  })

  test('quoted values do not split a group', () => {
    assert.equal(
      fingerprint('api', 'invalid slug "one-piece"', stackIn('anime.ts')),
      fingerprint('api', "invalid slug 'attack-on-titan'", stackIn('anime.ts'))
    )
  })

  test('different faults stay apart', () => {
    assert.notEqual(
      fingerprint('api', 'connection refused', stackIn('anime.ts')),
      fingerprint('api', 'permission denied', stackIn('anime.ts'))
    )
  })

  test('the same message from a different module stays apart', () => {
    assert.notEqual(
      fingerprint('api', 'boom', stackIn('anime.ts')),
      fingerprint('api', 'boom', stackIn('library.ts'))
    )
  })

  test('api and worker failures are never merged', () => {
    assert.notEqual(fingerprint('api', 'boom'), fingerprint('worker', 'boom'))
  })

  test('a vendor-only stack still fingerprints', () => {
    const onlyVendor = 'Error: boom\n    at x (node_modules/pg/lib/client.js:1:1)'
    assert.equal(typeof fingerprint('api', 'boom', onlyVendor), 'string')
  })

  test('a missing stack still produces a stable fingerprint', () => {
    assert.equal(fingerprint('api', 'boom'), fingerprint('api', 'boom'))
  })
})
