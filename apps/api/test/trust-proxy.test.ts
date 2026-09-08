// Who is allowed to tell us a client's address.
//
// request.ip is the rate limiter's key. Get this wrong in either direction and
// the limiter stops being a limiter:
//
//   too trusting   any client sets X-Forwarded-For, every fabricated address
//                  gets a fresh quota, and the expensive login hash becomes a
//                  brute-force and CPU-exhaustion vector. Measured before the
//                  fix: 8 of 8 attempts through an exhausted limit.
//
//   too closed     request.ip is the reverse proxy for every request, so the
//                  whole internet shares one bucket and real users lock each
//                  other out. The limit still "works" and protects nothing.
//
// The second is the one this file is mostly about, because it is the one that
// arrives by upgrade rather than by edit: Fastify 5.12 changed a numeric
// trustProxy to mean "trust nobody", and a hop count was a documented setting
// here. Nothing would have failed. The limiter would just have stopped working.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

/**
 * config.ts reads the environment once at import, so each case needs its own
 * module instance. The cache-busting query is the supported way to get one.
 */
async function trustProxyFor (value: string | undefined, { prod = false } = {}): Promise<unknown> {
  const previous = { tp: process.env.TRUST_PROXY, env: process.env.NODE_ENV, dsn: process.env.DATABASE_URL }
  if (value === undefined) delete process.env.TRUST_PROXY
  else process.env.TRUST_PROXY = value
  process.env.NODE_ENV = prod ? 'production' : 'test'
  process.env.JWT_SECRET ??= 'trust-proxy-secret-long-enough-0123456789'
  // Production has no default DSN — deliberately, so a real deployment cannot
  // fall back to localhost. This test is about trustProxy, so it supplies one
  // rather than asserting on an unrelated refusal.
  process.env.DATABASE_URL ??= 'postgres://yume:yume@127.0.0.1:5432/yume'
  try {
    const mod = await import(`../src/config.ts?trust=${encodeURIComponent(String(value))}-${prod}-${Math.random()}`)
    return mod.config.trustProxy
  } finally {
    if (previous.tp === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = previous.tp
    if (previous.env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous.env
    if (previous.dsn === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.dsn
  }
}

describe('who may set X-Forwarded-For', () => {
  test('trusts nobody by default', async () => {
    assert.equal(await trustProxyFor(undefined), false)
    assert.equal(await trustProxyFor(''), false)
    assert.equal(await trustProxyFor('false'), false)
  })

  test('takes an address or a subnet', async () => {
    assert.deepEqual(await trustProxyFor('172.16.0.0/12'), ['172.16.0.0/12'])
    assert.deepEqual(await trustProxyFor('10.0.0.1, 172.16.0.0/12'), ['10.0.0.1', '172.16.0.0/12'])
  })

  test('refuses a bare hop count, naming what to use instead', async () => {
    // Fastify 5.12: `if (typeof tp === 'number') return () => false`. A hop
    // count cannot check who the immediate peer is, so they fail closed — and
    // failing closed here means one rate-limit bucket for every client alive.
    // Refusing at boot puts the failure where somebody is looking.
    await assert.rejects(() => trustProxyFor('1'), /hop count/)
    await assert.rejects(() => trustProxyFor('2'), /TRUST_PROXY=2/)
    // And the message has to say what a working value looks like.
    await assert.rejects(() => trustProxyFor('1'), /TRUST_PROXY=172\.16\.0\.0\/12/)
  })

  test('never yields a number, whatever it is given', async () => {
    // The type says so, but the type is what quietly changed under us. This is
    // the assertion that survives the next upgrade.
    for (const value of ['172.16.0.0/12', '10.0.0.1', 'true']) {
      assert.notEqual(typeof await trustProxyFor(value), 'number', value)
    }
  })

  test('refuses blanket trust in production, allows it in development', async () => {
    assert.equal(await trustProxyFor('true'), true)
    await assert.rejects(() => trustProxyFor('true', { prod: true }), /bypass rate limiting/)
  })
})
