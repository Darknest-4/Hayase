// Themes.
//
// A theme used to be an extension: a package in a store, sandboxed in a
// worker, asked over a message channel for a list of colours. That is a great
// deal of machinery for twelve hex values, and it meant an operator could not
// put their own palette in front of their own viewers without publishing a
// package to a store.
//
// It is a table now. Which moves the interesting problem: the values an
// operator types are interpolated into a CSS custom property in every
// viewer's browser, so most of what is tested here is the boundary between a
// colour and a stylesheet.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { validColour, badToken } from '../src/lib/colour.ts'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'themes-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('colour validation', () => {
  // No database needed: this is the guard itself, and it is the one piece of
  // this feature that a mistake in is a defacement of every page.

  test('accepts the shapes a colour comes in', () => {
    for (const value of [
      '#fff', '#ffff', '#7c5cff', '#7c5cffaa',
      'hsl(248 72% 68%)', 'hsl(248, 72%, 68%)', 'hsla(248 72% 68% / 0.5)',
      'rgb(124 92 255)', 'rgba(124, 92, 255, 0.4)',
      'oklch(70% 0.15 250)', 'rebeccapurple', 'red'
    ]) {
      assert.equal(validColour(value), true, `${value} was refused`)
    }
  })

  test('refuses anything that could close the declaration', () => {
    // The attack this exists for: the value lands inside `--accent: HERE;` in
    // a <style> element, so a closing brace turns a colour into a stylesheet.
    for (const value of [
      'red; } body { display: none }',
      'red;}html{opacity:0}',
      'url(https://evil.invalid/beacon.png)',
      'var(--anything)',
      'color-mix(in srgb, red, blue)',
      'expression(alert(1))',
      '#fff</style><script>alert(1)</script>',
      '@import "https://evil.invalid/x.css"',
      'a'.repeat(200)
    ]) {
      assert.equal(validColour(value), false, `${value} was accepted`)
    }
  })

  test('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      assert.equal(validColour(value), false, `${JSON.stringify(value)} was accepted`)
    }
  })

  test('checks token names as well as their values', () => {
    assert.equal(badToken({ '--accent': '#fff' }), null)
    assert.equal(badToken({}), null)
    assert.equal(badToken(null), null)
    // A name is a custom property or it is nothing: without the check, a key
    // of `color: red; --x` would smuggle a second declaration in.
    assert.match(String(badToken({ accent: '#fff' })), /custom-property/)
    assert.match(String(badToken({ '--a; color': '#fff' })), /custom-property/)
    assert.match(String(badToken({ '--accent': 'red; }' })), /not a colour/)
    assert.match(String(badToken([1, 2])), /object/)
  })
})

describe('theme API', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  const slugs: string[] = []
  let admin = ''
  let plain = ''

  async function account (role?: string): Promise<string> {
    const username = 'thm_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/plugins/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    admin = await account('admin')
    plain = await account()
  })

  after(async () => {
    if (slugs.length) await pool.query('DELETE FROM themes WHERE slug = ANY($1)', [slugs])
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    await app?.close()
    await pool?.end()
  })

  async function create (body: Record<string, unknown>, token = admin): Promise<{ status: number, id?: string, body: string }> {
    const res = await app.inject({ method: 'POST', url: '/v1/admin/themes', headers: as(token), payload: body })
    if (typeof body.slug === 'string') slugs.push(body.slug)
    return { status: res.statusCode, id: (res.json() as { id?: string })?.id, body: res.body }
  }

  test('the theme list is public', async () => {
    // A signed-out visitor must get the site's colours. Requiring a token
    // would mean the page repaints when they sign in, which is worse than
    // serving a list of hex values to anybody who asks.
    const res = await app.inject({ url: '/v1/themes' })
    assert.equal(res.statusCode, 200, res.body)
    const themes = (res.json() as { data: Array<{ slug: string, is_default: boolean }> }).data
    assert.ok(themes.length >= 14, `only ${themes.length} themes seeded`)
    assert.equal(themes.filter(t => t.is_default).length, 1, 'there must be exactly one default')
  })

  test('an operator can add a theme', async () => {
    const slug = 'test-' + randomBytes(3).toString('hex')
    const res = await create({ slug, name: 'Test', base: 'dark', accent: '#7c5cff', sort: 500 })
    assert.equal(res.status, 201, res.body)
    const list = await app.inject({ url: '/v1/themes' })
    assert.ok((list.json() as { data: Array<{ slug: string }> }).data.some(t => t.slug === slug))
  })

  test('a colour that is not a colour is refused with a reason', async () => {
    const res = await create({
      slug: 'test-' + randomBytes(3).toString('hex'),
      name: 'Bad', base: 'dark', accent: 'red; } body { display: none }'
    })
    assert.equal(res.status, 400, res.body)
    // The message has to teach, or the operator retypes the same thing.
    assert.match(res.body, /not a colour|hex value/)
  })

  test('token overrides are checked the same way', async () => {
    const res = await create({
      slug: 'test-' + randomBytes(3).toString('hex'),
      name: 'Bad tokens', base: 'dark',
      tokens: { '--bg': 'url(https://evil.invalid/x.png)' }
    })
    assert.equal(res.status, 400, res.body)
  })

  test('a disabled theme leaves the picker but stays in the editor', async () => {
    const slug = 'test-' + randomBytes(3).toString('hex')
    const { id } = await create({ slug, name: 'Hidden', base: 'dark', accent: '#123456' })
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/admin/themes/${id}`, headers: as(admin), payload: { enabled: false }
    })
    assert.equal(patch.statusCode, 200, patch.body)

    const list = await app.inject({ url: '/v1/themes' })
    assert.equal((list.json() as { data: Array<{ slug: string }> }).data.some(t => t.slug === slug), false)
    const editor = await app.inject({ url: '/v1/admin/themes', headers: as(admin) })
    assert.ok((editor.json() as { data: Array<{ slug: string }> }).data.some(t => t.slug === slug))
  })

  test('making one theme default un-defaults the other', async () => {
    // The partial unique index allows exactly one, so this is not a nicety —
    // getting it wrong is a constraint violation on an ordinary edit.
    const slug = 'test-' + randomBytes(3).toString('hex')
    const { id } = await create({ slug, name: 'New default', base: 'light', accent: '#334455' })
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/admin/themes/${id}`, headers: as(admin), payload: { isDefault: true }
    })
    assert.equal(patch.statusCode, 200, patch.body)

    const defaults = (await pool.query('SELECT slug FROM themes WHERE is_default')).rows
    assert.equal(defaults.length, 1)
    assert.equal(defaults[0].slug, slug)

    // Put it back, so the rest of the suite and the seeded default agree.
    const original = (await pool.query("SELECT id FROM themes WHERE slug = 'default'")).rows[0]
    await app.inject({
      method: 'PATCH', url: `/v1/admin/themes/${original.id}`, headers: as(admin), payload: { isDefault: true }
    })
  })

  test('the default theme cannot be disabled or deleted out from under viewers', async () => {
    const original = (await pool.query("SELECT id FROM themes WHERE is_default")).rows[0]
    const disable = await app.inject({
      method: 'PATCH', url: `/v1/admin/themes/${original.id}`, headers: as(admin), payload: { enabled: false }
    })
    assert.equal(disable.statusCode, 400, disable.body)
    const remove = await app.inject({ method: 'DELETE', url: `/v1/admin/themes/${original.id}`, headers: as(admin) })
    assert.equal(remove.statusCode, 400, remove.body)
  })

  test('a built-in theme cannot be deleted or renamed', async () => {
    // Its slug is what a viewer's saved choice points at: changing it would
    // silently reset everybody using that theme.
    const builtIn = (await pool.query("SELECT id FROM themes WHERE built_in AND NOT is_default LIMIT 1")).rows[0]
    const remove = await app.inject({ method: 'DELETE', url: `/v1/admin/themes/${builtIn.id}`, headers: as(admin) })
    assert.equal(remove.statusCode, 400, remove.body)
    const rename = await app.inject({
      method: 'PATCH', url: `/v1/admin/themes/${builtIn.id}`, headers: as(admin), payload: { slug: 'renamed' }
    })
    assert.equal(rename.statusCode, 400, rename.body)
    // Recolouring one is fine, though — that is the point of having them.
    const before = (await pool.query('SELECT accent FROM themes WHERE id = $1', [builtIn.id])).rows[0].accent
    try {
      const recolour = await app.inject({
        method: 'PATCH', url: `/v1/admin/themes/${builtIn.id}`, headers: as(admin), payload: { accent: '#abcdef' }
      })
      assert.equal(recolour.statusCode, 200, recolour.body)
      assert.equal((await pool.query('SELECT accent FROM themes WHERE id = $1', [builtIn.id])).rows[0].accent, '#abcdef')
    } finally {
      // Put the seeded colour back. The built-in rows outlive the test run,
      // and a suite that leaves the deployment a different colour every time
      // it passes is not a test, it is a paint job.
      await pool.query('UPDATE themes SET accent = $2 WHERE id = $1', [builtIn.id, before])
    }
  })

  test('a theme an operator added can be deleted', async () => {
    const slug = 'test-' + randomBytes(3).toString('hex')
    const { id } = await create({ slug, name: 'Temporary', base: 'dark', accent: '#010203' })
    const res = await app.inject({ method: 'DELETE', url: `/v1/admin/themes/${id}`, headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
  })

  test('the editor is invisible without the permission', async () => {
    for (const [method, url] of [['GET', '/v1/admin/themes'], ['POST', '/v1/admin/themes']] as Array<[string, string]>) {
      const res = await app.inject({ method: method as 'GET', url, headers: as(plain), payload: {} })
      assert.equal(res.statusCode, 404, `${method} ${url} answered ${res.statusCode}`)
    }
    // The public list stays public, though: it is chrome, not administration.
    assert.equal((await app.inject({ url: '/v1/themes' })).statusCode, 200)
  })
})
