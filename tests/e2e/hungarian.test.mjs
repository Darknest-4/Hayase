// Angol szöveg a magyar felületen — pontosan, nem heurisztikával.
//
// A kérdés nem az, hogy „angolul néz-e ki egy szó". Az a fordítás minőségéről
// szólna, és tele lenne álpozitívval: a katalógus címei, a műfajcímkék és a
// stúdiók nevei angolul is helyesek.
//
// A kérdés az, hogy **van-e magyar fordítása annak a szövegnek, ami a képernyőn
// angolul áll**. Ha igen, akkor a szótár rendben van, és egy T() hiányzik egy
// hívási helyről. Ez pont az a hiba, amit végignézve sem lehet megtalálni: a
// szó ott van, olvasható, és semmi nem jelzi, hogy helyette magyar állhatna.
//
// Nyolc ilyet talált, amikor megírtam: a gyorskereső placeholderét (statikus
// markupban, amit semmi nem fordít), a könyvtár füleit, az értesítések
// „All caught up" alcímét, a beállítások egyik aria-label-jét, a rendezés
// legördülőjének felét.
//
//   npm run test:e2e
//
// Playwright vagy DATABASE_URL nélkül kihagyja magát — a CI-ben nem.

/* global document, localStorage, Storage, NodeFilter */
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

if (!chromium && process.env.CI) {
  throw new Error('playwright could not be imported and CI is set')
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

const ROUTES = ['home', 'search', 'list', 'notifications', 'profile', 'settings',
  'community', 'schedule', 'dashboard', 'changelog']

// A két képernyő, aminek azonosító kell — és amin a legtöbb szöveg van. A
// részletoldal fülsávja és infókártyája volt a legnagyobb szivárgás, a
// lejátszó pedig az egyetlen hely, ahol a felület a videó fölé kerül.
const WITH_ID = [
  { name: 'anime/:id', path: id => `anime/${id}` },
  { name: 'watch/:id', path: id => `watch/${id}:1` }
]

describe('a magyar felületen nincs lefordítatlan szöveg', { skip: REASON }, () => {
  let server, browser, pool, page, base, keys, sampleId
  const username = 'e2ehu' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'e2e-secret-not-used-for-anything-real-0123456789'
    process.env.LOG_LEVEL ??= 'warn'
    const [{ buildApp }, db, { I18n }] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts'),
      import('../../apps/web/src/shared/i18n/i18n.js')
    ])
    await import('../../apps/web/src/shared/i18n/hu.js')
    // Csak azok, amik tényleg változnak: a „Mecha" magyarul is Mecha, és egy
    // ilyen bejegyzés a képernyőn megkülönböztethetetlen a hiánytól.
    const dict = I18n.dictionary('hu')
    keys = Object.keys(dict).filter(key => dict[key] !== key)

    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    const account = await res.json()

    // Egy valódi cím a katalógusból: egy kitalált azonosító a „nincs ilyen"
    // képernyőt adná vissza, amin három sor szöveg van, és a teszt boldogan
    // zöld lenne anélkül, hogy a részletoldalt egyszer is megnézte volna.
    const sample = await pool.query(
      `SELECT a.id FROM anime a
        WHERE a.visibility = 'public'
          AND EXISTS (SELECT 1 FROM anime_images i WHERE i.anime_id = a.id AND i.kind = 'cover')
        ORDER BY a.popularity DESC NULLS LAST
        LIMIT 1`)
    sampleId = sample.rows[0]?.id ?? null

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    // A token az alkalmazás első sora előtt megy be: egy későbbi, csak
    // hash-ben eltérő navigáció nem tölti újra az oldalt, és bejelentkezés
    // nélkül a fele képernyő nem is renderelődik.
    await context.addInitScript(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    }, account)
    page = await context.newPage()
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

  it('has a dictionary to check against', () => {
    // E nélkül az alábbi állítás úgy menne át, hogy semmit nem keresett.
    assert.ok(keys.length > 200, `only ${keys.length} translated entries`)
  })

  const scan = async route => {
    await page.goto(`${base}/#/${route}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
    return page.evaluate(translatable => {
      const set = new Set(translatable)
      const found = new Set()
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walk.nextNode())) {
        const text = node.textContent.trim()
        if (text && set.has(text)) found.add(text)
      }
      // A látható szöveg fele nem szövegcsomópont: placeholder, title és
      // aria-label. A keresőmező placeholdere pont ilyen volt.
      for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
        for (const attr of ['placeholder', 'title', 'aria-label']) {
          const value = el.getAttribute(attr)
          if (value && set.has(value.trim())) found.add(value.trim())
        }
      }
      return [...found]
    }, keys)
  }

  for (const route of ROUTES) {
    it(`#/${route}`, async () => {
      const leaks = await scan(route)
      assert.deepEqual(leaks, [], `these have a Hungarian translation and are shown in English on #/${route}`)
    })
  }

  for (const screen of WITH_ID) {
    it(`#/${screen.name}`, async (t) => {
      if (!sampleId) return t.skip('the catalogue is empty')
      const route = screen.path(sampleId)
      const leaks = await scan(route)
      assert.deepEqual(leaks, [], `these have a Hungarian translation and are shown in English on #/${route}`)
    })
  }
})
