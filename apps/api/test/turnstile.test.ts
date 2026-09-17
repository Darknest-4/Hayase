// Az emberpróba — és főleg az, hogy MELYIK IRÁNYBA hibázik.
//
// Egy emberpróbánál a működő eset a könnyebbik fele. A nehezebbik az, amikor
// valami elromlik, mert ott két teljesen különböző hiba néz ki egyformán:
//
//   * a LÁTOGATÓ nem tudott tokent adni  → zárni kell, ez a dolgunk;
//   * MI nem tudtuk ellenőrizni           → átengedni kell, hangosan.
//
// A második azért van így, mert a másik választás elfogadhatatlan: egy
// Cloudflare-kiesés nem zárhatja ki a tulajdonost a saját oldaláról. Ez a
// suite nagyrészt ezt a határvonalat méri.
//
// A hálózat helyett egy helyi HTTP-kiszolgáló áll — a `siteverify` címét a
// modul konstansként tartja, ezért a `fetch`-et cseréljük ki. Ez az egyetlen
// helyettesítés a fájlban; minden más a valódi kód.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import * as turnstile from '../src/modules/auth/turnstile.ts'

const SITE = '0xTESZT_HELYSZIN'
const SECRET = '0xTESZT_TITOK'

const eredetiFetch = globalThis.fetch
const eredetiKornyezet = { ...process.env }

/** Amit a hamis Cloudflare válaszol. Tesztenként állítjuk. */
let valasz: { status?: number, body?: unknown, throws?: Error } = {}
/** Amit a modul kiküldött — ebből látszik, jól állította-e össze a kérést. */
let utolsoKeres: { url: string, params: URLSearchParams } | null = null

/*
 * A hamis napló AZ ADATOT IS ELTESZI, nem csak az üzenetet.
 *
 * Az első változata csak az üzenetet fogta meg — és az üzenetek rögzített
 * szövegek, amikbe sosem kerül semmi érzékeny. A titokszivárgást vizsgáló
 * teszt így trivinálisan átment, miközben a titok az ADATMEZŐN keresztül
 * mehetett volna ki. Egy teszt, ami csak a biztonságos felét nézi, rosszabb,
 * mint a semmi: hamis nyugalmat ad.
 */
const naplo = (): { warns: string[], everything: () => string, warn: (d: unknown, m: string) => void } => {
  const warns: string[] = []
  const data: unknown[] = []
  return {
    warns,
    everything: () => warns.join(' ') + ' ' + JSON.stringify(data),
    warn: (d, m) => { warns.push(m); data.push(d) }
  }
}

beforeEach(() => {
  process.env.TURNSTILE_SITE_KEY = SITE
  process.env.TURNSTILE_SECRET_KEY = SECRET
  delete process.env.TURNSTILE_PROTECT
  delete process.env.TURNSTILE_HOSTNAMES
  process.env.PUBLIC_URL = 'https://pelda.hu'
  valasz = { body: { success: true } }
  utolsoKeres = null

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    utolsoKeres = {
      url: String(input),
      params: new URLSearchParams(String(init?.body ?? ''))
    }
    if (valasz.throws) throw valasz.throws
    return new Response(JSON.stringify(valasz.body ?? {}), {
      status: valasz.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = eredetiFetch
  for (const key of Object.keys(process.env)) {
    if (!(key in eredetiKornyezet)) delete process.env[key]
  }
  Object.assign(process.env, eredetiKornyezet)
})

describe('a be- és kikapcsolás', () => {
  /*
   * EZ A LEGFONTOSABB ALAPESET. Egy friss telepítésen nincs Cloudflare-fiók,
   * és egy ellenőrzés, ami titok híján mindenkit kizár, nem biztonság, hanem
   * kiesés.
   */
  test('kulcsok nélkül mindent átenged', async () => {
    delete process.env.TURNSTILE_SITE_KEY
    delete process.env.TURNSTILE_SECRET_KEY
    assert.equal(turnstile.enabled(), false)
    assert.equal(turnstile.protects('register'), false)
    const verdict = await turnstile.verify(undefined, null, 'register')
    assert.equal(verdict.ok, true)
    assert.equal(utolsoKeres, null, 'meg sem szólította a Cloudflare-t')
  })

  test('fél kulcskészlettel sem kapcsol be', async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    assert.equal(turnstile.enabled(), false)
    assert.equal((await turnstile.verify('bármi', null, 'login')).ok, true)
  })

  /*
   * A jelszó-emlékeztetőnek a webkliensben nincs űrlapja, tehát nem tud tokent
   * szerezni. Bevenni annyi lenne, mint csendben bezárni egy végpontot.
   */
  test('alapból a regisztrációt és a belépést védi, a jelszó-emlékeztetőt nem', () => {
    assert.equal(turnstile.protects('register'), true)
    assert.equal(turnstile.protects('login'), true)
    assert.equal(turnstile.protects('forgot'), false)
  })

  test('a lista szűkíthető és bővíthető', () => {
    process.env.TURNSTILE_PROTECT = 'register'
    assert.equal(turnstile.protects('register'), true)
    assert.equal(turnstile.protects('login'), false)

    process.env.TURNSTILE_PROTECT = 'register, login ,forgot'
    assert.equal(turnstile.protects('forgot'), true, 'a szóközök nem számítanak')
  })

  test('a helyszín kulcsa kiadható, a titok sehogy', () => {
    assert.equal(turnstile.siteKey(), SITE)
    const exported = JSON.stringify(Object.keys(turnstile))
    assert.doesNotMatch(exported, /secret|titok/i)
  })
})

describe('a kérés, amit kiküldünk', () => {
  test('a Cloudflare végpontjára megy, űrlapkódolva', async () => {
    await turnstile.verify('token-abc', '203.0.113.9', 'register')
    assert.equal(utolsoKeres!.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
    assert.equal(utolsoKeres!.params.get('secret'), SECRET)
    assert.equal(utolsoKeres!.params.get('response'), 'token-abc')
    assert.equal(utolsoKeres!.params.get('remoteip'), '203.0.113.9')
  })

  /*
   * A cím SEGÍT a Cloudflare-nek, de nem kötelező — és ha a `TRUST_PROXY`
   * rosszul áll, egy hibás cím rontana, nem javítana.
   */
  test('cím nélkül nem küld üres remoteip mezőt', async () => {
    await turnstile.verify('token-abc', null, 'register')
    assert.equal(utolsoKeres!.params.has('remoteip'), false)
  })
})

describe('a látogató oldalán elromlott dolgok — ZÁRUNK', () => {
  test('hiányzó token', async () => {
    const verdict = await turnstile.verify(undefined, null, 'register')
    assert.equal(verdict.ok, false)
    assert.match(verdict.detail!, /Frissítsd az oldalt/)
    assert.equal(utolsoKeres, null, 'a Cloudflare-t meg sem kérdeztük fölöslegesen')
  })

  test('üres és nem szöveg típusú token', async () => {
    for (const rossz of ['', 42, null, {}, []]) {
      assert.equal((await turnstile.verify(rossz, null, 'login')).ok, false, String(rossz))
    }
  })

  /* A Cloudflare ennél hosszabbat nem ad; ami hosszabb, az nem tőle van. */
  test('képtelenül hosszú token', async () => {
    const verdict = await turnstile.verify('x'.repeat(2049), null, 'login')
    assert.equal(verdict.ok, false)
    assert.equal(utolsoKeres, null)
  })

  test('lejárt vagy már felhasznált token', async () => {
    valasz = { body: { success: false, 'error-codes': ['timeout-or-duplicate'] } }
    const verdict = await turnstile.verify('token', null, 'login')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason!, /timeout-or-duplicate/)
  })

  /*
   * A `success: true` annyit jelent, hogy a token valódi és friss. Azt NEM,
   * hogy erre a műveletre szerezték — enélkül egy belépéshez szerzett token
   * regisztrációra is jó lenne.
   */
  test('másik művelethez szerzett token', async () => {
    valasz = { body: { success: true, action: 'login', hostname: 'pelda.hu' } }
    const verdict = await turnstile.verify('token', null, 'register')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason!, /művelet nem egyezik/)
  })

  /*
   * A helyszín kulcsa NYILVÁNOS, tehát bárki kiteheti a saját lapjára. A
   * gazdanév az, ami megkülönbözteti a mi oldalunkat az övétől.
   */
  test('idegen oldalon szerzett token', async () => {
    valasz = { body: { success: true, hostname: 'hamis.example' } }
    const verdict = await turnstile.verify('token', null, 'register')
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason!, /idegen gazda/)
  })

  test('a saját gazdanevünk átmegy, a PUBLIC_URL-ből', async () => {
    valasz = { body: { success: true, hostname: 'pelda.hu' } }
    assert.equal((await turnstile.verify('token', null, 'register')).ok, true)
  })

  test('a további gazdanevek felsorolhatók', async () => {
    process.env.TURNSTILE_HOSTNAMES = 'regi.pelda.hu, www.pelda.hu'
    assert.deepEqual(turnstile.allowedHostnames().sort(),
      ['pelda.hu', 'regi.pelda.hu', 'www.pelda.hu'])
    valasz = { body: { success: true, hostname: 'REGI.PELDA.HU' } }
    assert.equal((await turnstile.verify('token', null, 'register')).ok, true,
      'a kis-nagybetű nem számít')
  })

  /*
   * Gazdanévlista nélkül NEM ellenőrzünk. Egy olyan telepítésen, ahol a
   * `PUBLIC_URL` sincs beállítva, egy kitalált gazdanév mindenkit kizárna.
   */
  test('gazdanévlista nélkül nem zárunk ki senkit emiatt', async () => {
    delete process.env.PUBLIC_URL
    assert.deepEqual(turnstile.allowedHostnames(), [])
    valasz = { body: { success: true, hostname: 'barmi.example' } }
    assert.equal((await turnstile.verify('token', null, 'register')).ok, true)
  })
})

describe('a MI oldalunkon elromlott dolgok — ÁTENGEDÜNK, hangosan', () => {
  /*
   * Ez a suite lényege. Egy Cloudflare-kiesés nem zárhatja ki a tulajdonost a
   * saját oldaláról — a sebességkorlát ilyenkor is áll, tehát a védelem
   * gyengül, de nem tűnik el.
   */
  test('a Cloudflare nem válaszol', async () => {
    valasz = { throws: new Error('fetch failed') }
    const log = naplo()
    const verdict = await turnstile.verify('token', null, 'login', log)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.degraded, true)
    assert.equal(log.warns.length, 1)
    assert.match(log.warns[0]!, /NEM FUTOTT LE/)
  })

  test('a Cloudflare hibás státusszal válaszol', async () => {
    valasz = { status: 502, body: {} }
    const log = naplo()
    const verdict = await turnstile.verify('token', null, 'login', log)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.degraded, true)
  })

  /*
   * Egy elgépelt titok a MI hibánk — ettől egyetlen látogató sem lesz gyanús.
   * Ha erre zárnánk, egy félreütés az egész hitelesítést leállítaná.
   */
  test('rossz titok', async () => {
    valasz = { body: { success: false, 'error-codes': ['invalid-input-secret'] } }
    const log = naplo()
    const verdict = await turnstile.verify('token', null, 'register', log)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.degraded, true)
    assert.match(log.warns[0]!, /A MI HIBÁNKBÓL/)
  })

  test('az átengedés SOHA nem csendes', async () => {
    for (const eset of [
      { throws: new Error('hálózat') },
      { status: 500, body: {} },
      { body: { success: false, 'error-codes': ['invalid-input-secret'] } },
      { body: { success: false, 'error-codes': ['internal-error'] } }
    ]) {
      valasz = eset
      const log = naplo()
      const verdict = await turnstile.verify('token', null, 'register', log)
      assert.equal(verdict.ok, true, JSON.stringify(eset))
      assert.equal(log.warns.length, 1, `nem naplózott: ${JSON.stringify(eset)}`)
    }
  })

  /*
   * A napló nem kaphatja meg a titkot. Ez az a fajta szivárgás, ami évekig
   * ott ül egy naplófájlban, és senki nem néz rá.
   */
  /*
   * A titok a kérés TÖRZSÉBEN utazik, és egy hálózati hiba üzenete előbb-utóbb
   * tartalmazza azt, amit a könyvtár épp a kezében tartott. A vizsgálat ezért
   * MINDENT néz, amit a naplózó kapott — az üzenetet és az adatot is.
   */
  test('a titok nem kerül a naplóba, se üzenetben, se adatban', async () => {
    valasz = { throws: new Error(`kapcsolat ${SECRET} felé megszakadt`) }
    const log = naplo()
    const verdict = await turnstile.verify('token', null, 'login', log)
    assert.doesNotMatch(log.everything(), new RegExp(SECRET))
    assert.doesNotMatch(verdict.reason ?? '', new RegExp(SECRET))
    assert.match(log.everything(), /«titok»/, 'a helyét jelöljük, nem csak levágjuk')
  })
})
