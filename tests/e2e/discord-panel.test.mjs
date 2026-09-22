/* global Storage, localStorage */
// A Discord vezérlőpult felülete.
//
// AMIT ŐRIZ: a panel a VALÓS adatot mutatja, és nem hazudik állapotot.
// Három tétel, és mindhárom mért hibából származó elvárás:
//
//   1. A panel SOHA nem ír `NaN`-t, `undefined`-ot vagy objektumot. A
//      követelmény 16. pontja ezt tiltja, és ebben a projektben már
//      előfordult: egy rangsoros listába tett állapotlista pontosan ezt
//      csinálta.
//
//   2. Az ELŐNÉZET nem küldés (11.2. pont) — a gomb felirata és a
//      visszajelzése is ezt mondja.
//
//   3. Telefonon sem lóg túl és nem vágódik le semmi.

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

const GUILD = '100000000000000777'
const CSATORNA = '200000000000000777'

describe('a Discord vezérlőpult felülete', { skip: REASON }, () => {
  let server, browser, pool, page, base, account
  const username = 'dpanel' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'discord-panel-secret-not-used-0123456789'
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

    await pool.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
    await pool.query(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type, message_id, last_success_at)
       VALUES ($1, $2, 'yume_statistics', '300000000000000001', now()),
              ($1, $2, 'system_health', NULL, NULL)`, [GUILD, CSATORNA])
    // Egy elromlott is, hogy a hibás állapot is látszódjon.
    await pool.query(
      `INSERT INTO persistent_messages (guild_id, channel_id, message_type, failure_count, last_error)
       VALUES ($1, $2, 'provider_status', 3, 'Missing Permissions')`, [GUILD, CSATORNA])

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    // Az `addInitScript` EGY argumentumot ad át — a kettőt objektumba kell tenni.
    await page.addInitScript(({ tokens, guild }) => {
      localStorage.setItem('yume-auth', JSON.stringify(tokens))
      localStorage.setItem('yume-discord-guild', guild)
      const getItem = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) {
        return String(key).includes('-onboarded::') ? '1' : getItem.call(this, key)
      }
    }, { tokens: account, guild: GUILD })
    await page.route('https://**', route => route.abort())
  })

  after(async () => {
    try {
      await pool?.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  const nyit = async (width = 1440) => {
    await page.setViewportSize({ width, height: 900 })
    /*
     * ELŐBB ÜRES LAP, ÉS EZ NEM ÓVATOSKODÁS.
     *
     * A `goto` UGYANARRA a címre — ide mindig `#/admin/discord` — nem tölti
     * újra a dokumentumot, csak a horgonyt állítja. Az előző tétel nyitva
     * maradt párbeszédablaka így ott marad a `body`-n, a háttere pedig
     * lefedi az egész oldalt: a következő tétel gombjai láthatók, de nem
     * kattinthatók. Ez a MÉRÉS hibája volt, nem a felületé — öt tétel bukott
     * el tőle úgy, hogy a felület hibátlanul működött.
     */
    await page.goto('about:blank')
    await page.goto(`${base}/#/admin/discord`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
  }

  const kepernyo = async () => await page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const nev = el => el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '')
    return {
      szoveg: document.querySelector('.admin-content')?.innerText ?? '',
      kilog: [...new Set([...document.querySelectorAll('body *')]
        .filter(e => { const b = e.getBoundingClientRect(); return b.width && b.right > limit + 1 })
        .map(nev))].slice(0, 5),
      levagott: [...document.querySelectorAll('.admin-content .meta-row-sub, .admin-content .dash-kpi-value')]
        .filter(e => e.scrollWidth > e.clientWidth + 1)
        .map(e => (e.textContent || '').trim().slice(0, 40)).slice(0, 5)
    }
  })

  it('megjelenik a szekció és betölti az üzeneteket', async () => {
    await nyit()
    const k = await kepernyo()
    assert.match(k.szoveg, /Tartós üzenetek/, 'nincs meg a panel')
    assert.match(k.szoveg, /YUME statisztika/, 'nem jelenik meg az üzenet típusa')
    assert.match(k.szoveg, /Rendszerállapot/)
  })

  it('SOHA nem ír NaN-t, undefined-ot vagy objektumot', async () => {
    await nyit()
    const k = await kepernyo()
    assert.ok(!/NaN/.test(k.szoveg), `NaN a panelen: ${k.szoveg.slice(0, 200)}`)
    assert.ok(!/undefined/.test(k.szoveg), `undefined a panelen: ${k.szoveg.slice(0, 200)}`)
    assert.ok(!/\[object /.test(k.szoveg), `objektum szövegként: ${k.szoveg.slice(0, 200)}`)
  })

  /*
   * A HÁROM ÁLLAPOT MEGKÜLÖNBÖZTETHETŐ. „Kint van", „még nem ment ki" és
   * „sikertelen" — ha ezek egyformán néznek ki, a panel nem ér semmit.
   */
  it('megkülönbözteti a kint lévőt, a ki nem mentet és a hibásat', async () => {
    await nyit()
    const k = await kepernyo()
    assert.match(k.szoveg, /kint van/)
    assert.match(k.szoveg, /még nem ment ki/)
    assert.match(k.szoveg, /sikertelen kísérlet/)
    // A hiba szövege is kint van, nem csak az, hogy „valami baj van".
    assert.match(k.szoveg, /Missing Permissions/)
  })

  it('az előnézet gombja nem ígér küldést', async () => {
    await nyit()
    const cimkek = await page.locator('.admin-content button').allInnerTexts()
    assert.ok(cimkek.some(c => /Előnézet/.test(c)), `nincs előnézet gomb: ${cimkek.join(', ')}`)
    assert.ok(!cimkek.some(c => /Küldés|Kiküldés/.test(c)),
      'van egy „küldés" feliratú gomb — az előnézet nem küldés')
  })

  /*
   * AZ ELŐNÉZET TÉNYLEG NEM KÜLD. Nem a felirat dönti el: a kattintás után az
   * adatbázisban sem jöhet létre üzenetazonosító.
   */
  it('az előnézet gombja tényleg nem küld üzenetet', async () => {
    await nyit()
    const elotte = await pool.query(
      "SELECT message_id FROM persistent_messages WHERE guild_id = $1 AND message_type = 'system_health'", [GUILD])
    assert.equal(elotte.rows[0].message_id, null)

    await page.locator('.admin-content button', { hasText: 'Előnézet' }).nth(1).click()
    await page.waitForTimeout(1200)

    const utana = await pool.query(
      "SELECT message_id FROM persistent_messages WHERE guild_id = $1 AND message_type = 'system_health'", [GUILD])
    assert.equal(utana.rows[0].message_id, null, 'az előnézet üzenetet küldött')
  })

  // ---- amit eddig csak API-n lehetett ----
  //
  // A felület sokáig listázott, ki-be kapcsolt és frissített; létrehozni,
  // szerkeszteni és törölni csak `curl`-lel lehetett. Ezek a tételek azt
  // mérik, hogy ez már nem így van — nem a gomb LÉTÉT, hanem a HATÁSÁT az
  // adatbázisban.

  it('az új üzenet űrlapja tényleg létrehoz egy rekordot', async () => {
    await nyit()
    await page.locator('.admin-content button', { hasText: '+ Új üzenet' }).click()
    await page.waitForTimeout(400)

    await page.locator('.dialog select').selectOption('popular_anime')
    await page.locator('.dialog input[inputmode="numeric"]').fill(CSATORNA)
    await page.locator('.dialog button', { hasText: 'Létrehozás' }).click()
    await page.waitForTimeout(1500)

    const sor = await pool.query(
      "SELECT channel_id, configuration FROM persistent_messages WHERE guild_id = $1 AND message_type = 'popular_anime'",
      [GUILD])
    assert.equal(sor.rows.length, 1, 'nem jött létre a rekord')
    assert.equal(sor.rows[0].channel_id, CSATORNA)
    // A típushoz tartozó beállítás is elment, nem veszett el az űrlapon.
    assert.equal(Number(sor.rows[0].configuration.days), 7)
  })

  /*
   * A 409 EMBERI NYELVEN. Egy guildben egy típusból egy AKTÍV üzenet lehet —
   * ha erre a nyers hibakód jönne vissza, az üzemeltető a saját beállításait
   * kezdené javítgatni egy olyan hiba miatt, ami nem az övé.
   */
  it('a duplikált típusra érthető üzenet jön, nem hibakód', async () => {
    await nyit()
    await page.locator('.admin-content button', { hasText: '+ Új üzenet' }).click()
    await page.waitForTimeout(400)
    await page.locator('.dialog select').selectOption('yume_statistics')
    await page.locator('.dialog input[inputmode="numeric"]').fill(CSATORNA)
    await page.locator('.dialog button', { hasText: 'Létrehozás' }).click()
    await page.waitForTimeout(1200)

    const hiba = await page.locator('.dialog .form-error').innerText()
    assert.match(hiba, /már van ilyen típusú aktív üzenet/)
    assert.ok(!/409/.test(hiba), `a nyers hibakód került a felületre: ${hiba}`)
  })

  it('a szerkesztés nem engedi átírni a típust', async () => {
    await nyit()
    await page.locator('.admin-content button[aria-label="További műveletek"]').first().click()
    await page.locator('.dropdown-item', { hasText: 'Szerkesztés' }).first().click()
    await page.waitForTimeout(400)
    assert.equal(await page.locator('.dialog select').isDisabled(), true,
      'szerkesztéskor is át lehet írni a típust — a kint lévő üzenet tartalmát cserélné ki')
  })

  it('a törlés megerősítést kér, és tényleg töröl', async () => {
    await nyit()
    const elotte = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])

    // Megerősítés NÉLKÜL nem törölhet: először elutasítjuk.
    page.once('dialog', d => d.dismiss())
    await page.locator('.admin-content button[aria-label="További műveletek"]').first().click()
    await page.locator('.dropdown-item', { hasText: 'Törlés' }).first().click()
    await page.waitForTimeout(900)
    const kozben = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])
    assert.equal(kozben.rows[0].n, elotte.rows[0].n, 'elutasított megerősítés után is törölt')

    page.once('dialog', d => d.accept())
    await page.locator('.admin-content button[aria-label="További műveletek"]').first().click()
    await page.locator('.dropdown-item', { hasText: 'Törlés' }).first().click()
    await page.waitForTimeout(1500)
    const utana = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])
    assert.equal(utana.rows[0].n, elotte.rows[0].n - 1, 'a megerősítés után sem törölt')
  })

  it('az előzmények megnyithatók', async () => {
    await nyit()
    await page.locator('.admin-content button[aria-label="További műveletek"]').first().click()
    await page.locator('.dropdown-item', { hasText: 'Előzmények' }).first().click()
    await page.waitForTimeout(1200)
    const szoveg = await page.locator('.dialog').innerText()
    assert.match(szoveg, /Előzmények/)
    assert.ok(!/undefined|NaN|\[object /.test(szoveg), `szemét az előzményekben: ${szoveg.slice(0, 200)}`)
  })

  /*
   * A FIÓK-ÖSSZEKÖTÉS PANELJE. Amíg ez nem volt kint, a `no_link` hibára a
   * felület csak annyit mondott, hogy „nincs Discord-fiók kötve" — azt nem,
   * hogy ezt hol lehet elintézni.
   */
  it('a fiók-panel megmondja, mit lehet tenni', async () => {
    await nyit()
    const szoveg = await page.locator('.admin-content').innerText()
    assert.match(szoveg, /Discord-fiók/)
    assert.ok(/Összekötés a Discorddal|nincs beállítva ezen a kiszolgálón/.test(szoveg),
      `a fiók-panel nem mond semmi használhatót: ${szoveg.slice(0, 300)}`)
  })

  for (const width of [1440, 430, 390, 360]) {
    it(`${width} képponton nem lóg túl és nem vágódik le`, async () => {
      await nyit(width)
      const k = await kepernyo()
      assert.deepEqual(k.kilog, [], `túllóg ${width}px-en`)
      assert.deepEqual(k.levagott, [], `levágott szöveg ${width}px-en`)
    })
  }
})
