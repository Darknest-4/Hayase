// The administration panel has the window to itself.
//
// It used to render inside the viewer's chrome: the icon rail on the left, the
// phone tab bar across the bottom, the marketing footer under a table of user
// accounts, and its own section rail beside all of it — two navigations
// competing for the same edge, and on a phone a bottom bar sitting on top of
// the panel's own controls. An operator screen and a viewer screen are not the
// same product.
//
// Layout is exactly the kind of thing a DOM stub cannot check: every assertion
// here is about what the browser computed, not about what the markup says.
//
//   npm run test:e2e            (from server/, with DATABASE_URL set)
//
// It skips itself when Playwright is missing or no database is configured.

/* global document, getComputedStyle, localStorage, Storage, window */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(here, '..', '..')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch {
  chromium = null
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

describe('admin panel layout', { skip: REASON }, () => {
  let server, browser, pool, base, account
  const username = 'e2eadm' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    const [{ buildApp }, db] = await Promise.all([
      import('../../../server/src/app.ts'),
      import('../../../server/src/db.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    account = await res.json()
    // The panel is invisible without the permissions, which is the subject of
    // its own test — here it is a precondition.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../../../server/src/plugins/auth.ts')
    auth.invalidatePermissions()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
  })

  after(async () => {
    await browser?.close()
    await server?.close()
    await pool?.query('DELETE FROM users WHERE username = $1', [username])
    await pool?.end()
  })

  /**
   * The panel, open, at a given viewport.
   *
   * The reload matters. Signing in by writing the token and then changing only
   * the hash leaves App.init() racing the write: it reads the token to load
   * the permission set, and whichever wins decides whether the gate lets the
   * route through. A full load after the token is in place removes the race
   * rather than sleeping through it.
   */
  async function open (viewport, route = '#/admin') {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', e => errors.push(String(e.message)))
    await page.route('https://**', r => r.abort())
    await page.addInitScript(() => {
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    })
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.evaluate(tokens => localStorage.setItem('yume-auth', JSON.stringify(tokens)), account)
    await page.goto(base + '/' + route, { waitUntil: 'domcontentloaded' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.admin-nav', { timeout: 15000 })
    return { page, errors }
  }

  const shown = (page, selector) => page.evaluate(s => {
    const el = document.querySelector(s)
    return !!el && getComputedStyle(el).display !== 'none'
  }, selector)

  it('replaces the site chrome with its own', async () => {
    const { page, errors } = await open({ width: 1280, height: 900 })
    assert.deepEqual(errors, [])
    assert.equal(await shown(page, '.sidebar'), false, 'the site rail is still there')
    assert.equal(await page.locator('.site-footer').count(), 0, 'the site footer is still there')
    assert.ok(await page.locator('.admin-nav-item').count() > 1, 'no section rail')
    // With the site rail gone this link is the only way back into the app.
    assert.ok(await page.locator('.admin-nav-back').count(), 'no way back to the site')
    await page.close()
  })

  it('gives the chrome back on the way out', async () => {
    // The class is set on <body>, so failing to clear it would leave the rest
    // of the app without navigation — a far worse bug than the one being fixed.
    const { page } = await open({ width: 1280, height: 900 })
    await page.locator('.admin-nav-back').click()
    await page.waitForTimeout(500)
    assert.equal(await shown(page, '.sidebar'), true, 'the site rail did not come back')
    assert.equal(await page.evaluate(() => document.body.className.includes('admin-route')), false)
    await page.close()
  })

  it('collapses the rail to icons and remembers it', async () => {
    const { page } = await open({ width: 1280, height: 900 })
    const width = () => page.evaluate(() => document.querySelector('.admin-nav').getBoundingClientRect().width)
    const full = await width()
    await page.locator('.admin-nav-collapse').click()
    await page.waitForTimeout(300)
    const collapsed = await width()
    assert.ok(collapsed < full / 2, `rail did not collapse: ${full} → ${collapsed}`)
    assert.equal(await shown(page, '.admin-nav-label'), false, 'labels survived the collapse')

    // A preference nobody has to set twice.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.admin-nav')
    assert.ok(await width() < full / 2, 'the collapsed rail did not survive a reload')
    await page.close()
  })

  it('turns the rail into a drawer on a phone', async () => {
    const { page, errors } = await open({ width: 390, height: 780 })
    assert.deepEqual(errors, [])
    // Off-screen until asked for: the rail used to become a horizontally
    // scrolling strip with most of the panel past the edge of the screen.
    const offscreen = () => page.evaluate(() => document.querySelector('.admin-nav').getBoundingClientRect().right)
    assert.ok(await offscreen() <= 0, 'the drawer is open before anything opened it')
    assert.equal(await shown(page, '.admin-topbar'), true, 'no header to open it with')

    await page.locator('.admin-menu-btn').click()
    await page.waitForTimeout(400)
    assert.ok(await offscreen() > 0, 'the drawer did not open')

    // Full height, not the height of its own contents: the drawer was pinned
    // to a transformed ancestor and stopped two hundred pixels short.
    const box = await page.evaluate(() => {
      const r = document.querySelector('.admin-nav').getBoundingClientRect()
      return { top: r.top, height: r.height, viewport: window.innerHeight }
    })
    assert.equal(box.top, 0)
    assert.ok(box.height >= box.viewport - 1, `drawer is ${box.height} of ${box.viewport}`)

    // Picking a section is what the drawer is for, so it closes itself.
    await page.locator('.admin-nav-item').nth(1).click()
    await page.waitForTimeout(400)
    assert.ok(await offscreen() <= 0, 'the drawer stayed open over the section it opened')
    await page.close()
  })

  it('does not print the section name twice on a phone', async () => {
    const { page } = await open({ width: 390, height: 780 })
    assert.equal(await shown(page, '.admin-content-head'), false)
    assert.ok((await page.locator('.admin-topbar-title').innerText()).trim().length, 'the header lost the title')
    await page.close()
  })
})
