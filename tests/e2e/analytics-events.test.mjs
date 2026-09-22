/* global Storage, localStorage */
// A KERESÉS → MEGNYITÁS, végig: kattintástól az adatbázisig.
//
// MIÉRT KELL ERRE E2E. A kiszolgálóoldalt egy API-teszt is megméri, a
// kliensoldalt egy egységteszt is — de azt, hogy a KETTŐ ÖSSZEÉR, csak egy
// valódi kattintás mondja meg. Ez az a fajta lánc, ami úgy szakad el, hogy
// minden darabja külön-külön zöld: egy elfelejtett import, egy rossz
// szelektor, egy figyelő, amit a lista újrarajzolása leszakít.
//
// AMIT ŐRIZ:
//   1. a találatra kattintás TÉNYLEG sort ír az egységes eseménytáblába;
//   2. a POZÍCIÓ is bekerül — egy első és egy huszadik helyen talált cím nem
//      ugyanaz a siker;
//   3. a duplikáció nem sokszorozza a számot.

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

describe('a keresés → megnyitás lánca', { skip: REASON }, () => {
  let server, browser, pool, page, base, account, events
  const username = 'ev_' + randomBytes(4).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'analytics-events-e2e-secret-0123456789'
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
    process.env.LOG_LEVEL ??= 'warn'
    process.env.RATE_LIMIT_MAX ??= '100000'
    process.env.WRITE_RATE_LIMIT_MAX ??= '100000'

    const [{ buildApp }, db, ev] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts'),
      import('../../apps/api/src/modules/analytics/events.ts')
    ])
    server = await buildApp()
    pool = db.pool
    events = ev
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    const res = await fetch(`${base}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${username}@example.com`, username, password: 'Correct-Horse-Battery-9' })
    })
    account = await res.json()

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
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
      const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
      if (rows[0]) await pool.query('DELETE FROM analytics_events WHERE user_id = $1', [rows[0].id])
      await pool.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  const userId = async () => {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username])
    return rows[0]?.id
  }

  it('a találatra kattintás eseményt ír, pozícióval', async () => {
    const id = await userId()
    await pool.query('DELETE FROM analytics_events WHERE user_id = $1', [id])

    await page.goto(`${base}/#/search?q=a`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a.card', { timeout: 20000 })
    const kartyak = await page.locator('a.card').count()
    assert.ok(kartyak > 1, `kevés találat a méréshez: ${kartyak}`)

    // A MÁSODIK találatra kattintunk: az elsővel nem derülne ki, hogy a
    // pozíció tényleg a listából jön, vagy csak véletlenül 1.
    const cel = page.locator('a.card').nth(1)
    const href = await cel.getAttribute('href')
    const animeId = String(href).split('#/anime/')[1]
    await cel.click()
    await page.waitForTimeout(1500)

    // A gyűjtő kötegel; a kiírást itt kérjük ki, ahogy az időzítő is tenné.
    await events.flush()

    const { rows } = await pool.query(
      "SELECT event_type, subject_type, subject_id, metadata FROM analytics_events WHERE user_id = $1 AND event_type = 'search.result.open'",
      [id])
    assert.equal(rows.length, 1, `${rows.length} esemény született egy kattintásból`)
    assert.equal(rows[0].subject_type, 'anime')
    assert.equal(rows[0].subject_id, animeId, 'nem arra a címre íródott, amire kattintottak')
    assert.equal(Number(rows[0].metadata.position), 2, 'a pozíció nem a listából jött')
  })

  /*
   * A DUPLIKÁCIÓ NEM SOKSZOROZ. Ugyanarra a találatra kétszer kattintva
   * tíz másodpercen belül EGY esemény — különben a „megtalálási arány"
   * abból állna, ki kattintgat gyorsabban.
   */
  it('kétszer ugyanarra kattintva egy esemény marad', async () => {
    const id = await userId()
    await pool.query('DELETE FROM analytics_events WHERE user_id = $1', [id])

    await page.goto(`${base}/#/search?q=a`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('a.card', { timeout: 20000 })
    await page.locator('a.card').first().click()
    await page.waitForTimeout(600)
    await page.goBack()
    await page.waitForSelector('a.card', { timeout: 20000 })
    await page.locator('a.card').first().click()
    await page.waitForTimeout(1200)
    await events.flush()

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM analytics_events WHERE user_id = $1 AND event_type = 'search.result.open'",
      [id])
    assert.equal(rows[0].n, 1, `${rows[0].n} esemény két gyors kattintásból`)
  })
})
