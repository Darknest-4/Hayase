/* global Storage, localStorage */
// A statisztikai panel két új füle — valódi böngésző, valódi adat.
//
// MINDEN ÁLLÍTÁS ITT EGY MÉRT HIBÁT ŐRIZ, és egyik sem következik a kódból:
//
//   1. `NaN` A PANELEN. Az `analyticsTable` egy RANGSOROLT, sávos lista:
//      számot vár a második oszlopban, és abból arányt számol. Állapotlistára
//      használva `NaN`-t és `[object HTMLSpanElement]`-et írt a képernyőre.
//      A követelmény 16. pontja ezt kifejezetten tiltja.
//
//   2. TELEFONOS TÚLLÓGÁS. Ugyanannak a listának a jobb oszlopa `nowrap`;
//      egy hosszabb felsorolás ott 623 képpontig feszítette a sort egy
//      390 képpontos telefonon, és a vége levágódott.
//
//   3. NULLA KÉRÉSNÉL A HIBAARÁNY NEM 0%. Egy 0%-os kártya azt állítaná,
//      hogy mérünk és minden rendben — pedig nincs adat.

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

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

const SLUG = 'e2e-panel-provider'

describe('a statisztikai panel új füljei', { skip: REASON }, () => {
  let server, browser, pool, page, base, account
  const username = 'panels' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'analytics-panels-secret-not-used-0123456789'
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

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    account = await res.json()
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = 'admin'
       ON CONFLICT DO NOTHING`, [username])
    const auth = await import('../../apps/api/src/middleware/auth.ts')
    auth.invalidatePermissions()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(tokens => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    }, account)
    await page.route('https://**', route => route.abort())
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM provider_metrics_daily WHERE slug = $1', [SLUG])
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  /** Mérési adat felvétele — valós alakú, hogy a panel is valósat mutasson. */
  const adat = async () => {
    await pool.query('DELETE FROM provider_metrics_daily WHERE slug = $1', [SLUG])
    await pool.query(
      `INSERT INTO provider_metrics_daily (day, slug, outcome, attempts, sources, latency_ms_sum, latency_ms_max)
       VALUES (current_date, $1, 'ok',      142, 284, 31240, 980),
              (current_date, $1, 'empty',    37,   0,  5180, 420),
              (current_date, $1, 'error',     6,   0,  2100, 860),
              (current_date, $1, 'timeout',   2,   0, 16000, 8000),
              (current_date, $1, 'skipped',  12,   0,     0,   0)`, [SLUG])
  }

  const nyitFul = async (cimke, width = 1440) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${base}/#/admin/analytics`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.report-tab', { timeout: 20000 })
    await page.locator('.report-tab', { hasText: cimke }).first().click()
    await page.waitForTimeout(1500)
  }

  /** Amit a néző TÉNYLEGESEN lát a panelen. */
  const kepernyo = async () => await page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const nev = el => el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '')
    const panelek = [...document.querySelectorAll('.admin-content .dash-panel')]
    /*
     * A TELJES FÜLTARTALMAT OLVASSUK, nem csak a paneleket. Az üres állapot
     * nem `.dash-panel`-be kerül, hanem közvetlenül a fül törzsébe — az első
     * változat ezt nem látta, és a teszt a TERMÉKET hibáztatta a saját szűk
     * mérése helyett.
     */
    const torzs = document.querySelector('.admin-content')?.innerText ?? ''
    return {
      szoveg: (panelek.map(p => p.innerText).join('\n') + '\n' + torzs),
      kartyak: (document.querySelector('.admin-content .dash-cards')?.innerText ?? ''),
      /*
       * A LEVÁGOTT SZÖVEG IS HIBA, nem csak a túllógás.
       *
       * Egy `white-space: nowrap` szövegsor nem feszíti szét a szülőt, ha az
       * levágja — a mérés „nem lóg túl"-t mond, a néző mégis a mondat felét
       * látja. Ezért a tartalom és a doboz szélességét is összevetjük.
       */
      levagott: [...document.querySelectorAll('.admin-content .meta-row-sub, .admin-content .dash-kpi-value')]
        .filter(e => e.scrollWidth > e.clientWidth + 1)
        .map(e => `${nev(e)}: "${(e.textContent || '').trim().slice(0, 40)}…"`)
        .slice(0, 5),
      kilog: [...new Set([...document.querySelectorAll('body *')]
        .filter(e => { const b = e.getBoundingClientRect(); return b.width && b.right > limit + 1 })
        .map(e => `${nev(e)} → ${Math.round(e.getBoundingClientRect().right)}`))].slice(0, 6),
      panelSzam: panelek.length
    }
  })

  it('mindkét új fül megjelenik', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${base}/#/admin/analytics`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.report-tab', { timeout: 20000 })
    const cimkek = await page.locator('.report-tab').allInnerTexts()
    assert.ok(cimkek.includes('Szolgáltatók'), `nincs Szolgáltatók fül: ${cimkek.join(', ')}`)
    assert.ok(cimkek.includes('Rendszer'), `nincs Rendszer fül: ${cimkek.join(', ')}`)
  })

  it('a rendszerállapot NEM ír NaN-t vagy objektumot a képernyőre', async () => {
    await nyitFul('Rendszer')
    const k = await kepernyo()
    assert.ok(k.panelSzam > 0, 'nem jelent meg panel')
    assert.ok(!/NaN/.test(k.szoveg), `NaN a rendszerállapotban: ${k.szoveg.slice(0, 200)}`)
    assert.ok(!/\[object /.test(k.szoveg), `objektum szövegként: ${k.szoveg.slice(0, 200)}`)
    assert.ok(!/undefined/.test(k.szoveg), `undefined a panelen: ${k.szoveg.slice(0, 200)}`)
  })

  it('a rendszerállapot valódi komponenseket sorol fel', async () => {
    await nyitFul('Rendszer')
    const k = await kepernyo()
    assert.match(k.szoveg, /postgres/i, 'az adatbázis állapota nem jelenik meg')
    // A be nem kapcsolt komponens nem hiba — ki is írjuk, hogy mi a helyzet.
    if (/redis/i.test(k.szoveg)) {
      assert.match(k.szoveg, /nincs bekapcsolva|működik|akadozik|nem elérhető/,
        'a komponens állapota nincs emberi szóval kiírva')
    }
  })

  it('a szolgáltatói fül a valódi mérésből számol', async () => {
    await adat()
    await nyitFul('Szolgáltatók')
    const k = await kepernyo()
    assert.match(k.szoveg, new RegExp(SLUG), 'a próbaszolgáltató nem jelenik meg')
    assert.ok(!/NaN|\[object |undefined/.test(k.szoveg + k.kartyak),
      `hibás érték a panelen: ${(k.szoveg + k.kartyak).slice(0, 200)}`)

    /*
     * A VÁRT SZÁM AZ ADATBÁZISBÓL JÖN, NEM BEÉGETVE.
     *
     * Eredetileg a saját vetésem összege (187) állt itt. Ez a KPI viszont a
     * TELJES időszak minden szolgáltatóját összegzi, tehát bármelyik másik
     * készlet egyetlen ottfelejtett sora elrontja — mérve: egy `yume-local`
     * sor egy attempttel, és a panel 188-at írt.
     *
     * Így a tétel azt méri, amit mérni akar: hogy a panel UGYANAZT a
     * szabályt alkalmazza, mint amit a végponttól elvárunk (a `skipped`
     * kimarad a kérdezett kérésekből, és a hibaarány ezekhez viszonyít) —
     * nem azt, hogy a teszt-adatbázis épp milyen állapotban van.
     */
    const { rows } = await pool.query(
      `SELECT coalesce(sum(attempts) FILTER (WHERE outcome IN ('ok','empty','error','timeout')), 0)::int AS kerdezett,
              coalesce(sum(attempts) FILTER (WHERE outcome IN ('error','timeout')), 0)::int AS hibas
         FROM provider_metrics_daily
        WHERE day >= current_date - 6`)
    const { kerdezett, hibas } = rows[0]
    const arany = kerdezett > 0 ? Math.round((hibas / kerdezett) * 1000) / 10 : null

    assert.ok(kerdezett >= 187, `a vetés nem ért be: ${kerdezett}`)
    assert.match(k.kartyak, new RegExp(String(kerdezett)),
      `a kérésszám nem ${kerdezett}: ${k.kartyak.replace(/\n/g, ' | ')}`)
    assert.match(k.kartyak, new RegExp(String(arany).replace('.', '[.,]') + '\\s*%'),
      `a hibaarány nem ${arany}%: ${k.kartyak.replace(/\n/g, ' | ')}`)
  })

  /*
   * AZ ÁLLAPOTVÁLTOZÁSOK PANELJE SZÖVEGET MUTAT, NEM SZÁMOT.
   *
   * Ez a hiba sokáig REJTVE VOLT: amíg egyetlen szolgáltató sem esett le, a
   * panel üres volt, és a NaN nem látszott. Az első állapotváltozás hozta
   * elő. Ezért a teszt maga vet be egy eseményt — a rejtett hibát nem
   * szabad a véletlenre bízni.
   */
  it('az állapotváltozások panelje nem ír NaN-t', async () => {
    await adat()
    await pool.query('DELETE FROM provider_events WHERE slug = $1', [SLUG])
    await pool.query(
      `INSERT INTO provider_events (slug, event, detail, latency_ms, at)
       VALUES ($1, 'down', 'Missing Permissions', 8000, now() - interval '2 hours'),
              ($1, 'up', NULL, 120, now() - interval '1 hour')`, [SLUG])
    try {
      await nyitFul('Szolgáltatók')
      const k = await kepernyo()
      assert.match(k.szoveg, /down|up/, 'nem jelenik meg az állapotváltozás')
      assert.ok(!/NaN/.test(k.szoveg), `NaN az állapotváltozásoknál: ${k.szoveg.slice(0, 200)}`)
      assert.ok(!/\[object /.test(k.szoveg), 'objektum szövegként')
    } finally {
      await pool.query('DELETE FROM provider_events WHERE slug = $1', [SLUG])
    }
  })

  /*
   * NULLA KÉRÉSNÉL NINCS SZÁZALÉK. Egy „0% hiba" kártya azt állítaná, hogy
   * mérünk és minden rendben — pedig egyszerűen nincs adat.
   */
  it('mérés nélkül üres állapotot mutat, nem nullákat', async () => {
    await pool.query('DELETE FROM provider_metrics_daily WHERE day >= current_date - 7')
    await nyitFul('Szolgáltatók')
    const k = await kepernyo()
    assert.ok(!/0[.,]0\s*%/.test(k.kartyak), 'nulla százalékot mutat adat nélkül')
    assert.match(k.szoveg + k.kartyak, /egyetlen szolgáltatói kérés sem|Nincs mérés/,
      'nincs érdemi üres állapot')
  })

  /*
   * CSUPA `skipped` — a megszakító mindent kizárt.
   *
   * Ez az az eset, amiben a hibaarány NEM 0%: nulla kérés ment ki, tehát
   * nincs mihez viszonyítani. Mérve, a javítás előtt: a kártya „0"-t írt,
   * mert a számformázó a „—" jelet `Number(…) || 0`-val nullára alakította.
   * Egy 0%-os hibaarány a legrosszabb lehetséges hazugság egy olyan
   * pillanatban, amikor épp minden szolgáltató ki van zárva.
   */
  it('csupa kihagyott kísérletnél nem mutat 0% hibaarányt', async () => {
    await pool.query('DELETE FROM provider_metrics_daily WHERE day >= current_date - 7')
    await pool.query(
      `INSERT INTO provider_metrics_daily (day, slug, outcome, attempts, sources, latency_ms_sum, latency_ms_max)
       VALUES (current_date, $1, 'skipped', 25, 0, 0, 0)`, [SLUG])

    await nyitFul('Szolgáltatók')
    const k = await kepernyo()
    assert.match(k.szoveg, new RegExp(SLUG), 'a szolgáltató nem jelenik meg')
    assert.ok(!/0\s*%/.test(k.kartyak),
      `0%-os hibaarányt mutat, pedig egyetlen kérés sem ment ki: ${k.kartyak.replace(/\n/g, ' | ')}`)
    assert.match(k.kartyak, /nincs adat/i, 'nem mondja meg, hogy nincs adat')
  })

  for (const width of [430, 390, 360]) {
    it(`${width} képponton egyik fül sem lóg túl`, async () => {
      await adat()
      for (const cimke of ['Szolgáltatók', 'Rendszer']) {
        await nyitFul(cimke, width)
        const k = await kepernyo()
        assert.deepEqual(k.kilog, [], `a(z) „${cimke}" fül túllóg ${width}px-en`)
        assert.deepEqual(k.levagott, [], `levágott szöveg a(z) „${cimke}" fülön ${width}px-en`)
      }
    })
  }
})
