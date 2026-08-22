// Package storage is the point where "the bytes a reviewer approved" and "the
// bytes a sandbox runs" are supposed to be the same thing, so the properties
// that guarantee that are asserted directly.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, before } from 'node:test'

// the module reads PACKAGE_DIR at import time, so point it at a scratch dir first
const dir = await mkdtemp(join(tmpdir(), 'pkgstore-'))
process.env.PACKAGE_DIR = dir

const { put, get, statBlob, sha256, looksLikeSource, PACKAGE_DIR, MAX_PACKAGE_BYTES } =
  await import('../src/lib/package-store.ts')

const source = Buffer.from('export default { async single () { return [] } }\n')
const digest = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('content addressing', () => {
  before(() => { assert.equal(PACKAGE_DIR, dir) })

  test('the key is the digest of what was actually stored', async () => {
    const stored = await put(source)
    assert.equal(stored.hash, digest(source))
    assert.equal(stored.size, source.length)
  })

  test('a stored package reads back byte for byte', async () => {
    const { hash } = await put(source)
    assert.deepEqual(await get(hash), source)
  })

  test('identical uploads collapse onto one blob', async () => {
    const a = await put(source)
    const b = await put(Buffer.from(source))
    assert.equal(a.hash, b.hash)
  })

  test('different bytes never share a key', async () => {
    const a = await put(Buffer.from('export default { a: 1 }'))
    const b = await put(Buffer.from('export default { a: 2 }'))
    assert.notEqual(a.hash, b.hash)
  })

  test('sha256 matches the platform digest', () => {
    assert.equal(sha256(source), digest(source))
  })
})

describe('serving refuses what it cannot vouch for', () => {
  test('bytes tampered with after storage are not served', async () => {
    const { hash } = await put(Buffer.from('export default { original: true }'))
    // simulate an on-disk edit after review
    await writeFile(join(dir, hash.slice(0, 2), hash), 'export default { injected: true }')
    assert.equal(await get(hash), undefined, 'a blob that no longer matches its hash must not be served')
  })

  test('an unknown hash reads back as missing, not as an error', async () => {
    assert.equal(await get('b'.repeat(64)), undefined)
    assert.equal(await statBlob('b'.repeat(64)), undefined)
  })

  test('a malformed hash is rejected rather than used as a path', async () => {
    for (const bad of ['../../etc/passwd', 'nothex', '', 'a'.repeat(63)]) {
      assert.equal(await get(bad), undefined, `${JSON.stringify(bad)} must not resolve`)
    }
  })

  test('a path-traversal hash cannot escape the store', async () => {
    const outside = join(dir, '..', 'escaped.js')
    await writeFile(outside, 'export default { escaped: true }')
    assert.equal(await get('../escaped.js'), undefined)
    // and the file is still where it was, untouched by the store
    assert.match(await readFile(outside, 'utf8'), /escaped/)
  })
})

describe('upload limits', () => {
  test('an empty package is rejected', async () => {
    await assert.rejects(put(Buffer.alloc(0)), /empty/)
  })

  test('an oversized package is rejected', async () => {
    await assert.rejects(put(Buffer.alloc(MAX_PACKAGE_BYTES + 1, 0x61)), /over the/)
  })

  test('binaries are not source code', () => {
    assert.equal(looksLikeSource(Buffer.from([0x00, 0x01, 0x02])), false)
    assert.equal(looksLikeSource(Buffer.from('\x7fELF\x02\x01\x01\x00')), false) // ELF header carries a NUL
    assert.equal(looksLikeSource(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false)     // JPEG: invalid UTF-8
    assert.equal(looksLikeSource(source), true)
  })

  test('valid UTF-8 source with non-ASCII text is accepted', () => {
    assert.equal(looksLikeSource(Buffer.from('// árvíztűrő tükörfúrógép\nexport default {}')), true)
  })
})
