// Belépés Discorddal a FŐOLDALON — valódi böngészőben, a Discord nélkül.
//
//   * a gomb csak beállított példányon látszik, és a Discord engedélyezési
//     lapjára visz (a kérés elfogva);
//   * a visszahívás után a böngésző a főoldalra ér, és a frissítő sütiből
//     munkamenetet vesz fel — a hozzáférési token SOHA nincs a címsorban;
//   * egy összekötetlen Discord-fiók üzenetet kap, nem munkamenetet.
//
// A kiszolgáló ebben a folyamatban fut: a Discord token-beváltását és a
// „ki vagyok" kérdést a kiszolgáló `fetch`-jénél hamisítjuk.

/* global document, localStorage, window */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(here, '..', '..', 'apps', 'web')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  chromium = null
}

if (!chromium && process.env.CI) {
  throw new Error('playwright could not be imported and CI is set.')
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

describe('belépés Discorddal a főoldalon', { skip: REASON }, () => {
  let server, browser, pool, base, page
  const username = 'dclgin' + randomBytes(4).toString('hex')
  const DISCORD_ID = '8' + String(Date.now()).padEnd(17, '2').slice(0, 17)
  let userId = ''
  let authorize = null
  let discordAzonosito = DISCORD_ID
  const eredetiFetch = globalThis.fetch

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'discord-login-e2e-secret-0123456789-abcdefghij'
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
    process.env.LOG_LEVEL ??= 'error'
    process.env.RATE_LIMIT_MAX ??= '100000'
    process.env.DISCORD_CLIENT_ID = '123456789012345678'
    process.env.DISCORD_CLIENT_SECRET = 'e2e-login-secret-NEM-VALODI'

    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`
    process.env.DISCORD_LOGIN_REDIRECT_URI = `${base}/v1/auth/discord/callback`

    await eredetiFetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    userId = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id
    await pool.query('INSERT INTO discord_links (user_id, discord_user_id) VALUES ($1, $2)', [userId, DISCORD_ID])

    // A Discord, a kiszolgáló felől: a kód beváltása és a „ki vagyok".
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    globalThis.fetch = async (url, init) => {
      const cim = String(url)
      if (cim === 'https://discord.com/api/v10/oauth2/token') return json({ access_token: 'e2e-hozzaferes', token_type: 'Bearer' })
      if (cim === 'https://discord.com/api/v10/users/@me') return json({ id: discordAzonosito })
      return await eredetiFetch(url, init)
    }

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(() => {
      window.__csp = []
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective))
    })
    page = await context.newPage()
    await page.route(/^https:\/\/discord\.com\//, route => { authorize = route.request().url(); return route.abort() })
    await page.route(/^https:\/\/(?!discord\.com)/, route => route.abort())
  })

  after(async () => {
    globalThis.fetch = eredetiFetch
    try {
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      delete process.env.DISCORD_CLIENT_ID
      delete process.env.DISCORD_CLIENT_SECRET
      delete process.env.DISCORD_LOGIN_REDIRECT_URI
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  const gomb = () => page.locator('.auth-alt button')

  /** A belépőlapról a Discordig: a gomb, és az elfogott engedélyezési cím állapota. */
  const inditas = async () => {
    authorize = null
    await page.goto('about:blank')
    await page.goto(`${base}/#/login`, { waitUntil: 'domcontentloaded' })
    await gomb().waitFor({ timeout: 15000 })
    await gomb().click()
    await page.waitForTimeout(1200)
    assert.ok(authorize, 'nem indult el a Discord felé')
    return new URL(authorize).searchParams.get('state')
  }

  it('a gomb a Discord engedélyezési lapjára visz, csak azonosítót kérve', async () => {
    await inditas()
    const url = new URL(authorize)
    assert.equal(url.pathname, '/oauth2/authorize')
    assert.equal(url.searchParams.get('scope'), 'identify')
    assert.equal(url.searchParams.get('redirect_uri'), `${base}/v1/auth/discord/callback`)
  })

  it('a visszahívás után belép — a token nincs a címben, a munkamenet a sütiből jön', async () => {
    const state = await inditas()
    const cimek = []
    page.on('framenavigated', f => { if (f === page.mainFrame()) cimek.push(f.url()) })
    await page.goto(`${base}/v1/auth/discord/callback?code=e2e-kod&state=${encodeURIComponent(state)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(localStorage.getItem('yume-auth')), null, { timeout: 15000 })
    const token = await page.evaluate(() => JSON.parse(localStorage.getItem('yume-auth')).accessToken)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    assert.equal(payload.sub, userId, 'nem a saját fiókjába lépett be')
    for (const c of cimek) assert.ok(!c.includes(token) && !/access|token=/i.test(c), `token a címsorban: ${c}`)
    await page.waitForTimeout(800)
    assert.doesNotMatch(await page.evaluate(() => window.location.hash), /login/, 'a belépőlapon maradt')
  })

  it('összekötetlen Discord-fiókkal üzenetet kap, nem munkamenetet', async () => {
    await page.evaluate(() => localStorage.removeItem('yume-auth'))
    await page.context().clearCookies()
    discordAzonosito = '899999999999999998'
    try {
      const state = await inditas()
      await page.goto(`${base}/v1/auth/discord/callback?code=e2e-kod&state=${encodeURIComponent(state)}`, { waitUntil: 'domcontentloaded' })
      // Az űrlapnak is van (rejtett) hibasora — a látható az, amelyik szól.
      await page.waitForSelector('.auth-error:not([hidden])', { timeout: 15000 })
      assert.match(await page.locator('.auth-error:not([hidden])').innerText(), /nincs YUME-fiók kötve/)
      assert.equal(await page.evaluate(() => localStorage.getItem('yume-auth')), null)
      assert.equal(await page.evaluate(() => window.location.hash), '#/login', 'a kimenet a címben maradt')
    } finally {
      discordAzonosito = DISCORD_ID
    }
  })

  it('beállítatlan példányon nincs gomb', async () => {
    const vissza = process.env.DISCORD_LOGIN_REDIRECT_URI
    delete process.env.DISCORD_LOGIN_REDIRECT_URI
    try {
      await page.evaluate(() => localStorage.removeItem('yume-auth'))
      await page.goto('about:blank')
      await page.goto(`${base}/#/login`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.auth-card form, .auth-form', { timeout: 15000 })
      await page.waitForTimeout(800)
      assert.equal(await gomb().count(), 0, 'nem működő folyamathoz is kínál gombot')
    } finally {
      process.env.DISCORD_LOGIN_REDIRECT_URI = vissza
    }
  })

  it('nem sértett CSP-szabályt', async () => {
    assert.deepEqual(await page.evaluate(() => window.__csp), [])
  })
})
