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
    /*
     * AZ EMBERPRÓBA KI VAN KAPCSOLVA a böngészős futásokban.
     *
     * Ezek a tesztek API-hívással regisztrálnak, tehát nincs widgetjük,
     * amitől tokent kérhetnének. Ha a futtató héjába be van töltve a `.env`
     * (és ez a szokásos mód egy szkript futtatásához), a regisztráció
     * 403-mal hasalna el, mielőtt egy böngésző egyáltalán elindulna — egy
     * olyan hibával, aminek semmi köze ahhoz, amit a teszt mér.
     *
     * A törlésnek az app IMPORTJA ELŐTT kell megtörténnie: a CSP-t a
     * `security.ts` betöltéskor építi fel.
     */
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
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
      mode,
      scope: 'global',
      enabled: true,
      startsAt: null,
      endsAt: null,
      estimatedEndAt: null,
      timezone: 'Europe/Budapest',
      title: 'Épp dolgozunk rajta',
      publicMessage: 'A YUME hamarosan újra elérhető lesz. Köszönjük a türelmet.',
      allowExistingSessions: false,
      drainSeconds: 0,
      actorId: null,
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

  /*
   * A VIDEÓ LEJÁTSZÓ LETT, NEM HÁTTÉRRÉTEG — és ezek a tesztek eddig a régi
   * szerződést mérték.
   *
   * Korábban `video.bg` volt: `position: fixed`, 22%-os átlátszóság,
   * `aria-hidden`, `pointer-events: none` — tehát se megállítani, se
   * hangosítani, se teljes képernyőre tenni nem lehetett, és a felolvasó
   * számára nem is létezett. A kártya SZÖVEGE mögött futott.
   *
   * Az új szerződést kilenc állítással a `maintenance-video-player.test.ts`
   * fedi, a KISZOLGÁLT HTML-en. Ez a két teszt ezért nem ismétli meg: azt
   * méri, amit csak valódi böngésző tud megmondani — hogy az elem tényleg
   * megjelenik, van mérhető mérete, és a forrás betöltődik.
   */
  it('a videó valódi, látható lejátszóként jelenik meg', async () => {
    await setMode('ACTIVE')
    const videoKeresek = []
    page.on('response', r => { if (/\/assets\/videos\//.test(r.url())) videoKeresek.push(r.status()) })
    await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })

    const video = await page.evaluate(() => {
      const node = document.querySelector('video.video')
      if (!node) return null
      const doboz = node.getBoundingClientRect()
      const cs = window.getComputedStyle(node)
      return {
        hatterreteg: Boolean(document.querySelector('video.bg')),
        vezerlok: node.controls,
        rejtve: node.getAttribute('aria-hidden'),
        szeles: Math.round(doboz.width),
        magas: Math.round(doboz.height),
        pozicio: cs.position,
        kattinthato: cs.pointerEvents,
        src: node.querySelector('source')?.getAttribute('src') ?? null
      }
    })

    assert.ok(video, 'nincs lejátszó a karbantartási oldalon')
    assert.equal(video.hatterreteg, false, 'visszakerült a háttérréteg')
    assert.equal(video.vezerlok, true, 'a lejátszónak nincsenek vezérlői')
    assert.equal(video.rejtve, null, 'a lejátszó el van rejtve a felolvasó elől')
    assert.equal(video.pozicio, 'static', 'a videó kikerült a tartalom folyamából')
    assert.notEqual(video.kattinthato, 'none', 'a videóra nem lehet rákattintani')
    assert.match(String(video.src), /^\/assets\/videos\//)

    // MÉRHETŐ MÉRET: egy nulla magas elem technikailag ott van, de nem látszik.
    assert.ok(video.szeles > 200, `a lejátszó ${video.szeles} képpont széles`)
    assert.ok(video.magas > 100, `a lejátszó ${video.magas} képpont magas`)

    // A forrás tényleg kiszolgálható — egy 404-es videó néma fekete doboz.
    page.removeAllListeners('response')
    assert.ok(videoKeresek.length > 0, 'a böngésző el sem kérte a videót')
    assert.ok(videoKeresek.every(s => s < 400), `a videó kérése: ${videoKeresek.join(', ')}`)
  })

  it('mozgásmentes módban sem indul el magától', async () => {
    /*
     * A 19. pont. A régi háttérvideó hurokban futó mozgókép volt, amit
     * mozgásmentes módban el KELLETT rejteni — most viszont a lejátszó nem
     * indul magától, tehát a lapon betöltéskor semmi nem mozog. Nem elrejtjük
     * tehát, hanem megmutatjuk, hogy nincs mit elrejteni: aki meg akarja
     * nézni, elindítja.
     */
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await setMode('ACTIVE')
    await page.goto(`${base}/v1/anime`, { waitUntil: 'load' })
    const allapot = await page.evaluate(() => {
      const node = document.querySelector('video.video')
      if (!node) return null
      return { all: node.paused, autoplay: node.autoplay, loop: node.loop, lathato: window.getComputedStyle(node).display }
    })
    assert.ok(allapot, 'nincs lejátszó')
    assert.equal(allapot.autoplay, false, 'a videó magától indul')
    assert.equal(allapot.loop, false, 'a videó hurokban jár')
    assert.equal(allapot.all, true, 'a videó mozgásmentes módban is játszik')
    assert.notEqual(allapot.lathato, 'none',
      'a lejátszó mozgásmentes módban eltűnt — nincs mit elrejteni rajta, mert nem indul magától')
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
