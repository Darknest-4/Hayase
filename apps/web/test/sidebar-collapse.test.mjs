// Az oldalsáv összecsukott állapota — egy igazság, két kapcsoló.
//
// AMI VOLT: a router közvetlenül egy `yume-nav-collapsed` nevű
// `localStorage` kulcsba írt. Három ára volt:
//
//   * a beállítások lapról nem lehetett állítani;
//   * nem volt PROFILONKÉNTI — egy gépen több profil ugyanazt az értéket
//     látta, pedig a többi megjelenési beállítás profilhoz kötött;
//   * az „Adatok mentése" sem vitte magával, tehát egy másik eszközre
//     átvitt profil elfelejtette.
//
// Innentől a profil beállításai közt él, és a sávon lévő nyíl meg a
// beállítások lap UGYANODA ír.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { install, storage as fakeStorage } from './support/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let Store

before(async () => {
  install()
  ;({ Store } = await import('../src/shared/state/store.js'))
})

beforeEach(() => { fakeStorage.clear?.() })

describe('az oldalsáv állapota', () => {
  it('alapból nyitva van', () => {
    assert.equal(Store.settings().navCollapsed, false)
  })

  it('a profil beállításai közt él, tehát mentésbe és profilba is belefér', () => {
    Store.saveSettings({ navCollapsed: true })
    assert.equal(Store.settings().navCollapsed, true)
    // Ugyanaz a doboz, mint a többi megjelenési beállításé — az exportot ez
    // viszi magával.
    assert.equal(Store.settings().titleLang, 'userPreferred')
  })

  it('a többi beállítást nem viszi magával', () => {
    Store.saveSettings({ nsfw: true })
    Store.saveSettings({ navCollapsed: true })
    assert.equal(Store.settings().nsfw, true)
  })
})

describe('a két kapcsoló', () => {
  const forras = nev => readFileSync(join(here, '..', 'src', nev), 'utf8')

  it('a sávon lévő nyíl a beállításba ír, nem saját kulcsba', () => {
    const router = forras('app/router.js')
    const fn = router.slice(router.indexOf('initNavCollapse () {'), router.indexOf('applyNavCollapsed () {'))
    assert.match(fn, /Store\.saveSettings\(\{ navCollapsed/)
    assert.doesNotMatch(fn, /setItem\('yume-nav-collapsed'/,
      'megint saját localStorage kulcsba ír')
  })

  /*
   * Aki már összecsukta a sávot, annak a választása a régi kulcsban ül.
   * Enélkül az első betöltésnél visszaugrana nyitottra — egy csendes
   * „elfelejtettük, amit beállítottál".
   */
  it('a régi kulcsról egyszer átköltöztet', () => {
    const router = forras('app/router.js')
    assert.match(router, /getItem\('yume-nav-collapsed'\)/)
    assert.match(router, /removeItem\('yume-nav-collapsed'\)/)
  })

  it('a beállítások lap a shellt kéri meg, nem a DOM-ot igazgatja', () => {
    const settings = forras('pages/settings.js')
    assert.match(settings, /Store\.saveSettings\(\{ navCollapsed/)
    assert.match(settings, /applyNavCollapsed\(\)/)
    assert.doesNotMatch(settings, /classList\.toggle\('nav-collapsed'/,
      'a beállítások lap maga nyúl a sávhoz — a nyíl felirata széttartana')
  })

  it('az érvényesítés egy helyen van', () => {
    const router = forras('app/router.js')
    const hits = (router.match(/classList\.toggle\('nav-collapsed'/g) ?? []).length
    assert.equal(hits, 1, `${hits} helyen állítja az osztályt — egy elég`)
  })
})
