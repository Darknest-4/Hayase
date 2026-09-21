// Karbantartás — hibahelyzetek (8. és 32. pont).
//
// A kérdés nem az, hogy működik-e, amikor minden rendben. Az a kérdés, hogy
// MI TÖRTÉNIK, amikor nem:
//
//   * az adatbázis eltűnik;
//   * az értesítés elveszik;
//   * a folyamat újraindul, hideg gyorsítótárral;
//   * több kérés egyszerre veszi észre, hogy lejárt a gyorsítótár.
//
// Mindegyikre DETERMINISZTIKUS válasz kell, és a szabályt ki is kell mondani:
// két rossz kimenetel között választunk, nem egy jó és egy rossz között.

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

process.env.JWT_SECRET ??= 'test-secret-for-unit-tests-only'

const repository = await import('../src/modules/maintenance/repository.ts')
const cache = await import('../src/modules/maintenance/cache.ts')
const { MODE, SCOPE } = await import('../src/modules/maintenance/state.ts')
const { decide, offConfig } = await import('../src/modules/maintenance/policy.ts')

const config = (over: Record<string, unknown> = {}) => ({
  ...offConfig(), enabled: true, mode: MODE.ACTIVE, scope: SCOPE.GLOBAL, version: 5, ...over
})

afterEach(() => {
  cache.setLoader(null)
  cache.reset()
})

describe('hidegindítás', () => {
  it('amíg nem tudunk semmit, NYITVA vagyunk', () => {
    // Egy friss folyamat első kérése nem várhat egy adatbázis-lekérdezésre, és
    // nem is zárhatja le az oldalt amiatt, hogy még nem olvasott.
    cache.setLoader(() => new Promise(() => {}))
    const current = cache.config()
    assert.equal(current.enabled, false)
    assert.equal(current.mode, MODE.OFF)
  })

  it('a beolvasás után már a valódi állapot megy', async () => {
    cache.setLoader(async () => config())
    const loaded = await cache.configNow()
    assert.equal(loaded.mode, MODE.ACTIVE)
    assert.equal(cache.config().mode, MODE.ACTIVE)
  })
})

describe('az adatbázis eltűnik', () => {
  it('ISMERT ÁLLAPOT NÉLKÜL nyitva maradunk', async () => {
    /*
     * A két rossz kimenetel közül ez a kevésbé rossz.
     *
     * Egy rövid kapcsolathiba miatt mindenkit karbantartási oldalra küldeni
     * sokkal gyakoribb és sokkal látványosabb hiba, mint az ellenkezője — és
     * egy olyan rendszerben, ahol a karbantartás alapállapota a KIKAPCSOLT,
     * a „nem tudom" leginkább a kikapcsoltra hasonlít.
     */
    cache.setLoader(async () => { throw new Error('ECONNREFUSED') })
    const current = await cache.configNow()
    assert.equal(current.enabled, false)
    assert.equal(current.mode, MODE.OFF)
  })

  it('ISMERT ÁLLAPOTTAL azt tartjuk — a vészhelyzet nem oldódik fel magától', async () => {
    /*
     * Ez a szabály másik fele, és ez a fontosabbik.
     *
     * Ha egy vészlezárás feloldódna attól, hogy az adatbázis elérhetetlen
     * lett, akkor a lezárás pont a legrosszabb pillanatban szűnne meg — egy
     * incidens közben, amikor az adatbázissal is baj lehet.
     */
    cache.setLoader(async () => config({ mode: MODE.EMERGENCY }))
    assert.equal((await cache.configNow()).mode, MODE.EMERGENCY)

    cache.setLoader(async () => { throw new Error('a kapcsolat megszakadt') })
    cache.invalidate()
    const afterFailure = await cache.configNow()
    assert.equal(afterFailure.mode, MODE.EMERGENCY, 'a hiba feloldotta a vészhelyzetet')
    assert.equal(afterFailure.version, 5)
  })

  it('a hiba látszik a diagnosztikában', async () => {
    cache.setLoader(async () => { throw new Error('a kapcsolat megszakadt') })
    await cache.configNow()
    assert.match(String(cache.stats().lastError), /megszakadt/)
  })

  it('a helyreállás után újra a friss állapot megy', async () => {
    cache.setLoader(async () => { throw new Error('ECONNREFUSED') })
    await cache.configNow()

    cache.setLoader(async () => config({ mode: MODE.READ_ONLY, version: 9 }))
    cache.invalidate()
    const recovered = await cache.configNow()
    assert.equal(recovered.mode, MODE.READ_ONLY)
    assert.equal(cache.stats().lastError, null, 'a régi hiba beragadt')
  })
})

describe('az értesítés elveszik', () => {
  it('a lejárati idő így is helyreállít', async () => {
    /*
     * Az értesítés az ELSŐDLEGES út, de nem az egyetlen. Ha egy `NOTIFY`
     * elveszik — bontott kapcsolat, épp újracsatlakozó hallgató —, a
     * lejárati idő akkor is behozza a változást.
     */
    let version = 1
    cache.setLoader(async () => config({ version, mode: MODE.OFF, enabled: false }))
    assert.equal((await cache.configNow()).version, 1)

    // A háttérben megváltozik, de ÉRTESÍTÉS NEM ÉRKEZIK.
    version = 2

    // A gyorsítótár még a régit tartja — ez így helyes, ez a gyorsítótár
    // lényege.
    assert.equal(cache.config().version, 1)

    // A lejárati idő letelte után viszont újra beolvas.
    cache.invalidate()
    assert.equal((await cache.configNow()).version, 2)
  })

  it('a lejárati idő elég rövid ahhoz, hogy ne legyen baj belőle', () => {
    // Fél perc késés egy karbantartás bekapcsolásánál elfogadható: a
    // bekapcsoló példány azonnal tudja, a többi legfeljebb ennyivel később.
    assert.ok(cache.TTL_MS <= 60_000, `a lejárati idő ${cache.TTL_MS} ms — túl hosszú`)
    assert.ok(cache.TTL_MS >= 5_000, `a lejárati idő ${cache.TTL_MS} ms — túl sűrűn kérdezne`)
  })
})

describe('egyszerre sok kérés', () => {
  it('lejárt gyorsítótárnál is EGY lekérdezés megy ki', async () => {
    // Enélkül egy hideg gyorsítótár egy forgalmas pillanatban
    // lekérdezés-özönt indítana — pont akkor, amikor az adatbázisnak a
    // legkevésbé van rá kapacitása.
    let calls = 0
    cache.setLoader(async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return config()
    })

    await Promise.all(Array.from({ length: 25 }, () => cache.configNow()))
    assert.equal(calls, 1, `${calls} lekérdezés ment ki egy helyett`)
  })

  it('a gyakori út nem vár lekérdezésre', async () => {
    cache.setLoader(async () => config())
    await cache.configNow()

    // A `config()` SZINKRON: a kérési úton nincs `await`, tehát nincs mire
    // várni. Ez a 7. és 29. pont lényege.
    const before = process.hrtime.bigint()
    for (let i = 0; i < 10_000; i++) cache.config()
    const perCall = Number(process.hrtime.bigint() - before) / 10_000
    assert.ok(perCall < 5_000, `hívásonként ${Math.round(perCall)} ns — túl drága a kérési úton`)
  })
})

describe('a döntés hibás adatból is determinisztikus', () => {
  it('az elrontott sorból biztonságos beállítás lesz', () => {
    const broken = repository.fromRow({
      version: 'nem-szám', mode: 'KITALÁLT', scope: 'nincs-ilyen', enabled: true,
      starts_at: null, ends_at: null, estimated_end_at: null, timezone: null,
      title: null, public_message: null, allow_existing_sessions: false, drain_seconds: Number.NaN
    } as never)
    assert.ok(broken)
    // Ismeretlen mód → OFF: egy elgépelt érték ne zárja le az oldalt.
    assert.equal(broken.mode, MODE.OFF)
    // Ismeretlen hatókör → global: egy elgépelt hatókör ne nyisson ki
    // véletlenül olyasmit, amit le akartak zárni.
    assert.equal(broken.scope, SCOPE.GLOBAL)
    assert.equal(broken.drainSeconds, 0)
    assert.equal(broken.version, 0)
  })

  it('üres sorból nincs beállítás, nem hamis beállítás', () => {
    assert.equal(repository.fromRow(null), null)
    assert.equal(repository.fromRow(undefined), null)
  })

  it('ugyanaz a bemenet ugyanazt a döntést adja', () => {
    // Determinizmus: a 32. pont zárómondata. Ugyanaz az állapot, ugyanaz az
    // idő, ugyanaz a kérés — ugyanaz a válasz, akárhányszor.
    const now = new Date('2026-09-20T03:00:00Z')
    const facts = { url: '/v1/anime', method: 'GET' }
    const first = decide(config(), now, facts)
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(decide(config(), now, facts), first)
    }
  })
})
