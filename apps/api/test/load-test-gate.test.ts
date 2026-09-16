// A sebességkorlát alóli kivétel: mikor NEM ad mentességet.
//
// Ez a modul egy biztonsági védelmet nyit ki. A tesztek súlypontja ezért nem
// az, hogy működik-e, hanem hogy a három feltétel közül bármelyik hiánya
// megfogja-e — mert egy kivétel, ami két feltételből is átenged, nem kivétel,
// hanem lyuk.
//
// A döntés `allowsLoadTest`-ként külön áll a kéréstől, mert a `config` a modul
// betöltésekor olvassa a környezetet: a bekötött úton egy futás egyetlen
// beállítást tudna végigpróbálni, és a fontos esetek épp a többi.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

const KEY = randomBytes(32).toString('base64')
const IPS = ['127.0.0.1', '10.4.0.9']

// A bekötött úthoz a környezetnek az app betöltése ELŐTT kell állnia: a config
// a modul betöltésekor olvassa. A korlát szándékosan nevetségesen alacsony,
// hogy tíz kérés is átlépje.
process.env.LOAD_TEST_KEY = KEY
process.env.RATE_LIMIT_MAX = '5'
process.env.JWT_SECRET ??= 'loadtest-secret-long-enough-0123456789'
const HAS_DB = Boolean(process.env.DATABASE_URL)

describe('the load-test exemption', () => {
  let allowsLoadTest: typeof import('../src/middleware/load-test.ts').allowsLoadTest

  before(async () => {
    ;({ allowsLoadTest } = await import('../src/middleware/load-test.ts'))
  })

  test('is off when no key is configured — whatever the request claims', () => {
    // Az alapállapot. Egy telepítés, ahol senki nem állított be semmit,
    // ugyanúgy korlátoz, mint eddig.
    assert.equal(allowsLoadTest(KEY, '127.0.0.1', undefined, IPS), false)
    assert.equal(allowsLoadTest(KEY, '127.0.0.1', '', IPS), false)
  })

  test('needs the header — a listed address alone is not enough', () => {
    assert.equal(allowsLoadTest(undefined, '127.0.0.1', KEY, IPS), false)
    assert.equal(allowsLoadTest('', '127.0.0.1', KEY, IPS), false)
    // Egy tömbként érkező fejléc (kétszer küldött) sem szöveg.
    assert.equal(allowsLoadTest([KEY], '127.0.0.1', KEY, IPS), false)
  })

  test('needs a listed address — the key alone is not enough', () => {
    // Ez a lényeg: aki a kulcsot megszerzi, azzal se tudjon máshonnan a
    // korlát mögé kerülni.
    assert.equal(allowsLoadTest(KEY, '203.0.113.7', KEY, IPS), false)
    assert.equal(allowsLoadTest(KEY, '::1', KEY, IPS), false)
  })

  test('refuses a wrong key, including one that merely starts right', () => {
    assert.equal(allowsLoadTest(KEY.slice(0, -1) + 'x', '127.0.0.1', KEY, IPS), false)
    assert.equal(allowsLoadTest(KEY.slice(0, 8), '127.0.0.1', KEY, IPS), false)
    assert.equal(allowsLoadTest(KEY + 'x', '127.0.0.1', KEY, IPS), false)
    assert.equal(allowsLoadTest('', '127.0.0.1', KEY, IPS), false)
  })

  test('allows exactly the intended case', () => {
    assert.equal(allowsLoadTest(KEY, '127.0.0.1', KEY, IPS), true)
    assert.equal(allowsLoadTest(KEY, '10.4.0.9', KEY, IPS), true)
  })

  test('a short key is refused at startup, not quietly accepted', async () => {
    // A kulcs egy sebességkorlát-kivétel kapuja; egy kitalálható kulcs pont
    // azt nyitja ki, amit a korlát véd. A config indításkor dob.
    const { execFileSync } = await import('node:child_process')
    let failed = false
    try {
      execFileSync(process.execPath, ['--experimental-strip-types', '-e',
        "import('./src/config.ts').then(m => { void m.config.loadTestKey })"],
      { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, LOAD_TEST_KEY: 'too-short' }, stdio: 'pipe' })
    } catch (err) {
      failed = true
      assert.match(String((err as { stderr?: Buffer }).stderr ?? ''), /LOAD_TEST_KEY is too short/)
    }
    assert.ok(failed, 'a short LOAD_TEST_KEY started without complaint')
  })
})

describe('the exemption, wired up', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: import('fastify').FastifyInstance

  before(async () => {
    const { buildApp } = await import('../src/app.ts')
    app = await buildApp()
    await app.ready()
  })

  after(async () => { await app?.close() })

  /** Tíz kérés egy olcsó nyilvános végpontra; hány ment át? */
  const burst = async (headers: Record<string, string>): Promise<number[]> => {
    const codes: number[] = []
    for (let i = 0; i < 10; i++) {
      codes.push((await app.inject({ url: '/v1/config', headers })).statusCode)
    }
    return codes
  }

  test('without the header the limit still bites', async () => {
    const codes = await burst({})
    assert.ok(codes.includes(429), `no request was limited: ${codes.join(',')}`)
  })

  test('with the header nothing is limited', async () => {
    // Ugyanaz a cím, ugyanaz a végpont, ugyanabban a percben — az egyetlen
    // különbség a fejléc.
    const codes = await burst({ 'x-yume-load-test': KEY })
    assert.ok(!codes.includes(429), `the exemption did not hold: ${codes.join(',')}`)
  })

  test('a wrong key is limited like everybody else', async () => {
    const codes = await burst({ 'x-yume-load-test': 'not-the-key' })
    assert.ok(codes.includes(429), `a wrong key got through: ${codes.join(',')}`)
  })

  test('the exemption is only about rate limiting, not about who you are', async () => {
    // Fontos határ: a mentesség nem hitelesítés. A kulccsal sem lehet olyan
    // helyre bemenni, ahova enélkül sem.
    const res = await app.inject({ url: '/v1/admin/backups', headers: { 'x-yume-load-test': KEY } })
    assert.equal(res.statusCode, 401, res.body)
  })
})
