// A katalógus szövege adat, nem kód.
//
// A leírás nem a miénk: az importból jön, és az adminfelületen szerkeszthető.
// Ha a felület HTML-ként értelmezi, akkor egy katalógusmező tartalma minden
// látogató böngészőjében lefut — a főoldali kiemelésen, az adatlapon és a
// gyorsnézeten.
//
// `U.plainDesc` pontosan ezt csinálta: leváló `div.innerHTML`, aztán
// `textContent`. A leváló elem nem véd — megmértem mindhárom motorban, hogy
// egy `<img src=x onerror=…>` ott is lefut, mert a kép betöltése az elem
// létrejöttéhez kötődik, nem a dokumentumhoz.
//
// Ami *mégis* megvédte ezt a telepítést: a CSP. `script-src 'self'`,
// `unsafe-inline` nélkül, tehát a beágyazott kezelő nem futhatott. Ezt le is
// mértem: a régi, sebezhető változattal is átment ez a teszt, amíg a CSP
// érvényben volt.
//
// Ezért veszi le a teszt a CSP-fejlécet. A kérdés nem az, hogy két réteg közül
// megvéd-e az egyik — hanem hogy a másik réteg önmagában is megáll-e. Egy
// félregépelt direktíva nem tehet egy katalógusmezőt kódfuttatássá.

/* global document, window, localStorage, Storage */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(here, '..', '..', 'apps', 'web')

let playwright
try {
  playwright = await import('playwright')
} catch {
  playwright = null
}
if (!playwright && process.env.CI) {
  throw new Error('playwright could not be imported and CI is set')
}
const REASON = !playwright
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

// A hasznos teher kétféleképp próbál futni: képhibával és beágyazott
// scripttel. Az első az, ami a leváló elemben is elsült.
const PAYLOAD = '<img src=x onerror="window.__xss = true">' +
  '<script>window.__xss = true</script>' +
  'Egy ártalmatlan mondat a leírásban.'

describe('catalogue text is data, not code', { skip: REASON }, () => {
  let server, pool, base, animeId, original
  const username = 'e2exss' + randomBytes(4).toString('hex')
  let account

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    process.env.YUME_SUPPRESS_WEBHOOKS = '1'
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

    // Egy valódi cím leírásába írjuk, ahogy egy szerkesztő tenné.
    // Olyan cím kell, aminek NINCS magyar leírása: a fordítási réteg
    // felülírná a beírt szöveget, és a teszt a fordítást mérné, nem a
    // tisztítást. (Ez pontosan meg is történt: a legnépszerűbb cím az egyik
    // olyan, aminek van magyar szövege.)
    const { rows } = await pool.query(
      `SELECT a.id, a.synopsis FROM anime a
        WHERE a.visibility = 'public' AND a.synopsis IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM anime_translations t
                           WHERE t.anime_id = a.id AND t.language = 'hu' AND t.approved)
        ORDER BY a.popularity DESC NULLS LAST LIMIT 1`)
    animeId = rows[0].id
    original = rows[0].synopsis
    await pool.query('UPDATE anime SET synopsis = $2 WHERE id = $1', [animeId, PAYLOAD])
  })

  after(async () => {
    try {
      if (animeId) await pool.query('UPDATE anime SET synopsis = $2 WHERE id = $1', [animeId, original])
      await pool.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await server?.close()
      await pool?.end()
    }
  })

  for (const engine of ['chromium', 'webkit', 'firefox']) {
    it(`${engine}: the description does not execute`, async () => {
      const browser = await playwright[engine].launch()
      try {
        const context = await browser.newContext()
        await context.addInitScript(tokens => {
          localStorage.setItem('yume-auth', JSON.stringify(tokens))
          const getItem = Storage.prototype.getItem
          Storage.prototype.getItem = function (key) {
            return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
          }
          window.__xss = false
        }, account)
        const page = await context.newPage()
        // A CSP itt szándékosan lekerül: a kliensoldali tisztításnak önmagában
        // kell megállnia. A fejléc érvényben a régi, sebezhető változat is
        // átment — vagyis a teszt a CSP-t mérte volna, nem a kódot.
        await page.route('**/*', async route => {
          const response = await route.fetch()
          const headers = { ...response.headers() }
          delete headers['content-security-policy']
          delete headers['content-security-policy-report-only']
          await route.fulfill({ response, headers })
        })
        await page.goto(`${base}/#/anime/${animeId}`, { waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2500)

        const result = await page.evaluate(() => ({
          fired: window.__xss === true,
          // A mondatnak meg kell jelennie: a védekezés nem lehet az, hogy
          // eldobjuk a leírást.
          shown: document.body.textContent.includes('ártalmatlan mondat'),
          // És a jelölés nem lehet ott elemként. Csak azt számoljuk, ami a
          // leírásból jöhetett — az oldal saját <script> elemei nem azok.
          injected: document.querySelectorAll('img[onerror]').length +
            [...document.querySelectorAll('script')].filter(s => s.textContent.includes('__xss')).length,
          sample: (document.querySelector('.detail-desc, .synopsis, .detail-synopsis')?.textContent ?? document.body.textContent).slice(0, 160)
        }))
        if (process.env.XSS_DEBUG) console.log(engine, JSON.stringify(result))
        assert.equal(result.fired, false, 'the catalogue description executed in ' + engine)
        assert.equal(result.shown, true, 'the description must still be readable')
        assert.equal(result.injected, 0, 'no element from the description may reach the page')
      } finally {
        await browser.close()
      }
    })
  }
})
