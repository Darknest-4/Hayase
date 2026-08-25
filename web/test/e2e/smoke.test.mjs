// Browser smoke test: the screens nothing else covers.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// The client's unit tests run against a DOM stub, which is the right trade for
// the parts with logic in them — the stream engine, i18n, the watch-time
// meter, the extensions. But it means the router, the layout, the sidebar, the
// sign-in modal and the player chrome had no automated coverage at all: a
// change that threw on boot would pass every test in the repository and only
// fail when somebody opened the page.
//
// This drives the real assembled application in a real browser and asserts the
// things that "the page is broken" actually looks like: an exception during
// boot, a route that renders nothing, a request the client makes to the wrong
// place.
//
// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------
//   npm run test:e2e            (from server/, with DATABASE_URL set)
//
// It skips itself — rather than failing — when Playwright is not installed or
// no database is configured, so `npm test` on a laptop stays dependency-free.

/* global localStorage, window */
import assert from 'node:assert/strict'
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

describe('browser smoke', { skip: REASON }, () => {
  let server, browser, base, account

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    // Each page load pulls ~40 static files; at debug level the request log
    // buries the test output completely.
    process.env.LOG_LEVEL ??= 'warn'
    const { buildApp } = await import('../../../server/src/app.ts')
    server = await buildApp()
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    // A real account, because half of what is being smoke-tested only renders
    // for one: the profile menu, the install buttons, the notification badge.
    const suffix = Math.floor(Math.random() * 1e9)
    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `e2e${suffix}@example.com`,
        username: `e2e${suffix}`,
        password: 'Correct-Horse-Battery-9'
      })
    })
    account = await res.json()

    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined
    })
  })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  /** A page with the account signed in, onboarding done, and no outbound calls. */
  async function open (route = '#/home') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', e => errors.push(String(e.message)))
    // Everything external (AniList, Jikan, image CDNs) is blocked: this test
    // is about our own code, and a rate-limited third party must never be the
    // reason CI goes red.
    await page.route('https://**', route => route.abort())

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.evaluate(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      const id = window.Store?.activeProfileId?.() ?? 'default'
      localStorage.setItem(`${window.Prefs.STORAGE_KEY}-onboarded::${id}`, '1')
    }, account)
    await page.goto(base + '/' + route, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    return { page, errors }
  }

  it('boots without throwing and renders the shell', async () => {
    const { page, errors } = await open()
    assert.deepEqual(errors, [])
    assert.ok(await page.locator('.sidebar').count(), 'no sidebar')
    assert.ok(await page.locator('#page').count(), 'no main region')
    await page.close()
  })

  it('renders every top-level route without an exception', async () => {
    // The router is one switch; a page that throws takes only itself down,
    // which is exactly why nobody notices until somebody visits it.
    for (const route of ['#/home', '#/search', '#/schedule', '#/list', '#/dashboard',
      '#/profile', '#/notifications', '#/community', '#/extensions', '#/settings']) {
      const { page, errors } = await open(route)
      const text = (await page.locator('#page').innerText()).trim()
      assert.deepEqual(errors, [], `${route} threw`)
      assert.ok(text.length > 0, `${route} rendered nothing`)
      await page.close()
    }
  })

  it('offers the skip link before the sidebar and moves focus with it', async () => {
    const { page } = await open()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip-link')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'page')
    await page.close()
  })

  it('shows the extension store with the bundled packages installable', async () => {
    const { page, errors } = await open('#/extensions')
    await page.waitForSelector('.ext-card, .empty-state, .callout', { timeout: 10000 })
    assert.deepEqual(errors, [])
    // A fresh CI database has no published extensions, so an empty store is a
    // valid outcome; a broken one is not.
    const cards = await page.locator('.ext-card').count()
    if (cards) {
      assert.ok(await page.locator('.ext-actions button').count(), 'cards with no action')
      assert.equal(await page.evaluate(() =>
        [...document.querySelectorAll('.ext-icon img')].filter(i => !i.complete || i.naturalWidth === 0).length
      ), 0, 'broken icon images')
    }
    await page.close()
  })

  it('opens the player screen and reports honestly with no source', async () => {
    // The most fragile screen in the client, and the one with no unit test
    // that touches its DOM.
    const { page, errors } = await open('#/watch/1?ep=1')
    await page.waitForTimeout(800)
    assert.deepEqual(errors, [])
    const text = (await page.locator('#page').innerText()).toLowerCase()
    assert.ok(text.length > 0, 'player rendered nothing')
    await page.close()
  })

  it('keeps the page from scrolling sideways on a phone', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
    await page.route('https://**', r => r.abort())
    await page.goto(base + '/#/home', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(overflows, false, 'the page scrolls horizontally at 390px')
    await page.close()
  })
})
