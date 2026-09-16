// Előellenőrzés: a tesztek nem futhatnak az éles adatbázison.
//
// Ez nem elméleti óvatosság. A suite-ok az éles adatbázison futottak, és
// három helyen látszott az ára: a 34 fiókból 30 tesztmaradék volt, a
// hibanapló 500-asai a tesztfutásokból származtak, és két `example.invalid`
// webhook maradt bent, ami hibacsoportot termelt.
//
// A `npm test` ezen a szkripten megy át. Ha a `DATABASE_URL` nem
// tesztadatbázisra mutat, a futás EL SEM INDUL — egy figyelmeztetés, amit el
// lehet görgetni, pontosan annyit ér, mint a mostani állapot.
//
// Kikapcsolható, de csak kimondva: `YUME_ALLOW_PROD_TESTS=1`. Aki ezt
// beírja, tudja, mit csinál; aki nem, azt nem éri váratlanul.

const url = process.env.DATABASE_URL

if (!url) {
  // Adatbázis nélkül a suite-ok maguktól kihagyják magukat. Ez érvényes
  // állapot (statikus tesztek így is futnak), nem hiba.
  process.exit(0)
}

if (process.env.YUME_ALLOW_PROD_TESTS === '1') {
  console.warn('[teszt] YUME_ALLOW_PROD_TESTS=1 — a futás az élesen is írhat.')
  process.exit(0)
}

let name
try {
  name = new URL(url).pathname.replace(/^\//, '')
} catch {
  console.error('[teszt] A DATABASE_URL nem értelmezhető.')
  process.exit(1)
}

/*
 * A kapcsolatkészlet mérete.
 *
 * A futtató fájlonként külön folyamatot indít, magonként egyet — négy magon
 * négy folyamat, mindegyik húszas készlettel, plusz az éles app és a worker:
 * 120 kapcsolat egy százas korlátra. A tünet nem „elfogytak a kapcsolatok"
 * volt, hanem egy 500-as a keresésen, tizenöt másodperc után — vagyis a
 * kapcsolatfelvétel ötmásodperces határideje háromszor.
 *
 * A package.json ezért `DB_POOL_MAX=5`-tel indít. Itt csak kimondjuk, ha
 * valaki felülírta, mert ez az a beállítás, aminek a hiánya órákkal később
 * egy véletlenszerű 500-ban jelenik meg.
 */
const pool = Number(process.env.DB_POOL_MAX ?? 20)
if (pool > 8) {
  console.warn(`[teszt] DB_POOL_MAX=${pool}: párhuzamos futásnál ez kimeríti a Postgres kapcsolatait.`)
}

if (!name.endsWith('_test')) {
  console.error(`
[teszt] MEGÁLL: a DATABASE_URL a(z) "${name}" adatbázisra mutat.

  A tesztek fiókokat hoznak létre, hibákat naplóznak és webhookokat írnak.
  Az éles adatbázisban ez olyan szemét, amit utána takarítani kell — és a
  takarítás az a lépés, ami egyszer elmarad. A 34 fiókból 30 így lett
  tesztmaradék.

  Tesztadatbázis egy paranccsal:
      scripts/database/test-db.sh
      export DATABASE_URL='postgres://yume:***@127.0.0.1:15432/yume_test'

  Ha tényleg az élesen akarsz futtatni, mondd ki:
      YUME_ALLOW_PROD_TESTS=1 npm test
`)
  process.exit(1)
}
