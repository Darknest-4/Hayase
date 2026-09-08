// Password hashing with Node's built-in scrypt (OWASP-recommended params).
// Format: scrypt$N$r$p$salt$hash — self-describing so params can be raised
// later and old hashes still verify.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

function scryptAsync (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => err ? reject(err) : resolve(key))
  })
}

const N = 131072 // 2^17
const r = 8
const p = 1
const KEYLEN = 64

export async function hashPassword (password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword (password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, rr, pp, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64!, 'base64')
  const expected = Buffer.from(hashB64!, 'base64')
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(n), r: Number(rr), p: Number(pp), maxmem: 256 * 1024 * 1024
  })
  return timingSafeEqual(actual, expected)
}
