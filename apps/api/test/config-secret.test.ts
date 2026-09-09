// Reading the configuration must not require a secret you are not going to use.
//
// `jwtSecret` was evaluated while this module was being built, so importing it
// for any reason demanded a token-signing secret. The database module imports
// config to read a pool timeout, and every maintenance entry point imports the
// database module — so `docker compose --profile founder run --rm founder`
// died on `Missing required env var: JWT_SECRET` before it opened a connection,
// and the `seed` and `enrich` services would have done the same. None of them
// ever signs a token.
//
// The two halves have to hold together: the module must import without one,
// and asking for the secret must still refuse when there is none. The point of
// the check was never "have a JWT_SECRET variable" — it is that the API cannot
// start with a missing or placeholder secret and discover it at the first
// sign-in.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const API = fileURLToPath(new URL('../', import.meta.url))

/**
 * Run a snippet in a fresh process with a controlled environment.
 *
 * A child process, not this one: the config module is evaluated once per
 * process and these cases need different environments, so they cannot share.
 */
function run (source: string, env: Record<string, string | undefined>): string {
  const clean = { ...process.env, ...env }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete clean[key]
  return execFileSync(process.execPath, ['--experimental-strip-types', '-e', source], {
    cwd: API, env: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

const PROD = { NODE_ENV: 'production', JWT_SECRET: undefined, DATABASE_URL: 'postgres://yume:yume@127.0.0.1:5432/yume' }

describe('config without a JWT secret', () => {
  test('imports, so a maintenance script can read a database setting', () => {
    const out = run(
      "import('./src/config.ts').then(m => console.log('timeout=' + m.config.dbStatementTimeoutMs))",
      PROD
    )
    assert.match(out, /timeout=\d+/, `importing config in production without a secret failed: ${out}`)
  })

  test('the database module imports too — that is the one the scripts pull in', () => {
    const out = run(
      "import('./src/infrastructure/database/index.ts').then(m => console.log('pool=' + (m.pool ? 'built' : 'missing')))",
      PROD
    )
    assert.equal(out, 'pool=built', `importing the database module without a secret failed: ${out}`)
  })

  test('but reading the secret still refuses', () => {
    const out = run(
      `import('./src/config.ts').then(m => {
         try { void m.config.jwtSecret; console.log('NO ERROR') }
         catch (e) { console.log('threw: ' + e.message) }
       })`,
      PROD
    )
    assert.match(out, /^threw: Missing required env var: JWT_SECRET$/, out)
  })

  test('and a placeholder is still refused in production', () => {
    // Laziness must not turn "start insecure" into a runtime surprise.
    for (const secret of ['dev-only-jwt-secret', 'please-change-me-now-abcdefghijklmno', 'short']) {
      const out = run(
        `import('./src/config.ts').then(m => {
           try { void m.config.jwtSecret; console.log('NO ERROR') }
           catch (e) { console.log('threw') }
         })`,
        { ...PROD, JWT_SECRET: secret }
      )
      assert.equal(out, 'threw', `${secret} was accepted in production`)
    }
  })

  test('a real secret is returned unchanged', () => {
    const secret = 'a'.repeat(48)
    const out = run(
      "import('./src/config.ts').then(m => console.log(m.config.jwtSecret))",
      { ...PROD, JWT_SECRET: secret }
    )
    assert.equal(out, secret)
  })
})
