// Browser smoke test: the screens nothing else covers.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// The client's unit tests run against a DOM stub, which is the right trade for
// the parts with logic in them — the stream engine, i18n, the watch-time
// meter. But it means the router, the layout, the sidebar, the
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

/* global document, localStorage, Storage, window */
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

    // Onboarding is keyed by profile id, and the id changes under the test:
    // it is 'default' before sign-in and the server's uuid once the client has
    // pulled the account's profiles. Writing the flag under the id that is
    // current at setup time therefore misses whenever the pull wins the race,
    // and the welcome modal then opens over whatever the test was about to
    // click. None of these tests are about onboarding, so the gate is answered
    // for every key instead of guessed at.
    await page.addInitScript(() => {
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    })

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' })
    await page.evaluate(tokens => localStorage.setItem('yume-auth', JSON.stringify(tokens)), account)
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
      '#/profile', '#/notifications', '#/community', '#/themes', '#/settings']) {
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

  it('opens the player screen without throwing', async () => {
    // The most fragile screen in the client, and the one with no unit test
    // that touches its DOM.
    //
    // This used to also assert that `#page` had text in it after 800 ms, and
    // that assertion was unsound: `PageWatch.render` shows a spinner, awaits
    // `Catalogue.media()`, and on success calls `root.replaceChildren()` —
    // clearing the screen — before awaiting source resolution. So an empty
    // `#page` is a state the player really passes through, and the old test
    // only went green when the anime lookup *failed* fast enough to paint an
    // error instead. Which of the two paths ran depended on the network, so
    // the test flipped between passing and "player rendered nothing" with no
    // change to the code at all.
    //
    // What is worth asserting here is what this test can actually stand
    // behind: opening the player throws nothing, and the router is on the
    // watch route. The blank interval itself is recorded as a finding in
    // status.html rather than papered over here.
    const { page, errors } = await open('#/watch/1?ep=1')
    await page.waitForTimeout(1500)
    assert.deepEqual(errors, [], 'the player threw')
    assert.match(page.url(), /#\/watch\/1/)
    assert.ok(await page.locator('#page').count(), 'the router did not reach the watch route')
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
