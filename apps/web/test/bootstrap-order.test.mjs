// A KRITIKUS BOOTSTRAP SORRENDJE.
//
// A BEJELENTETT TÜNET: kijelentkezve a `#/home`-ra érkezve a látogató a
// kezdőképernyőt kapja — de közben a kezdőlap már lefutott, és elindított
// tizenegy `/v1/anime/` lekérdezést, mind a tizenegy 401-gyel jött vissza.
// Éles mérés, konzolban és hálózati naplóban is látszott.
//
// A GYÖKÉROK: a `_gateCheck` egyetlen ággal kezelte a „még nincs meg a
// konfiguráció" és a „nem érhető el a háttér" állapotot —
//
//     if (!cfg) return privileged ? { ok: false, ... } : { ok: true }
//
// —, és mindkettőre átengedett. A második szándék volt: egy elérhetetlen
// háttértől ne álljon meg az egész oldal. Az elsőt viszont MINDEN indulás
// eltalálja, mert az `init()` több olyat is elindít, ami navigálni akar,
// mielőtt a `loadConfig()` visszatérne — a karbantartás-figyelő első válasza,
// egy nyelvváltás, egy `hashchange`.
//
// Az eredmény dupla renderelés volt: egyszer kapu nélkül, egyszer a kapuval.
//
// AMIT EZ A KÉSZLET ŐRIZ. Nem a tüneteket — azok éles mérésben látszanak —,
// hanem a szabályt: amíg a kritikus bootstrap tart, útvonal nem oldódik fel.
//
// MIÉRT KELLETT KÜLÖN TESZT. A `navigate()`-et a webes készletből EGYETLEN
// teszt sem hívta meg, tehát a 655 zöld teszt erről a viselkedésről semmit
// nem mondott. Amíg ez a fájl nem volt meg, a változás bizonyítatlan volt.

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { install } from './support/browser.mjs'

let App, configure, YumeAPI
let doc, restore

before(async () => {
  install()
  ;({ configure } = await import('../src/shared/lib/site-config.js'))
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
  ;({ App } = await import('../src/app/router.js'))
})

beforeEach(() => {
  mock.restoreAll()
  doc = createDocument()
  restore?.()
  restore = withDocument(doc)
  /*
   * A `navigate()` több elemet is megkeres az azonosítója alapján (a lapot, a
   * szalagot, a W2G ablakot). A csonk mindegyiknek ad egyet, és ugyanazt adja
   * vissza minden hívásra — különben a teszt nem a bootstrapet mérné, hanem
   * azt, hogy hány elemet felejtettem ki.
   */
  const elemek = new Map()
  doc.getElementById = id => {
    if (!elemek.has(id)) {
      const el = doc.createElement('div')
      el.setAttribute('id', id)
      doc.body.append(el)
      elemek.set(id, el)
    }
    return elemek.get(id)
  }
  doc.getElementById('page')
  configure({ config: { site: { name: 'Yume' }, flags: {} }, permissions: [], signedIn: () => false })
  // Cím NÉLKÜL a gyökér a kezdőképernyőre megy, nem a `home`-ra — a mérés
  // különben egy másik útvonalat figyelne, mint amit hisz magáról.
  globalThis.window.location.hash = '#/home'
  App._boot = 'pending'
  App.config = null
})

const oldal = () => doc.getElementById('page')

describe('a kritikus bootstrap előbb van, mint az első útvonal', () => {
  it('amíg a konfiguráció úton van, a navigáció nem rajzol', async () => {
    let hivtak = false
    App.routes.home = () => { hivtak = true }

    await App.navigate()

    assert.equal(hivtak, false,
      'a kezdőlap lefutott, mielőtt a kapu dönthetett volna — pontosan ez indította a tizenegy 401-et')
    assert.equal(oldal().children.length, 0, 'félkész oldal került a képre')
  })

  it('a bootstrap után viszont rajzol', async () => {
    let hivtak = false
    App.routes.home = () => { hivtak = true }
    App._boot = 'ready'
    App.config = { site: { name: 'Yume', requireLogin: false }, flags: {} }

    await App.navigate()

    assert.equal(hivtak, true, 'a kész bootstrap után nem rajzolt')
  })

  /*
   * A NEM ELÉRHETŐ HÁTTÉR NEM UGYANAZ, MINT A MÉG BE NEM TÖLTÖTT.
   *
   * A régi viselkedés szándéka helyes volt: ha a háttér elhasal, a lap
   * maradjon használható. Ez az ág megmarad — csak már nem ugyanaz, mint az
   * indulás.
   */
  it('ha a konfiguráció NEM tölthető be, a lap attól még működik', async () => {
    let hivtak = false
    App.routes.home = () => { hivtak = true }
    App._boot = 'failed'
    App.config = null

    await App.navigate()

    assert.equal(hivtak, true, 'egy elérhetetlen háttér megbénította az egész lapot')
  })

  /*
   * A `loadConfig` ELKAPJA a hibát. Eddig kidobta az `init()` egészét, tehát
   * a záró `navigate()` sosem futott le — a lapot csak az menthette meg, hogy
   * egy korábbi, kapu nélküli navigáció már rajzolt valamit. A védelem a
   * véletlenen múlt.
   */
  it('egy elhasalt konfiguráció-kérés nem viszi magával az indulást', async () => {
    mock.method(YumeAPI, 'config', () => Promise.reject(new Error('nincs hálózat')))
    mock.method(console, 'error', () => {})

    await App.loadConfig()

    assert.equal(App._boot, 'failed', 'a bootstrap állapota nem jelölte a hibát')
  })

  it('sikeres betöltés után az állapot „ready"', async () => {
    mock.method(YumeAPI, 'config', () => Promise.resolve({ site: { name: 'Yume' }, flags: {} }))
    mock.method(YumeAPI, 'user', () => null)

    await App.loadConfig()

    assert.equal(App._boot, 'ready')
  })
})
