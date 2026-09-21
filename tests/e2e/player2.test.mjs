// Player 2.0 — valódi böngészőben, valódi videóval.
//
// Ez a készlet azt méri, amit egy egységteszt nem tud megnézni: elrendezést,
// valódi lejátszást, és azt, mennyibe kerül a lejátszó. A DOM-csonknak nincs
// dobozmodellje, és nincs benne `<video>` sem — a lejátszó legfontosabb
// állításai („nem lóg ki a telefonon", „a vezérlő eltalálható ujjal", „a
// betöltő eltűnik, amikor elindul a kép") kizárólag itt mérhetők.
//
// A LEJÁTSZÓT KÖZVETLENÜL SZERELJÜK ÖSSZE, nem a nézőoldalon át. A nézőoldal
// egy katalógusbejegyzést, epizódsort és forrást kérne az adatbázisból; ez a
// teszt viszont nem a katalógusról szól. Az alkalmazás betöltött lapjára
// építünk — így az igazi CSS, az igazi betűkészlet és az igazi tokenek hatnak
// —, és a lejátszót egy helyi videófájlra állítjuk.
//
//   npm run test:e2e            (apps/api-ból, DATABASE_URL-lel)

/* global document, window, performance, requestAnimationFrame */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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

/** A helyi próbavideó. Enélkül nincs mit lejátszani, és azt meg kell mondani. */
const VIDEO = '/assets/videos/amv-counting-stars.mp4'
const VIDEO_PATH = join(WEB_ROOT, 'assets', 'videos', 'amv-counting-stars.mp4')

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : !existsSync(VIDEO_PATH)
          ? 'nincs helyi próbavideó (apps/web/assets/videos)'
          : false

// Ugyanazok a szélességek, amiket a többi képernyő is mér, plusz a 2560 —
// a lejátszó az egyetlen felület, amit nagy monitoron teljes szélességben
// néznek.
const WIDTHS = [2560, 1920, 1440, 1280, 1024, 768, 430, 390, 375, 360, 320]
const PHONE = 430
const MIN_TAP = 22

describe('player 2.0 valódi böngészőben', { skip: REASON }, () => {
  let server, browser, page, pool, base
  const errors = []

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

    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined,
      // A `<video>` hang nélkül indulhat automatikusan; hanggal a böngésző
      // megtagadja, és a teszt a tiltást mérné, nem a lejátszót.
      args: ['--autoplay-policy=no-user-gesture-required']
    })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', e => errors.push(String(e.message)))
    await page.route('https://**', r => r.abort())
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  })

  after(async () => {
    await browser?.close()
    await server?.close()
    await pool?.end()
  })

  /**
   * A lejátszó felállítása a betöltött lapon.
   *
   * A modult a lap saját kiszolgálójáról importáljuk, tehát pontosan azt a
   * fájlt futtatjuk, ami élesben is kimenne.
   */
  const mount = (options = {}) => page.evaluate(async ({ src, opts }) => {
    window.__ypPrefs = opts.prefs ?? {}
    document.querySelector('#yp-harness')?.remove()
    const host = document.createElement('div')
    host.id = 'yp-harness'
    host.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000;'
    document.body.append(host)

    const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.preload = 'metadata'

    const mounted = createEpisodePlayer({
      video,
      sources: [{ id: 'local', url: src, quality: 1080, label: 'helyi' }],
      media: { title: 'Próba', logoImage: null },
      episode: { number: 1 },
      nextEpisode: { number: 2 },
      skipSegments: opts.skipSegments ?? [],
      prefs: {
        get: key => window.__ypPrefs?.[key],
        set: (key, value) => { (window.__ypPrefs ??= {})[key] = value }
      }
    })
    host.append(mounted.node)
    window.__yp = mounted
    return true
  }, { src: VIDEO, opts: options })

  const teardown = () => page.evaluate(() => {
    window.__yp?.destroy()
    document.querySelector('#yp-harness')?.remove()
    window.__yp = null
  })

  it('felépül, és a rétegek a helyükön vannak', async () => {
    await mount()
    const shape = await page.evaluate(() => {
      const shell = document.querySelector('.yp')
      return {
        layers: [...shell.children].map(child => child.tagName === 'VIDEO' ? 'VIDEO' : child.className.split(' ')[0]),
        role: shell.getAttribute('role'),
        // A videó TÉNYLEGESEN kitölti a héjat — egy nulla magasságú réteg
        // ugyanúgy „ott van" a DOM-ban, és semmit nem mutat.
        videoBox: (() => { const r = shell.querySelector('video').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
        shellBox: (() => { const r = shell.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()
      }
    })
    assert.equal(shape.role, 'region')
    assert.deepEqual(shape.layers.slice(0, 4), ['VIDEO', 'yp-ambient', 'yp-subtitles', 'yp-surface'])
    assert.ok(shape.shellBox.h > 100, `a héjnak nincs magassága: ${JSON.stringify(shape.shellBox)}`)
    assert.deepEqual(shape.videoBox, shape.shellBox, 'a videó nem tölti ki a héjat')
    await teardown()
  })

  it('a videó tényleg elindul, és a betöltő eltűnik', async () => {
    await mount()
    const result = await page.evaluate(async () => {
      const video = document.querySelector('.yp video')
      const started = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 15000)
        const done = () => { clearTimeout(timer); resolve(true) }
        if (video.readyState >= 2) return done()
        video.addEventListener('loadeddata', done, { once: true })
      })
      if (!started) return { started: false }
      await video.play().catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 1600))
      const loader = document.querySelector('.yp-loader')
      return {
        started: true,
        playing: !video.paused && video.currentTime > 0,
        currentTime: video.currentTime,
        duration: video.duration,
        loaderHidden: loader.classList.contains('yp-hidden'),
        stateTime: window.__yp.player.state.get().playback.currentTime
      }
    })
    assert.equal(result.started, true, 'a videó nem töltötte be az első képkockát')
    assert.ok(result.playing, `nem indult el: ${JSON.stringify(result)}`)
    assert.ok(result.duration > 0, 'nincs hossz')
    assert.equal(result.loaderHidden, true, 'a betöltő a kép fölött maradt')
    // Az állapotfa KÖVETI a videót — ez az egész felépítés alapfeltevése.
    assert.ok(Math.abs(result.stateTime - result.currentTime) < 1.5,
      `az állapot elcsúszott a videótól: ${result.stateTime} vs ${result.currentTime}`)
    await teardown()
  })

  it('a vezérlők eltűnnek tétlenségre, és visszajönnek mozgásra', async () => {
    await mount()
    await page.evaluate(async () => {
      const video = document.querySelector('.yp video')
      if (video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }))
      await video.play().catch(() => {})
    })
    await page.mouse.move(700, 400)
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.__yp.player.state.get().ui.controlsVisible), true)

    // A türelmi idő három másodperc; négyet várunk, hogy az időzítő ütése is
    // beleférjen.
    await page.waitForTimeout(4200)
    assert.equal(await page.evaluate(() => window.__yp.player.state.get().ui.controlsVisible), false,
      'a vezérlők kint maradtak')

    await page.mouse.move(701, 401)
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => window.__yp.player.state.get().ui.controlsVisible), true,
      'a vezérlők nem jöttek vissza')
    await teardown()
  })

  it('szünetben nem tűnnek el', async () => {
    await mount()
    await page.evaluate(async () => {
      const video = document.querySelector('.yp video')
      if (video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }))
      video.pause()
    })
    await page.waitForTimeout(4200)
    assert.equal(await page.evaluate(() => window.__yp.player.state.get().ui.controlsVisible), true,
      'szünetben is eltűnt — pedig nincs mit takarnia')
    await teardown()
  })

  it('a tekerősáv kattintásra odaugrik', async () => {
    await mount()
    await page.evaluate(async () => {
      const video = document.querySelector('.yp video')
      if (video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }))
    })
    await page.mouse.move(700, 400)
    await page.waitForTimeout(200)
    const jumped = await page.evaluate(async () => {
      const seek = document.querySelector('.yp-seek')
      const rect = seek.getBoundingClientRect()
      const video = document.querySelector('.yp video')
      const before = video.currentTime
      const x = rect.left + rect.width * 0.5
      const y = rect.top + rect.height / 2
      for (const type of ['pointerdown', 'pointerup']) {
        seek.dispatchEvent(new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 }))
      }
      await new Promise(resolve => setTimeout(resolve, 300))
      return { before, after: video.currentTime, duration: video.duration }
    })
    // A felezőpontra kattintva a felénél kell lennie. Nem pontosan: a
    // kulcsképkockára igazítás pár másodpercet mozdíthat.
    assert.ok(Math.abs(jumped.after - jumped.duration / 2) < 5,
      `nem a felére ugrott: ${JSON.stringify(jumped)}`)
    await teardown()
  })

  it('a billentyűparancsok működnek, a beviteli mezőben pedig nem', async () => {
    await mount()
    const result = await page.evaluate(async () => {
      const shell = document.querySelector('.yp')
      const video = shell.querySelector('video')
      if (video.readyState < 2) await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }))
      video.currentTime = 30
      await new Promise(resolve => setTimeout(resolve, 120))

      const key = (target, k) => target.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: k, bubbles: true }))

      key(shell, 'ArrowRight')
      await new Promise(resolve => setTimeout(resolve, 120))
      const afterArrow = video.currentTime

      // Beviteli mező a lejátszón belül — ez a közös nézés csevegőmezője.
      const input = document.createElement('input')
      shell.append(input)
      input.focus()
      key(input, 'ArrowRight')
      await new Promise(resolve => setTimeout(resolve, 120))
      const afterTyping = video.currentTime
      input.remove()
      return { afterArrow, afterTyping }
    })
    assert.ok(result.afterArrow > 34, `a nyíl nem tekert: ${result.afterArrow}`)
    assert.equal(result.afterTyping, result.afterArrow, 'a beviteli mezőben is parancs lett a betűből')
    await teardown()
  })

  it('a hibaüzenet megjelenik, ha semmi nem játszható le', async () => {
    await page.evaluate(async () => {
      document.querySelector('#yp-harness')?.remove()
      const host = document.createElement('div')
      host.id = 'yp-harness'
      host.style.cssText = 'position:fixed;inset:0;z-index:9999;'
      document.body.append(host)
      const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
      const video = document.createElement('video')
      video.muted = true
      const mounted = createEpisodePlayer({
        video,
        sources: [{ id: 'rossz', url: '/nincs-ilyen-fajl.mp4', quality: 720 }],
        media: { title: 'Próba' },
        episode: { number: 1 }
      })
      host.append(mounted.node)
      window.__yp = mounted
    })
    await page.waitForSelector('.yp-error:not(.yp-hidden)', { timeout: 30000 })
    const message = await page.textContent('.yp-error-text')
    assert.match(message, /sem sikerült lejátszani/)
    // A betöltő NEM maradhat a hibaüzenet fölött: két egymásra rajzolt réteg
    // közül egyik sem olvasható.
    assert.equal(await page.evaluate(() => document.querySelector('.yp-loader').classList.contains('yp-hidden')), true)
    await teardown()
  })

  /*
   * ---- MINDEN SZÉLESSÉG ----
   *
   * UGYANEBBEN A KÉSZLETBEN. Külön `describe` külön szervert és külön
   * adatbázis-készletet nyitott, a `pool` viszont MODULSZINTŰ EGYKE: a
   * második `end()` „Called end on pool more than once"-szal elszállt, és a
   * teljes szélességi sorozat el sem indult.
   */
  for (const width of WIDTHS) {
    it(`${width} px`, async () => {
      await page.setViewportSize({ width, height: width < 700 ? 780 : 900 })
      await page.evaluate(async (src) => {
        document.querySelector('#yp-harness')?.remove()
        const host = document.createElement('div')
        host.id = 'yp-harness'
        host.style.cssText = 'position:relative;width:100%;'
        document.body.append(host)
        const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
        const video = document.createElement('video')
        video.muted = true
        video.preload = 'metadata'
        const mounted = createEpisodePlayer({
          video,
          sources: [{ id: 'local', url: src, quality: 1080 }],
          media: { title: 'Próba' },
          episode: { number: 1 },
          skipSegments: [{ kind: 'intro', start_sec: 5, end_sec: 40 }]
        })
        host.append(mounted.node)
        window.__yp = mounted
        // Nyitott menü: a legszélesebb réteg, amit egy keskeny képernyőn el
        // lehet rontani.
        mounted.ui.menu.show()
      }, VIDEO)
      await page.waitForTimeout(350)

      const report = await page.evaluate(minTap => {
        const doc = document.documentElement
        const shell = document.querySelector('.yp')
        const limit = doc.clientWidth
        const name = el => el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '')

        /*
         * A MÉRTÉK A HÉJ, NEM A KÉPERNYŐ — és csak arra, amit a néző használ.
         *
         * A `.yp` `overflow: hidden`, tehát ami túllóg rajta, az le van vágva,
         * nem kilóg. Az ambiens fényréteg szándékosan nagyobb (`scale(1.15)`),
         * és a rá vonatkozó „kilóg" jelzés hamis riasztás volt.
         *
         * Ami viszont SZÁMÍT: egy levágott gomb elérhetetlen. Ezért a
         * vezérlőket és a menüt a héj dobozához mérjük.
         */
        const box = shell.getBoundingClientRect()
        const wide = []
        const tiny = []
        for (const el of shell.querySelectorAll('button, .yp-controls, .yp-menu, .yp-skip, .yp-time, .yp-seek')) {
          const rect = el.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          if (rect.right > box.right + 1 || rect.left < box.left - 1) {
            wide.push(`${name(el)} (${Math.round(rect.left)}..${Math.round(rect.right)} vs héj ${Math.round(box.left)}..${Math.round(box.right)})`)
          }
          if (el.tagName === 'BUTTON' && !el.disabled &&
              (rect.width < minTap || rect.height < minTap)) {
            tiny.push(`${name(el)} ${Math.round(rect.width)}×${Math.round(rect.height)}`)
          }
        }
        const menu = shell.querySelector('.yp-menu').getBoundingClientRect()
        const controls = shell.querySelector('.yp-controls').getBoundingClientRect()
        return {
          pageScroll: doc.scrollWidth - limit,
          shellWidth: Math.round(box.width),
          clientW: limit,
          wide,
          tiny,
          menuFits: menu.right <= box.right + 1 && menu.left >= box.left - 1 && menu.height > 40,
          controlsFit: controls.right <= box.right + 1 && controls.left >= box.left - 1
        }
      }, MIN_TAP)

      assert.equal(report.pageScroll, 0, `a lap oldalra görgethető ${width}px-en`)
      assert.deepEqual(report.wide, [], `kilóg a lejátszóból ${width}px-en`)
      assert.equal(report.menuFits, true, `a beállítások menü kilóg ${width}px-en`)
      assert.equal(report.controlsFit, true, `a vezérlősáv kilóg ${width}px-en`)
      if (width <= PHONE) {
        assert.deepEqual(report.tiny, [], `ujjal eltalálhatatlan gomb ${width}px-en`)
      }
      await page.evaluate(() => { window.__yp?.destroy(); document.querySelector('#yp-harness')?.remove() })
      await page.setViewportSize({ width: 1440, height: 900 })
    })
  }

  /*
   * ---- MÉRÉS ----
   *
   * Számok, nem állítások. A küszöbök szándékosan LAZÁK: ez a gép egy VPS,
   * megosztott maggal, és egy szoros határ itt nem a lejátszóról mondana
   * valamit, hanem a szomszéd konténer terheléséről. Amit ezek megfognak, az
   * a NAGYSÁGRENDI elcsúszás — egy ötszörösére nőtt felépítési idő, egy
   * szétbontás után bennmaradó figyelő.
   *
   * A mért értékek a kimenetre is kiíródnak, hogy legyen mihez hasonlítani.
   */
  it('a felépítés ára', async () => {
    const measured = await page.evaluate(async (src) => {
      const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
      const runs = []
      for (let i = 0; i < 12; i++) {
        const host = document.createElement('div')
        host.style.cssText = 'position:absolute;left:-9999px;width:800px;'
        document.body.append(host)
        const video = document.createElement('video')
        video.muted = true
        const started = performance.now()
        const mounted = createEpisodePlayer({
          video,
          sources: [{ id: 'local', url: src, quality: 1080 }],
          media: { title: 'Próba' },
          episode: { number: 1 }
        })
        host.append(mounted.node)
        runs.push(performance.now() - started)
        mounted.destroy()
        host.remove()
      }
      runs.sort((a, b) => a - b)
      return { median: runs[6], worst: runs.at(-1), runs: runs.map(r => Math.round(r * 100) / 100) }
    }, VIDEO)

    console.log(`  felépítés: medián ${measured.median.toFixed(2)} ms, legrosszabb ${measured.worst.toFixed(2)} ms`)
    assert.ok(measured.median < 60, `a felépítés mediánja ${measured.median.toFixed(2)} ms`)
  })

  it('az állapotfrissítés ára', async () => {
    const measured = await page.evaluate(async (src) => {
      const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
      const host = document.createElement('div')
      host.style.cssText = 'position:absolute;left:-9999px;width:800px;'
      document.body.append(host)
      const video = document.createElement('video')
      video.muted = true
      const mounted = createEpisodePlayer({
        video,
        sources: [{ id: 'local', url: src, quality: 1080 }],
        media: { title: 'Próba' },
        episode: { number: 1 }
      })
      host.append(mounted.node)

      // Ezer időfrissítés: ennyi egy háromórás film alatt jön. Minden egyes
      // frissítés végigmegy a feliratkozókon és újrarajzolja a sávot.
      const started = performance.now()
      for (let i = 0; i < 1000; i++) mounted.player.state.patch({ playback: { currentTime: i * 0.25 } })
      const elapsed = performance.now() - started

      // És ezer olyan, ami NEM VÁLTOZTAT semmin: a mezőnkénti
      // változásfigyelés nélkül ezek is teljes újrarajzolást kérnének.
      const before = performance.now()
      for (let i = 0; i < 1000; i++) mounted.player.state.patch({ playback: { currentTime: 250 } })
      const idle = performance.now() - before

      mounted.destroy()
      host.remove()
      return { perUpdate: elapsed / 1000, idlePerUpdate: idle / 1000 }
    }, VIDEO)

    console.log(`  állapotfrissítés: ${(measured.perUpdate * 1000).toFixed(1)} µs/db, ` +
      `változás nélkül ${(measured.idlePerUpdate * 1000).toFixed(1)} µs/db`)
    assert.ok(measured.perUpdate < 1, `egy frissítés ${measured.perUpdate.toFixed(3)} ms`)
    // A NEM VÁLTOZÓ frissítésnek olcsóbbnak kell lennie. Ha nem az, a
    // mezőnkénti összehasonlítás nem működik, és minden `timeupdate`
    // újrarajzolja az egész felületet.
    assert.ok(measured.idlePerUpdate < measured.perUpdate,
      `a változás nélküli frissítés nem olcsóbb (${measured.idlePerUpdate.toFixed(3)} vs ${measured.perUpdate.toFixed(3)} ms)`)
  })

  it('a szétbontás után nem marad semmi', async () => {
    const leak = await page.evaluate(async (src) => {
      const { createEpisodePlayer } = await import('../../../../src/features/player2/watch/episode-player.js')
      const nodesBefore = document.querySelectorAll('*').length

      let owned = 0
      for (let i = 0; i < 25; i++) {
        const host = document.createElement('div')
        host.style.cssText = 'position:absolute;left:-9999px;width:800px;'
        document.body.append(host)
        const video = document.createElement('video')
        video.muted = true
        const mounted = createEpisodePlayer({
          video,
          sources: [{ id: 'local', url: src, quality: 1080 }],
          media: { title: 'Próba' },
          episode: { number: 1 }
        })
        host.append(mounted.node)
        mounted.destroy()
        owned = mounted.player.owned
        host.remove()
      }
      return { nodesBefore, nodesAfter: document.querySelectorAll('*').length, owned }
    }, VIDEO)

    console.log(`  25 felépítés+szétbontás után: ${leak.nodesAfter - leak.nodesBefore} maradék elem, ` +
      `${leak.owned} el nem bontott erőforrás`)
    assert.equal(leak.owned, 0, 'a szétbontás után maradt nyilvántartott erőforrás')
    // Huszonöt kör után egyetlen elem sem maradhat a lapon. A lejátszó a
    // részváltásnál újraépül; egy körönként bennmaradó héj egy sorozatnézés
    // alatt tucatnyi rejtett videóelemet jelentene.
    assert.equal(leak.nodesAfter, leak.nodesBefore, 'elemek maradtak a lapon')
  })

  it('a lejátszás nem terheli a főszálat', async () => {
    await mount()
    const measured = await page.evaluate(async () => {
      const video = document.querySelector('.yp video')
      if (video.readyState < 2) {
        await new Promise(resolve => {
          video.addEventListener('loadeddata', resolve, { once: true })
          setTimeout(resolve, 15000)
        })
      }
      await video.play().catch(() => {})

      // A KÉPKOCKÁK KÖZTI IDŐ. Ha a lejátszó minden `timeupdate`-re
      // újrarajzolna mindent, ez a szám látványosan megugrana.
      const gaps = []
      let last = performance.now()
      await new Promise(resolve => {
        let frames = 0
        const tick = () => {
          const now = performance.now()
          gaps.push(now - last)
          last = now
          if (++frames >= 120) return resolve()
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      gaps.sort((a, b) => a - b)
      return {
        median: gaps[Math.floor(gaps.length / 2)],
        p95: gaps[Math.floor(gaps.length * 0.95)],
        worst: gaps.at(-1)
      }
    })
    console.log(`  képkockaköz lejátszás közben: medián ${measured.median.toFixed(1)} ms, ` +
      `p95 ${measured.p95.toFixed(1)} ms, legrosszabb ${measured.worst.toFixed(1)} ms`)
    // Fejetlen böngészőben nincs valódi képernyőfrissítés, ezért a szám nem
    // hasonlítható egy asztali 60 Hz-hez. Amit megfog: a főszál BEFAGYÁSÁT.
    assert.ok(measured.p95 < 200, `a képkockaköz p95 ${measured.p95.toFixed(1)} ms — valami blokkolja a főszálat`)

    /*
     * A MEDIÁNRA SZŰKEBB HATÁR, mert ezen bukott meg egyszer már valami.
     *
     * A környezeti fény első változata a videó képkockáit másolta vászonra
     * fél másodpercenként. Ettől a medián 16,7 ms-ról 75,2 ms-ra romlott — a
     * visszaolvasás a GPU-ról a dekódolót lassabb úton hagyja, és nem a
     * másolás pillanata drágul, hanem az egész lejátszás.
     *
     * A 40 ms bőven a mért 16,7 fölött van (nem szorít egy terhelt gépen),
     * és bőven a 75 alatt (megfogja ezt a hibaosztályt).
     */
    assert.ok(measured.median < 40,
      `a képkockaköz mediánja ${measured.median.toFixed(1)} ms — valami folyamatos munkát végez lejátszás közben`)
    await teardown()
  })

  /*
   * ---- AKADÁLYMENTESSÉG (28. pont) ----
   *
   * Ezek közül egyik sem ellenőrizhető DOM-csonkon: kiszámolt stílus kell
   * hozzá, és egy valódi fókuszsorrend.
   */
  it('minden vezérlőnek van felolvasható neve', async () => {
    await mount()
    const nameless = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('.yp button, .yp [role="slider"]')) {
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const name = el.getAttribute('aria-label') || el.textContent.trim()
        if (!name) out.push(el.className || el.tagName)
      }
      return out
    })
    assert.deepEqual(nameless, [], 'ezeket a felolvasó „gomb"-ként mondaná be')
    await teardown()
  })

  it('a fókusz látszik, és a Tab végigmegy a vezérlőkön', async () => {
    await mount()
    const result = await page.evaluate(() => {
      /*
       * A REJTETT VEZÉRLŐK KIMARADNAK, és ez nem kényelmi kivétel: a
       * `.yp-hidden` `visibility: hidden`, amire a böngésző SZÁNDÉKOSAN nem
       * enged fókuszt, és ki is veszi a Tab sorrendjéből. Pont ezt akarjuk —
       * egy elrejtett gomb ne nyelje el a fókuszt a képernyőn kívül.
       */
      const focusable = [...document.querySelectorAll('.yp button:not([disabled]), .yp [tabindex="0"]')]
        .filter(el => {
          const style = window.getComputedStyle(el)
          return style.visibility !== 'hidden' && style.display !== 'none'
        })
      const invisible = []
      for (const el of focusable) {
        el.focus()
        // A `:focus-visible` kiszámolt körvonala nem mindig olvasható ki
        // programból; a szabály MEGLÉTE viszont igen, a lapon lévő
        // stíluslapokból.
        if (document.activeElement !== el) invisible.push(el.className)
      }
      const sheets = [...document.styleSheets].filter(sheet => {
        try { return sheet.cssRules } catch { return false }
      })
      const focusRules = sheets.flatMap(sheet => [...sheet.cssRules])
        .filter(rule => rule.selectorText?.includes('.yp') && rule.selectorText.includes(':focus-visible'))
        .map(rule => rule.style.outline || rule.style.outlineWidth)
        .filter(Boolean)
      return { count: focusable.length, notFocusable: invisible, focusRules: focusRules.length }
    })
    assert.ok(result.count >= 6, `csak ${result.count} fókuszálható vezérlő`)
    assert.deepEqual(result.notFocusable, [], 'ezekre nem lehet fókuszálni')
    assert.ok(result.focusRules >= 2, 'nincs látható fókuszjelölés a lejátszón')
    await teardown()
  })

  it('a tekerősáv a felolvasónak is csúszka', async () => {
    await mount()
    const seek = await page.evaluate(() => {
      const el = document.querySelector('.yp-seek')
      return {
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label'),
        min: el.getAttribute('aria-valuemin'),
        text: el.getAttribute('aria-valuetext'),
        tabindex: el.getAttribute('tabindex')
      }
    })
    assert.equal(seek.role, 'slider')
    assert.ok(seek.label)
    assert.equal(seek.min, '0')
    assert.equal(seek.tabindex, '0')
    // Kimondott idő, nem nyers másodperc: a „nyolcszázhetvenhárom" nem
    // mond semmit.
    assert.match(seek.text ?? '', /másodperc|perc|óra/)
    await teardown()
  })

  it('a mozgás letiltása megállítja a betöltő pásztázását', async () => {
    // Akinek a folyamatos mozgás rosszullétet okoz, annak a rendszerbeállítása
    // erről szól, és a lejátszónak illik meghallania.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mount()
    const animation = await page.evaluate(() => {
      const sweep = document.querySelector('.yp-loader-sweep')
      const style = window.getComputedStyle(sweep)
      return { name: style.animationName, base: window.getComputedStyle(document.querySelector('.yp-loader-base')).display }
    })
    assert.equal(animation.name, 'none', 'a pásztázás mozgásmentes módban is megy')
    // A logó nem tűnik el, csak nem mozog: színesen, egyben áll ott.
    assert.equal(animation.base, 'none')
    await teardown()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  it('a kikapcsolt gomb nem csak halvány, hanem tiltott is', async () => {
    // „No color-only information": egy csak opacitással jelzett tiltás a
    // felolvasónak és a színtévesztőnek egyaránt láthatatlan.
    await mount()
    const previous = await page.evaluate(() => {
      const el = document.querySelector('.yp-btn-prev')
      return { disabled: el.disabled, aria: el.getAttribute('aria-disabled'), opacity: window.getComputedStyle(el).opacity }
    })
    assert.equal(previous.disabled, true, 'nincs előző rész, mégsem tiltott')
    assert.ok(Number(previous.opacity) < 1, 'nincs látható különbség')
    await teardown()
  })

  it('nem dobott hibát a lap egyetlen lépésnél sem', () => {
    // A `pageerror` minden eddigi lépésre gyűlt. Egy elszállt ígéret nem
    // állítja meg a tesztet, de a lejátszót igen.
    assert.deepEqual(errors, [])
  })
})
