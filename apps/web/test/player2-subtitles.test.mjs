// Player 2.0 — felirat, minőség, átugrás.
//
// Mindhárom modul DOM nélkül fut. A feliratnál a legfontosabb eset nem a
// helyes formátum, hanem a rosszindulatú: egy .srt fájl idegen forrásból jön,
// és a tartalma soha nem kerülhet be címkeként a lapba.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  parseTimestamp, stripMarkup, parseSubtitles, toVtt, shift
} from '../src/features/player2/subtitles/subtitle-parser.js'
import {
  languageCode, scoreTrack, selectTrack, subtitleStyle
} from '../src/features/player2/subtitles/subtitle-manager.js'
import {
  qualityValue, availableQualities, networkCap, chooseQuality
} from '../src/features/player2/quality/quality-manager.js'
import {
  SKIP_KIND, normaliseSegments, segmentAt, createSkipManager
} from '../src/features/player2/skip/skip-manager.js'
import { createPlayer } from '../src/features/player2/core/player.js'

const quiet = { error () {}, warn () {}, log () {} }

function fakeVideo (overrides = {}) {
  const listeners = {}
  return {
    paused: true,
    currentTime: 0,
    duration: 1400,
    addEventListener (type, fn) { (listeners[type] ||= []).push(fn) },
    removeEventListener (type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn) },
    fire (type) { (listeners[type] ?? []).slice().forEach(fn => fn()) },
    ...overrides
  }
}

describe('feliratelemzés', () => {
  it('mindkét időformátumot érti', () => {
    assert.equal(parseTimestamp('00:00:01,500'), 1.5) // SRT: vessző
    assert.equal(parseTimestamp('00:00:01.500'), 1.5) // VTT: pont
    assert.equal(parseTimestamp('01:02:03.250'), 3723.25)
    assert.equal(parseTimestamp('02:03.250'), 123.25) // óra nélkül
    assert.equal(parseTimestamp('semmi'), null)
  })

  it('a hibás blokkot kihagyja, a többit beolvassa', () => {
    const cues = parseSubtitles([
      '1', '00:00:01,000 --> 00:00:02,000', 'Első',
      '',
      '2', 'ez nem időbélyeg', 'Ez kimarad',
      '',
      '3', '00:00:03,000 --> 00:00:04,000', 'Harmadik'
    ].join('\n'))
    assert.equal(cues.length, 2)
    assert.equal(cues[0].text, 'Első')
    assert.equal(cues[1].text, 'Harmadik')
  })

  it('a fordított idejű blokkot eldobja', () => {
    const cues = parseSubtitles('1\n00:00:05,000 --> 00:00:02,000\nvissza')
    assert.equal(cues.length, 0)
  })

  it('kiszedi a címkéket', () => {
    assert.equal(stripMarkup('<i>Dőlt</i> és <b>vastag</b>'), 'Dőlt és vastag')
    assert.equal(stripMarkup('{\\an8}fent'), 'fent')
  })

  it('a szkriptet nem engedi be — sem nyersen, sem entitásként', () => {
    // Nyers címke: a lejátszó szövegként teszi ki, de a szűrés sem árt.
    assert.equal(stripMarkup('<img src=x onerror=alert(1)>szöveg'), 'szöveg')

    /*
     * A VESZÉLYES eset: az entitás visszafejtése után KELETKEZIK a címke.
     * Egyetlen szűrőmenet ezt átengedi — a `&lt;script&gt;` nem címke, amíg
     * dekódolva nincs. Ezért fut a szűrés kétszer.
     */
    const decoded = stripMarkup('&lt;script&gt;alert(1)&lt;/script&gt;')
    assert.ok(!decoded.includes('<'), `címke maradt: ${decoded}`)
    assert.ok(!decoded.includes('script'), `„script" maradt: ${decoded}`)
  })

  it('VTT-t ad vissza fejléccel és ponttal', () => {
    const vtt = toVtt(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nSzöveg'))
    assert.ok(vtt.startsWith('WEBVTT'))
    assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.000'))
  })

  it('a késleltetés ezredmásodpercben számol, és mindkét végpontot mozgatja', () => {
    const [cue] = shift(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx'), 500)
    assert.equal(cue.start, 1.5)
    assert.equal(cue.end, 2.5)
  })

  it('a nulla elé csúszott jelzés kezdete nulla, a teljesen kicsúszott eltűnik', () => {
    const [partial] = shift(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx'), -1500)
    assert.equal(partial.start, 0, 'negatív kezdés maradt')
    assert.equal(partial.end, 0.5)
    assert.equal(shift(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx'), -5000).length, 0)
  })
})

describe('feliratsáv választása', () => {
  it('nyelvi kódot normalizál', () => {
    assert.equal(languageCode('hu-HU'), 'hu')
    assert.equal(languageCode('Hungarian'), 'hu')
    assert.equal(languageCode('jpn'), 'ja')
    assert.equal(languageCode(''), null)
  })

  it('a kért nyelvet választja', () => {
    const tracks = [{ language: 'en' }, { language: 'hu' }, { language: 'ja' }]
    assert.equal(selectTrack(tracks, { language: 'hu' }).language, 'hu')
  })

  it('a teljes sávot elsőbbségben részesíti a kényszerítettel szemben', () => {
    // A kényszerített sáv csak az idegen nyelvű részeket felirátozza. Aki
    // feliratot kért, annak a teljes verzió jár.
    const tracks = [{ language: 'hu', forced: true, default: true }, { language: 'hu' }]
    assert.equal(selectTrack(tracks, { language: 'hu' }).forced, undefined)
  })

  it('a kikapcsolt felirat nem ugyanaz, mint a hiányzó', () => {
    assert.equal(selectTrack([{ language: 'hu' }], { language: 'hu', enabled: false }), null)
    assert.equal(selectTrack([], { language: 'hu' }), null)
  })

  it('rossz nyelvű kényszerített sávnál inkább semmit', () => {
    assert.equal(selectTrack([{ language: 'de', forced: true }], { language: 'hu' }), null)
  })

  it('az angol értelmes második esély', () => {
    assert.equal(selectTrack([{ language: 'de' }, { language: 'en' }], { language: 'hu' }).language, 'en')
    assert.ok(scoreTrack({ language: 'hu' }, 'hu') > scoreTrack({ language: 'en' }, 'hu'))
  })

  it('a stílusból CSS-változó lesz, korlátok közé szorítva', () => {
    const style = subtitleStyle({ 'player.subtitle.size': 500, 'player.subtitle.backgroundOpacity': 3 })
    assert.equal(style['--yp-sub-size'], '2') // 200% a plafon
    assert.equal(style['--yp-sub-bg-opacity'], '1')
    assert.equal(subtitleStyle({})['--yp-sub-size'], '1')
  })
})

describe('minőségválasztás', () => {
  it('csak a tényleg létező felbontásokat sorolja fel, egyszer', () => {
    assert.deepEqual(availableQualities([{ quality: 720 }, { quality: 1080 }, { quality: 1080 }, {}]), [1080, 720])
  })

  it('az auto nem szám', () => {
    assert.equal(qualityValue('auto'), null)
    assert.equal(qualityValue('1080'), 1080)
  })

  it('a kézi választás erősebb a hálózati korlátnál', () => {
    const chosen = chooseQuality({
      available: [1080, 480],
      manual: '1080',
      prefs: { 'player.quality.wifi': '480' },
      network: { type: 'wifi' }
    })
    assert.equal(chosen.quality, 1080)
    assert.equal(chosen.auto, false)
  })

  it('az adattakarékos módot semmi nem írja felül', () => {
    const chosen = chooseQuality({
      available: [1080, 720, 480],
      prefs: { 'player.quality.dataSaver': true, 'player.quality.wifi': '1080' },
      network: { type: 'wifi' }
    })
    assert.equal(chosen.quality, 480)
  })

  it('a korlát alatti legjobbat veszi', () => {
    assert.equal(networkCap({ 'player.quality.mobile': '480' }, { type: 'cellular' }), 480)
    assert.equal(chooseQuality({
      available: [1080, 720, 480], prefs: { 'player.quality.mobile': '720' }, network: { type: 'cellular' }
    }).quality, 720)
  })

  it('ha minden a korlát fölött van, a legkisebbet adja — nem semmit', () => {
    const chosen = chooseQuality({ available: [2160, 1440], prefs: { 'player.quality.dataSaver': true } })
    assert.equal(chosen.quality, 1440)
  })

  it('üres listára nem talál ki felbontást', () => {
    assert.equal(chooseQuality({ available: [] }).quality, null)
    // A 13. pont kifejezett kérése: nem hirdetünk olyat, ami nincs.
    assert.equal(chooseQuality({ available: [720], manual: '2160' }).quality, 720)
  })
})

describe('átugrás', () => {
  it('a hibás sor kimarad, a többi marad', () => {
    const segments = normaliseSegments([
      { kind: 'intro', start_sec: 10, end_sec: 100 },
      { kind: 'kitalált', start_sec: 1, end_sec: 2 },
      { kind: 'outro', start_sec: 50, end_sec: 40 } // fordított
    ])
    assert.equal(segments.length, 1)
    assert.equal(segments[0].kind, SKIP_KIND.INTRO)
  })

  it('fajtánként a legtöbb szavazatot kapott marad', () => {
    const segments = normaliseSegments([
      { kind: 'intro', start_sec: 10, end_sec: 100, votes: 3 },
      { kind: 'intro', start_sec: 12, end_sec: 102, votes: 9 }
    ])
    assert.equal(segments.length, 1)
    assert.equal(segments[0].start, 12)
  })

  it('a legvégén nem villantja fel a gombot', () => {
    // Az outró átugrása ÉRVÉNYES művelet: a végére ugrás indítja a következő
    // részt. Amit kerülünk, az a két másodpercre megjelenő gomb — az már csak
    // villan egyet, mert a videó magától is véget ér.
    const outro = [{ kind: 'outro', start: 1380, end: 1400, votes: 1 }]
    assert.equal(segmentAt(outro, 1385, 1400)?.kind, 'outro')
    assert.equal(segmentAt(outro, 1399, 1400), null, 'az utolsó másodpercben is felvillan')
    assert.ok(segmentAt(outro, 1399, 0), 'ismeretlen hossznál nincs mihez mérni')
  })

  it('automatikusan ugrik, ha a néző kérte, és csak egyszer', () => {
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    const skipped = []
    player.bus.on('episode:skip-intro', s => skipped.push(s))
    const manager = createSkipManager(player, { prefs: { get: key => key === 'player.skip.introAuto' } })
    manager.load([{ kind: 'intro', start_sec: 10, end_sec: 100 }])

    video.currentTime = 20
    video.fire('timeupdate')
    assert.equal(video.currentTime, 100, 'nem ugrott az intró végére')
    assert.equal(skipped.length, 1)

    // A `timeupdate` sorozatban jön; a második nem ugorhat újra.
    video.fire('timeupdate')
    assert.equal(skipped.length, 1)
    player.destroy()
  })

  it('kézi módban csak felajánlja', () => {
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    const manager = createSkipManager(player, { prefs: { get: () => false } })
    manager.load([{ kind: 'intro', start_sec: 10, end_sec: 100 }])

    video.currentTime = 20
    video.fire('timeupdate')
    assert.equal(video.currentTime, 20, 'kézi módban nem ugorhat magától')
    assert.equal(player.state.get().ui.skipSegment?.kind, 'intro')

    assert.equal(manager.skip(), true)
    assert.equal(video.currentTime, 100)
    assert.equal(player.state.get().ui.skipSegment, null)
    player.destroy()
  })

  it('a visszatekerés visszahozza a gombot', () => {
    // Aki szándékosan visszatekert az intróra, az látni akarja — és ha
    // mégis továbbugrana, kelljen újra elérhetőnek lennie a gombnak.
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    const manager = createSkipManager(player, { prefs: { get: () => false } })
    manager.load([{ kind: 'intro', start_sec: 10, end_sec: 100 }])

    video.currentTime = 20
    video.fire('timeupdate')
    manager.skip()
    assert.equal(player.state.get().ui.skipSegment, null)

    video.currentTime = 20
    video.fire('seeked')
    assert.equal(player.state.get().ui.skipSegment?.kind, 'intro', 'a gomb nem jött vissza')
    player.destroy()
  })

  it('a szakaszon kívül nincs mit ajánlani', () => {
    const video = fakeVideo()
    const player = createPlayer({ video, logger: quiet })
    const manager = createSkipManager(player, {})
    manager.load([{ kind: 'intro', start_sec: 10, end_sec: 100 }])

    video.currentTime = 200
    video.fire('timeupdate')
    assert.equal(player.state.get().ui.skipSegment, null)
    assert.equal(manager.skip(), false)
    player.destroy()
  })
})
