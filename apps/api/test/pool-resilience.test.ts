// Egy adatbázis-újraindítás nem ölheti meg az alkalmazást.
//
// A HIBA, AMIBŐL EZ LETT, egy hangolási újraindításkor derült ki. A Postgres
// `terminating connection due to administrator command`-ot küldött a TÉTLEN
// kapcsolatokra, és ez megölte az API-t ÉS a workert is:
//
//     throw er; // Unhandled 'error' event
//     error: terminating connection due to administrator command
//     Emitted 'error' event on BoundPool instance at:
//
// Mindkét konténer `RestartCount: 1`-gyel jött vissza.
//
// Az ok nem a Postgres. A `pg` készlete `error` eseményt bocsát ki, ha egy
// éppen NEM használt kapcsolaton történik baj. Az ilyen esemény nem tartozik
// egyetlen `await`-hez sem, tehát nincs, aki elkapja — és a Node
// `EventEmitter`-e figyelő nélkül kivételt dob, ami kilépteti a folyamatot.
//
// A `restart: unless-stopped` visszahozta a szolgáltatásokat, de addig minden
// futó kérés elhasalt — és minden TERVEZETT adatbázis-karbantartás így
// végződött volna.
//
// Ez a fájl nem azt méri, hogy „van figyelő". Azt méri, hogy a folyamat
// TÚLÉLI azt az eseményt, ami korábban megölte.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createPool } from '@yume/database'

describe('a kapcsolatkészlet túléli a kiszolgáló bontását', () => {
  /*
   * A készlet `error` eseménye pontosan az az alak, ami a hibát okozta.
   * Figyelő nélkül ez a sor kilőné a tesztfolyamatot; ha lefut utána bármi,
   * az maga a bizonyíték.
   */
  test('a tétlen kapcsolat hibája nem lépteti ki a folyamatot', () => {
    const pool = createPool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      max: 1,
      connectionTimeoutMillis: 100,
      statementTimeoutMillis: 1000
    })

    const serverTerminated = Object.assign(
      new Error('terminating connection due to administrator command'),
      { code: '57P01' })

    assert.doesNotThrow(() => { pool.emit('error', serverTerminated) },
      'a készlet hibaeseménye kivételt dobott — figyelő nélkül ez kilépteti a folyamatot')

    // És a folyamat tényleg tovább él: ez a sor csak akkor fut le.
    assert.equal(typeof pool.end, 'function')
    void pool.end().catch(() => {})
  })

  test('minden készletnek van hibafigyelője, nem csak az elsőnek', () => {
    for (let i = 0; i < 3; i++) {
      const pool = createPool({
        connectionString: 'postgres://nobody@127.0.0.1:1/none',
        max: 1,
        connectionTimeoutMillis: 100,
        statementTimeoutMillis: 1000
      })
      assert.ok(pool.listenerCount('error') > 0,
        `a ${i + 1}. készletre nem került hibafigyelő`)
      void pool.end().catch(() => {})
    }
  })
})
