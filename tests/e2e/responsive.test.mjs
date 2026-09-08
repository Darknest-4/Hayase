// Every route, at every width somebody actually uses.
//
// Layout is the one thing no unit test can see. The DOM stub the client's
// other tests run against has no box model, so a rule that pushes a table off
// the side of a phone, or a grid that stops wrapping at 768px, passed
// everything in the repository and was found by looking.
//
// Three properties, checked at nine widths on every top-level route:
//
//   * the page does not scroll sideways. Horizontal overflow is the single
//     most common responsive defect and the most obvious to a viewer: it
//     detaches the header from the content and makes half the page reachable
//     only by dragging.
//   * no button or link is smaller than 22px on a phone. Below that a target
//     is a coin toss for a thumb, and the failure is silent — the control is
//     there, it just cannot be hit.
//   * nothing throws. A route that errors on load still renders its chrome,
//     so a broken page and a working one look alike from outside.
//
// One page, reused across the sweep. The first version of this launched a
// context per width and called getComputedStyle per element, which forces a
// reflow per node; it took longer than it was worth and told us nothing extra.
//
//   npm run test:e2e            (from server/, with DATABASE_URL set)
//
// It skips itself when Playwright is missing or no database is configured.

/* global document, localStorage, Storage */
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

/*
 * Skipping is for a developer without a browser installed. It is NOT for CI.
 *
 * These files report `# tests 0 / # fail 0 / exit 0` when playwright cannot be
 * imported, which reads as a pass in every summary that matters — and this
 * repository has already lost days to a pipeline that was green while checking
 * nothing. A missing browser in CI is a broken job, not an absent one.
 */
if (!chromium && process.env.CI) {
  throw new Error(
    'playwright could not be imported and CI is set. The end-to-end job must ' +
    'run these tests, not skip them — install playwright before this step.'
  )
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

// Desktop, tablet and the phone widths that actually ship: 360 is the floor
// for Android, 375 the small iPhone, 390 the current one, 430 the large.
const WIDTHS = [1920, 1440, 1280, 1024, 768, 430, 390, 375, 360]
const PHONE = 430

const ROUTES = ['home', 'search', 'list', 'notifications', 'profile', 'settings',
  'community', 'schedule', 'profiles', 'w2g', 'dashboard', 'admin',
  // An address with nothing behind it is a route too: it must render the
  // not-found state within the layout, not break out of it.
  'nonexistent-route']

/** Smallest tap target we accept on a phone, in CSS pixels. */
const MIN_TAP = 22

describe('responsive layout', { skip: REASON }, () => {
  let server, browser, pool, page, base, account
  const username = 'e2eresp' + randomBytes(4).toString('hex')
  const errors = []

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
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
    // The admin route is one of the widths under test, so the account has to
    // be able to open it.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../../apps/api/src/plugins/auth.ts')
    auth.invalidatePermissions()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
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
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  /** Measure one route at the viewport currently set. */
  const measure = async (route, min) => {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(400)
    return page.evaluate(minTap => {
      const doc = document.documentElement
      const limit = doc.clientWidth
      const name = el => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '')
      const out = { scrollW: doc.scrollWidth, clientW: limit, wide: [], tiny: [] }
      // Only walk the DOM when something is actually sticking out; naming the
      // culprit matters, but paying for the walk on every pass does not.
      if (doc.scrollWidth > limit + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const b = el.getBoundingClientRect()
          if (b.width && b.right > limit + 1) out.wide.push(name(el))
        }
      }
      for (const el of document.querySelectorAll('button, a[href]')) {
        const b = el.getBoundingClientRect()
        if (b.width > 0 && b.height > 0 && b.height < minTap && b.width < minTap) out.tiny.push(name(el))
      }
      out.wide = [...new Set(out.wide)].slice(0, 5)
      out.tiny = [...new Set(out.tiny)].slice(0, 5)
      return out
    }, min)
  }

  for (const width of WIDTHS) {
    it(`fits at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 })
      const overflowing = []
      const untappable = []
      for (const route of ROUTES) {
        const r = await measure(route, MIN_TAP)
        if (r.scrollW > r.clientW + 1) {
          overflowing.push(`#/${route}: ${r.scrollW} > ${r.clientW} (${r.wide.join(', ') || 'no element identified'})`)
        }
        if (width <= PHONE && r.tiny.length) {
          untappable.push(`#/${route}: ${r.tiny.join(', ')}`)
        }
      }
      assert.deepEqual(overflowing, [], `the page scrolls sideways at ${width}px`)
      assert.deepEqual(untappable, [], `tap targets under ${MIN_TAP}px at ${width}px`)
    })
  }

  it('renders every route without throwing', () => {
    // Collected across the whole sweep above rather than per width: a script
    // error is a property of the route, not of how wide the window is.
    assert.deepEqual(errors, [])
  })
})
