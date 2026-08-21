// Extension manifest validation and version compatibility. Pure logic.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyHealth } from '../src/routes/extensions.ts'
import {
  compareVersions, escalatedPermissions, satisfiesMinAppVersion, validateManifest
} from '../src/lib/extension-manifest.ts'

const base = {
  manifestVersion: 3,
  id: 'nyaa-search',
  name: 'Nyaa Search',
  version: '2.1.0',
  type: 'torrent',
  summary: 'Torrent search backed by nyaa.si'
}
const withPerms = (permissions: unknown): unknown => ({ ...base, permissions })

describe('manifest identity', () => {
  it('accepts a complete manifest', () => {
    assert.equal(validateManifest(base).valid, true)
  })

  it('rejects anything that is not an object', () => {
    for (const input of [null, 'x', 42, []]) assert.equal(validateManifest(input).valid, false)
  })

  it('pins the manifest version', () => {
    assert.match(validateManifest({ ...base, manifestVersion: 2 }).errors.join(), /manifestVersion must be 3/)
  })

  it('constrains the id to a slug shape', () => {
    for (const id of ['ab', 'Has Capitals', 'has_underscore', 'x'.repeat(65)]) {
      assert.equal(validateManifest({ ...base, id }).valid, false, `${id} should be rejected`)
    }
    assert.equal(validateManifest({ ...base, id: 'a-valid-id-9' }).valid, true)
  })

  it('requires semver for version and minAppVersion', () => {
    assert.equal(validateManifest({ ...base, version: '2.1' }).valid, false)
    assert.equal(validateManifest({ ...base, version: '2.1.0-beta.1' }).valid, true)
    assert.equal(validateManifest({ ...base, minAppVersion: 'latest' }).valid, false)
  })

  it('requires a summary within the store limit', () => {
    assert.equal(validateManifest({ ...base, summary: '' }).valid, false)
    assert.equal(validateManifest({ ...base, summary: 'x'.repeat(201) }).valid, false)
  })

  it('reports every problem at once rather than one per upload', () => {
    const result = validateManifest({ manifestVersion: 1, id: 'A', version: 'nope' })
    assert.ok(result.errors.length >= 4, `expected several errors, got ${result.errors.length}`)
  })
})

describe('manifest permissions', () => {
  it('rejects permissions outside the vocabulary', () => {
    assert.match(validateManifest(withPerms({ 'fs:write': {} })).errors.join(), /unknown permission/)
  })

  it('requires a non-empty host allowlist for net:fetch', () => {
    // an absent or empty list would mean "any host", which the sandbox must never grant
    assert.match(validateManifest(withPerms({ 'net:fetch': {} })).errors.join(), /non-empty hosts/)
    assert.match(validateManifest(withPerms({ 'net:fetch': { hosts: [] } })).errors.join(), /non-empty hosts/)
  })

  it('only accepts bare hostnames', () => {
    for (const host of ['*.nyaa.si', 'https://nyaa.si', 'nyaa.si/path', 'nyaa.si:8080', 'localhost']) {
      assert.equal(validateManifest(withPerms({ 'net:fetch': { hosts: [host] } })).valid, false, `${host} should be rejected`)
    }
    assert.equal(validateManifest(withPerms({ 'net:fetch': { hosts: ['nyaa.si', 'sub.nyaa.si'] } })).valid, true)
  })

  it('caps the number of declared hosts', () => {
    const hosts = Array.from({ length: 21 }, (_, i) => `h${i}.example.com`)
    assert.match(validateManifest(withPerms({ 'net:fetch': { hosts } })).errors.join(), /at most 20 hosts/)
  })

  it('limits player:subtitles to subtitle extensions', () => {
    assert.equal(validateManifest(withPerms({ 'player:subtitles': {} })).valid, false)
    assert.equal(validateManifest({ ...base, type: 'subtitle', permissions: { 'player:subtitles': {} } }).valid, true)
  })

  it('normalises permissions for storage', () => {
    const { permissions } = validateManifest(withPerms({ 'net:fetch': { hosts: ['nyaa.si'] }, 'query:ids': {} }))
    assert.deepEqual(permissions, [
      { permission: 'net:fetch', hosts: ['nyaa.si'] },
      { permission: 'query:ids', hosts: [] }
    ])
  })
})

describe('manifest options', () => {
  it('accepts a typed option schema', () => {
    assert.equal(validateManifest({ ...base, options: { trusted_only: { type: 'boolean', default: false } } }).valid, true)
  })

  it('requires choices for select options', () => {
    assert.match(validateManifest({ ...base, options: { mode: { type: 'select' } } }).errors.join(), /choices/)
  })

  it('rejects unknown option types and bad keys', () => {
    assert.equal(validateManifest({ ...base, options: { x: { type: 'function' } } }).valid, false)
    assert.equal(validateManifest({ ...base, options: { 'Bad-Key': { type: 'string' } } }).valid, false)
  })
})

describe('version compatibility', () => {
  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
  })

  it('gates rollout on minAppVersion', () => {
    assert.equal(satisfiesMinAppVersion('1.2.0', '1.4.0'), false)
    assert.equal(satisfiesMinAppVersion('1.4.0', '1.4.0'), true)
    assert.equal(satisfiesMinAppVersion('1.0.0', undefined), true, 'no requirement means it always runs')
  })
})

describe('permission escalation', () => {
  const previous = [{ permission: 'net:fetch', hosts: ['nyaa.si'] }]

  it('detects a newly requested permission', () => {
    const added = escalatedPermissions(previous, [...previous, { permission: 'storage:local', hosts: [] }])
    assert.deepEqual(added, ['storage:local'])
  })

  it('detects a widened host allowlist', () => {
    const added = escalatedPermissions(previous, [{ permission: 'net:fetch', hosts: ['nyaa.si', 'evil.example.com'] }])
    assert.deepEqual(added, ['net:fetch (+evil.example.com)'])
  })

  it('reports nothing when capabilities shrink or stay equal', () => {
    assert.deepEqual(escalatedPermissions(previous, previous), [])
    assert.deepEqual(escalatedPermissions(previous, []), [])
  })
})

describe('extension health', () => {
  it('classifies by failures per active install', () => {
    assert.equal(classifyHealth(0, 100), 'healthy')
    assert.equal(classifyHealth(5, 100), 'healthy')    // 0.05 < 0.1
    assert.equal(classifyHealth(20, 100), 'unstable')  // 0.2
    assert.equal(classifyHealth(60, 100), 'broken')    // 0.6
  })

  it('does not flatter an extension nobody has installed', () => {
    assert.equal(classifyHealth(0, 0), 'unknown')
    assert.equal(classifyHealth(3, 0), 'broken')
  })
})
