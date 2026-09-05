// What must never reach Discord, and who is allowed to ask the bot to speak.
//
// A security alert is the message most likely to be carrying the thing it is
// warning about: a failed-login event that helpfully includes the password
// attempted, a rate-limit alert with the API key that hit it. Discord messages
// are readable by every staff member, retained indefinitely, and entirely
// outside our control — so this is the last gate, and it is tested as one.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, test } from 'node:test'

import { maskIp, redact } from '../src/notify.ts'
import { verifySignature } from '../src/interactions.ts'

describe('redaction', () => {
  test('removes every field whose name says it is a secret', () => {
    const cleaned = redact({
      password: 'hunter2',
      apiKey: 'sk-live-abc',
      api_key: 'sk-live-abc',
      sessionToken: 'eyJ...',
      resetToken: 'r-123',
      Authorization: 'Bearer abc',
      cookie: 'sid=1',
      privateKey: '-----BEGIN',
      passwordHash: 'argon2...',
      mfaCode: '123456'
    }) as Record<string, string>

    for (const [key, value] of Object.entries(cleaned)) {
      assert.equal(value, '[redacted]', `${key} survived`)
    }
  })

  test('redacts the whole value, never a prefix of it', () => {
    // Half a token is still a clue, and the useful signal is that the field
    // was present at all.
    const cleaned = redact({ token: 'abcdefghijklmnop' }) as { token: string }
    assert.equal(cleaned.token, '[redacted]')
    assert.ok(!cleaned.token.includes('abcd'))
  })

  test('finds secrets nested inside the payload', () => {
    const cleaned = redact({ event: { actor: { credentials: { password: 'x' } } } }) as never
    assert.equal((cleaned as { event: { actor: { credentials: string } } }).event.actor.credentials, '[redacted]')
  })

  test('keeps the fields that make an alert useful', () => {
    const cleaned = redact({ kind: 'auth_failure', attempts: 5, username: 'someone' }) as Record<string, unknown>
    assert.equal(cleaned.kind, 'auth_failure')
    assert.equal(cleaned.attempts, 5)
    assert.equal(cleaned.username, 'someone')
  })

  test('masks an IP wherever it appears, in a field or in prose', () => {
    // "The same network again" stays readable; the address does not leave.
    assert.equal(maskIp('192.168.44.10'), '192.168.x.x')
    const cleaned = redact({ ip: '203.0.113.45', summary: 'repeated failures from 203.0.113.45' }) as Record<string, string>
    assert.equal(cleaned.ip, '203.0.x.x')
    const summary = cleaned.summary ?? ''
    assert.ok(!summary.includes('203.0.113.45'), summary)
    assert.ok(summary.includes('203.0.x.x'))
  })

  test('does not recurse forever on a cyclic payload', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    assert.doesNotThrow(() => redact(cyclic))
  })
})

describe('interaction signatures', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  // The last 32 bytes of the SPKI DER are the key Discord gives you as hex.
  const hex = raw.subarray(raw.length - 32).toString('hex')

  const signed = (timestamp: string, body: string): string =>
    sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')

  test('accepts a request Discord really signed', () => {
    const body = JSON.stringify({ type: 1 })
    const timestamp = '1700000000'
    assert.equal(verifySignature(hex, signed(timestamp, body), timestamp, body), true)
  })

  test('rejects a body that changed after signing', () => {
    // The attack this stops: replaying a real signature with `/ban` swapped in.
    const timestamp = '1700000000'
    const signature = signed(timestamp, JSON.stringify({ type: 2, data: { name: 'help' } }))
    assert.equal(verifySignature(hex, signature, timestamp, JSON.stringify({ type: 2, data: { name: 'ban' } })), false)
  })

  test('rejects a reused signature under a different timestamp', () => {
    const body = JSON.stringify({ type: 1 })
    assert.equal(verifySignature(hex, signed('1700000000', body), '1700009999', body), false)
  })

  test('rejects garbage without throwing', () => {
    // Discord deliberately sends invalid signatures when registering an
    // endpoint and refuses it unless they are rejected — so this failing
    // closed is what makes setup work at all.
    const body = '{}'
    for (const [key, signature] of [[hex, 'not-hex'], ['short', 'aabb'], ['', ''], [hex, '']] as const) {
      assert.equal(verifySignature(key, signature, '1', body), false)
    }
  })
})
