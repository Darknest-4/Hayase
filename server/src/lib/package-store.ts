// Extension package storage.
//
// Until now the store recorded package_key / package_hash / package_size as
// free-form JSON supplied by the developer, with nowhere to put the actual
// bytes. Nothing could be downloaded, so the sandbox never had code to load —
// and the hash a client verified against was a number the publisher had made
// up, which proves nothing.
//
// Storage is content-addressed: the key IS the sha256 of the bytes, computed
// here from what was actually uploaded. That gives three properties for free:
//
//   * the recorded hash cannot disagree with the stored bytes,
//   * identical uploads collapse onto one blob,
//   * a stored package is immutable, so it can be cached forever downstream.
//
// The backend is the local filesystem, which is the right size for a single
// VPS: no S3 SDK, no MinIO container, no credentials to leak. Every call site
// goes through this module, so an object-storage backend can replace the four
// functions below without touching the routes.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where blobs live. A Docker volume in deployment; a temp dir in tests. */
export const PACKAGE_DIR = process.env.PACKAGE_DIR ?? join(tmpdir(), 'yume-packages')

/** Hard ceiling on a single package. An extension is source code, not media. */
export const MAX_PACKAGE_BYTES = Number(process.env.MAX_PACKAGE_BYTES ?? 5_000_000)

const HEX64 = /^[0-9a-f]{64}$/

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Blobs are sharded by the first byte of their hash so the directory never
 * grows to tens of thousands of entries in one node.
 */
function blobPath (hash: string): string {
  if (!HEX64.test(hash)) throw new Error('invalid package hash')
  return join(PACKAGE_DIR, hash.slice(0, 2), hash)
}

export interface StoredPackage {
  hash: string
  size: number
}

/**
 * Store bytes and return their content hash. The caller never supplies the
 * hash — that is the whole point.
 *
 * Writes to a temporary name and renames into place, so a crash mid-write can
 * never leave a truncated blob under a hash that claims to describe it.
 */
export async function put (bytes: Buffer): Promise<StoredPackage> {
  if (!bytes.length) throw new Error('package is empty')
  if (bytes.length > MAX_PACKAGE_BYTES) {
    throw new Error(`package is ${bytes.length} bytes, over the ${MAX_PACKAGE_BYTES} byte limit`)
  }

  const hash = sha256(bytes)
  const target = blobPath(hash)

  // identical content is already stored — nothing to do
  const existing = await statBlob(hash)
  if (existing) return existing

  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, bytes, { mode: 0o440 })
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => {})
    throw err
  }
  return { hash, size: bytes.length }
}

/** Size and hash of a stored blob, or undefined when it is not there. */
export async function statBlob (hash: string): Promise<StoredPackage | undefined> {
  try {
    const info = await stat(blobPath(hash))
    return { hash, size: info.size }
  } catch {
    return undefined
  }
}

/**
 * Read a blob back, re-verifying the digest.
 *
 * The check costs a hash over at most 5 MB and catches the case that matters:
 * bytes that changed on disk after they were reviewed. A mismatch is treated
 * as a missing package rather than served, because serving it would hand the
 * sandbox code nobody approved.
 */
export async function get (hash: string): Promise<Buffer | undefined> {
  let bytes: Buffer
  try {
    bytes = await readFile(blobPath(hash))
  } catch {
    return undefined
  }
  if (sha256(bytes) !== hash) return undefined
  return bytes
}

/**
 * A package is source code that runs inside the sandbox. The sandbox enforces
 * the real boundary, but a package that is not even text is never something a
 * reviewer meant to approve, so it is rejected at the door.
 */
export function looksLikeSource (bytes: Buffer): boolean {
  if (bytes.includes(0)) return false // NUL byte: a binary, not source
  const text = bytes.subarray(0, 4096).toString('utf8')
  return !text.includes('�') // invalid UTF-8 decoded to a replacement char
}
