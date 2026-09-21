// A munkamenet túléli a hozzáférési token lejáratát.
//
// A HIBA, AMIT EZ MEGFOG:
//
// A frissítő token forog — a kiszolgáló a felhasznált munkamenetet
// visszavonja, és újat ad. Ez helyes: egy ellopott token így legfeljebb
// egyszer használható.
//
// Csakhogy egy oldalbetöltés több hitelesített kérést indít EGYSZERRE. Ha
// közben lejárt a hozzáférési token, mind 401-et kap, és — összefogás nélkül —
// mind elindít egy frissítést UGYANAZZAL a sütivel. Az első sikerül és
// forgatja a tokent; a többi egy már visszavont munkamenetet mutat fel, 401-et
// kap, és a kliens hibaága kijelentkezteti a felhasználót.
//
// Mérve, javítás előtt: négy párhuzamos kérésből négy frissítés indult, kettő
// 200, kettő 401, és két felhasználói kérés hibára futott. Hogy a munkamenet
// túléli-e, azon múlt, melyik frissítés ért célba utoljára — vagyis
// pénzfeldobás volt. A felhasználó ezt úgy látta, hogy negyedóránként
// kijelentkezteti az oldal.
//
// Ezért ez a teszt nem azt méri, hogy „a frissítés működik". Azt méri, hogy
// EGYETLEN frissítés indul, akárhány kérés akad el egyszerre.

/* global localStorage */
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
  throw new Error('playwright could not be imported and CI is set.')
}

const REASON = !chromium
  ? 'playwright is not installed'
  : !process.env.DATABASE_URL
      ? 'no DATABASE_URL'
      : false

describe('an expired access token does not end the session', { skip: REASON }, () => {
  let server, browser, pool, base
  const username = 'sess' + randomBytes(5).toString('hex')

  before(async () => {
    process.env.WEB_ROOT = WEB_ROOT
    process.env.JWT_SECRET ??= 'session-e2e-secret-0123456789-abcdefghij'
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
    process.env.LOG_LEVEL ??= 'error'
    process.env.RATE_LIMIT_MAX ??= '100000'

    const [{ buildApp }, db] = await Promise.all([
      import('../../apps/api/src/app.ts'),
      import('../../apps/api/src/infrastructure/database/index.ts')
    ])
    server = await buildApp()
    pool = db.pool
    await server.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${server.server.address().port}`

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined })
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

  /** Egy böngésző, bejelentkezve, LEJÁRT hozzáférési tokennel. */
  async function signedInWithExpiredToken (name) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const authCalls = []
    page.on('response', res => {
      const url = res.url().replace(base, '')
      if (url.startsWith('/v1/auth')) authCalls.push(`${res.status()} ${url}`)
    })
    await page.route('https://**', r => r.abort())
    await page.goto(`${base}/#/home`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)

    await page.evaluate(async user => {
      const res = await fetch('/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: `${user}@test.invalid`, username: user, password: 'a-long-enough-test-password-1'
        })
      })
      const body = await res.json()
      localStorage.setItem('yume-auth', JSON.stringify({ accessToken: body.accessToken }))
    }, name)

    // A hozzáférési token lejártra állítása. Az aláírás érvénytelen lesz, de
    // ez nem számít: a kiszolgáló előbb a lejáratot nézi, és a kliens
    // szempontjából a 401 a lényeg — pontosan ez a tizenötödik perc állapota.
    await page.evaluate(() => {
      const t = JSON.parse(localStorage.getItem('yume-auth'))
      const [head, payload, sig] = t.accessToken.split('.')
      const claims = JSON.parse(atob(payload))
      claims.exp = Math.floor(Date.now() / 1000) - 60
      const encode = o => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      t.accessToken = `${head}.${encode(claims)}.${sig}`
      localStorage.setItem('yume-auth', JSON.stringify(t))
    })

    authCalls.length = 0
    return { context, page, authCalls }
  }

  it('four parallel requests trigger exactly one refresh', async () => {
    const { context, page, authCalls } = await signedInWithExpiredToken(username)

    const result = await page.evaluate(async () => {
      // A lap sajátja; a lint abszolút útnak látja, pedig a böngészőben
      // origóhoz képesti cím — a kiszolgált kliens ugyanezt tölti be.
      // eslint-disable-next-line import/no-absolute-path
      const { YumeAPI } = await import('/src/shared/api/yume.js')
      const outcomes = await Promise.allSettled([
        YumeAPI._request('/v1/auth/permissions', { auth: true }),
        YumeAPI._request('/v1/auth/permissions', { auth: true }),
        YumeAPI._request('/v1/auth/permissions', { auth: true }),
        YumeAPI._request('/v1/auth/permissions', { auth: true })
      ])
      return {
        failures: outcomes.filter(o => o.status === 'rejected').map(o => String(o.reason?.message)),
        stillSignedIn: Boolean(localStorage.getItem('yume-auth'))
      }
    })

    const refreshes = authCalls.filter(call => call.includes('/v1/auth/refresh'))
    assert.equal(refreshes.length, 1,
      `${refreshes.length} frissítés indult négy elakadt kérésre: ${refreshes.join(', ')}`)
    assert.equal(refreshes[0].startsWith('200'), true, `a frissítés nem sikerült: ${refreshes[0]}`)

    // A felhasználó szempontjából ez a lényeg: egyetlen kérés sem hasal el, és
    // bejelentkezve marad.
    assert.deepEqual(result.failures, [], 'elakadt kérések a frissítés után')
    assert.equal(result.stillSignedIn, true, 'a munkamenet elveszett')

    await context.close()
  })

  it('a reload with an expired token keeps the reader signed in', async () => {
    const name = 'sess' + randomBytes(5).toString('hex')
    const { context, page } = await signedInWithExpiredToken(name)
    try {
      await page.goto(`${base}/#/list`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)

      const signedIn = await page.evaluate(() => Boolean(localStorage.getItem('yume-auth')))
      assert.equal(signedIn, true, 'egy újratöltés lejárt tokennel kijelentkeztetett')
    } finally {
      await context.close()
      await pool.query('DELETE FROM users WHERE username = $1', [name])
    }
  })
})
