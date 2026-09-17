// A belépőlap.
//
// Három dolgot mér, és mindhárom olyan, amiből korábban hiba lett:
//
//   1. A `?next=` a CÍMSORBÓL jön, tehát bárki megírhatja. Ami nem a saját
//      útvonalunk neve, az a főoldal — nem „majdnem odamegyünk".
//
//   2. EGY ŰRLAP VAN. Eddig három másolat létezett belőle (felugró ablak,
//      hozzáférési kapu, fiókkártya), és amikor az emberpróba bekerült, KETTŐBE
//      nem került bele — onnan a regisztráció 403-mal hasalt volna el, ráadásul
//      némán. Ez a suite arra megy rá, hogy a másolatok tényleg eltűntek.
//
//   3. A LAP LESZERELI MAGÁT. Az emberpróba widgetje idegen iframe-et és
//      időzítőt hagyna maga után; a router navigációkor szó nélkül kicseréli a
//      lap tartalmát.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, beforeEach, describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { install } from './support/browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))

let PageLogin, safeNext, YumeAPI, configure, App
let doc, restore

/** A widget iframe-et nyitna: a tesztekben nincs hálózat, és nem is kell. */
const NINCS_EMBERPROBA = { site: { name: 'Yume', turnstileSiteKey: null, turnstileOn: [] } }

before(async () => {
  install()
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
  ;({ configure } = await import('../src/shared/lib/site-config.js'))
  ;({ PageLogin, safeNext } = await import('../src/pages/login.js'))
  ;({ App } = await import('../src/app/router.js'))
})

beforeEach(() => {
  mock.restoreAll()
  doc = createDocument()
  restore = withDocument(doc)
  // A lap a DOM-ból való kikerülést figyeli; a csonkban ez nem fut magától.
  globalThis.MutationObserver = class {
    observe () {}
    disconnect () {}
  }
  configure({ config: NINCS_EMBERPROBA, permissions: [], signedIn: () => false })
})

after(() => { restore?.() })

/** A lap kirajzolása egy friss gyökérbe. */
function render ({ arg, next = null, user = null } = {}) {
  mock.method(YumeAPI, 'user', () => user)
  const root = doc.createElement('div')
  doc.body.append(root)
  const params = new URLSearchParams(next ? { next } : {})
  const ctx = { onAuthed: async () => {}, setTitle: () => {} }
  PageLogin.render(root, params, arg, ctx)
  return root
}

const szoveg = node => node.textContent

describe('a következő cím ellenőrzése', () => {
  it('egy sima útvonalnevet átenged', () => {
    assert.equal(safeNext('list'), 'list')
    assert.equal(safeNext('#/list'), 'list')
    assert.equal(safeNext('/list'), 'list')
  })

  it('az azonosítót is megtartja', () => {
    assert.equal(safeNext('anime/0f8a-9b'), 'anime/0f8a-9b')
  })

  /*
   * Ezek azok, amikért a függvény létezik. Egy `//rossz.example` alakú érték
   * ránézésre útvonalnak látszik; a böngésző viszont idegen gazdának olvassa.
   */
  it('ami nem a saját útvonalunk, az a főoldal', () => {
    for (const rossz of [
      '//rossz.example',
      'https://rossz.example',
      'javascript:alert(1)',
      '../../titok',
      'anime/../../x',
      'list?a=b',
      'LIST',
      ''
    ]) {
      assert.equal(safeNext(rossz), 'home', rossz)
    }
  })

  it('nem szöveg típusú értéket is elvisel', () => {
    for (const rossz of [null, undefined, 42, {}, []]) {
      assert.equal(safeNext(rossz), 'home', String(rossz))
    }
  })

  /* Önmagába visszaküldeni kört jelentene. */
  it('a belépőlapra nem irányít vissza', () => {
    assert.equal(safeNext('login'), 'home')
  })
})

describe('a lap', () => {
  it('kijelentkezve belépő űrlapot rajzol', () => {
    const root = render()
    assert.ok(root.querySelector('.auth-form'), 'nincs űrlap')
    assert.equal(root.querySelector('.auth-form').tagName, 'FORM',
      'valódi <form> kell: ettől küld az Enter, és ettől ismeri fel a jelszókezelő')
    const nevek = root.querySelectorAll('input').map(i => i.getAttribute('name'))
    assert.deepEqual(nevek, ['identifier', 'password'])
  })

  it('a #/login/register a regisztrációs füllel nyílik', () => {
    const root = render({ arg: 'register' })
    const nevek = root.querySelectorAll('input').map(i => i.getAttribute('name'))
    assert.deepEqual(nevek, ['email', 'username', 'password'],
      'a felhasználónév a jelszó ELŐTT álljon — a jelszókezelők ezt várják')
  })

  /*
   * Egy belépett látogatónak üres mezőket mutatni azt sugallná, hogy nincs is
   * bejelentkezve. Itt a lap elágazás, nem űrlap.
   */
  it('belépve nem űrlapot mutat, hanem továbbvisz', () => {
    const root = render({ user: { username: 'aki' } })
    assert.equal(root.querySelector('.auth-form'), null)
    assert.match(szoveg(root), /aki/)
  })

  it('a jelszómező típusa jelszó, és nem szivárog a címsorba', () => {
    const root = render()
    const jelszo = root.querySelectorAll('input').find(i => i.getAttribute('name') === 'password')
    assert.equal(jelszo.getAttribute('type'), 'password')
    assert.equal(jelszo.getAttribute('autocomplete'), 'current-password')
  })

  it('regisztrációnál új jelszót kér a böngészőtől, nem a mentettet', () => {
    const root = render({ arg: 'register' })
    const jelszo = root.querySelectorAll('input').find(i => i.getAttribute('name') === 'password')
    assert.equal(jelszo.getAttribute('autocomplete'), 'new-password')
  })

  /*
   * A hibaüzenet `role="alert"`: egy elrontott jelszó visszajelzése különben
   * csak azoknak létezik, akik látják.
   */
  it('a hibahely felolvasható', () => {
    const root = render()
    const hiba = root.querySelector('.field-error')
    assert.equal(hiba.getAttribute('role'), 'alert')
    assert.equal(hiba.hidden, true, 'induláskor nincs mit mondani')
  })

  it('a lap leszereli magát, amikor kikerül a dokumentumból', () => {
    let leszerelt = false
    globalThis.MutationObserver = class {
      constructor (fn) { this.fn = fn }
      observe () { leszerelt = true; this.fn() }
      disconnect () {}
    }
    const root = render()
    assert.ok(leszerelt, 'nem figyeli, mikor tűnik el')
    assert.ok(root)
  })
})

describe('a lap be van kötve', () => {
  it('van `login` útvonal', () => {
    assert.equal(typeof App.routes.login, 'function')
  })

  /*
   * A belépőlapon az ikonsáv öt olyan helyre mutatna, ahová egy kijelentkezett
   * látogató úgysem jut el.
   */
  it('króm nélkül jelenik meg', () => {
    assert.ok(App.CHROMELESS.includes('login'))
  })

  /*
   * EZ A FONTOS: ha a hozzáférési kapu elzárná, egy privát példányon a
   * belépőlap maga is kapu mögé kerülne, és nem lenne mód bejutni.
   */
  it('a hozzáférési kapu nem zárhatja el', () => {
    assert.ok(App._gateExempt.includes('login'))
  })

  /*
   * Az ikonsáv öt olyan helyre mutat, ahová csak belépés után lehet eljutni —
   * és a látogató épp azt csinálja. A `CHROMELESS` csak a LÁBLÉCET vezérli; a
   * sávot a testre tett jelölés rejti el, és ezt a két helyet könnyű
   * elfelejteni külön-külön.
   */
  it('az ikonsáv le van véve róla', () => {
    const forras = readFileSync(join(here, '..', 'src', 'app', 'router.js'), 'utf8')
    assert.match(forras, /classList\.toggle\('login-route', route === 'login'\)/)
    const css = readFileSync(join(here, '..', 'css', 'style.css'), 'utf8')
    assert.match(css, /body\.login-route \.sidebar/)
  })
})

describe('egy űrlap van, nem három', () => {
  const forras = nev => readFileSync(join(here, '..', 'src', nev), 'utf8')

  /*
   * A FELUGRÓ ABLAK MEGSZŰNT. Ugyanazt az űrlapot adta, másik keretben — és
   * két felület ugyanarra a dologra azt jelenti, hogy az egyik előbb-utóbb
   * lemarad egy változásról. Pontosan ez történt, amikor az emberpróba
   * bekerült: a három másolatból kettőbe nem került bele.
   */
  it('a kezdőképernyő a belépőlapra visz, nem saját ablakot nyit', () => {
    const s = forras('features/landing/landing.js')
    assert.match(s, /#\/login/)
    assert.doesNotMatch(s, /openAuthDialog|createAuthForm/,
      'a kezdőképernyő megint saját belépőfelületet épít')
  })

  /*
   * A fiókkártya volt az, amibe az emberpróba nem került bele. Innentől nem
   * űrlapot rajzol, hanem a belépőlapra visz.
   */
  it('a fiókkártya kijelentkezve a belépőlapra visz', () => {
    const s = forras('shared/ui/components.js')
    const kartya = s.slice(s.indexOf('authCard ('), s.indexOf('authCard (') + 2500)
    assert.match(kartya, /#\/login/)
    assert.doesNotMatch(kartya, /YumeAPI\.register\(/,
      'a kártya megint saját regisztrációt csinál — ez volt a néma 403 forrása')
  })

  it('a hozzáférési kapu is a belépőlapra visz', () => {
    const s = forras('app/router.js')
    const kapu = s.slice(s.indexOf("gate.kind === 'auth'"), s.indexOf("gate.kind === 'auth'") + 1800)
    assert.match(kapu, /#\/login\?next=/)
    assert.doesNotMatch(kapu, /C\.authCard/)
  })
})
