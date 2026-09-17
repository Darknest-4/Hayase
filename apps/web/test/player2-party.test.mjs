// Player 2.0 — közös nézés.
//
// Két visszacsatolás van ebben a modulban, és mindkettő olyan, ami élesben
// csak akkor derül ki, amikor már két ember nézi egyszerre:
//
//   * a VISSZHANG: a távoli szünet alkalmazása helyben `pause`-t vált ki, amit
//     kiküldve a másik oldal újra alkalmaz — és így tovább;
//   * az ELSODRÓDÁS: két lejátszó sosem megy pontosan egyszerre, és a
//     különbségre reagálva ugrálni rosszabb, mint együtt élni vele.

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createPlayer } from '../src/features/player2/core/player.js'
import {
  createWatchParty, reconcile, DRIFT_TOLERANCE_SEC, DRIFT_JUMP_SEC, POSITION_INTERVAL_MS
} from '../src/features/player2/party/watch-party.js'

const quiet = { error () {}, warn () {}, log () {} }

function fakeVideo () {
  const listeners = new Map()
  return {
    paused: true,
    currentTime: 0,
    duration: 1400,
    addEventListener (type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener () {},
    fire (type) { (listeners.get(type) ?? []).slice().forEach(fn => fn({ type })) },
    play () { this.paused = false; this.fire('play'); return Promise.resolve() },
    pause () { this.paused = true; this.fire('pause') }
  }
}

/**
 * A nyitott lejátszók, hogy egyik se maradjon szétbontatlanul.
 *
 * A házigazda helyzetjelentője `setInterval`, és az ÉLETBEN TARTJA az
 * eseményhurkot: szétbontás nélkül a tesztfuttató lefut, mindent zöldnek ír,
 * és utána örökre vár. Pontosan ez történt az első futáson — a tesztek
 * mind átmentek, a folyamat nem lépett ki.
 */
const open = []
afterEach(() => { while (open.length) open.pop().destroy() })

function party (options = {}) {
  const video = fakeVideo()
  const player = createPlayer({ video, logger: quiet })
  const sent = []
  const api = createWatchParty(player, {
    send: message => sent.push(message),
    canBroadcast: () => options.host !== false,
    ...options
  })
  open.push(player)
  return { video, player, sent, api }
}

describe('elsodródás', () => {
  it('a tűréshatáron belüli különbséghez nem nyúlunk', () => {
    // Egy fél másodpercért ugrálni rosszabb, mint együtt élni vele.
    assert.equal(reconcile(100, 100.4).action, 'none')
    assert.equal(reconcile(100, 100 + DRIFT_TOLERANCE_SEC).action, 'none')
  })

  it('a valódi elsodródást behozza, mindkét irányban', () => {
    assert.deepEqual(reconcile(100, 105), { action: 'seek', to: 105, why: 'elsodródás behozása' })
    assert.equal(reconcile(105, 100).action, 'seek')
  })

  it('nagy eltérésnél újraszinkronizál, nem araszol', () => {
    const decision = reconcile(100, 100 + DRIFT_JUMP_SEC + 10)
    assert.equal(decision.action, 'seek')
    assert.match(decision.why, /újraszinkronizálás/)
  })

  it('szünetben mindig igazodik', () => {
    // Álló képnél az ugrás nem szakít meg semmit.
    const decision = reconcile(100, 102, { playing: false })
    assert.equal(decision.action, 'seek')
    assert.match(decision.why, /ingyen/)
  })

  it('az értelmezhetetlen helyzetből nem lesz NaN a lejátszóban', () => {
    assert.equal(reconcile(100, NaN).action, 'none')
    assert.equal(reconcile(100, undefined).action, 'none')
  })
})

describe('visszhang', () => {
  it('a távoli szünet alkalmazása nem küld ki semmit', () => {
    // Enélkül a két oldal egymást szüneteltetné, örökké.
    const { video, sent, api } = party()
    api.join()
    video.currentTime = 50
    video.play()
    sent.length = 0

    api.receive({ type: 'w2g', action: 'pause', position: 60 })
    assert.equal(video.paused, true)
    assert.equal(video.currentTime, 60)
    assert.deepEqual(sent, [], `visszhang ment ki: ${JSON.stringify(sent)}`)
  })

  it('az egymásba érő alkalmazások nem oldják fel egymást idő előtt', () => {
    // Számláló, nem logikai érték: egy `seek` közben érkező `pause` az elsőt
    // befejezve hamisra állítaná a kapcsolót, és a második már kiküldené magát.
    const { sent, api } = party()
    api.join()
    api.receive({ type: 'w2g', action: 'seek', position: 100 })
    api.receive({ type: 'w2g', action: 'pause', position: 100 })
    assert.deepEqual(sent, [])
    assert.equal(api.applying, true, 'a némítás idő előtt feloldódott')
  })

  it('a saját műveletet viszont kiküldi', () => {
    const { video, sent, api } = party()
    api.join()
    video.currentTime = 30
    video.play()
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], { type: 'w2g', action: 'play', position: 30 })
  })
})

describe('ki vezethet', () => {
  it('alapból küld: a szerver dönti el, ki vezethet', () => {
    // Hamis alapértelmezés mellett az a házigazda sem vezetne, akiről a
    // kliens nem tudja, hogy az.
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    open.push(player)
    const sent = []
    const api = createWatchParty(player, { send: message => sent.push(message) })
    api.join()
    video.currentTime = 10
    video.play()
    assert.equal(sent.length, 1)
  })

  it('akiről tudjuk, hogy nem vezethet, annak a forgalmát megspóroljuk', () => {
    const { video, sent, api } = party({ host: false })
    api.join()
    video.play()
    video.currentTime = 90
    video.fire('seeked')
    assert.deepEqual(sent, [])
  })

  it('a vendég saját szünete megmarad, de a következő jelentés visszahozza', () => {
    // Aki kimegy egy pohár vízért, ne kelljen újracsatlakoznia.
    const { video, api } = party({ host: false })
    api.join()
    video.currentTime = 100
    video.play()
    video.pause()
    assert.equal(video.paused, true, 'a vendég nem tudta megállítani magának')

    api.receive({ type: 'w2g', action: 'play', position: 140 })
    assert.equal(video.paused, false)
    assert.equal(video.currentTime, 140)
  })

  it('szobán kívül semmi nem megy ki', () => {
    const { video, sent } = party()
    video.play()
    assert.deepEqual(sent, [], 'csatlakozás nélkül küldött')
  })
})

describe('a helyzetjelentés üteme', () => {
  it('nem a timeupdate-re megy', () => {
    // Másodpercenként négyszer küldve egy részen negyvenezer üzenet lenne,
    // semmi haszonnal. Négy másodperc bőven elég az elsodródás behozásához.
    assert.ok(POSITION_INTERVAL_MS >= 2000, 'túl sűrű helyzetjelentés')
    const { video, sent, api } = party()
    api.join()
    video.play()
    sent.length = 0
    for (let i = 0; i < 20; i++) video.fire('timeupdate')
    assert.deepEqual(sent, [])
  })
})

describe('ismeretlen üzenet', () => {
  it('nem csinál semmit, és nem is dob', () => {
    const { api } = party()
    api.join()
    assert.equal(api.receive({ type: 'chat', text: 'szia' }), null)
    assert.equal(api.receive({ type: 'w2g', action: 'kitalált' }), null)
    assert.equal(api.receive(null), null)
  })
})

describe('az állapotfa tud a szobáról', () => {
  it('a jelvényhez a felület innen olvas', () => {
    const { player, api } = party()
    assert.equal(player.state.get().ui.party, false)
    api.join()
    assert.equal(player.state.get().ui.party, true)
    api.leave()
    assert.equal(player.state.get().ui.party, false)
  })
})

describe('szivárgás', () => {
  it('a szétbontás után nem marad futó időzítő', () => {
    // A házigazda helyzetjelentője `setInterval`. Ha a szétbontás nem viszi
    // el, a tesztfuttató lefut, zöldet ír, és utána örökre vár — ez történt
    // az első futáson.
    const { player } = party()
    player.destroy()
    open.length = 0
    const timers = process.getActiveResourcesInfo().filter(name => name === 'Timeout')
    assert.deepEqual(timers, [], 'futó időzítő maradt a szétbontás után')
  })
})

describe('a kapcsolat később is megjöhet', () => {
  it('a szoba a lejátszó indulása UTÁN nyílik', () => {
    // A néző akkor írja be a kódot, amikor a rész már megy. Egy létrehozáskor
    // rögzített küldőfüggvényre kívülről hiába írnánk rá — a lezárás az
    // eredetit tartaná, és minden üzenet a semmibe menne.
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    open.push(player)
    const api = createWatchParty(player, {})

    video.currentTime = 20
    video.play() // szobán kívül: nincs hova

    const sent = []
    api.connect({ send: message => sent.push(message) })
    assert.equal(api.joined, true)

    video.currentTime = 40
    video.fire('seeked')
    assert.deepEqual(sent, [{ type: 'w2g', action: 'seek', position: 40 }])
  })
})
