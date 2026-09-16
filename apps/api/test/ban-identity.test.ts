// Egy alany, egy élő tiltás — és a feloldás az alanyra szól.
//
// A HIBA, AMIBŐL EZ LETT: a tiltás minden hívásra új sort szúrt be. Kétszer
// kiadva két élő tiltás keletkezett ugyanarra a címre, a feloldás viszont egy
// SORRA szólt. Az operátor feloldotta, amit a listában látott; a látogató
// továbbra is ki volt zárva, és a panel szerint nem volt rá tiltás. Ez az a
// fajta hiba, amit nem lehet hibaüzenetből megfejteni — csak a táblából.
//
// A duplikátum egy csendesebb kárt is okozott: az automatikus tiltás hossza a
// korábbi tiltások SZÁMÁBÓL nő, és a duplikátumok felfújták ezt a számot, így
// egy első fennakadás sokadikként büntetődött.
//
// Amit ez a fájl őriz:
//   * az ismételt tiltás meghosszabbít, nem hozzáad;
//   * a hosszabb lejárat nyer, a rövidebb nem rövidíthet;
//   * a párhuzamos tiltás sem hoz létre másodikat (ez a valódi eset: két
//     egyszerre blokkolt kérés két `autoBan`-t indít ugyanarra a címre);
//   * a feloldás minden élő tiltást elvisz az alanyról, a régieket is.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'ban-identity-secret-long-enough-0123456789'

describe('egy alanyhoz egy élő tiltás tartozik', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let bans: typeof import('../src/modules/edge/bans.ts')

  // Dokumentációs tartomány (RFC 5737), hogy egy valódi cím se kerüljön ide.
  const IP = '198.51.100.55'

  const liveCount = async (): Promise<number> => {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM edge_bans WHERE kind = 'ip' AND subject = $1 AND lifted_at IS NULL", [IP])
    return Number(rows[0].n)
  }
  const clean = async (): Promise<void> => {
    await pool.query("DELETE FROM edge_bans WHERE kind = 'ip' AND subject = $1", [IP])
  }

  before(async () => {
    const db = await import('../src/infrastructure/database/index.ts')
    pool = db.pool as never
    bans = await import('../src/modules/edge/bans.ts')
    await clean()
  })

  after(async () => {
    try { await clean() } finally { await pool?.end() }
  })

  test('a kétszer kiadott tiltás egy sor marad, hosszabb lejárattal', async () => {
    await clean()
    const first = await bans.ban({ kind: 'ip', subject: IP, reason: 'első', source: 'manual', seconds: 60 })
    const second = await bans.ban({ kind: 'ip', subject: IP, reason: 'második', source: 'manual', seconds: 3600 })

    assert.ok(first && second, 'mindkét tiltásnak sikerülnie kell')
    assert.equal(await liveCount(), 1, 'két élő tiltás keletkezett egy alanyra')
    assert.equal(first.id, second.id, 'a második tiltásnak a meglévőt kell meghosszabbítania')
    assert.ok(Number(second.expiresAt) > Number(first.expiresAt), 'a hosszabb lejáratnak nyernie kell')
  })

  test('a rövidebb tiltás nem rövidíti le a hosszabbat', async () => {
    await clean()
    const long = await bans.ban({ kind: 'ip', subject: IP, reason: 'hosszú', source: 'manual', seconds: 3600 })
    const short = await bans.ban({ kind: 'ip', subject: IP, reason: 'rövid', source: 'manual', seconds: 5 })
    assert.ok(long && short)
    assert.equal(Number(short.expiresAt), Number(long.expiresAt),
      'egy ötmásodperces tiltás nem engedhet el valakit egy órával korábban')
  })

  test('a végleges tiltás felülírja a lejárót', async () => {
    await clean()
    await bans.ban({ kind: 'ip', subject: IP, reason: 'egy óra', source: 'manual', seconds: 3600 })
    const forever = await bans.ban({ kind: 'ip', subject: IP, reason: 'végleges', source: 'manual', seconds: 0 })
    assert.ok(forever)
    assert.equal(forever.expiresAt, null, 'a véglegesnek végleges a lejárata')
  })

  /*
   * Ez a valódi eset. Az `index.ts` a blokkolt kérésre `void autoBan(...)`-t
   * hív; nyolc egyszerre érkező kérés nyolc tiltást indít ugyanarra a címre,
   * és zár nélkül mind a nyolc „nincs még élő tiltás"-t látna.
   */
  test('nyolc párhuzamos tiltás sem hoz létre másodikat', async () => {
    await clean()
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      bans.ban({ kind: 'ip', subject: IP, reason: `párhuzamos ${i}`, source: 'manual', seconds: 60 })))
    assert.ok(all.every(Boolean), 'egyik párhuzamos tiltás sem hasalhat el')
    assert.equal(await liveCount(), 1, 'a párhuzamos hívások duplikált tiltást hagytak')
  })

  /*
   * A visszafelé menő fél: a javítás előtt keletkezett párokat is fel kell
   * tudni oldani. Egy kézzel beszúrt második sor pontosan az, ami a
   * termelésben már ott lehet.
   */
  test('a feloldás minden élő tiltást elvisz az alanyról', async () => {
    await clean()
    await bans.ban({ kind: 'ip', subject: IP, reason: 'friss', source: 'manual', seconds: 600 })
    await pool.query(
      `INSERT INTO edge_bans (kind, subject, subject_inet, reason, source)
       VALUES ('ip', $1, $2::inet, 'a javítás előtti duplikátum', 'manual')`, [IP, IP])
    assert.equal(await liveCount(), 2, 'a próbához két élő tiltás kell')

    const { rows } = await pool.query(
      "SELECT id FROM edge_bans WHERE kind = 'ip' AND subject = $1 AND lifted_at IS NULL LIMIT 1", [IP])
    assert.equal(await bans.lift(String(rows[0].id), null, 'próba'), true)

    assert.equal(await liveCount(), 0, 'a feloldás után nem maradhat élő tiltás az alanyon')
    assert.equal(await bans.blocked({ ip: IP, userId: null, sessionId: null }), null,
      'a feloldott címnek át kell mennie')
  })
})
