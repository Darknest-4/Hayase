// Player 2.0 — a felület.
//
// Ez az EGYETLEN réteg, ami DOM-hoz nyúl, és ezért az egyetlen, aminek a
// teszteléséhez dokumentum kell. A `mini-dom.mjs` ad egyet: elég valódit
// ahhoz, hogy az állítások jelentsenek valamit, és elég kicsit ahhoz, hogy ne
// legyen belőle második böngésző.
//
// Amit itt bizonyítunk, az nem a kinézet — azt egy egységteszt nem tudja
// megmondani. Amit bizonyítunk, az a VISELKEDÉS: mi történik fogás közben, mi
// marad fókuszálható elrejtés után, mi látszik, ha nincs mit mutatni.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { createPlayer } from '../src/features/player2/core/player.js'
import { createVisibility, HIDE_DELAY_MS, TOUCH_HIDE_DELAY_MS } from '../src/features/player2/ui/controls-visibility.js'
import { createControls } from '../src/features/player2/ui/controls.js'
import { createLoadingOverlay } from '../src/features/player2/ui/loading-overlay.js'
import { createSeekBar } from '../src/features/player2/ui/seek-bar.js'
import { createSettingsMenu } from '../src/features/player2/ui/settings-menu.js'
import { createPlayerUI } from '../src/features/player2/ui/player-ui.js'
import { bufferedRanges, formatRemaining, formatTime, ratioFromPointer, spokenTime } from '../src/features/player2/ui/format.js'
import { ICON_NAMES, icon } from '../src/features/player2/ui/icons.js'
import { LOADING_PHASE } from '../src/features/player2/core/player-state.js'

const quiet = { error () {}, warn () {}, log () {} }

let doc
let restore

/**
 * A nyitott lejátszók.
 *
 * A héj félmásodperces időzítőt tart a vezérlők elrejtéséhez, és az ÉLETBEN
 * TARTJA az eseményhurkot. Amíg minden teszt átment, ez nem látszott: a
 * záró `player.destroy()` mindig lefutott. Az első BUKÓ állítás viszont
 * félbeszakítja a tesztet a `destroy()` ELŐTT — és onnantól a tesztfuttató
 * kiírja a hibát, majd örökre vár. A hiba oka így elveszik a lógásban.
 */
const open = []

beforeEach(() => {
  while (open.length) open.pop().destroy()
  restore?.()
  doc = createDocument()
  restore = withDocument(doc)
})

afterEach(() => { while (open.length) open.pop().destroy() })

function harness (overrides = {}) {
  const listeners = new Map()
  const video = {
    paused: true,
    currentTime: 0,
    duration: 1400,
    volume: 1,
    muted: false,
    playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    ownerDocument: doc,
    addEventListener (type, fn) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn) },
    removeEventListener () {},
    fire (type) { (listeners.get(type) ?? []).slice().forEach(fn => fn({ type })) },
    play () { this.paused = false; return Promise.resolve() },
    pause () { this.paused = true },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 225 }),
    ...overrides
  }
  return { video, player: createPlayer({ video, logger: quiet }) }
}

describe('időformázás', () => {
  it('az órát csak akkor írja ki, ha van', () => {
    assert.equal(formatTime(83), '1:23')
    assert.equal(formatTime(3723), '1:02:03')
    assert.equal(formatTime(0), '0:00')
  })

  it('a hibás bemenetből nem lesz NaN a képernyőn', () => {
    assert.equal(formatTime(NaN), '0:00')
    assert.equal(formatTime(-50), '0:00')
    assert.equal(formatTime(undefined), '0:00')
  })

  it('ismeretlen hossznál nincs hátralévő idő — nem nulla', () => {
    assert.equal(formatRemaining(10, 100), '-1:30')
    assert.equal(formatRemaining(10, 0), null)
    assert.equal(formatRemaining(10, NaN), null)
  })

  it('a felolvasott idő magyarul mondja', () => {
    assert.equal(spokenTime(3723), '1 óra 2 perc 3 másodperc')
    assert.equal(spokenTime(0), '0 másodperc')
    assert.equal(spokenTime(60), '1 perc')
  })

  it('a sávon kívülre húzott ujj nem tekerhet negatívba', () => {
    const rect = { left: 100, width: 200 }
    assert.equal(ratioFromPointer(50, rect), 0)
    assert.equal(ratioFromPointer(500, rect), 1)
    assert.equal(ratioFromPointer(200, rect), 0.5)
    assert.equal(ratioFromPointer(150, { left: 0, width: 0 }), 0)
  })

  it('a pufferelt szakaszokat külön tartja', () => {
    // Két tekerés után az eleje és a közepe is be van töltve. Egyetlen sávként
    // kirajzolva azt mondanánk, hogy minden készen áll.
    const buffered = { length: 2, start: i => [0, 600][i], end: i => [100, 700][i] }
    assert.deepEqual(bufferedRanges(buffered, 1000), [
      { start: 0, end: 0.1 }, { start: 0.6, end: 0.7 }
    ])
    assert.deepEqual(bufferedRanges(buffered, 0), [])
    assert.deepEqual(bufferedRanges(null, 1000), [])
  })
})

describe('ikonok', () => {
  it('minden ikon egy SVG', () => {
    for (const name of ICON_NAMES) {
      assert.match(icon(name), /^<svg [^>]*viewBox="0 0 24 24"/, `${name} nem SVG`)
      assert.ok(icon(name).includes('aria-hidden="true"'), `${name} nincs elrejtve a felolvasó elől`)
    }
  })

  it('ismeretlen névre üres, nem hibás jelölés', () => {
    assert.equal(icon('nincs-ilyen'), '')
  })
})

describe('a vezérlők láthatósága', () => {
  it('szünetben nem tűnik el', () => {
    let clock = 0
    const v = createVisibility({ now: () => clock })
    v.setPaused(true)
    clock += HIDE_DELAY_MS * 10
    assert.equal(v.tick(), true, 'szünetben eltűnt')
  })

  it('lejátszás közben a tétlenség elrejti', () => {
    let clock = 0
    const changes = []
    const v = createVisibility({ now: () => clock, onChange: value => changes.push(value) })
    v.setPaused(false)
    v.activity()
    clock += HIDE_DELAY_MS + 1
    assert.equal(v.tick(), false)
    assert.deepEqual(changes, [false])
  })

  it('nyitott menü mellett nem tűnhet el', () => {
    let clock = 0
    const v = createVisibility({ now: () => clock })
    v.setPaused(false)
    v.setPinned(true)
    clock += HIDE_DELAY_MS * 5
    assert.equal(v.tick(), true, 'a menü a semmi fölött maradt volna')
    v.setPinned(false)
    assert.equal(v.tick(), false)
  })

  it('érintésen hosszabb ideig marad kint', () => {
    // Érintőképernyőn nincs „egeret elmozdítok" gesztus a visszahozásra: ott
    // a vezérlők eltüntetése után újra koppintani kell.
    let clock = 0
    const v = createVisibility({ now: () => clock })
    v.setPaused(false)
    v.activity('touch')
    clock += HIDE_DELAY_MS + 100
    assert.equal(v.tick(), true, 'érintésen az egérhez mért idő után tűnt el')
    clock += TOUCH_HIDE_DELAY_MS
    assert.equal(v.tick(), false)
  })

  it('az azonnali elrejtés nem hat szünetben', () => {
    const v = createVisibility({})
    v.setPaused(true)
    assert.equal(v.hideNow(), true)
  })
})

describe('betöltőképernyő', () => {
  it('a logót teszi ki, ha van', () => {
    const { player } = harness()
    const { node } = createLoadingOverlay(player, { logoSrc: '/media/logo.png', title: 'Cím' })
    const art = node.querySelector('.yp-loader-art')
    assert.equal(art.tagName, 'IMG')
    assert.equal(art.getAttribute('src'), '/media/logo.png')
    // Kétszer: a szürke alapréteg és a színes, maszkolt réteg.
    assert.equal(node.querySelectorAll('.yp-loader-art').length, 2)
    player.destroy()
  })

  it('logó nélkül a YUME felirat áll ott', () => {
    const { player } = harness()
    const { node } = createLoadingOverlay(player, {})
    const art = node.querySelector('.yp-loader-wordmark')
    assert.ok(art, 'nincs felirat sem')
    assert.equal(art.textContent, 'YUME')
    player.destroy()
  })

  it('a logó címe nem kerülhet be jelölésként', () => {
    const { player } = harness()
    const { node } = createLoadingOverlay(player, { logoSrc: '"><img src=x onerror=alert(1)>' })
    // A helyes mérték nem az, hogy az „onerror" szó szerepel-e — menekítve
    // szerepelhet, ártalmatlan szövegként. Az a mérték, hogy KELETKEZETT-E
    // TŐLE ELEM: a betöltő két képet tesz ki (a szürke és a színes réteget),
    // és egy sikeres beszúrás harmadikat csinálna.
    assert.equal(node.querySelectorAll('img').length, 2, 'a beszúrásból elem lett')
    assert.ok(node.innerHTML.includes('&quot;'), 'az idézőjel nem lett menekítve')
    player.destroy()
  })

  it('a fázist és a forrás nevét is kiírja', () => {
    const { player } = harness()
    const { node } = createLoadingOverlay(player, {})
    player.state.patch({
      ui: { loadingPhase: LOADING_PHASE.SWITCHING_SOURCE },
      source: { current: { label: 'yume-local' } }
    })
    assert.equal(node.querySelector('.yp-loader-phase').textContent, 'Váltás másik forrásra — yume-local')
    player.destroy()
  })

  it('legalább egy másodpercig kint marad', () => {
    // Egy 200 ezredmásodpercre felvillanó logó villanásnak látszik, nem
    // betöltésnek.
    let clock = 0
    const { player } = harness()
    const { node } = createLoadingOverlay(player, { now: () => clock })
    clock += 200
    player.state.patch({ ui: { loadingPhase: LOADING_PHASE.READY } })
    assert.ok(!node.classList.contains('yp-hidden'), 'azonnal eltűnt')
    player.destroy()
  })

  it('hibánál azonnal eltűnik, hogy a hibaüzenet olvasható legyen', () => {
    const { player } = harness()
    const { node } = createLoadingOverlay(player, {})
    player.bus.emit('player:error', { message: 'baj' })
    assert.ok(node.classList.contains('yp-hidden'))
    player.destroy()
  })
})

describe('vezérlősáv', () => {
  it('a lejátszás gomb ikont és címkét is vált', () => {
    const { player } = harness()
    const controls = createControls(player, {})
    const play = controls.buttons.play
    assert.ok(play.innerHTML.includes('M6 4l14 8-14 8z'), 'nem a lejátszás ikon')
    assert.equal(play.getAttribute('aria-label'), 'Lejátszás')

    player.state.patch({ playback: { playing: true } })
    assert.ok(play.innerHTML.includes('M7 4h4v16H7z'), 'nem váltott szünet ikonra')
    assert.equal(play.getAttribute('aria-label'), 'Szünet')
    player.destroy()
  })

  it('felirat nélküli résznél a gomb látszik, de tiltott', () => {
    // Eltüntetve a néző azt hinné, a lejátszó nem tud feliratot.
    const { player } = harness()
    const controls = createControls(player, {})
    assert.equal(controls.buttons.subtitles.disabled, true)
    assert.equal(controls.buttons.subtitles.title, 'Ehhez a részhez nincs felirat')

    player.state.patch({ subtitles: { tracks: [{ id: 'hu', language: 'hu' }] } })
    assert.equal(controls.buttons.subtitles.disabled, false)
    player.destroy()
  })

  it('a nem egyszeres sebességet kiemeli', () => {
    const { player } = harness()
    const controls = createControls(player, {})
    assert.equal(controls.buttons.rate.textContent, '1x')
    assert.equal(controls.buttons.rate.classList.contains('yp-on'), false)

    player.state.patch({ playback: { rate: 1.25 } })
    assert.equal(controls.buttons.rate.textContent, '1.25x')
    assert.equal(controls.buttons.rate.classList.contains('yp-on'), true)
    player.destroy()
  })

  it('a némítás ikonja a tényleges hangerőt követi', () => {
    const { player } = harness()
    const controls = createControls(player, {})
    player.state.patch({ playback: { volume: 0.2 } })
    assert.ok(controls.buttons.mute.innerHTML.includes('M15.5 8.5a5 5 0 0 1 0 7'), 'nem a halk ikon')
    player.state.patch({ playback: { muted: true } })
    assert.ok(controls.buttons.mute.innerHTML.includes('M22 9l-6 6M16 9l6 6'), 'némítva nem a néma ikon')
    player.destroy()
  })

  it('nincs következő rész: a gomb tiltott', () => {
    const { player } = harness()
    const controls = createControls(player, {})
    assert.equal(controls.buttons.next.disabled, true)
    player.state.patch({ episode: { next: { number: 2 } } })
    assert.equal(controls.buttons.next.disabled, false)
    player.destroy()
  })

  it('elrejtve semmi nem fókuszálható, visszatérve minden ugyanaz', () => {
    const { player } = harness()
    const seek = createSeekBar(player, {})
    const controls = createControls(player, {}, { seekBar: seek })

    // A tekerősáv `tabindex="0"`-val fókuszálható: egy `<div role="slider">`
    // alapból nem az. Ha az elrejtés törölné, örökre kiesne a Tab sorából.
    assert.equal(seek.node.getAttribute('tabindex'), '0')

    controls.setVisible(false)
    assert.equal(controls.node.getAttribute('aria-hidden'), 'true')
    assert.equal(seek.node.getAttribute('tabindex'), '-1')
    assert.equal(controls.buttons.play.getAttribute('tabindex'), '-1')

    controls.setVisible(true)
    assert.equal(seek.node.getAttribute('tabindex'), '0', 'a tekerősáv kiesett a Tab sorából')
    assert.equal(controls.buttons.play.getAttribute('tabindex'), null, 'a gombra fölösleges tabindex került')
    player.destroy()
  })
})

describe('tekerősáv', () => {
  it('fogás közben nem rajzol a beérkező időből', () => {
    // Enélkül az ujj alól ugrál el a fej: a `timeupdate` a régi pozíciót
    // hozza, miközben a néző már máshol jár.
    const { player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1000, currentTime: 100 } })
    assert.equal(seek.node.querySelector('.yp-seek-played').style.width, '10%')

    seek.node.fire('pointerdown', { button: 0, clientX: 200 }) // 200/400 = 50%
    assert.equal(seek.scrubbing, true)
    assert.equal(seek.node.querySelector('.yp-seek-played').style.width, '50%')

    player.state.patch({ playback: { currentTime: 120 } })
    assert.equal(seek.node.querySelector('.yp-seek-played').style.width, '50%', 'fogás közben visszaugrott')
    player.destroy()
  })

  it('a tekerés az elengedéskor történik, nem húzás közben', () => {
    const { video, player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1000 } })

    seek.node.fire('pointerdown', { button: 0, clientX: 100 })
    doc.fire('pointermove', { clientX: 300 })
    assert.equal(video.currentTime, 0, 'húzás közben már tekert')

    doc.fire('pointerup', { clientX: 300 })
    assert.equal(video.currentTime, 750, 'elengedéskor nem tekert')
    assert.equal(seek.scrubbing, false)
    player.destroy()
  })

  it('az elvesztett fogás nem hagyja örökre fogva', () => {
    // Ablakváltás vagy rendszerpanel: a `pointerup` sosem érkezik meg. Fogva
    // maradt sávnál a kijelző soha többé nem frissülne.
    const { player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1000 } })
    seek.node.fire('pointerdown', { button: 0, clientX: 100 })
    doc.fire('pointercancel', {})
    assert.equal(seek.scrubbing, false)
    player.destroy()
  })

  it('billentyűzetről is tekerhető', () => {
    const { video, player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1000 } })
    video.currentTime = 100

    seek.node.fire('keydown', { key: 'ArrowRight', preventDefault () {} })
    assert.equal(video.currentTime, 105)
    seek.node.fire('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault () {} })
    assert.equal(video.currentTime, 135)
    seek.node.fire('keydown', { key: 'Home', preventDefault () {} })
    assert.equal(video.currentTime, 0, 'a Home nem az elejére vitt')
    seek.node.fire('keydown', { key: 'End', preventDefault () {} })
    assert.equal(video.currentTime, 1000)
    player.destroy()
  })

  it('a felolvasónak kimondott időt ad, nem nyers másodpercet', () => {
    const { player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1400, currentTime: 3723 } })
    assert.equal(seek.node.getAttribute('aria-valuetext'), '1 óra 2 perc 3 másodperc')
    assert.equal(seek.node.getAttribute('aria-valuemax'), '1400')
    player.destroy()
  })

  it('a jelölők a videó hosszához igazodnak, a tartományon kívüliek kimaradnak', () => {
    const { player } = harness()
    const seek = createSeekBar(player, {})
    player.state.patch({ playback: { duration: 1000 } })
    seek.setMarkers([
      { start: 100, kind: 'intro' },
      { start: 0, kind: 'intro' }, // a legelején nincs mit jelölni
      { start: 5000, kind: 'outro' } // a videón kívül
    ])
    const markers = seek.node.querySelectorAll('.yp-seek-marker')
    assert.equal(markers.length, 1)
    assert.equal(markers[0].style.left, '10%')
    player.destroy()
  })
})

describe('beállítások menü', () => {
  it('zárva semmit nem rajzol', () => {
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    assert.equal(menu.open, false)
    assert.ok(menu.node.classList.contains('yp-hidden'))
    player.destroy()
  })

  it('az automatikus minőség megmondja, mi megy éppen', () => {
    // Az „Automatikus" önmagában nem válasz arra, hogy miért homályos a kép.
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    player.state.patch({ quality: { auto: true, current: 480, available: [1080, 480] } })
    menu.show()
    const rows = menu.node.querySelectorAll('.yp-menu-value').map(n => n.textContent)
    assert.ok(rows.includes('Automatikus (480p)'), `a sorok: ${rows.join(' | ')}`)
    player.destroy()
  })

  it('üres minőséglista helyett egy mondat áll', () => {
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    menu.show('quality')
    assert.ok(menu.node.querySelector('.yp-menu-note'), 'üres panel maradt')
    player.destroy()
  })

  it('felirat nélkül megmondja, hogy nincs — és nem kínál megjelenést', () => {
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    menu.show('subtitles')
    assert.ok(menu.node.querySelector('.yp-menu-note'))
    const labels = menu.node.querySelectorAll('.yp-menu-label').map(n => n.textContent)
    assert.ok(!labels.some(l => l.includes('megjelenése')), 'stílus menü felirat nélkül')
    player.destroy()
  })

  it('a választás a megadott műveletet hívja, és visszalép a főpanelre', () => {
    const chosen = []
    const { player } = harness()
    const menu = createSettingsMenu(player, { selectQuality: value => chosen.push(value) })
    player.state.patch({ quality: { auto: true, current: 'auto', available: [1080, 720] } })
    menu.show('quality')
    const row = menu.node.querySelectorAll('.yp-menu-row').find(n => n.textContent.includes('1080p'))
    row.fire('click')
    assert.deepEqual(chosen, [1080])
    assert.equal(menu.node.querySelector('.yp-menu-back span').textContent, 'Beállítások')
    player.destroy()
  })

  it('a hangsáv csak akkor jelenik meg, ha van miből választani', () => {
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    menu.show()
    const labels = () => menu.node.querySelectorAll('.yp-menu-label').map(n => n.textContent)
    assert.ok(!labels().includes('Hangsáv'))

    player.state.patch({ audio: { tracks: [{ id: 'jp' }, { id: 'hu' }] } })
    assert.ok(labels().includes('Hangsáv'), 'két hangsávnál sem jelent meg')
    player.destroy()
  })

  it('a menüsorok címkéje nem kerülhet be jelölésként', () => {
    const { player } = harness()
    const menu = createSettingsMenu(player, {})
    player.state.patch({ subtitles: { tracks: [{ id: 'x', label: '<img src=x onerror=alert(1)>' }] } })
    menu.show('subtitles')
    assert.ok(!menu.node.innerHTML.includes('onerror'))
    player.destroy()
  })
})

describe('a lejátszó héja', () => {
  it('a rétegek a DOM sorrendjében állnak, nem z-index versenyben', () => {
    const { video, player } = harness()
    const ui = createPlayerUI(player, {}, { title: 'Cím' })
    const order = ui.node.children.map(child => child === video ? 'VIDEO' : child.className.split(' ')[0])
    assert.deepEqual(order, [
      'VIDEO', 'yp-ambient', 'yp-subtitles', 'yp-surface', 'yp-skip', 'yp-next',
      'yp-controls', 'yp-menu', 'yp-loader', 'yp-error'
    ])
    player.destroy()
  })

  it('megnevezett régió, hogy a felolvasó meg tudja mondani, hol vagyunk', () => {
    const { player } = harness()
    const ui = createPlayerUI(player, {}, { title: 'Bocchi the Rock' })
    assert.equal(ui.node.getAttribute('role'), 'region')
    assert.equal(ui.node.getAttribute('aria-label'), 'Bocchi the Rock — lejátszó')
    player.destroy()
  })

  it('a teljes képernyőt az esemény írja, nem a saját kapcsolónk', () => {
    // Az Escape, az F11 és a rendszer gesztusa is kiléptet. Saját
    // nyilvántartásból a lejátszó ilyenkor azt hinné, még teljes képernyőn van.
    const { player } = harness()
    const ui = createPlayerUI(player, {}, {})
    doc.fullscreenElement = ui.node
    doc.fire('fullscreenchange')
    assert.equal(player.state.get().ui.fullscreen, true)

    doc.fullscreenElement = null
    doc.fire('fullscreenchange')
    assert.equal(player.state.get().ui.fullscreen, false)
    assert.equal(ui.node.classList.contains('yp-fullscreen'), false)
    player.destroy()
  })

  it('az Escape előbb a menüt zárja, csak utána lép ki a teljes képernyőből', () => {
    let exits = 0
    const { player } = harness()
    const ui = createPlayerUI(player, { toggleFullscreen: () => exits++ }, {})
    player.state.patch({ ui: { fullscreen: true } })
    ui.menu.show()

    ui.node.fire('keydown', { key: 'Escape', target: { tagName: 'DIV' }, preventDefault () {} })
    assert.equal(ui.menu.open, false, 'a menü nyitva maradt')
    assert.equal(exits, 0, 'egy Escape mindkettőt elvitte')

    ui.node.fire('keydown', { key: 'Escape', target: { tagName: 'DIV' }, preventDefault () {} })
    assert.equal(exits, 1)
    player.destroy()
  })

  it('a csevegőmezőbe írt betű nem parancs', () => {
    // A közös nézésnek van csevegője. Enélkül az „f" teljes képernyő lenne
    // gépelés közben — és ez az a hiba, amit minden lejátszó elkövet egyszer.
    let toggles = 0
    const { player } = harness()
    const ui = createPlayerUI(player, { toggleFullscreen: () => { toggles++ } }, {})
    ui.node.fire('keydown', { key: 'f', target: { tagName: 'INPUT' }, preventDefault () {} })
    assert.equal(toggles, 0)
    ui.node.fire('keydown', { key: 'f', target: { tagName: 'DIV' }, preventDefault () {} })
    assert.equal(toggles, 1)
    player.destroy()
  })

  it('az átugrás gombja a szakasz fajtáját mondja', () => {
    const { player } = harness()
    const ui = createPlayerUI(player, {}, {})
    const skip = ui.node.querySelector('.yp-skip')
    assert.ok(skip.classList.contains('yp-hidden'))

    player.state.patch({ ui: { skipSegment: { kind: 'outro', end: 1400 } } })
    assert.equal(skip.textContent, 'Stáblista átugrása')
    assert.equal(skip.classList.contains('yp-hidden'), false)

    player.state.patch({ ui: { skipSegment: { kind: 'intro', end: 100 } } })
    assert.equal(skip.textContent, 'Intró átugrása')
    player.destroy()
  })

  it('a hiba a saját rétegében jelenik meg, újrapróbálással', () => {
    let retries = 0
    const { player } = harness()
    const ui = createPlayerUI(player, { retry: () => retries++ }, {})
    player.state.patch({ error: { message: 'A forrás nem indult el.', retryable: true } })

    const box = ui.node.querySelector('.yp-error')
    assert.equal(box.classList.contains('yp-hidden'), false)
    assert.equal(box.getAttribute('role'), 'alert')
    assert.equal(box.querySelector('.yp-error-text').textContent, 'A forrás nem indult el.')
    box.querySelector('.yp-btn-text').fire('click')
    assert.equal(retries, 1)
    player.destroy()
  })

  it('a nem újrapróbálható hibánál nincs Újra gomb', () => {
    const { player } = harness()
    const ui = createPlayerUI(player, {}, {})
    player.state.patch({ error: { message: 'Ez a rész nem érhető el.', retryable: false } })
    assert.equal(ui.node.querySelector('.yp-error').querySelector('.yp-btn-text'), null)
    player.destroy()
  })

  it('a felirat beállításaiból CSS-változó lesz a héjon', () => {
    const { player } = harness()
    const ui = createPlayerUI(player, {}, {})
    ui.applySubtitleStyle({ 'player.subtitle.size': 150, 'player.subtitle.color': '#ffcc00' })
    assert.equal(ui.node.style.getPropertyValue('--yp-sub-size'), '1.5')
    assert.equal(ui.node.style.getPropertyValue('--yp-sub-color'), '#ffcc00')
    player.destroy()
  })

  it('a szétbontás leszedi a héjat a lapról', () => {
    const { player } = harness()
    const ui = createPlayerUI(player, {}, {})
    doc.body.append(ui.node)
    assert.equal(doc.body.children.length, 1)
    player.destroy()
    assert.equal(doc.body.children.length, 0, 'a héj a lapon maradt')
  })
})
