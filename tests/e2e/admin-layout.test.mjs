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

describe('admin panel layout', { skip: REASON }, () => {
  let server, browser, pool, base, account
  const username = 'e2eadm' + randomBytes(4).toString('hex')

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
    // Egy böngészős futás percek alatt több száz kérést küld egyetlen címről:
    // minden oldalbetöltés lekéri a konfigurációt, a jogosultságokat és a
    // képernyő adatait. A globális sebességkorlát (300/perc) ezt helyesen
    // fojtja meg — és akkor a teszt egy 429-es hibalapot mér, nem a terméket.
    // Ez már megtörtént egyszer; azóta nevesítve van a hamis pozitívok között.
    process.env.RATE_LIMIT_MAX ??= '100000'
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
    // The panel is invisible without the permissions, which is the subject of
    // its own test — here it is a precondition.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../../apps/api/src/middleware/auth.ts')
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
    // `state: 'attached'`, nem a láthatóság. Telefonszélességen a fiók
    // szándékosan a képernyőn kívül ül, amíg valaki ki nem nyitja — ez a
    // fiókok lényege, és a 4. eset épp ezt állítja. A Playwright viszont a
    // viewporton kívüli elemet nem tekinti láthatónak, tehát a segédfüggvény
    // a saját tárgyára várt volna, és időtúllépéssel halt volna el.
    await page.waitForSelector('.admin-nav', { state: 'attached', timeout: 15000 })
    // A panel akkor áll készen, amikor a sorai kirajzolódtak; a fiók puszta
    // jelenléte ezt még nem jelenti.
    await page.waitForSelector('.admin-nav-item', { state: 'attached', timeout: 15000 })
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

  /*
   * EGY LAPON EGY ADMINFELÜLET.
   *
   * MÉRT HIBA. A `navigate()` kiüríti a `#page`-et, aztán megvárja az oldal
   * kezelőjét — két egyidejű navigáció így egymásba csúszott: az egyik már
   * betette a felületét, amikor a másik felébredt és betette a magáét is. Két
   * navigációs sáv, két időzítő, minden kérés duplán. A generációs őr ezt nem
   * fogta meg, mert csak a kezelő UTÁN néz, a beszúrás pedig addigra megvolt.
   *
   * A második megnyitáskor jelentkezett, mert az első után a beállítások már
   * a gyorsítótárból jöttek, és a nyelvi preferencia változása a bootstrap
   * ŐRE UTÁN indított egy második navigációt.
   */
  it('kétszer megnyitva sem lesz két adminfelület', async () => {
    const { page } = await open({ width: 1280, height: 900 })
    assert.equal(await page.locator('.admin-content').count(), 1, 'már az elsőre kettő')

    // Teljes dokumentumcsere, majd vissza — pontosan ez hozta elő.
    await page.goto('about:blank')
    await page.goto(`${base}/#/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.admin-nav-item', { state: 'attached', timeout: 15000 })
    await page.waitForTimeout(1500)
    assert.equal(await page.locator('.admin-content').count(), 1,
      'két adminfelület egy lapon — két navigációs sáv és minden kérés duplán')
    assert.equal(await page.locator('.admin-nav').count(), 1)
    await page.close()
  })

  /*
   * A GYORS OLDALVÁLTÁSBÓL A LEGUTOLSÓ NYER. A sorba állítás nem állhat meg
   * az elsőnél: aki kétszer kattint, a másodikat akarja látni.
   */
  it('gyors váltásnál a legutolsó oldal marad a képen', async () => {
    const { page } = await open({ width: 1280, height: 900 })
    await page.evaluate(() => { window.location.hash = '#/home' })
    await page.evaluate(() => { window.location.hash = '#/admin' })
    await page.waitForTimeout(2500)
    assert.equal(await page.locator('.admin-content').count(), 1, 'nem egy adminfelület maradt')
    assert.equal(await page.evaluate(() => document.body.className.includes('admin-route')), true,
      'nem az utolsó navigáció nyert')
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
    await page.waitForSelector('.admin-nav', { state: 'attached' })
    await page.waitForSelector('.admin-nav-item', { state: 'attached' })
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

  /*
   * A szakasz neve pontosan egyszer szerepeljen — és görgetés közben is
   * látszódjon.
   *
   * Ez a teszt korábban a HELYÉT rögzítette (a fejlécblokkban legyen, a felső
   * sávban ne). A hely azóta megfordult, és jó okkal: a fejlécblokk
   * elgörgetődik, és egy hosszú operátori lapon a képernyő közepén már semmi
   * nem mondja meg, melyik szakaszban vagy. A felső sáv tapad.
   *
   * Amit ki KELL kötni, az nem a hely, hanem a két tulajdonság: egyszer
   * szerepel, és görgetés után is ott van.
   */
  it('names the section exactly once on a phone', async () => {
    const { page } = await open({ width: 390, height: 780 })

    const visibleTexts = async () => page.evaluate(() => {
      const seen = []
      for (const sel of ['.admin-topbar-title', '.admin-content-title']) {
        for (const el of document.querySelectorAll(sel)) {
          const style = getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          const text = el.textContent.trim()
          if (text) seen.push(text)
        }
      }
      return seen
    })

    const names = await visibleTexts()
    assert.equal(names.length, 1, `a szakasz neve ${names.length}-szer látszik: ${names.join(' / ')}`)
    assert.ok(names[0].length, 'a szakasznak nincs neve sehol')
    await page.close()
  })

  it('keeps the section name on screen after scrolling', async () => {
    const { page } = await open({ width: 390, height: 780 })
    await page.evaluate(() => window.scrollTo(0, 1200))
    await page.waitForTimeout(250)

    const stillThere = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.admin-topbar-title, .admin-content-title')) {
        const style = getComputedStyle(el)
        if (style.display === 'none' || !el.textContent.trim()) continue
        const box = el.getBoundingClientRect()
        if (box.top >= 0 && box.bottom <= window.innerHeight) return el.textContent.trim()
      }
      return null
    })
    assert.ok(stillThere, 'lefelé görgetve semmi nem mondja meg, melyik szakaszban vagy')
    await page.close()
  })
})
