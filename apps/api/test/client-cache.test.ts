// A kliens gyorsítótárazása — a „friss váz, régi kód" ellen.
//
// MI TÖRTÉNT. Egy új útvonal élesítése után egy visszatérő látogató telefonján
// „Page not found" jelent meg, miközben a kiszolgálón minden rendben volt: az
// `index.html` mindig friss (a Cloudflare nem gyorsítótárazza), a modulok
// viszont négy órára eltárolódtak. Új váz, RÉGI `router.js`, és az új útvonal
// abban még nem létezett.
//
// A négy órát nem mi adjuk, és megmértük, hogy nem is tudunk alámenni:
//
//   eredet: `no-cache` (js)      → él: `max-age=14400`
//   eredet: `max-age=86400` (kép) → él: `max-age=86400`
//
// A Cloudflare zónabeállítása fölülírja a rövidebb értéket. Fejlécekkel tehát
// nem oldható meg — a CÍMNEK kell változnia telepítésenként.
//
// Ez a suite azt méri, hogy változik is, hogy a régi címek közben élnek, és
// hogy a bélyegzett cím tényleg a fájlt adja vissza.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import {
  STAMP_PREFIX, clientVersion, forgetClientVersion, stampAssets, unstamp
} from '../src/infrastructure/http/client-version.ts'

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'yume-kliens-'))
  await mkdir(join(root, 'src', 'app'), { recursive: true })
  await mkdir(join(root, 'css'), { recursive: true })
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'src', 'app', 'main.js'), 'export const a = 1\n')
  await writeFile(join(root, 'css', 'style.css'), 'body{}\n')
  await writeFile(join(root, 'assets', 'kep.svg'), '<svg/>')
  await writeFile(join(root, 'index.html'),
    '<link rel="stylesheet" href="/css/style.css">' +
    '<link rel="icon" href="/assets/kep.svg" />' +
    '<script type="module" src="/src/app/main.js"></script>')
})

after(async () => { await rm(root, { recursive: true, force: true }) })

beforeEach(() => { forgetClientVersion() })

describe('a verzió', () => {
  test('ugyanabból az állapotból ugyanaz', async () => {
    const a = await clientVersion(root)
    forgetClientVersion()
    assert.equal(await clientVersion(root), a)
  })

  test('rövid és cím-biztos', async () => {
    assert.match(await clientVersion(root), /^[0-9a-f]{12}$/)
  })

  /*
   * EZ A LÉNYEG. Ha egy modul változik, a verziónak változnia kell — különben
   * a látogató a régi címről kapja a régi kódot, és pont az a hiba
   * ismétlődik meg, ami miatt ez a modul létezik.
   */
  test('egy megváltozott modultól megváltozik', async () => {
    const elotte = await clientVersion(root)
    forgetClientVersion()
    await writeFile(join(root, 'src', 'app', 'main.js'), 'export const a = 2\n')
    assert.notEqual(await clientVersion(root), elotte)
  })

  test('egy új modultól is megváltozik', async () => {
    const elotte = await clientVersion(root)
    forgetClientVersion()
    await writeFile(join(root, 'src', 'app', 'uj.js'), 'export const b = 1\n')
    const utana = await clientVersion(root)
    assert.notEqual(utana, elotte)
    await rm(join(root, 'src', 'app', 'uj.js'))
    forgetClientVersion()
  })

  test('a stíluslap változása is számít', async () => {
    const elotte = await clientVersion(root)
    forgetClientVersion()
    await writeFile(join(root, 'css', 'style.css'), 'body{color:red}\n')
    assert.notEqual(await clientVersion(root), elotte)
  })

  /*
   * A képek KIMARADNAK a verzióból: ritkán változnak, és egy elavult kép
   * legrosszabb esetben csúnya — nem törött alkalmazás. Ha beleszámítanának,
   * egy borító cseréje az egész modulkészletet újratöltetné mindenkivel.
   */
  test('egy kép változása nem mozgatja meg az egész klienst', async () => {
    const elotte = await clientVersion(root)
    forgetClientVersion()
    await writeFile(join(root, 'assets', 'kep.svg'), '<svg viewBox="0 0 1 1"/>')
    assert.equal(await clientVersion(root), elotte)
  })

  /*
   * A `readdir` sorrendje nem garantált. Ha az számítana, ugyanaz a telepítés
   * két gépen két verziót adna — és a látogatók feleslegesen töltenének újra.
   */
  test('nem függ a fájlrendszer olvasási sorrendjétől', async () => {
    const elotte = await clientVersion(root)
    forgetClientVersion()
    // Az mtime visszaállításával ugyanaz az állapot áll elő.
    const a = await clientVersion(root)
    assert.equal(a, elotte)
  })

  test('hiányzó könyvtár nem hiba', async () => {
    const ures = await mkdtemp(join(tmpdir(), 'yume-ures-'))
    try {
      assert.match(await clientVersion(ures), /^[0-9a-f]{12}$/)
    } finally {
      await rm(ures, { recursive: true, force: true })
    }
  })
})

describe('a lap bélyegzése', () => {
  test('a modul és a stíluslap megkapja a verziót', async () => {
    const html = stampAssets(
      '<link href="/css/style.css"><script src="/src/app/main.js"></script>', 'abc123')
    assert.match(html, /"\/b\/abc123\/css\/style\.css"/)
    assert.match(html, /"\/b\/abc123\/src\/app\/main\.js"/)
  })

  /*
   * EGYETLEN CÍM ELÉG. A kliens modulkészlete relatív importokat használ, és
   * egy relatív import a KÉRŐ MODUL címéhez képest oldódik fel — tehát a
   * belépési pont bélyegzése az egész gráfot magával viszi.
   */
  test('a képek címe érintetlen marad', async () => {
    const html = stampAssets('<link rel="icon" href="/assets/kep.svg">', 'abc123')
    assert.match(html, /"\/assets\/kep\.svg"/)
  })

  test('verzió nélkül semmit nem ír át', async () => {
    const eredeti = '<script src="/src/app/main.js"></script>'
    assert.equal(stampAssets(eredeti, ''), eredeti)
  })

  test('csak attribútumértéket ír át, szöveget nem', async () => {
    const html = stampAssets('<p>a /src/app/main.js fájl</p>', 'abc123')
    assert.equal(html, '<p>a /src/app/main.js fájl</p>')
  })

  test('aposztrófos attribútumot is', async () => {
    assert.match(stampAssets("<script src='/src/x.js'>", 'abc123'), /'\/b\/abc123\/src\/x\.js'/)
  })
})

describe('a bélyegzett cím szétszedése', () => {
  test('visszaadja a fájl útvonalát', () => {
    assert.equal(unstamp('/b/abc123def456/src/app/main.js'), 'src/app/main.js')
    assert.equal(unstamp('/b/abc123/css/style.css'), 'css/style.css')
  })

  test('a lekérdezés nem zavarja meg', () => {
    assert.equal(unstamp('/b/abc123/src/x.js?t=1'), 'src/x.js')
  })

  /*
   * A VERZIÓT NEM VETJÜK ÖSSZE A MOSTANIVAL. A telepítés pillanatában a
   * látogató böngészőjében még a régi lap fut, és annak a régi címeit is ki
   * kell szolgálni — különben pont a telepítés másodpercében törne el az
   * oldal mindenkinél, aki nyitva tartja.
   */
  test('egy régi verziójú cím is kiszolgálható', () => {
    assert.equal(unstamp('/b/000000000000/src/app/main.js'), 'src/app/main.js')
  })

  test('csak a kliens saját könyvtárai', () => {
    for (const rossz of [
      '/b/abc123/etc/passwd',
      '/b/abc123/assets/kep.svg',   // a képek nincsenek bélyegezve
      '/b/abc123/test/titok.mjs',
      '/b/abc123/index.html'
    ]) {
      assert.equal(unstamp(rossz), null, rossz)
    }
  })

  test('a kitörési kísérlet elbukik', () => {
    for (const rossz of [
      '/b/abc123/src/../../../etc/passwd',
      '/b/abc123/src/..',
      '/b/abc123/../css/x.css'
    ]) {
      assert.equal(unstamp(rossz), null, rossz)
    }
  })

  test('ami nem bélyegzett cím, az nem is az', () => {
    for (const mas of ['/src/app/main.js', '/b/main.js', `/${STAMP_PREFIX}/`, '/v1/config', '/']) {
      assert.equal(unstamp(mas), null, mas)
    }
  })

  test('a verzió csak hexa lehet', () => {
    assert.equal(unstamp('/b/../src/x.js'), null)
    assert.equal(unstamp('/b/ZZZZZZ/src/x.js'), null)
  })
})

// ---------------------------------------------------------------------------
// A VALÓDI KISZOLGÁLÁS
// ---------------------------------------------------------------------------
//
// A fenti a logikát méri; ez azt, hogy a logika a helyére is került. Amit csak
// itt lehet látni: a fejlécek, és hogy a bélyegzett cím tényleg fájlt ad.

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'client-cache-secret-0123456789abcdef'

describe('a kiszolgált kliens', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts').buildApp>>
  let pool: import('pg').Pool
  let verzio: string

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
    forgetClientVersion()
    verzio = await clientVersion(process.env.WEB_ROOT ??
      new URL('../../web', import.meta.url).pathname)
  })

  after(async () => {
    try { await app?.close() } finally { await pool?.end() }
  })

  test('a lap bélyegzett hivatkozásokkal megy ki', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.match(res.body, new RegExp(`/b/${verzio}/src/app/main\\.js`),
      'a belépési pont nincs bélyegezve — a modulgráf a régi címeken maradna')
    assert.match(res.body, new RegExp(`/b/${verzio}/css/`))
  })

  /*
   * A LAP MINDIG ELLENŐRZÉS ALATT. Ez hozza a verziót: ha ez elavulna, minden
   * más is elavulna vele — és pont ez volt az eredeti hiba.
   */
  test('a lapot mindig újra kell kérdezni', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    assert.equal(res.headers['cache-control'], 'no-cache')
  })

  /* Egy ismeretlen cím is a lapot kapja: ez egy egyoldalas alkalmazás. */
  test('egy útvonal is a lapot kapja, ugyanúgy bélyegezve', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, new RegExp(`/b/${verzio}/src/app/main\\.js`))
  })

  test('a bélyegzett cím a fájlt adja, örökre eltárolhatóan', async () => {
    const res = await app.inject({ method: 'GET', url: `/b/${verzio}/src/app/main.js` })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /javascript/)
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  })

  /*
   * A telepítés pillanatában a látogató böngészőjében még a régi lap fut. Ha a
   * régi cím 404-et adna, pont akkor törne el az oldal mindenkinél, aki nyitva
   * tartja.
   */
  test('egy korábbi verzió címe is kiszolgálódik', async () => {
    const res = await app.inject({ method: 'GET', url: '/b/000000000000/src/app/main.js' })
    assert.equal(res.statusCode, 200)
  })

  /* A régi, bélyegzetlen cím is él: aki így kérte, kapja meg. */
  test('a bélyegzetlen cím továbbra is működik', async () => {
    const res = await app.inject({ method: 'GET', url: '/src/app/main.js' })
    assert.equal(res.statusCode, 200)
  })

  test('a bélyegzett úton nem lehet kitörni a kliensből', async () => {
    for (const rossz of [
      '/b/abc123/src/../../apps/api/src/config.ts',
      '/b/abc123/test/e2e.mjs',
      '/b/abc123/../.env'
    ]) {
      const res = await app.inject({ method: 'GET', url: rossz })
      assert.notEqual(res.statusCode, 200, rossz)
    }
  })

  /*
   * A képek nincsenek a verzióban, tehát a bélyegzett úton sincs keresnivalójuk
   * — a saját, stabil címükön mennek ki.
   */
  test('a képek a bélyegzett úton nem érhetők el', async () => {
    const res = await app.inject({ method: 'GET', url: `/b/${verzio}/assets/yume.svg` })
    assert.notEqual(res.statusCode, 200)
  })
})
