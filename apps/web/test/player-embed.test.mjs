// Beágyazott lejátszó — a keret, és ami körülötte eldől.
//
// AMIT EZ A KÉSZLET ŐRIZ, egy mondatban: egy beágyazó cím SOHA nem kerülhet a
// `<video>` elembe. Ha odakerülne, a böngésző egy HTML-lapot próbálna
// videóként dekódolni — a néző néma fekete dobozt látna, a napló pedig
// „sikeres lejátszást" írna. Ez a hiba csendes, ezért mérni kell.
//
// A `document` csonk, nem valódi DOM: a modul szerződése szerint a szülőelem
// és a dokumentum PARAMÉTER, nem keresés.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { attachEmbed, createEmbedFrame, sandboxFor, ALLOW, SANDBOX, UNSANDBOXED_FLAG } from '../src/features/player/embed-frame.js'
import { classify, declaredKind, normalise, SOURCE_KIND } from '../src/features/player2/engine/source-ranking.js'
import { engineFor, embedEngine, nativeEngine, hlsEngine } from '../src/features/player2/engine/engines.js'
import { createSourceManager } from '../src/features/player2/engine/source-manager.js'
import { createPlayer } from '../src/features/player2/core/player.js'

const quiet = { error () {}, warn () {}, log () {} }
const CIM = 'https://beagyazo.pelda/stream/s-2/169846/sub'

/** Elemcsonk: attribútumok és figyelők, semmi több. */
function elemCsonk (tag) {
  const attrs = {}
  const listeners = {}
  return {
    tagName: tag.toUpperCase(),
    style: {},
    className: '',
    attrs,
    parentNode: null,
    setAttribute (k, v) { attrs[k] = String(v) },
    getAttribute (k) { return attrs[k] ?? null },
    removeAttribute (k) { delete attrs[k] },
    addEventListener (t, fn, o) { (listeners[t] ||= []).push({ fn, once: o?.once }) },
    removeEventListener (t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter(l => l.fn !== fn) },
    remove () { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this) },
    /** Teszthez: esemény kiváltása. */
    fire (t) { (listeners[t] ?? []).slice().forEach(l => l.fn()) },
    listeners
  }
}

/** Videócsonk egy szülővel, ahogy a lejátszó dobozában ül. */
function videoSzulovel () {
  const video = elemCsonk('video')
  let src = ''
  const parent = {
    children: [],
    appendChild (node) { this.children.push(node); node.parentNode = this; return node }
  }
  video.parentNode = parent
  video.load = () => {}
  /*
   * A `src` BEÁLLÍTÁSA ESEMÉNYT VÁLT KI, mint egy valódi elemnél.
   *
   * Enélkül a natív motor is időtúllépésbe futna, és egy „a beágyazás után a
   * következő forrásra lép" teszt attól látszana zöldnek vagy pirosnak, hogy
   * a CSONK nem tud betölteni — nem attól, amit mér.
   */
  Object.defineProperty(video, 'src', {
    get () { return src },
    set (v) {
      src = String(v)
      if (src) setTimeout(() => video.fire('loadedmetadata'), 2)
    },
    configurable: true
  })
  video.ownerDocument = { createElement: elemCsonk }
  return { video, parent }
}

describe('a beágyazó keret', () => {
  it('https címből keretet készít', () => {
    const frame = createEmbedFrame(CIM, { document: { createElement: elemCsonk } })
    assert.equal(frame.getAttribute('src'), CIM)
    assert.equal(frame.className, 'player-embed')
  })

  /*
   * A HOMOKOZÓ JELENLÉTE A LÉNYEG. A `sandbox` attribútum nélkül az `iframe`
   * MINDENT megtehet — köztük elnavigálhatja a YUME-ot egy másik címre.
   */
  it('homokozóval jön létre, felső navigáció nélkül', () => {
    const frame = createEmbedFrame(CIM, { document: { createElement: elemCsonk } })
    const sandbox = frame.getAttribute('sandbox')
    assert.ok(sandbox, 'nincs sandbox attribútum — a keret mindent megtehet')
    assert.ok(sandbox.includes('allow-scripts'), 'a lejátszó script nélkül el sem indul')
    assert.ok(!sandbox.includes('allow-top-navigation'), 'a keret elvihetné az oldalt')
    assert.ok(!sandbox.includes('allow-popups'), 'a keret reklámablakot nyithatna')
    assert.ok(!sandbox.includes('allow-downloads'))
    assert.ok(!sandbox.includes('allow-modals'))
  })

  it('csak a lejátszáshoz kellő jogosultságokat kéri', () => {
    const frame = createEmbedFrame(CIM, { document: { createElement: elemCsonk } })
    const allow = frame.getAttribute('allow')
    assert.ok(allow.includes('fullscreen'))
    for (const tiltott of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'midi']) {
      assert.ok(!allow.includes(tiltott), `a keret ${tiltott} jogot kér`)
    }
  })

  it('a hivatkozó címből csak az eredetet adja tovább', () => {
    const frame = createEmbedFrame(CIM, { document: { createElement: elemCsonk } })
    // A teljes cím elárulná, melyik animét és részt nézi valaki.
    assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin')
  })

  it('nem https címre elhasal, nem csendben rossz keretet ad', () => {
    for (const rossz of ['javascript:alert(1)', 'http://a.hu/x', '//a.hu/x', '/x', '', null]) {
      assert.throws(() => createEmbedFrame(rossz, { document: { createElement: elemCsonk } }),
        /https/, `átengedte: ${String(rossz)}`)
    }
  })
})

describe('a keret beillesztése', () => {
  it('a videóelem mellé teszi, és elrejti a videót', async () => {
    const { video, parent } = videoSzulovel()
    const igeret = attachEmbed(video, CIM)
    const frame = parent.children[0]
    assert.ok(frame, 'nem került keret a lejátszó dobozába')
    assert.equal(video.style.display, 'none', 'a videóelem látszik a keret mögött')
    frame.fire('load')
    await igeret
  })

  /*
   * A `<video>` KIÜRÍTÉSE nem takarítás, hanem sávszélesség. Ha egy korábbi
   * forrás rajta maradt, a böngésző a keret mögött tovább töltené egy
   * videót, amit senki nem lát.
   */
  it('kiüríti a videóelemet, mielőtt elrejti', async () => {
    const { video, parent } = videoSzulovel()
    video.src = 'https://regi.pelda/film.mp4'
    let load = 0
    video.load = () => { load++ }
    const igeret = attachEmbed(video, CIM)
    parent.children[0].fire('load')
    await igeret
    assert.ok(load > 0, 'a videóelem betöltése nem lett megszakítva')
  })

  it('a lebontás eltünteti a keretet és visszahozza a videót', async () => {
    const { video, parent } = videoSzulovel()
    const igeret = attachEmbed(video, CIM)
    parent.children[0].fire('load')
    const teardown = await igeret

    teardown()
    assert.equal(parent.children.length, 0, 'a keret ottmaradt')
    assert.notEqual(video.style.display, 'none', 'a videóelem rejtve maradt')
  })

  it('a lebontás kétszer hívva sem hibázik', async () => {
    const { video, parent } = videoSzulovel()
    const igeret = attachEmbed(video, CIM)
    parent.children[0].fire('load')
    const teardown = await igeret
    teardown()
    teardown()
  })

  it('időtúllépésre elutasít, és nem hagyja ott a keretet', async () => {
    const { video, parent } = videoSzulovel()
    await assert.rejects(() => attachEmbed(video, CIM, { timeoutMs: 10 }), /időben/)
    assert.equal(parent.children.length, 0, 'a bukott keret ottmaradt a dobozban')
    assert.notEqual(video.style.display, 'none')
  })

  it('szülőelem nélkül hangosan elhasal', () => {
    const arva = elemCsonk('video')
    arva.parentNode = null
    assert.throws(() => attachEmbed(arva, CIM), /szülőelem/)
  })
})

describe('a beágyazás felismerése', () => {
  /*
   * EZ A KÉSZLET LEGFONTOSABB TESZTJE.
   *
   * Egy beágyazó cím semmiben nem különbözik egy videófájl címétől, tehát a
   * `classify()` `direct`-nek veszi — és a natív motor betöltené a `<video>`
   * elembe. A fajtát a szerver mondja meg; ha a `normalise()` nem venné át
   * tőle, ez a hiba némán visszatérne.
   */
  it('a címből NEM látszik, hogy beágyazás — ezért a szerver mondja meg', () => {
    assert.equal(classify(CIM), SOURCE_KIND.DIRECT, 'a fixtúra elavult')

    const bejelentesNelkul = normalise({ url: CIM })
    assert.equal(bejelentesNelkul.kind, SOURCE_KIND.DIRECT)

    const bejelentessel = normalise({ url: CIM, kind: 'embed' })
    assert.equal(bejelentessel.kind, SOURCE_KIND.EMBED,
      'a szerver bejelentett fajtája elveszett — a HTML-lap a <video>-ba kerülne')
  })

  it('a beágyazást a beágyazó motor viszi, nem a natív', () => {
    const jelolt = normalise({ url: CIM, kind: 'embed' })
    assert.equal(engineFor(jelolt), embedEngine)
    assert.ok(!nativeEngine.canPlay(jelolt), 'a natív motor elvinné a HTML-lapot')
    assert.ok(!hlsEngine.canPlay(jelolt))
  })

  it('a folyamforrások továbbra is a régi motorokhoz mennek', () => {
    assert.equal(engineFor(normalise({ url: 'https://a.hu/x.m3u8' })), hlsEngine)
    assert.equal(engineFor(normalise({ url: 'https://a.hu/x.mp4' })), nativeEngine)
    // És a beágyazó motor NEM viszi el őket.
    assert.ok(!embedEngine.canPlay(normalise({ url: 'https://a.hu/x.mp4' })))
    assert.ok(!embedEngine.canPlay(normalise({ url: 'https://a.hu/x.m3u8' })))
  })

  /*
   * A NÉZŐ BEILLESZTETT CÍME NEM LEHET BEÁGYAZÁS.
   *
   * A beillesztett rekord a `watch.js`-ben `{ url, title, source }` alakú —
   * `kind` mező nélkül. Ez a teszt azt rögzíti, hogy a bejelentés az EGYETLEN
   * út: aki csak címet ad, az nem kap `iframe`-et.
   */
  it('a puszta cím nem válik beágyazássá', () => {
    const beillesztett = normalise({ url: CIM, title: 'Manual source' })
    assert.notEqual(beillesztett.kind, SOURCE_KIND.EMBED)
    assert.ok(!embedEngine.canPlay(beillesztett))
  })
})

/*
 * A SZERVER BEJELENTETT FAJTÁJA — EGY MÉRT, ÉLES HIBA.
 *
 * Mérve valódi Firefoxban, élő AnimeParadise manifeszten
 * (`https://stream.animeparadise.moe/m3u8?url=<token>` — NINCS `.m3u8`
 * kiterjesztés):
 *
 *   a mai út:   kind=direct → natív motor → SOURCE_UNSUPPORTED
 *   HLS motorral ugyanaz: sikeres, 1556 mp
 *
 * Vagyis egy tökéletesen lejátszható folyam bukott el azon, hogy a címéből
 * nem látszott, mi az.
 */
describe('a szerver által bejelentett fajta', () => {
  const HLS_CIM = 'https://stream.animeparadise.moe/m3u8?url=Pg4I1_qqoha8MBE2cFg6'

  it('a kiterjesztés nélküli HLS-cím a CÍMBŐL direct-nek látszik', () => {
    assert.equal(classify(HLS_CIM), SOURCE_KIND.DIRECT, 'a fixtúra elavult')
  })

  it('a bejelentés HLS-motorhoz irányítja, nem a natívhoz', () => {
    const jelolt = normalise({ url: HLS_CIM, kind: 'hls' })
    assert.equal(jelolt.kind, SOURCE_KIND.HLS)
    assert.equal(engineFor(jelolt), hlsEngine)
    assert.ok(!nativeEngine.canPlay(jelolt), 'a natív motor vinné el a HLS-t')
  })

  it('minden bejelentett fajtát a helyes fajtára képez', () => {
    assert.equal(declaredKind('hls'), SOURCE_KIND.HLS)
    assert.equal(declaredKind('dash'), SOURCE_KIND.DASH)
    assert.equal(declaredKind('mp4'), SOURCE_KIND.DIRECT)
    assert.equal(declaredKind('embed'), SOURCE_KIND.EMBED)
  })

  it('ismeretlen bejelentésre a címből való felismerés dönt', () => {
    for (const rossz of ['valami', '', 'HLS', 'magnet', 42, null, undefined, {}]) {
      assert.equal(declaredKind(rossz), null, `elfogadta: ${String(rossz)}`)
    }
    // és a normalise ilyenkor a címre esik vissza
    assert.equal(normalise({ url: 'https://a.hu/x.m3u8', kind: 'valami' }).kind, SOURCE_KIND.HLS)
    assert.equal(normalise({ url: HLS_CIM, kind: 'valami' }).kind, SOURCE_KIND.DIRECT)
  })

  /*
   * A NÉZŐ BEILLESZTETT CÍME NEM VÁLASZTHAT MOTORT. A beillesztett rekord a
   * `watch.js`-ben `{ url, title, source }` alakú — `kind` mező nélkül.
   */
  it('a puszta cím nem tud fajtát bejelenteni', () => {
    const beillesztett = normalise({ url: HLS_CIM, title: 'Manual source' })
    assert.equal(beillesztett.kind, SOURCE_KIND.DIRECT)
  })

  it('a .m3u8 végű címek továbbra is a régi úton mennek', () => {
    assert.equal(normalise({ url: 'https://a.hu/x.m3u8' }).kind, SOURCE_KIND.HLS)
    assert.equal(normalise({ url: 'https://a.hu/x.mp4' }).kind, SOURCE_KIND.DIRECT)
    assert.equal(normalise({ url: 'https://a.hu/x.mpd' }).kind, SOURCE_KIND.DASH)
    assert.equal(normalise({ url: 'magnet:?xt=urn:btih:abc' }).kind, SOURCE_KIND.MAGNET)
  })
})

describe('a forráskezelő és a beágyazás', () => {
  /** Videócsonk, ami a szülőjével együtt a forráskezelőnek is jó. */
  function jatekos () {
    const { video, parent } = videoSzulovel()
    const player = createPlayer({ video, logger: quiet })
    return { player, video, parent }
  }

  it('beágyazott forrást elindít, és nem tesz semmit a videóelembe', async () => {
    const { player, video, parent } = jatekos()
    const sources = createSourceManager(player, { timeoutMs: 500 })
    sources.load([{ id: 'a1', url: CIM, kind: 'embed', variant: 'sub', provider: 'Anikoto' }])

    const fut = sources.start()
    // A keret a következő tickben kerül be; a `load` erre a példányra megy.
    await new Promise(resolve => setTimeout(resolve, 5))
    parent.children[0]?.fire('load')

    const eredmeny = await fut
    assert.equal(eredmeny.ok, true, 'a beágyazott forrás nem indult el')
    assert.equal(video.src, '', 'a beágyazó cím a <video> elembe került')
    player.destroy?.()
  })

  it('a beágyazás bukása után a következő forrásra lép', async () => {
    const { player, video } = jatekos()
    const sources = createSourceManager(player, { timeoutMs: 20 })
    sources.load([
      { id: 'a1', url: CIM, kind: 'embed', variant: 'sub' },
      { id: 'a2', url: 'https://a.hu/jo.mp4', variant: 'sub' }
    ])

    // A keret `load`-ja sosem jön → időtúllépés → tovább a második forrásra.
    const eredmeny = await sources.start()
    assert.equal(eredmeny.ok, true)
    assert.equal(eredmeny.candidate.url, 'https://a.hu/jo.mp4')
    assert.equal(video.src, 'https://a.hu/jo.mp4')
    player.destroy?.()
  })

  it('forrás nélkül továbbra is a „nincs forrás" állapot jön', async () => {
    const { player } = jatekos()
    const sources = createSourceManager(player, { timeoutMs: 20 })
    sources.load([])
    const eredmeny = await sources.start()
    assert.equal(eredmeny.ok, false)
    assert.equal(eredmeny.error.code, 'NO_SOURCE')
    player.destroy?.()
  })
})

/*
 * A HOMOKOZÓ FELOLDÁSA — KAPCSOLÓ MÖGÖTT.
 *
 * MÉRVE (2026-09-21, valódi Chromiumban): a `megaplay.buzz` lejátszója minden
 * homokozót elutasít, mind a tizenegy token megadásával is. Homokozó nélkül
 * elindul — de akkor a beágyazott lap elnavigálhatja a YUME-ot, és ablakot
 * nyithat. Ezért ez üzemeltetői döntés, és ezért ALAPBÓL ZÁRVA van.
 */
describe('a homokozó kapcsolója', () => {
  const be = () => true
  const ki = () => false

  it('alapból homokoz — beállítások nélkül is', () => {
    assert.equal(sandboxFor(), SANDBOX)
    assert.equal(sandboxFor({}), SANDBOX)
  })

  /*
   * A LEGFONTOSABB ÁLLÍTÁS ITT. A `featureOn` egy NEM LÉTEZŐ kapcsolóra
   * IGAZAT ad vissza — a többi funkciónál ez helyes, itt viszont azt
   * jelentené, hogy a migráció lefuttatása nélkül a homokozó mindenhol
   * feloldódik. A `flagDeclared` ezért nem díszítés.
   */
  it('a nem deklarált kapcsoló NEM oldja fel a homokozót', () => {
    assert.equal(sandboxFor({ flagDeclared: ki, featureOn: be }), SANDBOX)
  })

  it('a deklarált, de kikapcsolt kapcsoló sem oldja fel', () => {
    assert.equal(sandboxFor({ flagDeclared: be, featureOn: ki }), SANDBOX)
  })

  it('deklarált ÉS bekapcsolt kapcsolóval oldódik fel', () => {
    assert.equal(sandboxFor({ flagDeclared: be, featureOn: be }), null)
  })

  it('a kapcsolót a helyes kulcson kérdezi', () => {
    const kertKulcsok = []
    sandboxFor({
      flagDeclared: (k) => { kertKulcsok.push(['flagDeclared', k]); return true },
      featureOn: (k) => { kertKulcsok.push(['featureOn', k]); return true }
    })
    assert.deepEqual(kertKulcsok, [
      ['flagDeclared', 'feature.' + UNSANDBOXED_FLAG],
      ['featureOn', UNSANDBOXED_FLAG]
    ])
  })

  it('feloldva a keret sandbox attribútum NÉLKÜL jön létre', () => {
    const frame = createEmbedFrame(CIM, { document: { createElement: elemCsonk }, sandbox: null })
    assert.equal(frame.getAttribute('sandbox'), null, 'a homokozó ottmaradt')
    // Amit a feloldás NEM vesz el: ezek homokozó nélkül is érvényesek.
    assert.ok(frame.getAttribute('allow').includes('fullscreen'))
    assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin')
    for (const tiltott of ['camera', 'microphone', 'geolocation']) {
      assert.ok(!frame.getAttribute('allow').includes(tiltott),
        `homokozó nélkül a ${tiltott} is megnyílt`)
    }
  })

  it('a beillesztés is továbbadja a feloldást', async () => {
    const { video, parent } = videoSzulovel()
    const igeret = attachEmbed(video, CIM, { sandbox: null })
    assert.equal(parent.children[0].getAttribute('sandbox'), null)
    parent.children[0].fire('load')
    await igeret
  })
})

describe('a beágyazás állandói', () => {
  it('a sandbox és az allow exportálva van, hogy mérhető legyen', () => {
    assert.equal(typeof SANDBOX, 'string')
    assert.equal(typeof ALLOW, 'string')
  })
})
