// Security hardening tests. These use Fastify's inject() so no server socket
// and no database connection are needed — none of the exercised routes query.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'

const { buildApp } = await import('../src/app.ts')

/** Fresh app per test: the rate-limit store is in-process, so tests must not share it. */
const freshApp = async (): Promise<Awaited<ReturnType<typeof buildApp>>> => buildApp()

describe('security headers', () => {
  it('sets the hardening headers on responses', async () => {
    const app = await freshApp()
    const res = await app.inject({ method: 'GET', url: '/v1/health' })
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'DENY')
    assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin')
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin')
    await app.close()
  })

  it('ships a CSP that blocks inline scripts and framing', async () => {
    const app = await freshApp()
    const res = await app.inject({ method: 'GET', url: '/v1/health' })
    const csp = String(res.headers['content-security-policy'])
    assert.match(csp, /script-src 'self'/)        // no 'unsafe-inline' for scripts
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-eval/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /object-src 'none'/)
    // the UI genuinely needs inline style attributes, so this one is expected
    assert.match(csp, /style-src[^;]*'unsafe-inline'/)
    await app.close()
  })
})

describe('rate limiting', () => {
  it('never throttles health checks (orchestrators poll them)', async () => {
    const app = await freshApp()
    const codes = new Set<number>()
    for (let i = 0; i < 40; i++) {
      codes.add((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode)
    }
    assert.deepEqual([...codes], [200])
    await app.close()
  })

  it('throttles unauthenticated bursts and answers in problem+json', async () => {
    process.env.RATE_LIMIT_MAX = '5'
    const app = await freshApp()
    let limited: Awaited<ReturnType<typeof app.inject>> | undefined
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/config' })
      if (res.statusCode === 429) { limited = res; break }
    }
    assert.ok(limited, 'expected a 429 within 10 requests at max=5')
    const body = limited!.json() as { type: string, title: string, status: number, detail: string }
    assert.equal(body.status, 429)
    assert.equal(body.title, 'Too Many Requests')
    assert.match(body.detail, /retry in/i)
    await app.close()
    delete process.env.RATE_LIMIT_MAX
  })
})

describe('request limits', () => {
  it('rejects oversized bodies with 413', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ identifier: 'x'.repeat(2_000_000), password: 'whatever1' })
    })
    assert.equal(res.statusCode, 413)
    await app.close()
  })
})

describe('monitoring authorisation', () => {
  it('refuses anonymous access to every admin monitoring endpoint', async () => {
    const app = await freshApp()
    for (const url of ['/current', '/history?metric=cpu.usage_pct', '/thresholds', '/queues']) {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/monitoring' + url })
      assert.equal(res.statusCode, 401, `${url} should require authentication`)
    }
    await app.close()
  })

  it('rejects a forged bearer token', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/monitoring/current',
      headers: { authorization: 'Bearer not.a.real.token' }
    })
    assert.equal(res.statusCode, 401)
    await app.close()
  })
})

describe('production secret validation', () => {
  // config.ts validates at import, so each case runs in its own process
  const loadConfig = (env: Record<string, string>): { ok: boolean, message: string } => {
    try {
      const out = execFileSync(process.execPath,
        ['--experimental-strip-types', '-e', 'import("./src/config.ts").then(() => console.log("OK"))'],
        { env: { ...process.env, DATABASE_URL: 'postgres://x@localhost/x', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { ok: out.includes('OK'), message: out }
    } catch (error) {
      return { ok: false, message: String((error as { stderr?: string }).stderr ?? error) }
    }
  }

  it('refuses to boot in production with the development placeholder', () => {
    const result = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-jwt-secret' })
    assert.equal(result.ok, false)
    assert.match(result.message, /placeholder/i)
  })

  it('refuses a secret that is too short to be safe', () => {
    const result = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short-secret' })
    assert.equal(result.ok, false)
    assert.match(result.message, /too short/i)
  })

  it('accepts a properly generated secret', () => {
    const result = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'B'.repeat(64) })
    assert.equal(result.ok, true)
  })

  it('never allows wildcard CORS in production', () => {
    const out = execFileSync(process.execPath,
      ['--experimental-strip-types', '-e', 'import("./src/config.ts").then(m => console.log(JSON.stringify(m.config.corsOrigins)))'],
      { env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'C'.repeat(64), CORS_ORIGINS: '*', DATABASE_URL: 'postgres://x@localhost/x' }, encoding: 'utf8' })
    assert.match(out, /false/, 'wildcard must collapse to same-origin in production')
  })
})
