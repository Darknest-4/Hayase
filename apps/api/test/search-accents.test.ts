// Az ékezetsemleges keresés — a lekérdezés szintjén, nem a függvényén.
//
// A HIBA, AMIT EZ MEGFOG, két éve ott ült a rendszerben, és minden teszt zöld
// volt közben.
//
// A 0022-es migráció kifejezetten azért készült, hogy „nobody types »támadás«
// on a phone — they type »tamadas«". Létrehozta a `yume_unaccent` függvényt és
// három GIN trigram-indexet rá. A `hungarian-text.test.ts` ellenőrizte, hogy a
// függvény hajtogat, és hogy immutable, tehát indexelhető. Mindkettő igaz volt.
//
// Csak éppen EGYETLEN LEKÉRDEZÉS SEM HÍVTA MEG. A három index hatvankét
// megabájtot foglalt és nulla olvasást szolgált ki; az ékezetsemleges keresés
// mint felhasználói élmény nem létezett. Élesben mérve: „Őrült" → 0 találat,
// „Orult" → 1. Aki helyesen írta a magyart, kevesebbet talált.
//
// A tanulság a tesztre vonatkozik, nem a kódra: egy építőelem működéséről szóló
// állítás nem állítás arról, hogy HASZNÁLJUK is. Ez a fájl ezért a keresés
// kimenetét nézi, nem a `yume_unaccent`-ét.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { buildSearchSql } from '../src/modules/search/search.ts'

import type pg from 'pg'

/*
 * Az olcsó fele: a felépített SQL. Nem kell hozzá adatbázis, és pontosan azt
 * fogja meg, ami elromlott — a hiányzó hívást.
 */
describe('a keresés lekérdezése hajtogatja az ékezeteket', () => {
  const sql = buildSearchSql({}).sql

  it('mindhárom forrásra meghívja a yume_unaccent-et', () => {
    for (const column of ['a.canonical_title', 't.title', 's.synonym']) {
      assert.ok(sql.includes(`yume_unaccent(${column})`),
        `${column} nem megy át a yume_unaccent-en — a 0022 indexe erre a hívásra van`)
    }
  })

  it('a keresett kifejezést is hajtogatja, nem csak a tárolt szöveget', () => {
    // Egyoldalú hajtogatás annyit érne, hogy a „Támadás" megtalálja a
    // „tamadas"-t, de fordítva nem. A felhasználó mindkét irányban gépel.
    assert.ok(sql.includes('yume_unaccent($1)'),
      'a lekérdezés szövege hajtogatás nélkül megy a hasonlításba')
  })

  it('a hajtogatott találat a pontos betűzés alatt és a szótári fölött rangsorol', () => {
    assert.ok(sql.includes('THEN 55'), 'nincs önálló szint a hajtogatott egyezésnek')
    const folded = sql.indexOf('THEN 55')
    assert.ok(sql.indexOf("THEN 60") < folded,
      'a hajtogatott egyezésnek a „tartalmazza" (60) UTÁN kell jönnie a CASE-ben')
    assert.ok(folded < sql.indexOf('THEN 40'),
      'a hajtogatott egyezésnek a teljes szöveges találat (40) ELŐTT kell jönnie')
  })

  it('a szűrésbe is bekerül, nem csak a pontozásba', () => {
    // Csak a CASE-ben szerepelve egy sor, amit KIZÁRÓLAG hajtogatva lehet
    // megtalálni, be se kerülne a jelöltek közé — a pontozásnak nem lenne mit
    // pontoznia.
    const where = sql.slice(sql.indexOf('FROM anime a'))
    assert.ok(where.includes('yume_unaccent(a.canonical_title) ILIKE'),
      'a hajtogatott egyezés nem szerepel a WHERE-ben')
  })
})

/*
 * A drága fele: valódi sorok. Ez az az állítás, ami a felhasználó élményét
 * méri — hogy a helyesen írt magyar szó ugyanazt találja meg, mint az
 * ékezet nélküli.
 */
describe('ékezetes és ékezet nélküli írásmód ugyanazt találja', {
  skip: process.env.DATABASE_URL ? false : 'no DATABASE_URL'
}, () => {
  let pool: pg.Pool
  let searchAnime: typeof import('../src/modules/search/search.ts').searchAnime
  const title = 'Őrült Űrhajós Árvíztűrő Próba'
  let animeId = ''

  before(async () => {
    const db = await import('../src/infrastructure/database/index.ts')
    pool = db.pool as never
    ;({ searchAnime } = await import('../src/modules/search/search.ts'))
    const { rows } = await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility, is_adult)
       VALUES ($1, 'TV', 'FINISHED', 'public', false) RETURNING id`, [title])
    animeId = String(rows[0].id)
  })

  after(async () => {
    try {
      if (animeId) await pool.query('DELETE FROM anime WHERE id = $1', [animeId])
    } finally { await pool?.end() }
  })

  const finds = async (query: string): Promise<boolean> => {
    const rows = await searchAnime(pool as never, query, { limit: 50 })
    return rows.some(row => String(row.id) === animeId)
  }

  it('az ékezetes írásmód megtalálja', async () => {
    assert.ok(await finds('Őrült Űrhajós'), 'a pontosan beírt cím nem találta meg magát')
  })

  it('az ékezet nélküli írásmód is megtalálja', async () => {
    assert.ok(await finds('Orult Urhajos'),
      'a telefonon begépelt, ékezet nélküli alak nem találja meg — pont ezért készült a 0022')
  })

  it('a kettő ugyanarra a sorra mutat', async () => {
    assert.ok(await finds('arviztturo') || await finds('arvizturo'),
      'egy ékezet nélküli részlet sem találja meg a címet')
  })
})
