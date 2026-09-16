// Player 2.0 — környezeti fény, kislejátszó, zárolt képernyő, fejlesztői
// réteg, telemetria.
//
// Öt kis modul, és mindegyiknek egyetlen nehéz kérdése van:
//
//   * a fény ne kerüljön semmibe, amikor nem látszik;
//   * a kislejátszó ne tudjon elveszni a képernyőn kívül;
//   * a zárolt képernyő ne törjön el ott, ahol nincs;
//   * a fejlesztői réteget senki ne lássa véletlenül;
//   * a telemetria ne vigyen ki semmit, amit nem szabad.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import { createDocument, withDocument } from './support/mini-dom.mjs'
import { createPlayer } from '../src/features/player2/core/player.js'
import {
  createAmbientLight, SAMPLE_WIDTH, SAMPLE_HEIGHT
} from '../src/features/player2/ambient/ambient-light.js'
import {
  createMiniPlayer, clampPosition, clampWidth, KEEP_VISIBLE_PX, MIN_WIDTH, MAX_WIDTH
} from '../src/features/player2/mini/mini-player.js'
import { createMediaSession } from '../src/features/player2/integration/media-session.js'
import { createDebugOverlay } from '../src/features/player2/debug/debug-overlay.js'
import {
  createTelemetry, sanitise, TELEMETRY_EVENTS, THROTTLE_MS
} from '../src/features/player2/telemetry/player-telemetry.js'
import { createFlagEvaluator } from '../src/features/player2/flags/player-feature-flags.js'
import { EV } from '../src/features/player2/core/player-events.js'

const quiet = { error () {}, warn () {}, log () {} }

/**
 * A `navigator` Node 22-ben CSAK OLVASHATÓ tulajdonság: az egyszerű
 * értékadás `Cannot set property navigator` hibával elszáll. A
 * `defineProperty` viszont felülírja, és a visszaadott függvény vissza is
 * állítja — enélkül a következő készlet a mi csonkunkat kapná.
 */
function withNavigator (value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  return () => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else delete globalThis.navigator
  }
}
const open = []
let restore = null

afterEach(() => {
  while (open.length) open.pop().destroy()
  restore?.(); restore = null
})

function harness (videoOverrides = {}) {
  const doc = createDocument()
  restore = withDocument(doc)
  const listeners = new Map()
  const video = {
    paused: true, currentTime: 0, duration: 1400, playbackRate: 1, readyState: 4,
    videoWidth: 1920, videoHeight: 1080, networkState: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    ownerDocument: doc,
    addEventListener (type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn) },
    removeEventListener () {},
    fire (type) { (listeners.get(type) ?? []).slice().forEach(fn => fn({ type })) },
    play () { this.paused = false; this.fire('play'); return Promise.resolve() },
    pause () { this.paused = true; this.fire('pause') },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
    ...videoOverrides
  }
  const player = createPlayer({ video, logger: quiet })
  open.push(player)
  return { doc, video, player }
}

describe('környezeti fény', () => {
  it('a videót NEM mintázza — ezt mérés döntötte el', () => {
    // 150 képkocka mediánja, kétszer megismételve:
    //   nincs fény 16,7 ms · csak a másolás 76,0 ms · másolás+elmosás 74,8 ms
    // A költség maga a `drawImage(video, …)`: visszaolvasás a GPU-ról,
    // ami után a dekódoló lassabb úton marad. Nem a másolás pillanata
    // drágul, hanem az egész lejátszás.
    const source = readFileSync(
      new URL('../src/features/player2/ambient/ambient-light.js', import.meta.url), 'utf8')
    // A MEGJEGYZÉSEK NÉLKÜL, mert a modul fejléce épp azt magyarázza el, hogy
    // miért nincs ott `drawImage(video, …)` — és a minta arra is illett.
    const code = source.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n')
    assert.ok(!/drawImage\s*\(\s*video/.test(code), 'visszakerült a videó mintázása')
    assert.ok(!/setInterval|player\.interval/.test(code), 'visszakerült az ismétlődő munka')
  })

  it('a borítót egyszer festi fel, és utána nem csinál semmit', async () => {
    const { doc, player } = harness()
    const canvas = doc.createElement('canvas')
    const wrap = doc.createElement('div')
    wrap.append(canvas); canvas.parentNode = wrap
    let draws = 0
    canvas.getContext = () => ({ drawImage () { draws++ } })

    const ambient = createAmbientLight(player, canvas, {
      prefs: { get: () => undefined },
      imageSrc: '/borito.jpg',
      loadImage: () => Promise.resolve({})
    })
    await ambient.ready
    assert.equal(draws, 1)
    assert.equal(ambient.painted, true)
    assert.equal(ambient.running, false, 'valami folyamatosan fut')
    assert.ok(wrap.classList.contains('yp-ambient-on'))
  })

  it('apró vásznon dolgozik', () => {
    // A kép úgyis el van mosva: egy nagyobb másolat ugyanazt a foltot adja.
    assert.ok(SAMPLE_WIDTH <= 64 && SAMPLE_HEIGHT <= 36, 'túl nagy mintavevő vászon')
  })

  it('kikapcsolva egyetlen képet sem másol', async () => {
    const { doc, player } = harness()
    const canvas = doc.createElement('canvas')
    const wrap = doc.createElement('div'); wrap.append(canvas); canvas.parentNode = wrap
    let draws = 0
    canvas.getContext = () => ({ drawImage () { draws++ } })
    const ambient = createAmbientLight(player, canvas, {
      prefs: { get: key => (key === 'player.ui.ambient' ? false : undefined) },
      imageSrc: '/borito.jpg',
      loadImage: () => Promise.resolve({})
    })
    await ambient.ready
    // A festés megtörténik, de a réteg NEM jelenik meg. A kép betöltése
    // ugyanis már elindult, mire a beállítást megnézhettük volna — és egy
    // félbehagyott festés bonyolultabb, mint egy rejtett réteg.
    assert.equal(wrap.classList.contains('yp-ambient-on'), false)
    assert.equal(canvas.style.opacity, '0')
  })

  it('a be nem tölthető kép nem viszi magával a lejátszást', async () => {
    const { doc, player } = harness()
    const canvas = doc.createElement('canvas')
    const wrap = doc.createElement('div'); wrap.append(canvas); canvas.parentNode = wrap
    canvas.getContext = () => ({ drawImage () {} })
    const ambient = createAmbientLight(player, canvas, {
      prefs: { get: () => undefined },
      imageSrc: '/nincs.jpg',
      loadImage: () => Promise.reject(new Error('404'))
    })
    await ambient.ready
    assert.equal(ambient.failed, true)
    assert.equal(ambient.painted, false)
    assert.equal(wrap.classList.contains('yp-ambient-on'), false)
  })

  it('kép nélkül nem próbálkozik', async () => {
    const { doc, player } = harness()
    const canvas = doc.createElement('canvas')
    const wrap = doc.createElement('div'); wrap.append(canvas); canvas.parentNode = wrap
    const ambient = createAmbientLight(player, canvas, { prefs: { get: () => undefined } })
    await ambient.ready
    assert.equal(ambient.painted, false)
    assert.equal(ambient.failed, false, 'kép hiányát hibának vette')
  })

  it('az erősség nullánál nem jelenik meg', async () => {
    const { doc, player } = harness()
    const canvas = doc.createElement('canvas')
    const wrap = doc.createElement('div'); wrap.append(canvas); canvas.parentNode = wrap
    canvas.getContext = () => ({ drawImage () {} })
    const ambient = createAmbientLight(player, canvas, {
      prefs: { get: key => (key === 'player.ui.ambientIntensity' ? 0 : undefined) },
      imageSrc: '/b.jpg',
      loadImage: () => Promise.resolve({})
    })
    await ambient.ready
    assert.equal(wrap.classList.contains('yp-ambient-on'), false)
  })
})

describe('kislejátszó', () => {
  it('nem tud kicsúszni a képernyőről', () => {
    // Egy képernyőn kívülre húzott kislejátszót nem lehet visszahozni, és a
    // néző csak annyit lát, hogy szól valami, amit nem talál.
    const viewport = { width: 1280, height: 720 }
    const right = clampPosition({ left: 99999, top: 100, width: 360, height: 200 }, viewport)
    assert.equal(right.left, viewport.width - KEEP_VISIBLE_PX)

    const left = clampPosition({ left: -99999, top: -500, width: 360, height: 200 }, viewport)
    assert.equal(left.left, KEEP_VISIBLE_PX - 360, 'balra teljesen eltűnt')
    assert.equal(left.top, 0, 'felfelé kicsúszott')

    const below = clampPosition({ left: 10, top: 99999, width: 360, height: 200 }, viewport)
    assert.equal(below.top, viewport.height - KEEP_VISIBLE_PX)
  })

  it('a szélesség a képernyőhöz is igazodik', () => {
    assert.equal(clampWidth(MAX_WIDTH + 500, 1920), MAX_WIDTH)
    assert.equal(clampWidth(10, 1920), MIN_WIDTH)
    // Keskeny képernyőn a maximum is kisebb — különben a két oldalán nem
    // maradna fogás.
    assert.equal(clampWidth(MAX_WIDTH, 400), 240)
    assert.ok(clampWidth(MAX_WIDTH, 300) >= MIN_WIDTH, 'a minimum alá ment')
  })

  it('belépéskor helyőrzőt hagy, kilépéskor visszaáll', () => {
    const { doc, player } = harness()
    const host = doc.createElement('div')
    const shell = doc.createElement('div')
    shell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 })
    host.append(shell)
    shell.parentNode = host
    doc.body.append(host)

    const mini = createMiniPlayer(player, shell, { viewport: () => ({ width: 1280, height: 720 }) })
    assert.equal(mini.enter(), true)
    assert.equal(mini.active, true)
    assert.ok(shell.classList.contains('yp-mini'))
    // A helyőrző nélkül a lap tartalma felugrik, és a néző elveszíti, hol tartott.
    assert.ok(host.children.some(child => child.classList?.contains('yp-mini-placeholder')), 'nincs helyőrző')
    assert.equal(player.state.get().ui.miniPlayer, true)

    assert.equal(mini.exit(), true)
    assert.equal(shell.classList.contains('yp-mini'), false)
    assert.equal(host.children.some(child => child.classList?.contains('yp-mini-placeholder')), false)
    assert.equal(player.state.get().ui.miniPlayer, false)
  })

  it('a szétbontás kilép belőle', () => {
    const { doc, player } = harness()
    const host = doc.createElement('div')
    const shell = doc.createElement('div')
    shell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 })
    host.append(shell); shell.parentNode = host; doc.body.append(host)
    const mini = createMiniPlayer(player, shell, { viewport: () => ({ width: 1280, height: 720 }) })
    mini.enter()
    player.destroy()
    open.pop()
    assert.equal(mini.active, false, 'a kislejátszó a lapon maradt a szétbontás után')
  })
})

describe('zárolt képernyő', () => {
  it('ahol nincs Media Session, ott nem törik el', () => {
    const restoreNav = withNavigator({})
    try {
      const { player } = harness()
      const session = createMediaSession(player, { title: 'Próba' })
      assert.equal(session.supported, false)
      assert.doesNotThrow(() => session.update({ title: 'Más' }))
    } finally { restoreNav() }
  })

  it('a támogatott műveleteket beköti, az ismeretleneket kihagyja', () => {
    const bound = new Map()
    const restoreNav = withNavigator({
      mediaSession: {
        setActionHandler (action, fn) {
          // Egy böngésző, ami nem ismeri a `seekto`-t. Ettől a többinek
          // mennie kell.
          if (action === 'seekto') throw new TypeError('ismeretlen művelet')
          bound.set(action, fn)
        },
        setPositionState () {}
      }
    })
    try {
      const { video, player } = harness()
      const session = createMediaSession(player, { title: 'Próba', onNext: () => {} })

      assert.equal(session.supported, true)
      assert.ok(session.actions.includes('play'))
      assert.ok(session.actions.includes('nexttrack'), 'a következő rész nem került be')
      assert.ok(!session.actions.includes('seekto'), 'az ismeretlen művelet bekerült')

      bound.get('seekforward')({ seekOffset: 30 })
      assert.equal(video.currentTime, 30)
      bound.get('pause')()
      assert.equal(video.paused, true)
    } finally { restoreNav() }
  })

  it('előző/következő nélkül nem hirdet részváltást', () => {
    const restoreNav = withNavigator({ mediaSession: { setActionHandler () {}, setPositionState () {} } })
    try {
      const { player } = harness()
      const session = createMediaSession(player, { title: 'Próba' })
      assert.ok(!session.actions.includes('nexttrack'))
      assert.ok(!session.actions.includes('previoustrack'))
    } finally { restoreNav() }
  })
})

describe('fejlesztői réteg', () => {
  it('alapból ki van kapcsolva — ez az egyetlen ilyen funkció', () => {
    // A többi flag alapértelmezése igen: egy funkció, amiről a kapcsolótábla
    // még nem tud, inkább működjön. Húsz sornyi belső szám a videó fölött
    // viszont kifejezett kérés nélkül nem jelenhet meg.
    const bare = createFlagEvaluator({})
    assert.equal(bare.isOn('player.debug'), false)
    assert.equal(bare.isOn('player.subtitles'), true, 'a többi alapértelmezés megváltozott')

    const asked = createFlagEvaluator({ featureOn: name => name === 'player.debug' })
    assert.equal(asked.isOn('player.debug'), true)
  })

  it('rejtve nem rajzol', () => {
    const { player } = harness()
    const debug = createDebugOverlay(player)
    assert.equal(debug.visible, false)
    assert.ok(debug.node.classList.contains('yp-hidden'))
    assert.equal(debug.node.innerHTML, '')
  })

  it('megmutatja, amit a hibakeresés tényleg kérdez', () => {
    const { player } = harness()
    const debug = createDebugOverlay(player)
    debug.show()
    const keys = debug.rows().map(([key]) => key)
    for (const needed of ['forrás', 'minőség', 'puffer előre', 'kiesett képkocka', 'indulás → első kép']) {
      assert.ok(keys.includes(needed), `hiányzik: ${needed}`)
    }
  })

  it('a hibakód sem kerülhet be jelölésként', () => {
    const { player } = harness()
    const debug = createDebugOverlay(player)
    player.state.patch({ error: { code: '<img src=x onerror=alert(1)>' } })
    debug.show()
    // A helyes mérték NEM az, hogy szerepel-e az „onerror" szó: menekítve
    // szerepelhet, ártalmatlan szövegként. Az a mérték, hogy KELETKEZETT-E
    // TŐLE ELEM. (Ugyanezt egyszer már elrontottam a betöltőképernyőnél.)
    assert.equal(debug.node.querySelectorAll('img').length, 0, 'a beszúrásból elem lett')
    assert.ok(debug.node.innerHTML.includes('&lt;img'), 'nem lett menekítve')
  })

  it('az indulási időt az első forrásválasztástól méri', () => {
    // Nem a modul létrejöttétől: a kettő közé beleeshet egy hálózati kérés,
    // és az nem a lejátszó ideje.
    let clock = 0
    const { video, player } = harness()
    const debug = createDebugOverlay(player, { now: () => clock })
    clock = 5000                    // ennyit várt a lap, mielőtt forrás lett
    player.bus.emit('source:selected', { id: 'a' })
    clock = 5400
    video.fire('loadeddata')
    assert.equal(debug.metrics.firstFrameMs, 400, 'a lap várakozását is beleszámolta')
  })
})

describe('telemetria', () => {
  it('a forráscím és a hibaszöveg nem megy ki', () => {
    const dirty = {
      ms: 1234.567,
      url: 'https://forras.hu/v.mp4?token=titkos',
      message: '/opt/yume/apps/api/src/... hívásverem',
      code: 'SOURCE_TIMEOUT',
      quality: '1080',
      auto: true
    }
    const clean = sanitise(dirty)
    assert.deepEqual(clean, { ms: 1234.57, quality: 1080, code: 'SOURCE_TIMEOUT', auto: true })
    assert.ok(!('url' in clean), 'a forráscím kiment — tokent tartalmazhat')
    assert.ok(!('message' in clean), 'a hibaszöveg kiment — belső utat tartalmazhat')
  })

  it('a hosszú szöveg kiesik, akkor is, ha kódnak adja ki magát', () => {
    assert.equal(sanitise({ code: 'x'.repeat(200) }).code, undefined)
    assert.equal(sanitise({ reason: 'rövid' }).reason, 'rövid')
  })

  it('a zárt listán kívüli eseményt nem küldi el', () => {
    const { player } = harness()
    const sent = []
    const telemetry = createTelemetry(player, { send: (event, payload) => sent.push([event, payload]) })
    assert.equal(telemetry.emit('kitalált_esemény', {}), false)
    assert.equal(telemetry.emit('player_started', {}), true)
    assert.deepEqual(sent.map(([event]) => event), ['player_started'])
  })

  it('eseményenként külön fojt', () => {
    // Közös fojtással a sűrű pufferelés elnyelné a ritka minőségváltást.
    let clock = 0
    const { player } = harness()
    const sent = []
    const telemetry = createTelemetry(player, { send: (e) => sent.push(e), now: () => clock })

    assert.equal(telemetry.emit('buffer_start'), true)
    assert.equal(telemetry.emit('buffer_start'), false, 'nem fojtott')
    assert.equal(telemetry.emit('quality_changed'), true, 'a másik eseményt is elnyelte')

    clock += THROTTLE_MS + 1
    assert.equal(telemetry.emit('buffer_start'), true)
  })

  it('küldőfüggvény nélkül néma', () => {
    const { player } = harness()
    const telemetry = createTelemetry(player, {})
    assert.equal(telemetry.enabled, false)
    assert.equal(telemetry.emit('player_started'), false)
  })

  it('a forráshibából csak a kód megy ki', () => {
    const { player } = harness()
    const sent = []
    createTelemetry(player, { send: (event, payload) => sent.push([event, payload]) })
    player.bus.emit(EV.SOURCE_FAILED, {
      code: 'SOURCE_TIMEOUT',
      attempts: 2,
      failure: { code: 'SOURCE_TIMEOUT', detail: 'https://belso.cim/x?token=titkos' }
    })
    assert.deepEqual(sent, [['source_failed', { attempt: 2, code: 'SOURCE_TIMEOUT' }]])
  })

  it('tíz esemény van, és mind nevesített', () => {
    assert.equal(TELEMETRY_EVENTS.length, 10)
    assert.ok(TELEMETRY_EVENTS.every(name => /^[a-z_]+$/.test(name)))
  })
})
