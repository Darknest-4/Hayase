// What a failed GraphQL operation tells the caller in production.
//
// A resolver's own refusal and the parser's syntax and validation errors are
// written for the caller and pass through. Anything else — a database error
// quoting SQL, a stack — is replaced with the request id, exactly as the REST
// error handler replaces a 500. Before this, mercurius returned the raw message.

import assert from 'node:assert/strict'
import { after, before, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.NODE_ENV = 'production'
process.env.JWT_SECRET = 'graphql-errors-production-secret-0123456789abcdef'
delete process.env.TRUST_PROXY

describe('GraphQL errors in production', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>
  let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
  let settings: typeof import('../src/modules/settings/site-settings.ts')['settings']

  before(async () => {
    const [{ buildApp }, db, site] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/site-settings.ts')
    ])
    app = await buildApp()
    await app.ready()
    pool = db.pool
    settings = site.settings
  })

  after(async () => {
    mock.restoreAll()
    await app?.close()
  })

  const ask = async (query: string) => {
    mock.method(settings, 'requiresLogin', async () => false)
    const res = await app.inject({ method: 'POST', url: '/graphql', payload: { query } })
    return res.json() as { data?: unknown, errors?: Array<{ message: string }> }
  }

  it('masks an internal error and names the request instead', async () => {
    const original = pool.query.bind(pool)
    mock.method(pool, 'query', async (text: unknown, params?: unknown) => {
      if (typeof text === 'string' && text.includes('FROM anime a WHERE a.id = $1')) {
        throw new Error('relation "secret_internal_table" does not exist')
      }
      return await (original as (t: unknown, p?: unknown) => Promise<unknown>)(text, params)
    })
    try {
      const body = await ask('{ anime(id: "00000000-0000-4000-8000-000000000000") { id } }')
      const message = body.errors?.[0]?.message ?? ''
      assert.match(message, /^Internal error — quote request /)
      assert.ok(!message.includes('secret_internal_table'), 'the database message reached the caller')
    } finally {
      mock.restoreAll()
    }
  })

  it('passes a syntax error through', async () => {
    const body = await ask('{ anime(')
    assert.match(body.errors?.[0]?.message ?? '', /Syntax Error/)
  })

  it('passes a validation error through', async () => {
    const body = await ask('{ noSuchField }')
    assert.match(body.errors?.[0]?.message ?? '', /Cannot query field/)
  })

  it('passes a deliberate refusal through', async () => {
    const body = await ask('{ schedule(from: "1900-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z") { episodeId } }')
    assert.match(body.errors?.[0]?.message ?? '', /A schedule spans at most/)
  })
})
