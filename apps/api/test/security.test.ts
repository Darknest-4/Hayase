// Security hardening tests. These use Fastify's inject(), so no server socket
// is opened.
//
// The header used to claim no database connection was needed either, "because
// none of the exercised routes query". The monitoring endpoints do — that is
// the point of asserting they are refused — so a pool connection is opened and
// the pool has to be released, or the process outlives the test run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'

const { buildApp } = await import('../src/app.ts')

/**
 * Fresh app per test: the rate-limit store is in-process, so tests must not
 * share it.
 *
 * Every app is remembered so the `after` hook can close it. Each test also
 * closes its own on the way out, which is fine — but that line is the last one
 * in the test, so an assertion failing above it skips the close and leaks a
 * Fastify instance. Enough of those and the process never exits, which is how
 * a failing assertion here became a six-hour CI job instead of a red one.
 */
const opened: Array<Awaited<ReturnType<typeof buildApp>>> = []
const freshApp = async (): Promise<Awaited<ReturnType<typeof buildApp>>> => {
  const app = await buildApp()
  opened.push(app)
  return app
}

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
  /*
   * Build the application, do not merely import the configuration.
   *
   * These used to import config.ts and assert that the import threw, because
   * the secret was validated while that module was being evaluated. It is read
   * lazily now — importing config for a database timeout must not demand a
   * token-signing secret, or no maintenance script can run — so an import that
   * succeeds no longer says anything either way.
   *
   * What the check is actually for is unchanged and is what is asserted here:
   * the API refuses to *start* with a missing or placeholder secret, rather
   * than starting and discovering it at somebody's first sign-in.
   *
   * `cwd` is set explicitly. Without it the child resolved its import against
   * whatever directory the suite happened to be run from, so these passed
   * under `npm run test --workspace` and failed from the repository root —
   * which is how a real failure here would have been read as a path problem.
   */
  const API = fileURLToPath(new URL('../', import.meta.url))

  const boot = (env: Record<string, string>): { ok: boolean, message: string } => {
    try {
      const out = execFileSync(process.execPath,
        ['--experimental-strip-types', '-e',
          'import("./src/app.ts").then(m => m.buildApp()).then(app => app.close()).then(() => console.log("OK"))'],
        {
          cwd: API,
          env: { ...process.env, DATABASE_URL: 'postgres://x@localhost/x', ...env },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      return { ok: out.includes('OK'), message: out }
    } catch (error) {
      const e = error as { stdout?: string, stderr?: string }
      return { ok: false, message: String(e.stderr ?? '') + String(e.stdout ?? '') }
    }
  }

  it('refuses to boot in production with the development placeholder', () => {
    const result = boot({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-jwt-secret' })
    assert.equal(result.ok, false)
    assert.match(result.message, /placeholder/i)
  })

  it('refuses to boot in production with a secret that is too short to be safe', () => {
    const result = boot({ NODE_ENV: 'production', JWT_SECRET: 'short-secret' })
    assert.equal(result.ok, false)
    assert.match(result.message, /too short/i)
  })

  it('refuses to boot in production with no secret at all', () => {
    const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgres://x@localhost/x' }
    delete env.JWT_SECRET
    let message = ''
    try {
      execFileSync(process.execPath,
        ['--experimental-strip-types', '-e',
          'import("./src/app.ts").then(m => m.buildApp()).then(app => app.close()).then(() => console.log("OK"))'],
        { cwd: API, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      assert.fail('the API started in production with no JWT_SECRET')
    } catch (error) {
      message = String((error as { stderr?: string }).stderr ?? error)
    }
    assert.match(message, /JWT_SECRET/)
  })

  it('boots with a properly generated secret', () => {
    // The other direction: the refusals above must be about the secret and not
    // about the API being unable to start at all.
    const result = boot({ NODE_ENV: 'production', JWT_SECRET: 'B'.repeat(64) })
    assert.equal(result.ok, true, result.message)
  })

  it('never allows wildcard CORS in production', () => {
    const out = execFileSync(process.execPath,
      ['--experimental-strip-types', '-e', 'import("./src/config.ts").then(m => console.log(JSON.stringify(m.config.corsOrigins)))'],
      {
        cwd: API,
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'C'.repeat(64), CORS_ORIGINS: '*', DATABASE_URL: 'postgres://x@localhost/x' },
        encoding: 'utf8'
      })
    assert.match(out, /false/, 'wildcard must collapse to same-origin in production')
  })
})

// Release everything this file opened, whatever the tests above did.
//
// Closing an app a second time is a no-op the tests' own closes make likely,
// so it is swallowed; failing to close one is what actually costs something.
after(async () => {
  for (const app of opened) await app.close().catch(() => {})
  const { pool } = await import('../src/infrastructure/database/index.ts')
  await pool.end()
})
