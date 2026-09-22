/* global Storage, localStorage */
// A Discord-vezérlőpult — SAJÁT CÍMEN.
//
// MI VÁLTOZOTT, ÉS MIÉRT EZ A KÉSZLET IS. A Discord-felület kikerült a YUME
// adminpaneljéből: saját alkalmazás (`apps/discord`), amit a kiszolgáló a
// `/dashboard` előtag alatt ad, a fordított proxy pedig a
// `discord.animehub.hu` gyökerére ír át. Ez a készlet a `/dashboard/` címen
// méri ugyanazt, amit korábban az adminpanelen mért — plusz azt, ami csak
// most lett igaz:
//
//   1. a YUME adminfelületén MÁR NINCS Discord szekció;
//   2. a vezérlőpult belépést kér, és a saját tárolójából dolgozik;
//   3. ami gateway nélkül nem mérhető, arról AZT írja ki — nem nullát.

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
const DISCORD_USER = '300000000000000777'

describe('a Discord vezérlőpult', { skip: REASON }, () => {
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

    /*
     * A JOGCÍM NEM YUME-ADMIN, HANEM A DISCORD-JOG. Ez a készlet szándékosan
     * NEM ad admin szerepkört: pontosan azt méri, hogy egy közönséges
     * YUME-fiók, aminek a Discord-szerverén „Szerver kezelése" joga van,
     * bejut a vezérlőpultra. Ez a szétválasztás oka.
     */
    await pool.query('DELETE FROM discord_links WHERE discord_user_id = $1', [DISCORD_USER])
    await pool.query(
      'INSERT INTO discord_links (user_id, discord_user_id, discord_username) SELECT id, $2, $3 FROM users WHERE username = $1',
      [username, DISCORD_USER, 'probauser'])
    await pool.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [DISCORD_USER])
    // MANAGE_GUILD (1 << 5 = 32), frissen lekérdezve.
    await pool.query(
      `INSERT INTO discord_guild_members (discord_user_id, guild_id, guild_name, owner, permissions, fetched_at)
       VALUES ($1, $2, 'Próba szerver', false, '32', now())`, [DISCORD_USER, GUILD])

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
      // A VEZÉRLŐPULTNAK SAJÁT TÁROLÓKULCSA VAN. Külön cím, külön munkamenet:
      // a böngésző eredetenként tárol, és ez a szétválasztás szándékos.
      localStorage.setItem('yume-discord-auth', JSON.stringify(tokens))
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
      await pool?.query('DELETE FROM discord_welcome_config WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_welcome_log WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_registry WHERE guild_id = $1', [GUILD])
      await pool?.query('DELETE FROM discord_guild_members WHERE discord_user_id = $1', [DISCORD_USER])
      await pool?.query('DELETE FROM discord_links WHERE discord_user_id = $1', [DISCORD_USER])
      await pool?.query('DELETE FROM users WHERE username = $1', [username])
    } finally {
      await browser?.close()
      await server?.close()
      await pool?.end()
    }
  })

  const nyit = async (nezet = 'overview', width = 1440) => {
    await page.setViewportSize({ width, height: 900 })
    // Üres lap előbb: azonos címre mutató `goto` nem tölti újra a
    // dokumentumot, és az előző tétel párbeszédablaka nyitva maradna.
    await page.goto('about:blank')
    await page.goto(`${base}/dashboard/#/${nezet}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2200)
  }

  const kepernyo = async () => await page.evaluate(() => {
    const limit = document.documentElement.clientWidth
    const nev = el => el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '')
    return {
      szoveg: document.querySelector('.dc-main')?.innerText ?? document.body.innerText,
      kilog: [...new Set([...document.querySelectorAll('body *')]
        .filter(e => { const b = e.getBoundingClientRect(); return b.width && b.right > limit + 1 })
        .map(nev))].slice(0, 5)
    }
  })

  // ---- a szétválasztás ----

  /*
   * A YUME ADMINPANELJÉN MÁR NINCS DISCORD. Ez a tétel a KÖLTÖZÉST őrzi: ha
   * valaki visszateszi, azonnal kiderül. A szekciólista a felület egyetlen
   * forrása, tehát elég azt megnézni.
   */
  it('a YUME adminfelületén nincs többé Discord szekció', async () => {
    const szekciok = await page.evaluate(async b => {
      const m = await import(b + '/src/shared/lib/admin-sections.js')
      return m.ADMIN_SECTIONS.map(s => s.key)
    }, base)
    assert.ok(!szekciok.includes('discord'),
      'a Discord visszakerült az adminpanelbe — a vezérlőpult saját címen él')
    assert.ok(szekciok.includes('webhooks'), 'a webhookok viszont maradtak: azok a YUME saját értesítései')
  })

  it('a webkliens API-felületén sincs Discord-hívó', async () => {
    const van = await page.evaluate(async b => {
      const m = await import(b + '/src/shared/api/yume.js')
      return Object.prototype.hasOwnProperty.call(m.YumeAPI.admin, 'discord')
    }, base)
    assert.equal(van, false, 'a webkliens még mindig a Discord-végpontokat hívja')
  })

  // ---- a vezérlőpult ----

  it('betölt, és a szervert a névén mutatja', async () => {
    await nyit()
    const k = await kepernyo()
    assert.match(k.szoveg, /Áttekintés/)
    const valaszto = await page.locator('.dc-guild select').inputValue()
    assert.equal(valaszto, GUILD, 'nem a jogosultsággal bíró szerver van kiválasztva')
  })

  /*
   * BELÉPÉS NÉLKÜL NINCS VEZÉRLŐPULT. Ez nem a biztonság mérése — azt a
   * kiszolgáló dönti el —, hanem azé, hogy a felület ne egy üres vázat
   * mutasson annak, aki nincs belépve.
   */
  it('belépés nélkül belépőlapot mutat', async () => {
    const friss = await browser.newPage()
    await friss.route('https://**', r => r.abort())
    await friss.goto(`${base}/dashboard/`, { waitUntil: 'domcontentloaded' })
    await friss.waitForTimeout(1500)
    assert.equal(await friss.locator('.dc-login-card').count(), 1, 'nincs belépőlap')
    assert.equal(await friss.locator('.dc-nav').count(), 0, 'a menü belépés nélkül is kint van')
    await friss.close()
  })

  /*
   * A BELÉPŐŰRLAP TÉNYLEG BELÉPTET.
   *
   * MÉRT HIBA, ÉS EZ A TÉTEL AZÉRT VAN. A készlet többi tétele a tárolóba
   * írt tokennel indul — vagyis az ŰRLAPOT egyik sem használta. Élesben
   * derült ki, hogy a kliens `email` néven küldte azt, amit a kiszolgáló
   * `identifier` néven vár (e-mailt ÉS felhasználónevet is elfogad
   * ugyanazon a mezőn), és a felhasználó egy angol validációs üzenetet
   * kapott: „body must have required property 'identifier'".
   *
   * Ezt egyetlen egységteszt sem foghatta meg: mindkét oldal önmagában
   * helyes volt, csak a KETTŐ KÖZTI szerződés nem.
   */
  it('a belépőűrlappal tényleg be lehet lépni', async () => {
    const friss = await browser.newPage()
    await friss.route('https://**', r => r.abort())
    await friss.goto(`${base}/dashboard/`, { waitUntil: 'domcontentloaded' })
    await friss.waitForSelector('.dc-login-card', { timeout: 15000 })

    await friss.locator('.dc-login-card input').first().fill(`${username}@example.com`)
    await friss.locator('.dc-login-card input[type="password"]').fill('Correct-Horse-Battery-9')
    await friss.locator('.dc-login-card button').click()
    await friss.waitForTimeout(3000)

    const hiba = await friss.locator('.dc-login-card .form-error').count()
      ? await friss.locator('.dc-login-card .form-error').innerText()
      : ''
    assert.equal(hiba, '', `a belépés hibát adott: ${hiba}`)
    assert.equal(await friss.locator('.dc-nav').count(), 1, 'nem jutott be a vezérlőpultra')
    await friss.close()
  })

  /* Felhasználónévvel is — a kiszolgáló ugyanazon a mezőn fogadja. */
  it('felhasználónévvel is be lehet lépni', async () => {
    const friss = await browser.newPage()
    await friss.route('https://**', r => r.abort())
    await friss.goto(`${base}/dashboard/`, { waitUntil: 'domcontentloaded' })
    await friss.waitForSelector('.dc-login-card', { timeout: 15000 })

    await friss.locator('.dc-login-card input').first().fill(username)
    await friss.locator('.dc-login-card input[type="password"]').fill('Correct-Horse-Battery-9')
    await friss.locator('.dc-login-card button').click()
    await friss.waitForTimeout(3000)
    assert.equal(await friss.locator('.dc-nav').count(), 1, 'felhasználónévvel nem jutott be')
    await friss.close()
  })

  it('rossz jelszóra magyar üzenetet ad, nem sémahibát', async () => {
    const friss = await browser.newPage()
    await friss.route('https://**', r => r.abort())
    await friss.goto(`${base}/dashboard/`, { waitUntil: 'domcontentloaded' })
    await friss.waitForSelector('.dc-login-card', { timeout: 15000 })

    await friss.locator('.dc-login-card input').first().fill(`${username}@example.com`)
    await friss.locator('.dc-login-card input[type="password"]').fill('rossz-jelszo-mert-nem-ez')
    await friss.locator('.dc-login-card button').click()
    await friss.waitForTimeout(2500)

    const hiba = await friss.locator('.dc-login-card .form-error').innerText()
    assert.match(hiba, /jelszó/, `nem emberi üzenet: ${hiba}`)
    // A SÉMAHIBA ITT A LEGÁRULKODÓBB JEL: azt jelenti, hogy a kérés alakja
    // rossz, nem a jelszó.
    assert.ok(!/property|required|body must/i.test(hiba), `sémahiba került a felületre: ${hiba}`)
    await friss.close()
  })

  it('SOHA nem ír NaN-t, undefined-ot vagy objektumot', async () => {
    for (const nezet of ['overview', 'messages', 'health', 'audit', 'notifications', 'setup', 'welcome']) {
      await nyit(nezet)
      const k = await kepernyo()
      assert.ok(!/NaN/.test(k.szoveg), `NaN a(z) ${nezet} nézeten`)
      assert.ok(!/undefined/.test(k.szoveg), `undefined a(z) ${nezet} nézeten`)
      assert.ok(!/\[object /.test(k.szoveg), `objektum szövegként a(z) ${nezet} nézeten`)
    }
  })

  it('megkülönbözteti a kint lévőt, a ki nem mentet és a hibásat', async () => {
    await nyit('messages')
    const k = await kepernyo()
    assert.match(k.szoveg, /kint van/)
    assert.match(k.szoveg, /még nem ment ki/)
    assert.match(k.szoveg, /sikertelen kísérlet/)
    assert.match(k.szoveg, /Missing Permissions/)
  })

  /*
   * AMI NINCS, ARRÓL AZT MONDJA. Ez a készlet legfontosabb állítása: a
   * tagstatisztika nem üres lista és nem nulla, hanem egy magyarázat arról,
   * hogy az adat GATEWAY nélkül nem létezik. A nulla azt állítaná, hogy
   * mérünk, és senki nem csatlakozott.
   */
  it('a tagstatisztika nem nullát mutat, hanem megmondja, mi hiányzik', async () => {
    await nyit('members')
    const k = await kepernyo()
    assert.match(k.szoveg, /nincs adatforrás/i)
    assert.match(k.szoveg, /gateway/i)
    assert.ok(!/^0$/m.test(k.szoveg), 'nullát ír egy nem mért adatra')
  })

  it('a parancsstatisztika megmondja, hogy nincs parancs', async () => {
    await nyit('commands')
    const k = await kepernyo()
    assert.match(k.szoveg, /nincs/i)
  })

  it('az előnézet nem küld, és ezt ki is mondja', async () => {
    await nyit('messages')
    const elotte = await pool.query(
      "SELECT message_id FROM persistent_messages WHERE guild_id = $1 AND message_type = 'system_health'", [GUILD])
    assert.equal(elotte.rows[0].message_id, null)

    await page.locator('.dc-main button', { hasText: 'Előnézet' }).first().click()
    await page.waitForTimeout(1200)
    const dialogSzoveg = await page.locator('.dialog').innerText()
    assert.match(dialogSzoveg, /NEM ment ki/)

    const utana = await pool.query(
      "SELECT message_id FROM persistent_messages WHERE guild_id = $1 AND message_type = 'system_health'", [GUILD])
    assert.equal(utana.rows[0].message_id, null, 'az előnézet üzenetet küldött')
  })

  it('az új üzenet űrlapja tényleg létrehoz egy rekordot', async () => {
    await nyit('messages')
    await page.locator('.dc-main button', { hasText: '+ Új üzenet' }).click()
    await page.waitForTimeout(400)
    await page.locator('.dialog select').selectOption('popular_anime')
    await page.locator('.dialog input[inputmode="numeric"]').fill(CSATORNA)
    await page.locator('.dialog button', { hasText: 'Létrehozás' }).click()
    await page.waitForTimeout(1500)

    const sor = await pool.query(
      "SELECT channel_id, configuration FROM persistent_messages WHERE guild_id = $1 AND message_type = 'popular_anime'",
      [GUILD])
    assert.equal(sor.rows.length, 1, 'nem jött létre a rekord')
    assert.equal(Number(sor.rows[0].configuration.days), 7, 'a típushoz tartozó beállítás elveszett')
  })

  it('a duplikált típusra érthető üzenet jön, nem hibakód', async () => {
    await nyit('messages')
    await page.locator('.dc-main button', { hasText: '+ Új üzenet' }).click()
    await page.waitForTimeout(400)
    await page.locator('.dialog select').selectOption('yume_statistics')
    await page.locator('.dialog input[inputmode="numeric"]').fill(CSATORNA)
    await page.locator('.dialog button', { hasText: 'Létrehozás' }).click()
    await page.waitForTimeout(1200)
    const hiba = await page.locator('.dialog .form-error').innerText()
    assert.match(hiba, /már van ilyen típusú aktív üzenet/)
    assert.ok(!/409/.test(hiba), `a nyers hibakód került a felületre: ${hiba}`)
  })

  it('a törlés megerősítést kér, és tényleg töröl', async () => {
    await nyit('messages')
    const elotte = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])

    page.once('dialog', d => d.dismiss())
    await page.locator('.dc-main button', { hasText: 'Törlés' }).first().click()
    await page.waitForTimeout(900)
    const kozben = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])
    assert.equal(kozben.rows[0].n, elotte.rows[0].n, 'elutasított megerősítés után is törölt')

    page.once('dialog', d => d.accept())
    await page.locator('.dc-main button', { hasText: 'Törlés' }).first().click()
    await page.waitForTimeout(1500)
    const utana = await pool.query('SELECT count(*)::int AS n FROM persistent_messages WHERE guild_id = $1', [GUILD])
    assert.equal(utana.rows[0].n, elotte.rows[0].n - 1, 'a megerősítés után sem törölt')
  })

  it('az előzmény megnyitható', async () => {
    await nyit('messages')
    await page.locator('.dc-main button', { hasText: 'Előzmény' }).first().click()
    await page.waitForTimeout(1200)
    const szoveg = await page.locator('.dialog').innerText()
    assert.match(szoveg, /Előzmények/)
    assert.ok(!/undefined|NaN|\[object /.test(szoveg), `szemét az előzményekben: ${szoveg.slice(0, 200)}`)
  })

  it('a beállítások megmutatják az összekötött fiókot', async () => {
    await nyit('settings')
    const k = await kepernyo()
    assert.match(k.szoveg, /Discord-fiók/)
    assert.match(k.szoveg, /probauser|Próba szerver/)
  })

  // ---- setup és köszöntő ----

  /*
   * A SETUP OLDAL TOKEN NÉLKÜL IS MEGÁLL A LÁBÁN. A mérőkörnyezetben nincs
   * valódi bot token, tehát a Discordtól semmit nem tudunk lekérdezni — a
   * felületnek ilyenkor is meg kell mondania, MI HIÁNYZIK, és nem szabad
   * nullákat vagy kitalált állapotot mutatnia.
   */
  it('a setup oldal megmondja, mi hiányzik', async () => {
    await nyit('setup')
    const k = await kepernyo()
    assert.match(k.szoveg, /Setup/)
    assert.ok(!/NaN|undefined|\[object /.test(k.szoveg), `szemét a setup oldalon: ${k.szoveg.slice(0, 200)}`)
    // A gombok akkor is ott vannak, ha épp nincs mit tenni.
    const gombok = await page.locator('.dc-main button').allInnerTexts()
    for (const cimke of ['Előnézet', 'Setup futtatása', 'Javítás', 'Gyári visszaállítás']) {
      assert.ok(gombok.some(g => g.includes(cimke)), `nincs gomb: ${cimke} (${gombok.join(', ')})`)
    }
  })

  /*
   * A GYÁRI VISSZAÁLLÍTÁS NEM EGY KATTINTÁS. Az első gomb csak ELŐNÉZETET
   * ad: megmutatja, mit törölne, és csak utána jöhet a megerősítés.
   */
  it('a gyári visszaállítás előbb megmutatja, mit törölne', async () => {
    await nyit('setup')
    await page.locator('.dc-main button', { hasText: 'Gyári visszaállítás' }).click()
    await page.waitForTimeout(1500)
    const k = await kepernyo()
    assert.match(k.szoveg, /előnézet|törlődne|Nincs mit törölni/i,
      `nem mutatott előnézetet: ${k.szoveg.slice(0, 300)}`)
    // ÉS NEM TÖRÖLT SEMMIT: a registry érintetlen.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM discord_registry WHERE guild_id = $1', [GUILD])
    assert.equal(rows[0].n, 0)
  })

  it('a köszöntő oldal szerkeszthető, és a hibás sablont elutasítja', async () => {
    await nyit('welcome')
    const k = await kepernyo()
    assert.match(k.szoveg, /Köszöntő/)

    const sablon = page.locator('.dc-main textarea')
    await sablon.fill('Üdv, {user}! Ez a {nincs_ilyen_valtozo} hibás.')
    await page.locator('.dc-main button', { hasText: 'Mentés' }).click()
    await page.waitForTimeout(1500)

    const hiba = await page.locator('.dc-main .form-error').innerText()
    assert.match(hiba, /nincs_ilyen_valtozo/, `nem mondta meg, melyik változó rossz: ${hiba}`)
  })

  it('a köszöntő előnézete nem küld', async () => {
    await nyit('welcome')
    await page.locator('.dc-main textarea').fill('Üdv, {user}! A szerver: {server_name}')
    await page.locator('.dc-main button', { hasText: 'Mentés' }).click()
    await page.waitForTimeout(1200)
    await page.locator('.dc-main button', { hasText: 'Előnézet' }).click()
    await page.waitForTimeout(1200)

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM discord_welcome_log WHERE guild_id = $1', [GUILD])
    assert.equal(rows[0].n, 0, 'az előnézet köszöntőt küldött')
  })

  for (const width of [1440, 430, 390, 360]) {
    it(`${width} képponton nem lóg túl`, async () => {
      await nyit('overview', width)
      const k = await kepernyo()
      assert.deepEqual(k.kilog, [], `túllóg ${width}px-en`)
    })
  }
})
