// Útvonal → stíluslapok: minden oldal azt töltse be, ami kell neki — se többet,
// se kevesebbet.
//
// 2026-09 óta a `style.css` csak a keret; a képernyők saját szabályai a
// `css/pages/`, a több képernyőn használt moduloké a `css/features/` alatt
// vannak, és a router (`ROUTE_STYLES`) tölti be őket az útvonallal együtt. Ez a
// teszt azt veti össze, amit egy útvonal moduljai TÉNYLEGESEN használnak, azzal,
// amit az útvonal betölt:
//
//   1. SE KEVESEBB. Egy osztály, amit az útvonal valamelyik modulja kiad, és
//      csak lusta lapban van szabálya, legyen olyan lapban, amit az útvonal
//      betölt (ROUTE_STYLES, vagy a modulok saját `loadStylesheet` hívása).
//      Mért hiba volt, amiből ez lett: a beállítások lejátszó-füle a
//      `player2.css` szabályait használja, a lap viszont csak a lejátszóoldalon
//      jött le — friss betöltés után a panel stílus nélkül állt.
//   2. SE TÖBB. Minden felsorolt lapból kell valami az útvonalnak.
//   3. A KERET NEM VISZ OLDALSZABÁLYT. A `style.css` egyetlen osztálya sem
//      lehet olyan, amit csak EGY útvonal moduljai használnak — annak a helye az
//      útvonal lapja, különben minden oldal letölti.
//
// Az osztályhasználat szövegkeresés (a megjegyzések nélkül), a dinamikus
// előtagokkal (`'kind-' + x`, `` `rel-${s}` ``) együtt — ugyanaz, amivel a
// lapokat szétválogattuk.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { classTokens } from './support/class-context.mjs'
import { dynamicImports, staticGraph } from './support/module-graph.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const WEB = join(here, '..')
const CSS_DIR = join(WEB, 'css')
const read = rel => readFileSync(join(WEB, rel), 'utf8')

// ---- a router táblái, a forrásból ----
const router = read('src/app/router.js')
const tableOf = name => router.slice(router.indexOf(`export const ${name} = {`), router.indexOf('\n}\n', router.indexOf(`export const ${name} = {`)))
const ROUTE_MODULES = Object.fromEntries([...tableOf('ROUTE_MODULES').matchAll(/^\s+([a-z0-9]+): \(\) => import\('\.\.\/([^']+)'\)/gm)]
  .map(m => [m[1], 'src/' + m[2]]))
const ROUTE_STYLES = Object.fromEntries([...tableOf('ROUTE_STYLES').matchAll(/^\s+([a-z0-9]+): \[([^\]]*)\]/gm)]
  .map(m => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])]))

// ---- ki tartozik hová ----
const SHELL = staticGraph('src/app/main.js')
SHELL.add('index.html')
const OWNERS = {}
/**
 * Egy útvonal minden modulja: a statikus gráf, és az útvonalon belüli
 * dinamikus importok gráfjai is (a lejátszóoldal a ténylegesen induló
 * lejátszót így tölti be) — azok is erre a képernyőre rajzolnak.
 */
const routeGraph = entry => {
  const files = staticGraph(entry, SHELL)
  for (let grew = true; grew;) {
    grew = false
    for (const target of dynamicImports(files)) {
      if (files.has(target) || SHELL.has(target) || Object.values(ROUTE_MODULES).includes(target)) continue
      for (const f of staticGraph(target, SHELL)) if (!files.has(f)) { files.add(f); grew = true }
    }
  }
  return files
}
for (const [route, entry] of Object.entries(ROUTE_MODULES)) OWNERS[route] = routeGraph(entry)
// A keret lusta funkciói (a router nem-útvonal dinamikus importjai): a saját
// lapjukat maguk töltik be.
for (const target of dynamicImports(SHELL)) {
  if (Object.values(ROUTE_MODULES).includes(target)) continue
  OWNERS['feature:' + target] = staticGraph(target, SHELL)
}

// ---- osztályhasználat ----
// A megjegyzések és a stíluslapnevek (`'features/comments.css'`) nem osztályok.
const stripComments = (file, text) => (file.endsWith('.js')
  ? text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\\w])\/\/[^\n]*/g, '$1')
  : text.replace(/<!--[\s\S]*?-->/g, ' ')).replace(/'[^'\n]*\.css'/g, "''")
const SOURCE = new Map()
const source = file => {
  if (!SOURCE.has(file)) SOURCE.set(file, stripComments(file, read(file)))
  return SOURCE.get(file)
}
const PREFIXES = new Map()
const prefixes = file => {
  if (!PREFIXES.has(file)) {
    const text = source(file)
    // Egy azonosító (`id = 'dash-' + …`) előtagja nem osztályé: kimarad.
    const notId = m => !/\bid\s*[:=]\s*[`'"]?$/.test(text.slice(Math.max(0, m.index - 12), m.index))
    PREFIXES.set(file, new Set([
      ...[...text.matchAll(/([a-z][\w-]*-)\$\{/g)].filter(notId).map(m => m[1]),
      ...[...text.matchAll(/([a-z][\w-]*-)['"]\s*\+/g)].filter(notId).map(m => m[1])
    ]))
  }
  return PREFIXES.get(file)
}
const TOKENS = new Map()
const tokens = file => {
  if (!TOKENS.has(file)) TOKENS.set(file, classTokens(source(file)))
  return TOKENS.get(file)
}
const uses = (file, cls) => {
  // A szótár szövegei („Delete comment?") nem osztálynevek.
  if (file.startsWith('src/shared/i18n/')) return false
  // Egyszavas osztálynév (`chat`, `franchise`, `on`): csak osztálykörnyezetben
  // számít — a puszta szóegyezés adatot is talál (`subject_type === 'comment'`).
  if (!cls.includes('-') && file.endsWith('.js')) return tokens(file).has(cls)
  if (new RegExp('(^|[^\\w-])' + cls.replace(/-/g, '\\-') + '($|[^\\w-])').test(source(file))) return true
  for (const p of prefixes(file)) if (cls.startsWith(p) && cls.length > p.length) return true
  return false
}
const usedBy = (files, cls) => [...files].some(f => uses(f, cls))

// ---- a lapok osztályai ----
const stripNot = sel => {
  let out = sel
  for (;;) {
    const i = out.indexOf(':not(')
    if (i < 0) return out
    let depth = 0; let j = i + 4
    for (; j < out.length; j++) {
      if (out[j] === '(') depth++
      else if (out[j] === ')' && --depth === 0) break
    }
    out = out.slice(0, i) + out.slice(j + 1)
  }
}
/** Egy lap szelektorai, mindegyik az osztályaival (a `:not(...)` tartalma nélkül). */
const selectorsOfSheet = css => {
  const out = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"[^"]*"|'[^']*'/g, '""')
  for (const m of text.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim()
    if (prelude.startsWith('@')) continue
    for (const sel of prelude.split(',')) {
      const classes = [...stripNot(sel).matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(c => c[1])
      if (classes.length) out.push({ sel: sel.trim(), classes })
    }
  }
  return out
}
const classesOfSheet = css => new Set(selectorsOfSheet(css).flatMap(s => s.classes))
const LAZY_SHEETS = readdirSync(CSS_DIR, { recursive: true }).map(String)
  .filter(f => f.endsWith('.css') && !['tokens.css', 'components.css', 'style.css', 'discord.css'].includes(f))
const SHEET_SELECTORS = Object.fromEntries(LAZY_SHEETS.map(f => [f, selectorsOfSheet(readFileSync(join(CSS_DIR, f), 'utf8'))]))
const SHEET_CLASSES = Object.fromEntries(LAZY_SHEETS.map(f => [f, new Set(SHEET_SELECTORS[f].flatMap(s => s.classes))]))
const EAGER_CLASSES = new Set([...classesOfSheet(read('css/components.css')), ...classesOfSheet(read('css/style.css'))])

/** Amit egy tulajdonos (útvonal vagy lusta funkció) betölt: a tábla + a modulok saját `loadStylesheet` hívásai. */
const loadedBy = owner => {
  // A nyers forrásból (csak a megjegyzések nélkül): a `source()` a lapneveket
  // már kiszűrte, azokat itt épp keressük.
  const raw = f => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\\w])\/\/[^\n]*/g, '$1')
  // A szó szerinti hívások, és egy olyan fájlban, ami `loadStylesheet`-et hív,
  // minden `…css` szöveg is (a profil a füleihez egy táblából választ).
  const own = [...OWNERS[owner]].flatMap(f => {
    const text = raw(f)
    if (!text.includes('loadStylesheet(')) return []
    return [...text.matchAll(/'([\w/-]+\.css)'/g)].map(m => m[1])
  })
  return new Set([...(ROUTE_STYLES[owner] ?? []), ...own])
}

describe('az útvonalak stíluslapjai', () => {
  it('a tábla minden útvonalat ismer, és minden lapja létezik', () => {
    assert.ok(Object.keys(ROUTE_MODULES).length >= 15, 'a ROUTE_MODULES táblát nem sikerült beolvasni')
    for (const [route, sheets] of Object.entries(ROUTE_STYLES)) {
      assert.ok(ROUTE_MODULES[route], `ROUTE_STYLES.${route}: nincs ilyen útvonal`)
      for (const sheet of sheets) assert.ok(existsSync(join(CSS_DIR, sheet)), `ROUTE_STYLES.${route}: ${sheet} nem létezik`)
    }
  })

  it('se kevesebb: amit egy képernyő használ, az be is töltődik vele', () => {
    // Szelektoronként: egy szabály akkor kell egy képernyőnek, ha MINDEN
    // osztálya előfordul nála (vagy a keretben), és legalább egy nála. Egy
    // állapotosztály (`.on`, `.current`) önmagában nem jelent semmit.
    const byKey = new Map()
    for (const sheet of LAZY_SHEETS) {
      for (const { classes } of SHEET_SELECTORS[sheet]) {
        const key = [...new Set(classes)].sort().join('.')
        if (!byKey.has(key)) byKey.set(key, { classes: [...new Set(classes)], sheets: new Set() })
        byKey.get(key).sheets.add(sheet)
      }
    }
    const missing = []
    for (const owner of Object.keys(OWNERS)) {
      const loaded = loadedBy(owner)
      for (const [key, { classes, sheets }] of byKey) {
        if (classes.every(c => EAGER_CLASSES.has(c))) continue
        const mine = classes.filter(c => usedBy(OWNERS[owner], c))
        if (!mine.length) continue
        if (!classes.every(c => mine.includes(c) || usedBy(SHELL, c))) continue
        if ([...sheets].some(f => loaded.has(f))) continue
        missing.push(`${owner}: .${key.replaceAll('.', '.')} — szabálya csak itt: ${[...sheets].join(', ')}`)
      }
    }
    assert.deepEqual(missing, [], 'ezek a képernyőn stílus nélkül jelennének meg')
  })

  it('se több: minden felsorolt lapból kell valami az útvonalnak', () => {
    const extra = []
    for (const [route, sheets] of Object.entries(ROUTE_STYLES)) {
      for (const sheet of sheets) {
        const classes = [...SHEET_CLASSES[sheet] ?? []].filter(c => !EAGER_CLASSES.has(c))
        if (!classes.some(c => usedBy(OWNERS[route], c))) extra.push(`${route}: ${sheet}`)
      }
    }
    assert.deepEqual(extra, [], 'ezeket a lapokat az útvonal letölti, de semmit nem használ belőlük')
  })

  it('a keret lapjában nincs egyetlen útvonal saját szabálya sem', () => {
    const shellClasses = classesOfSheet(read('css/style.css'))
    const own = []
    for (const cls of shellClasses) {
      if (usedBy(SHELL, cls)) continue
      const routes = Object.keys(OWNERS).filter(o => usedBy(OWNERS[o], cls))
      if (routes.length === 1) own.push(`.${cls} → ${routes[0]}`)
    }
    assert.deepEqual(own, [], 'ezek egyetlen képernyőé — a helyük a képernyő saját lapja')
  })

  it('a keret három lapja a lapban van, a többi nem', () => {
    const html = read('index.html')
    const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="[^"]*\/css\/([^"]+)"/g)].map(m => m[1])
    assert.deepEqual(linked.sort(), ['components.css', 'style.css', 'tokens.css'])
  })
})
