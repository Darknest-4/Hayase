// Sub / dub classification and preference-aware ranking.
//
// This is pattern matching over release titles, which is exactly the kind of
// code that looks right and is wrong on the third example. The false-positive
// cases below are the point: "Subaru" is not a subtitle and "Dubai" is not a
// dub, and a word-boundary that goes missing would pass every happy-path test.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, before } from 'node:test'
import { createContext, runInNewContext } from 'node:vm'

let Engine

before(() => {
  // The client modules are plain scripts that assign globals, so they are run
  // in a fresh realm rather than imported.
  const context = createContext({
    window: {},
    document: { createElement: () => ({ canPlayType: () => '' }) },
    console
  })
  runInNewContext(readFileSync(new URL('../js/stream-engine.js', import.meta.url), 'utf8'), context)
  Engine = context.StreamEngine ?? context.window.StreamEngine
})

const classify = (raw, subs = []) => Engine.classifyVariant(raw, subs)

/**
 * Arrays built inside the vm realm have that realm's Array.prototype, so
 * assert.deepEqual reports "same structure but not reference-equal" against an
 * array literal from this file. A JSON round trip brings the value into this
 * realm; it compares the data, which is what these assertions are about.
 */
const plain = value => JSON.parse(JSON.stringify(value))

describe('language codes', () => {
  it('maps the spellings sources actually use', () => {
    for (const value of ['hu', 'HUN', 'hungarian', 'Magyar']) {
      assert.equal(Engine.languageCode(value), 'hu', `failed on ${value}`)
    }
    for (const value of ['en', 'ENG', 'English']) {
      assert.equal(Engine.languageCode(value), 'en', `failed on ${value}`)
    }
    for (const value of ['ja', 'jpn', 'Japanese']) {
      assert.equal(Engine.languageCode(value), 'ja', `failed on ${value}`)
    }
  })

  it('treats a region tag as the same language', () => {
    assert.equal(Engine.languageCode('hu-HU'), 'hu')
    assert.equal(Engine.languageCode('en_GB'), 'en')
  })

  it('returns null for nothing rather than a fake code', () => {
    assert.equal(Engine.languageCode(''), null)
    assert.equal(Engine.languageCode(null), null)
    assert.equal(Engine.languageCode(undefined), null)
  })
})

describe('variant classification', () => {
  it('trusts an explicit non-Japanese audio language over the title', () => {
    // The title says sub, the source says the audio is Hungarian. The source
    // wins: it knows what it is serving.
    const result = classify({ audio: 'hu', title: '[Group] Show - 01 [SUB]' })
    assert.equal(result.variant, 'dub')
    assert.equal(result.audioLang, 'hu')
  })

  it('calls Japanese audio with subtitles a sub', () => {
    const result = classify({ audio: 'ja', title: 'Show 01' }, [{ lang: 'hu', url: 'x' }])
    assert.equal(result.variant, 'sub')
    assert.deepEqual(plain(result.subLangs), ['hu'])
  })

  it('reads the release title when there is nothing else', () => {
    assert.equal(classify({ title: '[Group] Show - 01 [Dual Audio][1080p]' }).variant, 'dub')
    assert.equal(classify({ title: '[Group] Show - 01 [Multi-Sub]' }).variant, 'sub')
    assert.equal(classify({ title: '[Group] Show - 01 RAW 1080p' }).variant, 'raw')
  })

  it('reads Hungarian release wording', () => {
    assert.equal(classify({ title: 'Show 01 magyar szinkron' }).variant, 'dub')
    assert.equal(classify({ title: 'Show 01 magyar felirat' }).variant, 'sub')
    assert.equal(classify({ title: 'Show 01 szinkronos' }).variant, 'dub')
    assert.equal(classify({ title: 'Show 01 feliratos' }).variant, 'sub')
  })

  it('does not see a dub in "Subaru" or a sub in "Dubai"', () => {
    // Without word boundaries both of these match, and a viewer who asked for
    // a dub gets a subtitled release of a show whose character is called
    // Subaru. This is the case that decided the patterns.
    assert.equal(classify({ title: 'Re:Zero - Subaru special 01' }).variant, 'unknown')
    assert.equal(classify({ title: 'Journey to Dubai 01' }).variant, 'unknown')
    assert.equal(classify({ title: 'Doublework 01' }).variant, 'unknown')
  })

  it('prefers dub over sub for a dual-audio release', () => {
    // Dual audio carries both, and someone who asked for a dub can use it.
    assert.equal(classify({ title: 'Show 01 [Dual Audio][Subbed]' }).variant, 'dub')
  })

  it('says unknown rather than guessing', () => {
    // A wrong guess starts the wrong audio, which is worse than admitting it.
    const result = classify({ title: '[Group] Show - 01 [1080p][HEVC]' })
    assert.equal(result.variant, 'unknown')
    assert.equal(result.audioLang, null)
    assert.deepEqual(plain(result.subLangs), [])
  })

  it('infers a sub from subtitle tracks with no other signal', () => {
    assert.equal(classify({ title: 'Show 01' }, [{ lang: 'en', url: 'x' }]).variant, 'sub')
  })

  it('de-duplicates subtitle languages', () => {
    const result = classify({ title: 'Show' }, [
      { lang: 'hu', url: 'a' }, { lang: 'HUN', url: 'b' }, { lang: 'en', url: 'c' }
    ])
    assert.deepEqual(plain(result.subLangs).sort(), ['en', 'hu'])
  })

  it('survives junk without throwing', () => {
    for (const raw of [null, undefined, {}, { title: null }, { audio: 42 }]) {
      assert.doesNotThrow(() => classify(raw))
    }
  })
})

describe('preference-aware ranking', () => {
  const make = (over = {}) => ({
    playable: true,
    variant: 'sub',
    subLangs: [],
    quality: 1080,
    source: { slug: 's', name: 'S', health: 'unknown', accuracy: 'medium' },
    metadata: { seeders: 0 },
    ...over
  })

  it('puts the requested variant first even at lower quality', () => {
    // The whole point of the setting: a 1080p sub is the wrong answer for
    // someone who asked for a dub.
    const sub = make({ variant: 'sub', quality: 1080, id: 'sub' })
    const dub = make({ variant: 'dub', quality: 480, id: 'dub' })
    const ranked = Engine.rank([sub, dub], { variant: 'dub' })
    assert.equal(ranked[0].id, 'dub')
  })

  it('ranks unknown above the wrong variant but below the right one', () => {
    const right = make({ variant: 'dub', id: 'right' })
    const maybe = make({ variant: 'unknown', id: 'maybe' })
    const wrong = make({ variant: 'sub', id: 'wrong' })
    const ranked = Engine.rank([wrong, maybe, right], { variant: 'dub' })
    assert.deepEqual(plain(ranked.map(r => r.id)), ['right', 'maybe', 'wrong'])
  })

  it('lets quality decide again when no variant is preferred', () => {
    const low = make({ variant: 'dub', quality: 480, id: 'low' })
    const high = make({ variant: 'sub', quality: 1080, id: 'high' })
    assert.equal(Engine.rank([low, high], { variant: 'any' })[0].id, 'high')
    assert.equal(Engine.rank([low, high], {})[0].id, 'high')
  })

  it('prefers the requested subtitle language among equal variants', () => {
    const hu = make({ subLangs: ['hu'], quality: 480, id: 'hu' })
    const en = make({ subLangs: ['en'], quality: 1080, id: 'en' })
    assert.equal(Engine.rank([en, hu], { variant: 'sub', subtitles: 'hu' })[0].id, 'hu')
  })

  it('never ranks an unplayable candidate first, whatever the preference', () => {
    // Playability has to dominate: a perfectly matching stream the browser
    // cannot open is not a better answer than one it can.
    const perfect = make({ variant: 'dub', playable: false, id: 'perfect' })
    const usable = make({ variant: 'sub', playable: true, id: 'usable' })
    assert.equal(Engine.rank([perfect, usable], { variant: 'dub' })[0].id, 'usable')
  })

  it('does not mutate the array it was given', () => {
    const list = [make({ variant: 'sub', id: 'a' }), make({ variant: 'dub', id: 'b' })]
    Engine.rank(list, { variant: 'dub' })
    assert.deepEqual(plain(list.map(r => r.id)), ['a', 'b'])
  })
})
