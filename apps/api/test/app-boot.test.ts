// A bootolás sorrendje — egy néma beragadás ellen.
//
// MI TÖRTÉNT. Egy induláskori ellenőrzés `app.ready(callback)`-kel került be a
// `buildApp`-be. Ez a hívás nem csak feliratkozik a bootra: EL IS INDÍTJA. A
// visszaadott példány ettől már bootolás közben volt, és aki utána
// regisztrált egy útvonalat, majd `await app.ready()`-t hívott, az örökre
// megállt — nem hibaüzenettel, hanem némán.
//
// MIÉRT NEM VETTE ÉSZRE SENKI. A `cloudflare-chain.test.ts` pontosan ezt
// csinálja, tehát elhasalt — csak épp BERAGADT ahelyett, hogy megbukott
// volna. A tesztfuttató erre a fájlra várt, és onnantól az EGÉSZ API-suite
// nem jutott a végére. Egy piros teszt látszik; egy beragadt nem.
//
// EZ A FÁJL ezért időkorláttal méri ugyanazt: ha a `ready` nem jön meg
// másodpercek alatt, az bukás, nem várakozás.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'app-boot-secret-long-enough-0123456789'

/** Ennyit várunk a bootra. A mért idő ~1 másodperc; a tízszerese bőven elég. */
const READY_TIMEOUT_MS = 10_000

/*
 * A STATIKUS ŐR — ez a fontosabbik.
 *
 * A futásidejű teszt alatta megbukik, ha a hiba visszajön, de csak tíz
 * másodperc után, és a félig bootolt példány miatt a folyamat még utána sem
 * feltétlenül lép ki. Ez a vizsgálat viszont AZONNAL válaszol, és pontosan
 * megmondja, mit kell javítani — egy néma beragadás ellen ez a különbség
 * számít.
 */
describe('a boot indítása', () => {
  test('a buildApp nem indítja el magától a bootot', async () => {
    const path = fileURLToPath(new URL('../src/app.ts', import.meta.url))
    const source = await readFile(path, 'utf8')

    /*
     * A KOMMENTEKET KI KELL VENNI, mert a szabályt a kód mellett le is írjuk —
     * és az első változat a SAJÁT MAGYARÁZÓ KOMMENTJÉRE bukott meg. Egy őr,
     * ami arra pirosodik, hogy leírtuk, mit ne csináljunk, használhatatlan.
     *
     * Ez nem elemző, csak kommentirtó: egy sztringben álló `//` elé is
     * beleharaphat. Itt ez nem baj — a legrosszabb eset egy ELNÉZETT hívás,
     * nem egy kitalált.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

    // Csak a `ready` HÍVÁSA számít, ARGUMENTUMMAL. A `await app.ready()`
    // argumentum nélkül ártalmatlan — az csak megvárja a bootot.
    const hits = [...code.matchAll(/\bapp\.ready\s*\(\s*[^)\s]/g)]
    assert.equal(hits.length, 0,
      'az app.ts `app.ready(callback)`-et hív. Ez ELINDÍTJA a bootot, és ' +
      'ettől a buildApp() után regisztrált útvonal örökre megállítja az ' +
      'app.ready()-t. Használj `app.addHook(\'onReady\', …)`-t helyette.')
  })
})

/**
 * Egy időzítő, ami NEM tartja életben a folyamatot.
 *
 * Minden várakozás körül ott van, mert egy félig bootolt Fastify-példánynál a
 * LEZÁRÁS is megállhat — és egy takarításban beragadt teszt ugyanolyan néma,
 * mint amit meg akar fogni.
 */
const varakozas = (ms: number): Promise<void> => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

describe('a bootolás', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  test('a buildApp UTÁN is lehet útvonalat regisztrálni', { timeout: 20_000 }, async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    const app = await buildApp()
    try {
      // Pontosan az a minta, ami beragadt: útvonal a `buildApp` után, a
      // `ready` előtt. Egy teszt, ami így akar bemérni valamit — például azt,
      // kinek hiszi az app a hívót —, nem tehet mást.
      app.get('/__boot-proba', async () => ({ ok: true }))

      let elkeszult = false
      const ready = app.ready().then(() => { elkeszult = true })
      await Promise.race([ready, varakozas(READY_TIMEOUT_MS)])

      assert.ok(elkeszult,
        `az app.ready() ${READY_TIMEOUT_MS} ms alatt sem jött meg — a boot ` +
        'valószínűleg már elindult a buildApp-en belül (app.ready(callback) ' +
        'helyett onReady hook kell)')

      const res = await app.inject({ url: '/__boot-proba' })
      assert.equal(res.statusCode, 200)
    } finally {
      // A LEZÁRÁS IS IDŐKORLÁTOS. Egy félig bootolt példány `close`-a ugyanúgy
      // megállhat, mint a `ready`-je, és akkor a teszt nem megbukna, hanem
      // beragadna — vagyis pont az történne, ami ellen íródott.
      await Promise.race([app.close().catch(() => {}), varakozas(5000)])
      await Promise.race([db.pool.end().catch(() => {}), varakozas(5000)])
    }
  })
})
