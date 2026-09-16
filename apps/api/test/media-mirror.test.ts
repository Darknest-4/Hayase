// A képtükör — és főleg az, amit NEM szabad kiszolgálnia.
//
// Ez az útvonal a tárhelykulcsot a KÉRÉS URL-jÉBŐL veszi, és ugyanazon a
// Cloudflare-fiókon ott vannak az adatbázis-mentések is. Egy elrontott
// kiszolgáló útvonal tehát nem „hibás képet" jelentene, hanem azt, hogy a
// teljes adatbázis letölthető egy jól megtippelt URL-lel.
//
// Két zár védi, egymástól függetlenül:
//
//   1. KÜLÖN VÖDÖR — a média nem abban a vödörben van, mint a mentések, tehát
//      ez a kód nem is tud rájuk mutatni;
//   2. ISMERT KULCS — a kulcsnak szerepelnie kell az `anime_images.mirror_key`
//      oszlopban; csak azt lehet letölteni, amit mi tettünk oda képként.
//
// A suite nagyobb fele a második zárat feszegeti. A kulcsképzés determinizmusa
// azért van itt, mert arra épül a `Cache-Control: immutable` ígérete.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { mirrorKeyFor } from '../src/modules/media/mirror.ts'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'media-mirror-secret-long-enough-0123456789'

describe('a tárhelykulcs', () => {
  test('ugyanarra a forrásra mindig ugyanaz', () => {
    const url = 'https://cdn.myanimelist.net/images/anime/10/22857.jpg'
    assert.equal(mirrorKeyFor('cover', url), mirrorKeyFor('cover', url))
  })

  test('különböző forrásokra különböző', () => {
    assert.notEqual(
      mirrorKeyFor('cover', 'https://pelda.hu/a.jpg'),
      mirrorKeyFor('cover', 'https://pelda.hu/b.jpg'))
  })

  /*
   * Ez tartja a `Cache-Control: immutable` ígéretét. Ha egy kulcs mögött
   * megváltozhatna a kép, egy évig rossz borítót mutatnánk a látogatóknak, és
   * semmi nem törölné a gyorsítótárukból.
   */
  test('a kulcs a forrás URL-jéből származik, nem a sor azonosítójából', () => {
    const key = mirrorKeyFor('cover', 'https://pelda.hu/kep.png')
    assert.match(key, /^media\/cover\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
  })

  test('kiterjesztés nélküli forrásra jpg-t feltételez', () => {
    assert.match(mirrorKeyFor('banner', 'https://pelda.hu/kep'), /\.jpg$/)
  })

  test('a fajta a kulcs része, tehát a fajták nem keverednek', () => {
    const url = 'https://pelda.hu/kep.jpg'
    assert.notEqual(mirrorKeyFor('cover', url), mirrorKeyFor('banner', url))
  })
})

describe('a kiszolgáló útvonal csak ismert kulcsot ad ki', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
  })

  after(async () => {
    try { await app?.close() } finally { await pool?.end() }
  })

  /*
   * A LÉNYEG. Minden ilyen kérésre 404 kell — nem 403, nem 500, és főleg nem
   * tartalom. A mentések elérési útja szándékosan szerepel a listán: az a
   * forgatókönyv, ami miatt ez a suite létezik.
   */
  test('ismeretlen kulcsra 404', async () => {
    const attempts = [
      'media/cover/00/nincs-ilyen.jpg',           // jó alakú, de nem a miénk
      'yume/yume-20260916T140328Z.dump',          // egy adatbázis-mentés neve
      'media/cover/..%2f..%2fyume%2fbackup.dump', // kódolt útvonal-bejárás
      '..%2f.env',                                // kódolt kilépés a gyökérbe
      'proba/binaris.bin',                        // idegen prefix
      ''                                          // üres
    ]
    for (const key of attempts) {
      const res = await app.inject({ url: `/media/${key}` })
      assert.equal(res.statusCode, 404,
        `a(z) „${key}" kulcsra ${res.statusCode} jött, nem 404`)
    }
  })

  /*
   * A KÓDOLATLAN útvonal-bejárás külön eset, és a különbség nem apróság.
   *
   * A `/media/../.env` az útválasztóig sem jut el ilyen alakban: a `..`-t a
   * kérés útvonalának normalizálása feloldja, és a kérés `/.env` lesz, amit az
   * SPA visszaesése szolgál ki. Vagyis nem 404 jön rá, hanem 200 — és ez
   * HELYES, mert az `index.html` megy vissza, nem a fájl.
   *
   * Az állítás ezért nem a státuszkódra szól, hanem arra, ami tényleg számít:
   * ilyen kérésre SEMMILYEN alakban nem jöhet vissza titok. A státuszkód
   * rögzítése itt téves biztonságérzetet adna — egy 200-as HTML-válasz
   * ugyanolyan ártalmatlan, mint egy 404.
   */
  test('normalizált útvonal-bejárás sem ad vissza titkot', async () => {
    const attempts = [
      'media/../.env',
      'media/../../etc/passwd',
      'media/../yume/yume-20260916T140328Z.dump',
      'media/cover/../../yume/backup.dump'
    ]
    for (const key of attempts) {
      const res = await app.inject({ url: `/media/${key}` })
      assert.ok(!res.body.includes('PGDMP'),
        `„${key}": adatbázis-mentés tartalma a válaszban`)
      assert.ok(!/JWT_SECRET|POSTGRES_PASSWORD|R2_SECRET/.test(res.body),
        `„${key}": környezeti titok a válaszban`)
      assert.ok(!res.body.includes('root:x:0:0'),
        `„${key}": a gazdagép jelszófájlja a válaszban`)
    }
  })

  /*
   * A tükör és a tárhely eltérhet: egy sor mondhatja, hogy a kép ott van, míg
   * a tárhelyről közben törölték. Ez 404, nem 500 — a látogató szempontjából
   * a kép nincs meg, és egy ötszázas hibaoldal ennél semmivel nem mond többet.
   */
  test('a sorban szereplő, de a tárhelyről hiányzó kép 404', async () => {
    const ghost = mirrorKeyFor('cover', `https://pelda.hu/szellem-${Date.now()}.jpg`)
    const { rows } = await pool.query(
      "SELECT id FROM anime_images WHERE object_key LIKE 'http%' LIMIT 1")
    if (!rows[0]) return // üres katalógus — nincs mit mérni

    const id = String(rows[0].id)
    const previous = await pool.query('SELECT mirror_key FROM anime_images WHERE id = $1', [id])
    try {
      await pool.query('UPDATE anime_images SET mirror_key = $2 WHERE id = $1', [id, ghost])
      const res = await app.inject({ url: `/media/${ghost}` })
      assert.ok(res.statusCode === 404 || res.statusCode === 503,
        `${res.statusCode} jött; 404 (nincs a tárhelyen) vagy 503 (nincs tárhely) a helyes`)
    } finally {
      await pool.query('UPDATE anime_images SET mirror_key = $2 WHERE id = $1',
        [id, previous.rows[0]?.mirror_key ?? null])
    }
  })

  test('a válasz sosem HTML — az SPA visszaesése nem nyelheti el', async () => {
    const res = await app.inject({ url: '/media/media/cover/aa/nincs.jpg' })
    assert.ok(!res.body.startsWith('<!doctype'),
      'a /media/* kérés az SPA index.html-jét kapta, tehát az útvonal nincs bekötve')
  })
})
