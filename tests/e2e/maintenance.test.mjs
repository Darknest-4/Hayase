// Karbantartási mód valódi böngészőben — a 31. pont.
//
// Amit CSAK itt lehet megnézni: elrendezés, a videó tényleges indulása, a
// mozgásmentes mód hatása, és hogy a 503-as oldal önmagában megáll-e egy
// olyan pillanatban, amikor a kiszolgáló épp nem szolgál ki.
//
//   npm run test:e2e --workspace @yume/api

/* global document, window */
import assert from 'node:assert/strict'
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
  throw new Error('playwright could not be imported and CI is set — install it before this step.')
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL ? 'no DATABASE_URL' : false

// A karbantartási oldalt telefonon nézik a legtöbben: ha valami baj van, a
// hírt ott olvassák el.
const WIDTHS = [1920, 1440, 1024, 768, 430, 390, 360, 320]

describe('karbantartási oldal böngészőben', { skip: REASON }, () => {
  let server, browser, page, pool, base, repository, cache

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    process.env.RATE_LIMIT_MAX ??= '100000'

    const [{ buildApp }, db, repo, cacheModule] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts'),
      import('../../apps/api/src/modules/maintenance/repository.ts'),
      import('../../apps/api/src/modules/maintenance/cache.ts')
    ])
    repository = repo
    cache = cacheModule
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.route('https://**', r => r.abort())

    /*
     * A BÖNGÉSZŐ KÍVÜLRŐL JÖN — ezért kap továbbítófejlécet.
     *
     * A teszt a hurokcímről csatlakozik, és a rendszer azt a SAJÁT
     * rendszerünknek tekinti (`middleware/internal-request.ts`): a worker, a
     * bot és a háttérfeladatok karbantartás alatt is futnak, különben pont
     * azt a migrációt nem lehetne végigvinni, amiért a karbantartás van.
     *
     * Enélkül ez a készlet nem a karbantartást mérné, hanem azt, hogy a
     * tesztböngésző honnan csatlakozik — és zöld lett volna akkor is, ha a
     * karbantartás egyáltalán nem működik.
     */
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.99' })
  })

  after(async () => {
    await setMode('OFF', { enabled: false })
    await browser?.close()
    await server?.close()
    await pool?.end()
  })

  const setMode = async (mode, over = {}) => {
    await repository.save({
      mode, scope: 'global', enabled: true,
      startsAt: null, endsAt: null, estimatedEndAt: null,
      timezone: 'Europe/Budapest',
      title: 'Épp dolgozunk rajta',
      publicMessage: 'A YUME hamarosan újra elérhető lesz. Köszönjük a türelmet.',
      allowExistingSessions: false, drainSeconds: 0, actorId: null,
      ...over
    })
    cache.invalidate()
    await cache.configNow()
  }

  it('a 503-as oldal magában megáll — semmit nem tölt le kívülről', async () => {
    // Egy státuszoldal, ami stíluslapot vagy betűkészletet kér, pont akkor
    // hasal el, amikor a kiszolgáló bajban van.
    await setMode('ACTIVE')
    const external = []
    page.on('request', r => {
      const url = r.url()
      if (!url.startsWith(base) && !url.startsWith('data:')) external.push(url)
    })
    const response = await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })

    assert.equal(response.status(), 503)
    assert.equal(response.headers()['x-yume-maintenance'], 'true')
    assert.ok(Number(response.headers()['retry-after']) > 0)

    const shown = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent,
      message: document.querySelector('p')?.textContent,
      hasRetry: Boolean(document.querySelector('.retry')),
      logo: document.querySelector('.logo')?.textContent
    }))
    assert.match(shown.title, /Épp dolgozunk rajta/)
    assert.equal(shown.logo, 'YUME')
    assert.equal(shown.hasRetry, true)
    assert.deepEqual(external.filter(url => !url.includes('favicon')), [])
    page.removeAllListeners('request')
  })

  it('a videó tényleg megjelenik a karbantartási oldalon', async () => {
    await setMode('ACTIVE')
    await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })
    const video = await page.evaluate(() => {
      const node = document.querySelector('video.bg')
      if (!node) return null
      return {
        muted: node.muted, loop: node.loop, hidden: node.getAttribute('aria-hidden'),
        src: node.querySelector('source')?.getAttribute('src') ?? null
      }
    })
    // Van videó az `assets/videos`-ban, tehát meg KELL találnia.
    assert.ok(video, 'a felismerő nem talált videót')
    assert.equal(video.muted, true, 'a háttérvideó nem néma')
    assert.equal(video.loop, true)
    assert.equal(video.hidden, 'true', 'a háttérvideó nincs elrejtve a felolvasó elől')
    assert.match(String(video.src), /^\/assets\/videos\//)
  })

  it('mozgásmentes módban a háttérvideó eltűnik', async () => {
    // A 19. pont. Egy hurokban futó mozgókép pont az, amitől valakinek
    // rosszul lehet.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setMode('ACTIVE')
    await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })
    const display = await page.evaluate(() => {
      const node = document.querySelector('video.bg')
      return node ? window.getComputedStyle(node).display : 'nincs elem'
    })
    assert.equal(display, 'none', 'mozgásmentes módban is megy a háttérvideó')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  it('a gépi hívó JSON-t kap, a böngésző oldalt', async () => {
    await setMode('ACTIVE')
    const json = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
    }, `${base}/v1/anime`)

    assert.equal(json.status, 503)
    assert.match(json.type, /json/)
    const parsed = JSON.parse(json.body)
    assert.equal(parsed.error.code, 'YUME_MAINTENANCE')
    assert.equal(parsed.error.mode, 'ACTIVE')
    assert.ok(parsed.error.requestId)
    // Semmi belső.
    for (const leak of ['postgres', 'yume_test', '/opt/', 'select ']) {
      assert.ok(!json.body.toLowerCase().includes(leak), leak)
    }
  })

  it('a státusz végpont karbantartás alatt is válaszol', async () => {
    // Enélkül nem lehetne KIJÖNNI: a karbantartási oldal sem tudná
    // megkérdezni, vége van-e már.
    await setMode('EMERGENCY')
    const status = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      return { status: response.status, body: await response.json() }
    }, `${base}/v1/status`)
    assert.equal(status.status, 200)
    assert.equal(status.body.mode, 'EMERGENCY')
    assert.equal(status.body.status, 'maintenance')
  })

  it('az Újratöltés gomb működik, és vége után be is enged', async () => {
    await setMode('ACTIVE')
    await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })
    assert.ok(await page.$('.retry'))

    await setMode('OFF', { enabled: false })
    /*
     * AZ EREDMÉNYRE VÁRUNK, nem a navigációs eseményre.
     *
     * A `waitForLoadState` azonnal visszatér (az előző betöltés már kész), a
     * `waitForNavigation` pedig itt kifutott az időből. Amit valójában tudni
     * akarunk, az nem az, hogy történt-e navigáció, hanem hogy ELTŰNT-E a
     * karbantartási oldal — és ezt közvetlenül is meg lehet kérdezni.
     */
    await page.click('.retry')
    await page.waitForFunction(() => !document.querySelector('.retry'), null, { timeout: 15000 })
    // A karbantartás vége után ugyanaz a cím már a valódi választ adja.
    const after = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 300),
      stillMaintenance: Boolean(document.querySelector('.retry'))
    }))
    assert.equal(after.stillMaintenance, false,
      `a karbantartási oldal ragadt be — amit látunk: ${after.text.replace(/\s+/g, ' ').slice(0, 120)}`)
  })

  for (const width of WIDTHS) {
    it(`${width} px — semmi nem lóg ki`, async () => {
      await setMode('ACTIVE')
      await page.setViewportSize({ width, height: width < 700 ? 780 : 900 })
      await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })

      const report = await page.evaluate(() => {
        const doc = document.documentElement
        const limit = doc.clientWidth
        const wide = []
        const tiny = []
        for (const el of document.querySelectorAll('main *, button')) {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          if (rect.right > limit + 1 || rect.left < -1) {
            wide.push(el.tagName.toLowerCase() + ' ' + Math.round(rect.left) + '..' + Math.round(rect.right))
          }
          if (el.tagName === 'BUTTON' && (rect.width < 22 || rect.height < 22)) {
            tiny.push(el.textContent.trim() + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height))
          }
        }
        return { scroll: doc.scrollWidth - limit, wide, tiny, limit }
      })

      assert.equal(report.scroll, 0, `oldalra görgethető ${width}px-en`)
      assert.deepEqual(report.wide, [], `kilóg ${width}px-en`)
      assert.deepEqual(report.tiny, [], `ujjal eltalálhatatlan gomb ${width}px-en`)
      await page.setViewportSize({ width: 1440, height: 900 })
    })
  }
})
