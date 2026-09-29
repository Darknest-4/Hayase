// A Discord-fiók összekötése a FŐOLDALRÓL (Beállítások → Fiók).
//
// Az összekötés eddig csak a Discord-vezérlőpulton indulhatott — az viszont
// 2026-09-29 óta jogosultsághoz kötött, és a bot `/link` parancsa ide küldi a
// tagokat. Ez a teszt a teljes kört méri valódi böngészőben, a Discord nélkül:
//
//   * a gomb a Discord engedélyezési lapjára visz (a kérés elfogva);
//   * a Discordnál „mégse" után a böngésző a FŐOLDALRA tér vissza, üzenettel,
//     és a kimenet paramétere kikerül a címből;
//   * összekötve a név látszik, a bontás megerősítéssel törli a kapcsolatot;
//   * beállítatlan OAuth mellett nincs gomb — csak kimondja, hogy nincs.

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

describe('a Discord-fiók összekötése a főoldalról', { skip: REASON }, () => {
  let server, browser, pool, base, page
  const username = 'dclink' + randomBytes(4).toString('hex')
  let authorize = null

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'discord-link-e2e-secret-0123456789-abcdefghij'
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
    process.env.LOG_LEVEL ??= 'error'
    process.env.RATE_LIMIT_MAX ??= '100000'
    // Próbaértékek: az OAuth „be van állítva", de a Discordig semmi nem jut el.
    process.env.DISCORD_CLIENT_ID = '123456789012345678'
    process.env.DISCORD_CLIENT_SECRET = 'e2e-proba-secret-NEM-VALODI'

    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`
    // A visszahívás ide hozza vissza a böngészőt (futás közben olvassa).
    process.env.PUBLIC_URL = base
    process.env.DISCORD_REDIRECT_URI = `${base}/v1/discord/oauth/callback`

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    const account = await res.json()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await context.addInitScript(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify({ accessToken: tokens.accessToken }))
      window.__csp = []
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective))
    }, account)
    page = await context.newPage()
    await page.route(/^https:\/\/discord\.com\//, route => { authorize = route.request().url(); return route.abort() })
    await page.route(/^https:\/\/(?!discord\.com)/, route => route.abort())
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      delete process.env.DISCORD_CLIENT_ID
      delete process.env.DISCORD_CLIENT_SECRET
      delete process.env.DISCORD_REDIRECT_URI
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  const nyit = async () => {
    await page.goto('about:blank')
    await page.goto(`${base}/#/settings?tab=account`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.settings-discord :is(button, .setting-row-desc, .settings-discord-who)', { timeout: 15000 })
  }

  it('a gomb a Discord engedélyezési lapjára visz', async () => {
    await nyit()
    await page.locator('.settings-discord button').click()
    await page.waitForTimeout(1500)
    assert.ok(authorize, 'nem indult el a Discord felé')
    const url = new URL(authorize)
    assert.equal(url.host, 'discord.com')
    assert.equal(url.pathname, '/oauth2/authorize')
    assert.equal(url.searchParams.get('redirect_uri'), `${base}/v1/discord/oauth/callback`)
    assert.ok(url.searchParams.get('state'), 'nincs állapot a kérésben')
  })

  it('a Discordnál „mégse" után a főoldalra tér vissza, üzenettel', async () => {
    const state = new URL(authorize).searchParams.get('state')
    await page.goto(`${base}/v1/discord/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    assert.equal(await page.evaluate(() => window.location.hash), '#/settings?tab=account', 'a kimenet a címben maradt')
    assert.match(await page.evaluate(() => document.querySelector('#toasts')?.innerText ?? ''), /megszakítottad/)
  })

  it('összekötve a név látszik, és a bontás megerősítés után törli', async () => {
    await pool.query(
      `INSERT INTO discord_links (user_id, discord_user_id, discord_username)
       SELECT id, $2, 'probauser' FROM users WHERE username = $1`,
      [username, '5' + randomBytes(8).toString('hex').replace(/\D/g, '0').padEnd(17, '1').slice(0, 17)])
    await nyit()
    assert.match(await page.locator('.settings-discord').innerText(), /@probauser/)
    await page.locator('.settings-discord button').click()
    await page.waitForSelector('.dialog[role="dialog"]')
    await page.locator('.dialog-foot button').last().click()
    await page.waitForTimeout(1500)
    const { rows } = await pool.query(
      'SELECT 1 FROM discord_links l JOIN users u ON u.id = l.user_id WHERE u.username = $1', [username])
    assert.equal(rows.length, 0, 'a bontás után is összekötve maradt')
    assert.equal(await page.locator('.settings-discord button').count(), 1, 'az összekötés gombja nem jött vissza')
  })

  it('beállítatlan OAuth mellett nincs gomb, csak kimondja', async () => {
    const id = process.env.DISCORD_CLIENT_ID
    delete process.env.DISCORD_CLIENT_ID
    try {
      await nyit()
      assert.equal(await page.locator('.settings-discord button').count(), 0, 'nem működő folyamathoz is kínál gombot')
      assert.match(await page.locator('.settings-discord').innerText(), /nincs beállítva/)
    } finally {
      process.env.DISCORD_CLIENT_ID = id
    }
  })

  it('nem sértett CSP-szabályt (Trusted Types is)', async () => {
    assert.deepEqual(await page.evaluate(() => window.__csp), [])
  })
})
