// A sebességkorlát viselkedése: kit fojt meg, kit nem, és mit lát az, akit
// megfojtott.
//
// Három külön állítás, és mind a három egy-egy valódi panaszból nőtt ki:
//
//   * a korlát ÁTLAGOS HASZNÁLAT MELLETT is elérhető volt. Egy cím mögött
//     sokan vannak (mobilszolgáltatói NAT, munkahely), és a régi 300/perc
//     húsz ember között fejenként három oldal;
//   * a SAJÁT RENDSZERÜNK is beleszaladt. A worker és a bot ugyanezt az API-t
//     hívja, és ha őket megfojtjuk, a rendszer bénítja meg saját magát;
//   * aki elérte, egy NYERS JSON-t kapott a képernyőre, ami böngészőben nem
//     hibaüzenet, hanem egy elrontott oldal látszata.

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'

const { buildApp } = await import('../src/app.ts')
const { rateLimitDefaults } = await import('../src/modules/settings/site-settings.ts')
const { isInternalRequest } = await import('../src/middleware/internal-request.ts')

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = []
after(async () => { for (const app of opened) await app.close().catch(() => {}) })

const freshApp = async (max: number): Promise<Awaited<ReturnType<typeof buildApp>>> => {
  process.env.RATE_LIMIT_MAX = String(max)
  const app = await buildApp()
  opened.push(app)
  return app
}

/** Kérések, amíg 429 nem jön. A választ adja vissza, vagy `null`. */
async function untilThrottled (
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
  attempts = 12
): Promise<{ statusCode: number, headers: Record<string, unknown>, body: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const response = await app.inject({ method: 'GET', url: '/v1/config', headers })
    if (response.statusCode === 429) {
      return { statusCode: response.statusCode, headers: response.headers as Record<string, unknown>, body: response.body }
    }
  }
  return null
}

describe('a korlát alapértéke', () => {
  it('elbírja az átlagos használatot', () => {
    /*
     * Megszámolva, mennyibe kerül egy valódi látogatás: a főoldal 13
     * API-kérés, a többi képernyő 1–5. Húsz ember egy szolgáltatói cím mögött
     * percenként legalább ezret termel — a réginek beállított 300 ezt
     * megfojtotta.
     */
    const limits = rateLimitDefaults()
    assert.ok(limits.global.max >= 1000, `a globális korlát ${limits.global.max}/perc — átlagos használatnál kevés`)
    assert.equal(limits.global.windowSeconds, 60)
  })

  it('az üres környezeti változóból nem lesz nulla korlát', () => {
    // `Number(process.env.X ?? alap)` csapda: az üres sztring nem nullish,
    // átmegy a `??`-on, és `Number('')` az NULLA. Egy elfelejtett
    // `RATE_LIMIT_MAX=` sor így mindenkinek 429-et adott volna.
    const previous = process.env.RATE_LIMIT_MAX
    try {
      process.env.RATE_LIMIT_MAX = ''
      assert.ok(rateLimitDefaults().global.max >= 1000)
      process.env.RATE_LIMIT_MAX = 'nem-szám'
      assert.ok(rateLimitDefaults().global.max >= 1000)
      process.env.RATE_LIMIT_MAX = '0'
      assert.ok(rateLimitDefaults().global.max >= 1000, 'a nulla korlát mindenkit kizárna')
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_MAX
      else process.env.RATE_LIMIT_MAX = previous
    }
  })

  it('a belépés viszont szoros marad', () => {
    // Ez a jelszókitalálás elleni védelem. Az emelés nem vonatkozhat rá.
    const limits = rateLimitDefaults()
    assert.ok(limits.auth.max <= 15, `a belépési korlát ${limits.auth.max} — túl laza a kitalálás ellen`)
    assert.ok(limits.auth.windowSeconds >= 600)
  })
})

describe('kit fojt meg', () => {
  it('a külső hívót igen', async () => {
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, { 'x-forwarded-for': '203.0.113.10' })
    assert.ok(throttled, 'a külső hívó nem érte el a korlátot')
    assert.equal(throttled.statusCode, 429)
  })

  it('a SAJÁT rendszerünket soha', async () => {
    /*
     * A `inject` alapból hurokcímről érkezik, fejléc nélkül — pont úgy, ahogy
     * a worker vagy a bot hívja az API-t. Húsz kérés egy kettes korlát
     * mellett: ha a mentesség nem működne, a harmadik már 429 lenne.
     */
    const app = await freshApp(2)
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: 'GET', url: '/v1/config' })
      assert.notEqual(response.statusCode, 429, `a ${i + 1}. belső kérés megfojtva`)
    }
  })

  it('a mentességet nem lehet fejléccel kihazudni', async () => {
    // Aki kívülről azt állítja, hogy ő a szerver, attól még kívül van.
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, {
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1'
    })
    assert.ok(throttled, 'a hamisított hurokcím mentességet adott')
  })

  it('az egészségjelző soha nem fojtható', async () => {
    // Egy 429-et az irányítórendszer a szolgáltatás halálaként olvassa.
    const app = await freshApp(1)
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({
        method: 'GET', url: '/v1/health', headers: { 'x-forwarded-for': '203.0.113.11' }
      })
      assert.notEqual(response.statusCode, 429)
    }
  })
})

describe('mit lát, akit megfojtott', () => {
  it('a böngésző rendes oldalt kap', async () => {
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, {
      'x-forwarded-for': '203.0.113.20',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    })
    assert.ok(throttled, 'nem sikerült elérni a korlátot')
    assert.match(String(throttled.headers['content-type']), /text\/html/)
    assert.match(throttled.body, /<!doctype html>/i)
    assert.match(throttled.body, /YUME/)
    assert.match(throttled.body, /Túl sok kérés/)
    // Újratöltés gomb, hogy ne kelljen találgatni.
    assert.match(throttled.body, /Újratöltés/)
  })

  it('az oldal nem tölt le semmit kívülről', async () => {
    // Egy státuszoldal, ami stíluslapot vagy betűkészletet kér, pont akkor
    // hasal el, amikor a kiszolgáló bajban van.
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, {
      'x-forwarded-for': '203.0.113.21', accept: 'text/html'
    })
    assert.ok(throttled)
    assert.ok(!/https?:\/\//.test(throttled.body), 'külső hivatkozás van az oldalon')
  })

  it('a gépi hívó továbbra is JSON-t kap', async () => {
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, {
      'x-forwarded-for': '203.0.113.22', accept: 'application/json'
    })
    assert.ok(throttled)
    assert.match(String(throttled.headers['content-type']), /json/)
    const body = JSON.parse(throttled.body) as { status: number, title: string }
    assert.equal(body.status, 429)
  })

  it('a `*/*`-ot küldő curl is JSON-t kap', async () => {
    // A csillag nem böngésző: azt minden programkönyvtár küldi.
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, { 'x-forwarded-for': '203.0.113.23', accept: '*/*' })
    assert.ok(throttled)
    assert.match(String(throttled.headers['content-type']), /json/)
  })

  it('az oldal nem árul el belső részletet', async () => {
    const app = await freshApp(2)
    const throttled = await untilThrottled(app, {
      'x-forwarded-for': '203.0.113.24', accept: 'text/html'
    })
    assert.ok(throttled)
    for (const leak of ['postgres', 'yume_test', '/opt/', 'password', 'at Object.', 'node_modules']) {
      assert.ok(!throttled.body.toLowerCase().includes(leak.toLowerCase()), `kiszivárgott: ${leak}`)
    }
  })
})

describe('a felismerés maga', () => {
  it('a Caddyn átjött kérés nem belső, akkor sem, ha a Caddy magáncímen ül', () => {
    assert.equal(isInternalRequest({
      socket: { remoteAddress: '172.18.0.2' }, headers: { 'x-forwarded-for': '8.8.8.8' }
    } as never), false)
  })
})
