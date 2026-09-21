// Fejléc, lábléc, mobil sáv — EGY forrásból.
//
// A BEJELENTETT TÜNET: „ha kikapcsolok egy oldalt a headerből, eltűnik onnan,
// de a footerben továbbra is megjelenik".
//
// A GYÖKÉROK: két, egymástól független navigációs forrás volt.
//
//   * a fejléc (`applyNavVisibility`) FUTÁSIDŐBEN szűrt a kapcsolótáblából,
//     és a mobil sáv ugyanazokat a `.sidebar-btn` elemeket használja, tehát
//     az együtt mozgott vele;
//   * a lábléc egy BEDRÓTOZOTT linklistát épített újra minden rendereléskor,
//     és a kapcsolótábláról nem tudott semmit.
//
// Ugyanaz a kérdés, két külön válasz. Innentől egy predikátum felel —
// `site-config.pageAvailable` —, és mindkét felület azt kérdezi.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'

import { install } from './support/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

let configure, pageAvailable, GATE_EXEMPT, App

before(async () => {
  install()
  ;({ configure, pageAvailable, GATE_EXEMPT } = await import('../src/shared/lib/site-config.js'))
  ;({ App } = await import('../src/app/router.js'))
})

const setup = ({ flags = {}, requireLogin = false, signedIn = true, perms = [] } = {}) => {
  mock.restoreAll()
  configure({
    config: { site: { name: 'Yume', requireLogin }, flags },
    permissions: perms,
    signedIn: () => signedIn
  })
}

beforeEach(() => setup())

describe('az oldal elérhetősége', () => {
  it('kapcsolósor nélkül jár — egy új oldal ne tűnjön el a régi telepítéseken', () => {
    assert.equal(pageAvailable('home'), true)
  })

  it('kikapcsolva nem jár', () => {
    setup({ flags: { 'page.community': { enabled: false } } })
    assert.equal(pageAvailable('community'), false)
    assert.equal(pageAvailable('home'), true, 'a többit nem viszi magával')
  })

  it('jogosultsághoz kötve csak annak, aki jogosult', () => {
    const flags = { 'page.w2g': { enabled: true, access: 'permission', permission: 'w2g.use' } }
    setup({ flags })
    assert.equal(pageAvailable('w2g'), false)
    setup({ flags, perms: ['w2g.use'] })
    assert.equal(pageAvailable('w2g'), true)
  })

  /*
   * Beállítás nélkül IGENT mondunk: egy még be nem töltött konfiguráció ne
   * ürítse ki a navigációt. Amit egy oldal tényleg kiszolgál, azt a kiszolgáló
   * dönti el — ez csak az ajánlat.
   */
  it('betöltetlen konfigurációval nem ürül ki a menü', () => {
    configure({ config: null, permissions: [], signedIn: () => false })
    assert.equal(pageAvailable('home'), true)
  })

  it('privát példányon a kijelentkezett látogatónak csak a mentes útvonalak', () => {
    setup({ requireLogin: true, signedIn: false })
    assert.equal(pageAvailable('home'), false)
    for (const route of GATE_EXEMPT) {
      assert.equal(pageAvailable(route), true, `${route} elzárva — így nincs út befelé`)
    }
  })
})

describe('a három navigációs felület', () => {
  const forras = nev => readFileSync(join(here, '..', 'src', nev), 'utf8')

  it('a fejléc a közös predikátumot kérdezi, nem saját szabályt', () => {
    const router = forras('app/router.js')
    const fn = router.slice(router.indexOf('applyNavVisibility ()'), router.indexOf('applyNavVisibility ()') + 900)
    assert.match(fn, /pageAvailable\(route\)/)
    assert.doesNotMatch(fn, /cfg\.flags\[/, 'megint maga olvassa a kapcsolótáblát')
    assert.doesNotMatch(fn, /requireLogin/, 'megint maga dönt a privát példányról')
  })

  it('a lábléc is azt kérdezi, és nincs bedrótozott listája', () => {
    const components = forras('shared/ui/components.js')
    const footer = components.slice(components.indexOf('  footer () {'), components.indexOf('  footer () {') + 4000)
    assert.match(footer, /pageAvailable\(route\)/)
    assert.doesNotMatch(footer, /col\(T\('footer\.discover'\), \[\[/,
      'visszakerült a bedrótozott linklista')
  })

  /*
   * A mentességi lista EGY példányban él. Két másolat pont azt a széttartást
   * adná, ami miatt ez a modul létezik.
   */
  it('a kapu mentességi listája nincs lemásolva', () => {
    assert.equal(App._gateExempt, GATE_EXEMPT, 'a router saját másolatot tart')
  })
})
