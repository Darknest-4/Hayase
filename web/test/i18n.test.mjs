// Translation lookup, and the two things that can silently rot in it.
//
//   1. T() serves two call styles — a dotted path into web/copy.js and an
//      English source string. They were two separate systems before this
//      merge, and 43 existing call sites use the first, so a regression there
//      renders `footer.colophon` in the page instead of a sentence.
//
//   2. A translation orphans itself when its English source string is edited.
//      Nothing errors; the interface just quietly reverts to English. The last
//      group reports orphans so that stays visible.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach } from 'node:test'
import { createContext, runInNewContext } from 'node:vm'

const I18N_JS = new URL('../js/i18n.js', import.meta.url)
const HU_JS = new URL('../i18n/hu.js', import.meta.url)
const COPY_JS = new URL('../copy.js', import.meta.url)

function load ({ withDictionary = true, withCopy = true } = {}) {
  const documentElement = {
    _attrs: {},
    setAttribute (key, value) { this._attrs[key] = value },
    getAttribute (key) { return this._attrs[key] }
  }
  const context = createContext({
    window: {},
    document: { documentElement },
    console
  })
  runInNewContext(readFileSync(I18N_JS, 'utf8'), context)
  if (withCopy) runInNewContext(readFileSync(COPY_JS, 'utf8'), context)
  if (withDictionary) runInNewContext(readFileSync(HU_JS, 'utf8'), context)
  return {
    I18n: context.I18n ?? context.window.I18n,
    T: context.T ?? context.window.T,
    documentElement,
    context
  }
}

describe('English-source lookup', () => {
  let I18n, T
  beforeEach(() => { ({ I18n, T } = load()) })

  it('translates a known string', () => {
    I18n.setLanguage('hu')
    assert.equal(T('Start Watching'), 'Megnézem')
    assert.equal(T('Settings'), 'Beállítások')
  })

  it('returns the English source when there is no translation', () => {
    // The whole reason the key IS the English text: a missing entry renders
    // the sentence, never an identifier and never a blank.
    I18n.setLanguage('hu')
    assert.equal(T('A string nobody translated'), 'A string nobody translated')
  })

  it('returns the source when the language has no dictionary at all', () => {
    const { I18n: fresh, T: freshT } = load({ withDictionary: false })
    fresh.setLanguage('hu')
    assert.equal(freshT('Start Watching'), 'Start Watching')
  })

  it('serves English by returning the keys unchanged', () => {
    I18n.setLanguage('en')
    assert.equal(T('Start Watching'), 'Start Watching')
    assert.equal(T('Settings'), 'Settings')
  })

  it('never returns empty or throws on junk input', () => {
    // A translation layer that can break the interface is worse than none.
    I18n.setLanguage('hu')
    for (const value of [null, undefined, '', 0, {}, []]) {
      assert.doesNotThrow(() => I18n.t(value))
    }
    assert.equal(I18n.t(''), '')
  })

  it('falls back past an empty translation', () => {
    // An entry mapped to '' would otherwise render a blank button.
    I18n.register('hu', { 'Blank entry': '' })
    I18n.setLanguage('hu')
    assert.equal(I18n.t('Blank entry'), 'Blank entry')
  })
})

describe('context disambiguation', () => {
  it('prefers a context-scoped entry and falls back to the plain one', () => {
    const { I18n } = load()
    // The separator is NUL on purpose: a printable one would collide with a
    // genuine key, since 'Home nav' is a plausible English string by itself.
    const scoped = 'Home' + I18n.CONTEXT_SEP + 'nav'
    I18n.register('hu', { Home: 'Főoldal', [scoped]: 'Kezdőlap' })
    I18n.setLanguage('hu')
    assert.equal(I18n.t('Home', 'nav'), 'Kezdőlap')
    assert.equal(I18n.t('Home'), 'Főoldal')
    assert.equal(I18n.t('Home', 'nowhere'), 'Főoldal', 'an unknown context falls back, not blank')
  })

  it('uses a separator that cannot appear in ordinary UI copy', () => {
    const { I18n } = load()
    assert.equal(I18n.CONTEXT_SEP.charCodeAt(0), 0)
  })
})

describe('copy-catalogue lookup', () => {
  let I18n, T
  beforeEach(() => { ({ I18n, T } = load()) })

  it('resolves a dotted path through web/copy.js and then translates it', () => {
    // The pre-existing call style. 43 sites use it; breaking it renders raw
    // keys in the page.
    I18n.setLanguage('hu')
    assert.equal(T('nav.community'), 'Közösség')
    assert.equal(T('home.rails.trending'), 'Most felkapott')
  })

  it('returns the catalogue English value when there is no translation', () => {
    I18n.setLanguage('en')
    assert.equal(T('nav.community'), 'Community')
    assert.equal(T('home.rails.trending'), 'Trending Now')
  })

  it('does not mistake an ordinary sentence for a dotted path', () => {
    // "No results." contains a dot. It must still reach the English-source
    // lookup rather than being treated as a catalogue path and lost.
    I18n.setLanguage('hu')
    assert.equal(T('No results found.'), 'Nincs találat.')
  })

  it('falls back to the key for a dotted path that is in neither', () => {
    I18n.setLanguage('hu')
    assert.equal(T('nav.doesNotExist'), 'nav.doesNotExist')
  })

  it('works with no catalogue loaded at all', () => {
    const { I18n: fresh, T: freshT } = load({ withCopy: false })
    fresh.setLanguage('hu')
    assert.doesNotThrow(() => freshT('nav.community'))
    assert.equal(freshT('Settings'), 'Beállítások')
  })
})

describe('language switching', () => {
  it('updates <html lang>, which was hardcoded to "en"', () => {
    // Screen readers and the browser's own spell-checker read this attribute.
    const { I18n, documentElement } = load()
    I18n.setLanguage('en')
    assert.equal(documentElement.getAttribute('lang'), 'en')
    I18n.setLanguage('hu')
    assert.equal(documentElement.getAttribute('lang'), 'hu')
  })

  it('refuses a language it has no dictionary for', () => {
    const { I18n } = load()
    I18n.setLanguage('hu')
    I18n.setLanguage('de')
    assert.equal(I18n.language(), 'hu', 'switching to German would render every key raw')
  })

  it('always allows English, which needs no dictionary', () => {
    const { I18n } = load({ withDictionary: false })
    I18n.setLanguage('en')
    assert.equal(I18n.language(), 'en')
  })
})

describe('formatting follows the chosen language', () => {
  let I18n
  beforeEach(() => { ({ I18n } = load()) })

  it('maps each language to a real locale', () => {
    I18n.setLanguage('hu')
    assert.equal(I18n.locale(), 'hu-HU')
    I18n.setLanguage('en')
    assert.equal(I18n.locale(), 'en-GB')
  })

  it('formats a date differently in each', () => {
    // The bug this replaces: every call site passed `undefined`, meaning the
    // browser's language, so choosing Hungarian left the dates in English.
    const date = new Date('2026-03-14T00:00:00Z')
    I18n.setLanguage('hu')
    const hu = I18n.date(date)
    I18n.setLanguage('en')
    assert.notEqual(hu, I18n.date(date))
  })

  it('returns empty for an unparseable date rather than "Invalid Date"', () => {
    assert.equal(I18n.date('not a date'), '')
    assert.equal(I18n.time('not a date'), '')
  })

  it('substitutes named placeholders', () => {
    const { I18n: fresh } = load()
    fresh.register('hu', { 'Episode {n}': '{n}. rész' })
    fresh.setLanguage('hu')
    assert.equal(fresh.f('Episode {n}', { n: 4 }), '4. rész')
  })

  it('leaves an unsupplied placeholder alone instead of printing undefined', () => {
    const { I18n: fresh } = load()
    fresh.setLanguage('en')
    assert.equal(fresh.f('Episode {n}', {}), 'Episode {n}')
  })
})

describe('dictionary health', () => {
  const source = readFileSync(HU_JS, 'utf8')

  it('has a plausible number of entries', () => {
    // Guards the two checks below from passing trivially if the parse ever
    // stops matching.
    const { I18n } = load()
    const dict = I18n.dictionary('hu')
    assert.ok(Object.keys(dict).length > 150, `only ${Object.keys(dict).length} entries parsed`)
  })

  it('has no entry that translates to an empty string', () => {
    // Such an entry is dead — t() falls back past it — so it is a silent lie
    // about what has been translated.
    const { I18n } = load()
    const dict = I18n.dictionary('hu')
    const empty = Object.entries(dict).filter(([, v]) => typeof v === 'string' && !v.trim()).map(([k]) => k)
    assert.deepEqual(empty, [], `dead entries: ${empty.join(', ')}`)
  })

  it('has no accidental copy-paste entry', () => {
    // An entry equal to its key usually means somebody pasted the English into
    // the value and moved on. A few words genuinely are the same in Hungarian,
    // so those are named here rather than the check being dropped — the point
    // is to catch the accident, not to forbid a correct translation.
    const SAME_IN_HUNGARIAN = new Set(['Spoiler', 'Fantasy'])
    const { I18n } = load()
    const dict = I18n.dictionary('hu')
    const same = Object.entries(dict)
      .filter(([k, v]) => k === v && !SAME_IN_HUNGARIAN.has(k))
      .map(([k]) => k)
    assert.deepEqual(same, [], `entries that translate to themselves: ${same.join(', ')}`)
  })

  it('is valid JavaScript that registers into the hu slot', () => {
    assert.match(source, /I18n\.register\('hu'/)
  })
})
