// Every engine, and the one property no other test checks: can you scroll.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// `responsive.test.mjs` sweeps nine widths in Chromium and asserts the page
// does not scroll *sideways*. Nothing asserted that it scrolls *downwards*,
// and nothing ran in Safari's engine at all — which is the one people report
// problems from, because it is what every iPhone uses.
//
// The scroll assertion is not as obvious as it sounds, and writing it wrongly
// is how this file started. Four things to know:
//
//   1. The document never scrolls. `.app-shell` is `height: 100dvh;
//      overflow: clip` and `.page` is the scroller. A test that calls
//      `window.scrollTo` measures nothing and reports success.
//
//   2. `.page` sets `scroll-behavior: smooth`, so assigning `scrollTop`
//      animates. Reading it back two frames later says it did not move, on
//      every engine, at a rate that differs per engine — which looks exactly
//      like a browser-specific bug and is not one. Ask for `behavior:
//      'instant'` and give it time to land.
//
//   3. Synthetic `TouchEvent`s do not cause scrolling in any engine: real
//      touch is handled by the compositor, not by dispatched events. A test
//      that fakes a swipe measures nothing.
//
//   4. `page.mouse.wheel` is not meaningful in a touch-only context, so a
//      WebKit phone profile "failing" a wheel test says nothing about WebKit.
//
// What is left that is worth asserting: the scroller exists, it is the element
// the stylesheet says it is, it actually moves, and nothing above it has
// `touch-action: none` — which is the one declaration that really does stop a
// finger scrolling a page.

/* global document, getComputedStyle, localStorage, Storage */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(here, '..', '..', 'apps', 'web')

let pw
try { pw = await import('playwright') } catch { pw = null }

const HAS_DB = Boolean(process.env.DATABASE_URL)
const REASON = !pw ? 'playwright is not installed' : !HAS_DB ? 'no DATABASE_URL' : false

/** Engines this machine has. A missing one is skipped, not failed. */
const ENGINES = ['chromium', 'webkit', 'firefox']

const ROUTES = ['home', 'search', 'schedule', 'list', 'profile', 'dashboard', 'community', 'changelog', 'settings']

describe('every engine', { skip: REASON }, () => {
  let server, pool, base, account
  const username = 'e2ecb' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'cross-browser-secret-long-enough-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    // The sweep is a few hundred requests in a couple of minutes; the default
    // limit exists for the internet, not for a test.
    process.env.RATE_LIMIT_MAX ??= '100000'
    process.env.AUTH_RATE_LIMIT_MAX ??= '500'

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
      body: JSON.stringify({ email: `${username}@example.invalid`, username, password: 'Correct-Horse-Battery-9' })
    })
    account = await res.json()
  })

  after(async () => {
    try { await pool?.query('DELETE FROM users WHERE username = $1', [username]) } finally {
      await server?.close()
      await pool?.end()
    }
  })

  /** A context that is signed in before the app's first line runs. */
  async function openPage (browser, contextOptions) {
    const ctx = await browser.newContext(contextOptions)
    await ctx.addInitScript(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      const get = Storage.prototype.getItem
      // Onboarding is its own screen with its own tests; it must not stand in
      // front of every route here.
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded') ? '1' : get.call(this, key)
      }
    }, account)
    return await ctx.newPage()
  }

  const probe = async page => await page.evaluate(async () => {
    const el = document.querySelector('.page')
    if (!el) return { missing: true }
    const style = getComputedStyle(el)
    const tall = el.scrollHeight > el.clientHeight + 40
    let moved = null
    if (tall) {
      const before = el.scrollTop
      el.scrollTo({ top: 600, behavior: 'instant' })
      await new Promise(resolve => setTimeout(resolve, 200))
      moved = el.scrollTop > before + 100
      el.scrollTo({ top: before, behavior: 'instant' })
    }
    // Anything between the scroller and the root that refuses a finger.
    const blocked = []
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (getComputedStyle(node).touchAction === 'none') {
        blocked.push(node.tagName.toLowerCase() + '.' + String(node.className).trim().split(/\s+/)[0])
      }
    }
    return {
      tall,
      moved,
      overflowY: style.overflowY,
      blocked,
      wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      children: document.querySelector('#page')?.children.length ?? -1
    }
  })

  for (const engine of ENGINES) {
    it(`${engine}: every route renders, scrolls, and does not spill sideways`, async () => {
      if (!pw[engine]) return
      let browser
      try {
        browser = await pw[engine].launch()
      } catch {
        return // engine not downloaded on this machine
      }
      try {
        const page = await openPage(browser, { viewport: { width: 375, height: 700 } })
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        const failures = []

        for (const route of ROUTES) {
          errors.length = 0
          await page.goto(`${base}/#/${route}`, { waitUntil: 'load' })
          await page.waitForTimeout(1200)
          const r = await probe(page)

          if (r.missing) { failures.push(`${route}: no .page scroller`); continue }
          if (r.children <= 0) failures.push(`${route}: blank`)
          if (r.tall && r.moved === false) failures.push(`${route}: content is ${r.overflowY} but will not scroll`)
          if (r.blocked.length) failures.push(`${route}: touch-action:none on ${r.blocked.join(', ')}`)
          if (r.wide) failures.push(`${route}: horizontal overflow`)
          if (errors.length) failures.push(`${route}: ${errors[0].slice(0, 80)}`)
        }
        assert.deepEqual(failures, [], `${engine}:\n  ` + failures.join('\n  '))
      } finally {
        await browser.close()
      }
    })
  }

  it('webkit on a phone profile scrolls, which is where the reports come from', async () => {
    if (!pw.webkit) return
    let browser
    try { browser = await pw.webkit.launch() } catch { return }
    try {
      const page = await openPage(browser, { ...pw.devices['iPhone 13'] })
      await page.goto(`${base}/#/home`, { waitUntil: 'load' })
      await page.waitForTimeout(1500)
      const r = await probe(page)
      assert.ok(!r.missing, 'the scroller must exist on a phone profile')
      assert.equal(r.blocked.length, 0, `touch-action:none above the scroller: ${r.blocked.join(', ')}`)
      if (r.tall) assert.equal(r.moved, true, 'the home page must scroll on an iPhone profile')
    } finally {
      await browser.close()
    }
  })
})
