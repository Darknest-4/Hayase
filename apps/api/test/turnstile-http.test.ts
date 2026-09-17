// Az emberpróba a VALÓDI útvonalakon.
//
// A `turnstile.test.ts` a döntést méri; ez azt, hogy a döntés a helyére is
// került. Két dolog, ami csak itt látszik:
//
//   * a KAPU SORRENDJE — a jelszó-ellenőrzés szándékosan drága (scrypt,
//     N=2^17), és egy robot kérésére egyetlen ilyet sem akarunk elégetni. Ha
//     a kapu a jelszó UTÁN futna, a védelem CPU-t spórolni nem spórolna, és a
//     végpont továbbra is kimerítő terhelésnek lenne kitéve;
//   * a CSP — a widget idegen origóról tölt szkriptet és iframe-et. A
//     `script-src 'self'` ezt kizárja, és a hiba NÉMA: a widget egyszerűen
//     nem jelenik meg. Pont ez a fajta hiba az, ami csak éles üzemben,
//     látogatói bejelentésből derül ki.
//
// A környezet a fájl TETEJÉN áll be, az app importja előtt: a CSP-t a
// `security.ts` egyszer építi fel, betöltéskor.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)

const SITE = '0xTESZT_HELYSZIN'
const SECRET = '0xTESZT_TITOK'
process.env.TURNSTILE_SITE_KEY = SITE
process.env.TURNSTILE_SECRET_KEY = SECRET
process.env.TURNSTILE_HOSTNAMES = 'teszt.pelda.hu'
process.env.JWT_SECRET ??= 'turnstile-http-secret-0123456789abcdef'
process.env.PUBLIC_URL ??= 'https://teszt.pelda.hu'
process.env.CLOUDFLARE_ANALYTICS = 'true'

/** Amit a hamis Cloudflare válaszol a következő ellenőrzésre. */
let siteverify: unknown = { success: true, hostname: 'teszt.pelda.hu' }
let hivasok = 0

describe('az emberpróba a hitelesítési útvonalakon', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts').buildApp>>
  let pool: import('pg').Pool
  const eredetiFetch = globalThis.fetch

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('siteverify')) {
        hivasok++
        return new Response(JSON.stringify(siteverify), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return await eredetiFetch(input as never, init)
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = eredetiFetch
    try { await app?.close() } finally { await pool?.end() }
  })

  /** Kívülről érkező kérés: proxyfejléccel, hogy ne számítson belsőnek. */
  const kivulrol = (url: string, body: unknown): Parameters<typeof app.inject>[0] => ({
    method: 'POST',
    url,
    headers: { 'x-forwarded-for': '203.0.113.77' },
    payload: body
  })

  const egyediEmail = (): string => `turnstile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@pelda.hu`

  test('regisztráció token nélkül: 403, és a kliens tudja, mit tegyen', async () => {
    const res = await app.inject(kivulrol('/v1/auth/register', {
      email: egyediEmail(), username: 'proba' + Date.now().toString().slice(-6), password: 'eleg-hosszu-jelszo'
    }))
    assert.equal(res.statusCode, 403)
    const body = res.json() as { detail: string, code: string }
    assert.equal(body.code, 'turnstile_failed')
    assert.match(body.detail, /Frissítsd az oldalt/)
  })

  /*
   * EZ A SORREND TESZTJE. Szándékosan NEM LÉTEZŐ fiókkal és rossz jelszóval
   * megyünk: ha a kapu a jelszó után futna, 401-et kapnánk (és elégettünk
   * volna egy scrypt-et). A 403 azt bizonyítja, hogy a kapu volt előbb.
   */
  test('belépés token nélkül: 403, még mielőtt a jelszóhoz érnénk', async () => {
    const res = await app.inject(kivulrol('/v1/auth/login', {
      identifier: 'nincs-ilyen-fiok@pelda.hu', password: 'akarmi-is-lehet'
    }))
    assert.equal(res.statusCode, 403)
    assert.equal((res.json() as { code: string }).code, 'turnstile_failed')
  })

  test('érvényes tokennel a belépés a szokásos útján megy tovább', async () => {
    siteverify = { success: true, action: 'login', hostname: 'teszt.pelda.hu' }
    const elotte = hivasok
    const res = await app.inject(kivulrol('/v1/auth/login', {
      identifier: 'nincs-ilyen-fiok@pelda.hu', password: 'akarmi-is-lehet', turnstileToken: 'jo-token'
    }))
    assert.equal(hivasok, elotte + 1, 'megkérdeztük a Cloudflare-t')
    // 401: a kapun átjutott, és a hitelesítésen bukott el — ami itt a helyes
    // válasz, mert tényleg nincs ilyen fiók.
    assert.equal(res.statusCode, 401)
  })

  test('a Cloudflare által visszautasított token: 403', async () => {
    siteverify = { success: false, 'error-codes': ['timeout-or-duplicate'] }
    const res = await app.inject(kivulrol('/v1/auth/login', {
      identifier: 'nincs-ilyen-fiok@pelda.hu', password: 'akarmi-is-lehet', turnstileToken: 'elhasznalt'
    }))
    assert.equal(res.statusCode, 403)
  })

  /*
   * A jelszó-emlékeztetőnek a webkliensben nincs űrlapja, tehát nem tudna
   * tokent szerezni. 204 a válasz akkor is, ha nincs ilyen fiók — ez a
   * végpont szándékosan nem árulja el, létezik-e.
   */
  test('a jelszó-emlékeztető alapból nem kér emberpróbát', async () => {
    const res = await app.inject(kivulrol('/v1/auth/forgot', { identifier: 'nincs-ilyen@pelda.hu' }))
    assert.notEqual(res.statusCode, 403)
  })

  test('a token a séma miatt nem hasal el, és nem is kötelező ott', async () => {
    // 2049 karakter: a séma `maxLength`-je fogja meg, nem az útvonal.
    const res = await app.inject(kivulrol('/v1/auth/login', {
      identifier: 'valaki@pelda.hu', password: 'akarmi-is-lehet', turnstileToken: 'x'.repeat(2049)
    }))
    assert.equal(res.statusCode, 400, 'a séma utasítja vissza, nem 500-zal hasal el')
  })

  describe('a kliens megkapja, amire szüksége van', () => {
    test('a nyilvános konfig hozza a helyszín kulcsát és a védett űrlapokat', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/config' })
      assert.equal(res.statusCode, 200)
      const site = (res.json() as { site: Record<string, unknown> }).site
      assert.equal(site.turnstileSiteKey, SITE)
      assert.deepEqual(site.turnstileOn, ['register', 'login'])
    })

    /*
     * A TITOK SEHOL. Ez a hasznos teherbírás minden látogatóhoz kimegy.
     */
    test('a titok nincs benne a nyilvános konfigban', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/config' })
      assert.doesNotMatch(res.body, new RegExp(SECRET))
    })

    /*
     * A CSP némán öl: a `script-src 'self'` mellett a widget szkriptje nem
     * töltődik be, hibaüzenet nélkül. Ez pont az a hiba, ami csak éles
     * üzemben derül ki — egyszer már megtörtént a státuszoldal beágyazott
     * szkriptjével.
     */
    test('a CSP beengedi a widget szkriptjét és iframe-jét', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/config' })
      const csp = res.headers['content-security-policy'] as string
      const origin = 'https://challenges.cloudflare.com'
      const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? ''
      const frameSrc = /frame-src ([^;]+)/.exec(csp)?.[1] ?? ''
      assert.ok(scriptSrc.includes(origin), `script-src: ${scriptSrc}`)
      assert.ok(frameSrc.includes(origin), `frame-src: ${frameSrc}`)
      assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'a script-src szigorú marad')
    })

    /*
     * A Web Analytics beaconját NEM MI tesszük be: ha a zónán be van
     * kapcsolva, a Cloudflare az ÉLEN fűzi bele a HTML-be. A CSP viszont a mi
     * fejlécünk, és az blokkolja — élesben pontosan ez történt, és az
     * eredmény egy néma hiba volt: a kapcsoló bekapcsolva, adat sehol.
     */
    test('a CSP beengedi a Web Analytics beaconját, ha be van kapcsolva', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/config' })
      const scriptSrc = /script-src ([^;]+)/.exec(res.headers['content-security-policy'] as string)?.[1] ?? ''
      assert.ok(scriptSrc.includes('https://static.cloudflareinsights.com'), `script-src: ${scriptSrc}`)
    })
  })
})
