// Player 2.0 — a következő rész kártyája és a teljes beállításpanel.
//
// A kártyánál minden szabály ugyanarról szól: A NÉZŐ DÖNT. A panelnál arról,
// hogy a felület és a séma NE TUDJON ELTÉRNI egymástól — mert az eltérés
// csendben egy beállítás, amit nem lehet átállítani, vagy ami nem csinál
// semmit.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { createPlayer } from '../src/features/player2/core/player.js'
import { createNextEpisodeCard, shouldShow, SHOW_BEFORE_END_SEC } from '../src/features/player2/ui/next-episode.js'
import { createSettingsPanel, controlFor, SETTINGS_GROUPS } from '../src/features/player2/ui/settings-panel.js'
import {
  PLAYER_PREFERENCE_SCHEMA, createPlayerPreferences
} from '../src/features/player2/preferences/player-preferences.js'

const quiet = { error () {}, warn () {}, log () {} }
const open = []
let doc
let restore

beforeEach(() => {
  while (open.length) open.pop().destroy()
  restore?.()
  doc = createDocument()
  restore = withDocument(doc)
})
afterEach(() => { while (open.length) open.pop().destroy(); restore?.(); restore = null })

function harness (prefValues = {}) {
  const listeners = new Map()
  const video = {
    paused: false, currentTime: 0, duration: 1400,
    ownerDocument: doc,
    addEventListener (type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener () {},
    fire (type) { (listeners.get(type) ?? []).slice().forEach(fn => fn({ type })) },
    play: () => Promise.resolve(),
    pause () {}
  }
  const player = createPlayer({ video, logger: quiet })
  open.push(player)
  const prefs = { get: key => prefValues[key], set: () => {} }
  return { video, player, prefs }
}

describe('mikor jelenjen meg a kártya', () => {
  it('a rész vége felé igen, korábban nem', () => {
    assert.equal(shouldShow({ currentTime: 1380, duration: 1400, hasNext: true }), true)
    assert.equal(shouldShow({ currentTime: 1300, duration: 1400, hasNext: true }), false)
  })

  it('rövid résznél arányosan szűkebb az ablak', () => {
    // Egy hatvan másodperces extránál a huszonöt másodperc a videó fele
    // lenne, és a kártya végigkísérné az egészet.
    assert.equal(shouldShow({ currentTime: 50, duration: 60, hasNext: true }), false)
    assert.equal(shouldShow({ currentTime: 55, duration: 60, hasNext: true }), true)
  })

  it('következő rész nélkül soha', () => {
    assert.equal(shouldShow({ currentTime: 1395, duration: 1400, hasNext: false }), false)
  })

  it('ismeretlen hossznál nem találgat', () => {
    assert.equal(shouldShow({ currentTime: 1395, duration: NaN, hasNext: true }), false)
    assert.equal(shouldShow({ currentTime: 1395, duration: 0, hasNext: true }), false)
  })
})

describe('a kártya viselkedése', () => {
  it('automatikus továbblépésnél visszaszámol', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': true, 'player.ui.nextCountdownSec': 5 })
    let nexts = 0
    const card = createNextEpisodeCard(player, { prefs, onNext: () => nexts++ })
    player.state.patch({ episode: { next: { number: 2 } } })

    video.currentTime = 1390
    video.fire('timeupdate')
    assert.equal(card.visible, true)
    assert.equal(card.remaining, 5)
    assert.ok(card.node.querySelector('.yp-next-go').textContent.includes('5'))
    assert.equal(nexts, 0)
  })

  it('kikapcsolt automatikánál gomb, nem visszaszámláló', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': false })
    const card = createNextEpisodeCard(player, { prefs })
    player.state.patch({ episode: { next: { number: 2 } } })
    video.currentTime = 1390
    video.fire('timeupdate')

    assert.equal(card.visible, true, 'kikapcsolt automatikánál is meg kell jelennie')
    assert.equal(card.remaining, null)
    assert.equal(card.node.querySelector('.yp-next-cancel').hidden, true, 'nincs mit megszakítani')
  })

  it('a megszakítás VÉGLEGES erre a részre', () => {
    // Egy visszaszámláló, ami a megszakítás után tíz másodperccel újraindul,
    // nem megszakítható — csak halogatható.
    const { video, player, prefs } = harness({ 'player.autoplayNext': true, 'player.ui.nextCountdownSec': 5 })
    let nexts = 0
    const card = createNextEpisodeCard(player, { prefs, onNext: () => nexts++ })
    player.state.patch({ episode: { next: { number: 2 } } })

    video.currentTime = 1390
    video.fire('timeupdate')
    card.node.querySelector('.yp-next-cancel').fire('click')
    assert.equal(card.visible, false)
    assert.equal(card.dismissed, true)

    video.currentTime = 1395
    video.fire('timeupdate')
    assert.equal(card.visible, false, 'a megszakított kártya visszajött')
    assert.equal(nexts, 0)
  })

  it('a stáblista elé visszatekerve újra felajánlható', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': true })
    const card = createNextEpisodeCard(player, { prefs })
    player.state.patch({ episode: { next: { number: 2 } } })
    video.currentTime = 1390
    video.fire('timeupdate')
    card.dismiss()

    video.currentTime = 600
    video.fire('seeked')
    assert.equal(card.dismissed, false, 'a visszatekerés nem vonta vissza a megszakítást')

    video.currentTime = 1390
    video.fire('timeupdate')
    assert.equal(card.visible, true)
  })

  it('nulla másodperces visszaszámlálásnál azonnal lép', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': true, 'player.ui.nextCountdownSec': 0 })
    let nexts = 0
    const card = createNextEpisodeCard(player, { prefs, onNext: () => nexts++ })
    player.state.patch({ episode: { next: { number: 2 } } })
    video.currentTime = 1390
    video.fire('timeupdate')
    assert.equal(nexts, 1)
    assert.equal(card.remaining, null)
  })

  it('a gomb felolvasva egyetlen értelmes mondat', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': true, 'player.ui.nextCountdownSec': 5 })
    const card = createNextEpisodeCard(player, { prefs })
    player.state.patch({ episode: { next: { number: 2 } } })
    video.currentTime = 1390
    video.fire('timeupdate')
    const label = card.node.querySelector('.yp-next-go').getAttribute('aria-label')
    assert.match(label, /2\. rész/)
    assert.match(label, /5 másodperc/)
  })

  it('az elrejtés megállítja a visszaszámlálást', () => {
    const { video, player, prefs } = harness({ 'player.autoplayNext': true, 'player.ui.nextCountdownSec': 5 })
    let nexts = 0
    const card = createNextEpisodeCard(player, { prefs, onNext: () => nexts++ })
    player.state.patch({ episode: { next: { number: 2 } } })
    video.currentTime = 1390
    video.fire('timeupdate')
    assert.equal(card.remaining, 5)

    video.currentTime = 100
    video.fire('timeupdate')
    assert.equal(card.visible, false)
    assert.equal(card.remaining, null, 'a visszaszámláló a háttérben tovább ketyeg')
  })
})

describe('a teljes beállításpanel', () => {
  const build = (values = {}) => {
    const store = new Map(Object.entries(values))
    const prefs = createPlayerPreferences({ get: k => store.get(k), set: (k, v) => store.set(k, v) })
    return { store, prefs, panel: createSettingsPanel(prefs) }
  }

  it('a 25. pont mind a négy csoportját felsorolja', () => {
    assert.deepEqual(SETTINGS_GROUPS.map(g => g.title), ['Lejátszás', 'Minőség', 'Felirat', 'Felület'])
  })

  it('minden felsorolt kulcs létezik a sémában', () => {
    // A panel és a séma eltérése csendben egy beállítás, amit nem lehet
    // átállítani — vagy ami nem csinál semmit.
    const unknown = SETTINGS_GROUPS
      .flatMap(group => group.keys.map(([key]) => key))
      .filter(key => !(key in PLAYER_PREFERENCE_SCHEMA))
    assert.deepEqual(unknown, [])
  })

  it('a vezérlő fajtája a sémából következik', () => {
    assert.equal(controlFor('player.autoplay'), 'switch')
    assert.equal(controlFor('player.quality.wifi'), 'select')
    assert.equal(controlFor('player.subtitle.size'), 'range')
    assert.equal(controlFor('player.subtitle.color'), 'color')
    assert.equal(controlFor('player.subtitle.language'), 'text')
    assert.equal(controlFor('nincs.ilyen'), null)
  })

  it('a tartományon kívüli érték a mezőben is a határra kerül', () => {
    // Enélkül a panel mást mutatna, mint ami érvényes — és a néző nem tudná,
    // miért „nem fogadja el".
    const { store, panel } = build()
    const size = panel.inputs.get('player.subtitle.size')
    size.value = '900'
    size.fire('change')
    assert.equal(store.get('player.subtitle.size'), 200)
    assert.equal(size.value, '200', 'a mezőben ottmaradt a 900')
  })

  it('a kapcsolók logikai értéket mentenek, nem szöveget', () => {
    const { store, panel } = build()
    const input = panel.inputs.get('player.quality.dataSaver')
    input.checked = true
    input.fire('change')
    assert.equal(store.get('player.quality.dataSaver'), true)
  })

  it('a felsorolt mezők csak érvényes értéket kínálnak', () => {
    const { panel } = build()
    const wifi = panel.inputs.get('player.quality.wifi')
    const offered = wifi.children.map(option => option.value)
    assert.deepEqual(offered, PLAYER_PREFERENCE_SCHEMA['player.quality.wifi'].values.map(String))
  })

  it('a 0–1-es tartomány finomabb lépésközt kap', () => {
    // Egészekkel lépve egy átlátszatlanság három állást ismerne.
    const { panel } = build()
    assert.equal(panel.inputs.get('player.subtitle.backgroundOpacity').step, '0.05')
    assert.equal(panel.inputs.get('player.subtitle.size').step, '1')
  })

  it('a frissítés visszaolvassa a tárolt értékeket', () => {
    const { store, panel } = build()
    store.set('player.subtitle.size', 150)
    store.set('player.autoplay', false)
    panel.refresh()
    assert.equal(panel.inputs.get('player.subtitle.size').value, '150')
    assert.equal(panel.inputs.get('player.autoplay').checked, false)
  })
})

describe('billentyűkiosztás a 24. pont szerint', () => {
  it('P = kép a képben, B = előző rész', async () => {
    const { shortcutFor, SHORTCUT_HELP } = await import('../src/features/player2/ui/keyboard.js')
    assert.equal(shortcutFor({ key: 'p', target: {} }).action, 'toggle-pip')
    assert.equal(shortcutFor({ key: 'b', target: {} }).action, 'previous-episode')
    assert.equal(shortcutFor({ key: 'n', target: {} }).action, 'next-episode')
    // Az `I` másodikként megmarad: a YouTube azt használja, és az ujjak
    // megjegyzik.
    assert.equal(shortcutFor({ key: 'i', target: {} }).action, 'toggle-pip')
    assert.ok(SHORTCUT_HELP.some(row => row.keys.includes('B')))
  })
})
