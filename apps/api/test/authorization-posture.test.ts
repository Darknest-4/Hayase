// A JOGOSULTSÁGI ÁLLÁS — mind a 238 végpontról, minden futásnál.
//
// Ez a készlet nem egy-egy útvonalat vizsgál, hanem a RENDSZER egészét: veszi
// a Fastify valódi útvonaltábláját, és mindet meghívja kétféleképpen —
// névtelenül és egy frissen regisztrált, átlagos fiókkal. Amit ezután
// állítunk, az nem egy lista, amit karban kell tartani, hanem egy szabály:
//
//   1. az adminfelület EGYETLEN végpontja sem válaszol sem névtelenül, sem
//      átlagos felhasználónak;
//   2. SEHOL nincs 5xx — egy rossz kérés a kérés hibája, nem a kiszolgálóé.
//
// MIÉRT ÍGY, ÉS NEM STATIKUS ELEMZÉSSEL. Először a forrást próbáltam
// megnézni: „melyik `fastify.get` mellett áll `requirePermission`". A válasz
// 84 „őrizetlen" végpont lett, ami színtiszta elemzési hiba volt — a
// regisztrációk alakja túl sokféle. A futó alkalmazás megkérdezése viszont
// nem téveszthető meg.
//
// AMIT EZ MEGTALÁLT, amikor megírtam:
//
//   * NYOLC végpont adott 500-at egy elrontott azonosítóra, mert a `:id`
//     nyersen ment a lekérdezésbe, és a Postgres dobta el. Ebből KETTŐ csak
//     belépve látszott: a 401 mögött ültek, tehát egy névtelen pásztázás
//     sosem találta volna meg őket. Ezért mér ez a készlet mindkét állásban.
//   * a `/v1/admin/badges` 200-at adott bármelyik belépett fióknak. Adat nem
//     szivárgott (a számok helyén `null` állt), de a 109 testvére `hide:
//     true`-val pont azért ad 404-et, hogy az adminfelület LÉTE se derüljön
//     ki — ez az egy ellentmondott nekik.
//
// A MÉRÉS ÖNSEBE, amiért a próba kihagy három útvonalat: az első futásom
// meghívta a `POST /v1/auth/logout-all`-t, ami visszavonta a saját tokenünket,
// és onnantól minden további végpont 401-et adott. Negyvenhat „találat", ami
// csak annyit mért, hogy sikerült kijelentkeznünk.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { publicInstance } from './support/instance.ts'

import type { FastifyInstance } from 'fastify'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'authorization-posture-secret-long-enough-0123456789'
// Ez a készlet sok kérést küld egyben; a korlátoknak saját tesztjük van.
process.env.RATE_LIMIT_MAX ??= '5000'
process.env.WRITE_RATE_LIMIT_MAX ??= '2000'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

interface Probe { method: string, url: string, status: number, body: string }

let app: FastifyInstance
let pool: { end: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
let nevtelen: Probe[] = []
let felhasznalo: Probe[] = []

/** A saját munkamenetünket ölné meg; lásd a fejlécet. */
const ONGYILKOS = /^\/v1\/auth\/(logout|logout-all|refresh)$/

/**
 * A Fastify útvonaltáblája, teljes címekkel.
 *
 * A `printRoutes` ELŐTAGFÁT ad: minden sor a szülő útjához fűz egy darabot, és
 * a mélységet a behúzás mondja meg. Soronként olvasva „permissions" vagy
 * „/:id" lesz az út — olyan címek, amiket meg lehet hívni, de a válaszukból
 * semmi nem következik.
 */
function utvonalak (instance: FastifyInstance): Array<{ method: string, url: string }> {
  const sorok = instance.printRoutes({ commonPrefix: false }).split('\n').filter(s => s.trim())
  const ut: string[] = []
  const tabla: Array<{ method: string, url: string }> = []
  for (const sor of sorok) {
    const m = /^([│\s]*)(?:├──|└──)\s(\S+)(?:\s\(([^)]+)\))?/.exec(sor)
    if (!m) continue
    const melyseg = Math.floor(m[1]!.length / 4)
    ut.length = melyseg
    ut[melyseg] = m[2]!
    if (!m[3]) continue
    const url = ut.slice(0, melyseg + 1).join('')
    for (const method of m[3].split(', ')) tabla.push({ method, url })
  }
  return tabla
}

async function vegigjar (headers: Record<string, string>): Promise<Probe[]> {
  const out: Probe[] = []
  for (const { method, url } of utvonalak(app)) {
    if (method === 'HEAD' || method === 'OPTIONS') continue
    // A verziózott statikus útvonal nem API.
    if (url.startsWith('/b/')) continue
    if (ONGYILKOS.test(url)) continue
    const cim = url.replace(/:\w+/g, '1').replace(/\*/g, 'x').replace(/\|.*$/, '')
    const res = await app.inject({
      method: method as never, url: cim, headers,
      payload: method === 'GET' ? undefined : {}
    })
    out.push({ method, url, status: res.statusCode, body: res.body.slice(0, 200) })
  }
  return out
}

describe('a jogosultsági állás', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  publicInstance()

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    nevtelen = await vegigjar({})

    const nev = 'posture_' + randomBytes(5).toString('hex')
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${nev}@test.invalid`, username: nev, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(reg.statusCode, 201, 'a próbafiók regisztrációja: ' + reg.body)
    const token = (reg.json() as { accessToken: string }).accessToken
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [nev])
    const userId = String(rows[0]!.id)
    const prof = await pool.query('SELECT id FROM user_profiles WHERE user_id = $1', [userId])

    felhasznalo = await vegigjar({
      authorization: `Bearer ${token}`,
      'x-profile-id': String(prof.rows[0]!.id)
    })

    await pool.query('DELETE FROM users WHERE id = $1', [userId])
  })

  after(async () => {
    await app?.close()
    await pool?.end()
  })

  it('a próba tényleg végigment az egész táblán', () => {
    // Ha a tábla összeomlana (elrontott elemzés), a többi állítás üres
    // halmazon lenne igaz — ezért ez az első.
    assert.ok(nevtelen.length > 150, `csak ${nevtelen.length} végpontot hívtunk meg`)
    assert.equal(nevtelen.length, felhasznalo.length)
    assert.ok(nevtelen.some(p => p.url === '/v1/health'), 'a tábla nem tartalmazza az egészségjelzőt')
    assert.ok(nevtelen.filter(p => p.url.includes('/v1/admin/')).length > 100,
      'az adminfelület nincs a mért táblában')
  })

  it('egyetlen adminvégpont sem válaszol névtelenül', () => {
    const atengedte = nevtelen
      .filter(p => p.url.includes('/v1/admin/') && p.status < 400)
      .map(p => `${p.method} ${p.url} → ${p.status}`)
    assert.deepEqual(atengedte, [])
  })

  it('egyetlen adminvégpont sem válaszol átlagos felhasználónak', () => {
    const atengedte = felhasznalo
      .filter(p => p.url.includes('/v1/admin/') && p.status < 400)
      .map(p => `${p.method} ${p.url} → ${p.status}: ${p.body.slice(0, 80)}`)
    assert.deepEqual(atengedte, [])
  })

  /*
   * Egy rossz azonosító a KÉRÉS hibája. Az 500 nemcsak pontatlan válasz:
   * elrejti a valódi üzemzavart is, mert a hibakövetőben elvegyül a
   * szemét között.
   */
  it('egy elrontott azonosítótól egyetlen végpont sem hasal el', () => {
    const elhasalt = [...nevtelen, ...felhasznalo]
      .filter(p => p.status >= 500)
      .map(p => `${p.method} ${p.url} → ${p.status}`)
    assert.deepEqual([...new Set(elhasalt)], [])
  })
})
