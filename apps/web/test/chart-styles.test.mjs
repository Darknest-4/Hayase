// A diagramok stílushorgai — mind meg is van-e fogva.
//
// A BEJELENTETT TÜNET: az adminpanel áttekintésén a dátumfeliratok nagynak és
// zsúfoltnak látszottak, mintha ráfutnának a görbére, és a diagramokon nem
// volt rácsvonal.
//
// A GYÖKÉROK nem a diagram kódjában volt: a `charts.js` kiadja a `chart-grid`
// és `chart-axis` osztályokat, de a `9d8b2f93` („admin: one design system for
// the panel, instead of nineteen") KITÖRÖLTE mindkét szabályt a CSS-ből, és
// nem tett a helyükre semmit. Ettől
//
//   `chart-grid`  az SVG alapértelmezett `stroke`-ja `none` → a rácsvonalak
//                 egyszerűen nem látszottak;
//   `chart-axis`  szabály híján a böngésző 16 képpontos alapértelmezésén
//                 rajzolt a ~11 helyett.
//
// Semmi nem hasalt el tőle: az SVG egy ismeretlen osztályra nem szól, csak
// máshogy rajzol. Pont ezért kell erre teszt — ez a fajta hiba csendben él
// meg hónapokig.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const forras = readFileSync(join(here, '../src/shared/ui/charts.js'), 'utf8')

/** Minden CSS, amit a lap betölt. */
const css = ['tokens.css', 'components.css', 'style.css', 'admin.css', 'maintenance.css', 'player2.css']
  .map(f => readFileSync(join(here, '../css/', f), 'utf8'))
  .join('\n')

/**
 * A `charts.js`-ben kiadott osztálynevek.
 *
 * Kétféleképpen kerülnek ki: `class: 'x'` az attribútumobjektumban, és
 * `setAttribute('class', 'x')` utólag. Mindkettőt nézzük, különben a teszt
 * csak a felét méri — és az a rosszabbik eset, mert zöld marad.
 */
function osztalyok () {
  const ki = new Set()
  for (const m of forras.matchAll(/class:\s*'([^']+)'/g)) for (const c of m[1].split(/\s+/)) ki.add(c)
  for (const m of forras.matchAll(/setAttribute\('class',\s*'([^']+)'\)/g)) for (const c of m[1].split(/\s+/)) ki.add(c)
  return [...ki]
}

/*
 * MEGNEVEZŐ OSZTÁLYOK — nem stílushorgok, ezért nem kell rájuk szabály.
 *
 * A kivétel NEM üres lista és nem is „mindent átengedünk": mindegyikhez itt
 * áll, MIÉRT nincs szabálya. Ez a különbség a szándékos kivétel és az
 * elfelejtett szabály között — az utóbbi volt az eredeti hiba.
 */
const MEGNEVEZO = {
  'chart-axis-x': 'az x-tengely feliratait nevezi meg; a stílust a közös `chart-axis` adja',
  'chart-axis-y': 'ugyanez az y-tengelyre — a tesztek erről ismerik fel, melyik tengely melyik'
}

describe('a diagramok stílusai', () => {
  it('a teszt tényleg talál osztályokat', () => {
    // Egy elrontott minta üres halmazon mindent átengedne.
    const lista = osztalyok()
    assert.ok(lista.length >= 4, `csak ${lista.length} osztályt találtam: ${lista.join(', ')}`)
    assert.ok(lista.includes('chart'), 'a gyökérosztály hiányzik a listából')
  })

  it('minden kiadott osztálynak van CSS-szabálya', () => {
    const arva = osztalyok()
      .filter(c => !(c in MEGNEVEZO))
      .filter(c => !new RegExp('\\.' + c + '\\b').test(css))
    assert.deepEqual(arva, [],
      'a `charts.js` kiad ilyen osztályt, de semmi nem stílusozza — ' +
      'az SVG erre nem szól, csak máshogy rajzol')
  })

  /*
   * A kivétellista sem avulhat el csendben: ha egy megnevező osztály kikerül
   * a kódból, a listából is ki kell venni, különben legközelebb egy elfelejtett
   * szabályt takar el.
   */
  it('a kivétellistán csak olyan van, amit a kód tényleg kiad', () => {
    const kiadott = new Set(osztalyok())
    const felesleges = Object.keys(MEGNEVEZO).filter(c => !kiadott.has(c))
    assert.deepEqual(felesleges, [], 'a kivétellista elavult bejegyzéseket tartalmaz')
  })

  /*
   * A rácsvonalnak KÜLÖN kell stroke, mert az SVG alapértelmezése `none`.
   * Egy `fill`-t megadó szabály itt nem ér semmit, és ránézésre helyesnek
   * látszik — ezért van rá saját állítás.
   */
  it('a rácsvonalnak van vonalszíne, nem csak szabálya', () => {
    const blokk = css.match(/\.chart-grid\s*\{[^}]*\}/)
    assert.ok(blokk, 'nincs .chart-grid szabály')
    assert.match(blokk[0], /stroke\s*:/,
      'a rácsvonal szabálya nem ad `stroke`-ot — az SVG alapértelmezése `none`, tehát nem látszik')
  })

  it('a tengelyfeliratnak van betűmérete és színe', () => {
    const blokk = css.match(/\.chart-axis\s*\{[^}]*\}/)
    assert.ok(blokk, 'nincs .chart-axis szabály')
    assert.match(blokk[0], /font-size\s*:/, 'méret nélkül a böngésző 16 képpontot rajzol')
    assert.match(blokk[0], /fill\s*:/, 'az SVG szöveget a `fill` színezi, nem a `color`')
  })
})
