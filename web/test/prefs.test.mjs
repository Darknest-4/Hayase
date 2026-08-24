// Client preferences, and the pin that keeps them honest.
//
// web/js/prefs.js repeats the defaults and allowed values that
// server/src/lib/preferences.ts declares. That duplication is deliberate — the
// client has to answer Prefs.get() before it has ever spoken to a server, so
// it cannot wait for the spec to arrive — but a duplicate that drifts is worse
// than no duplicate at all: the settings screen would save one thing and the
// API would store another, and nothing would report it.
//
// So the first group here reads the server file and asserts the two agree.
// They can be wrong together; they cannot drift apart quietly.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, beforeEach } from 'node:test'
import { createContext, runInNewContext } from 'node:vm'

const SERVER_SPEC = new URL('../../server/src/lib/preferences.ts', import.meta.url)
const CLIENT = new URL('../js/prefs.js', import.meta.url)

/** A minimal localStorage, so the module under test has somewhere to write. */
function fakeStorage () {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    _map: map
  }
}

function loadPrefs ({ languages = ['hu-HU'], storage = fakeStorage() } = {}) {
  const context = createContext({
    window: { navigator: { language: languages[0], languages } },
    localStorage: storage,
    Store: { activeProfileId: () => 'profile-1' },
    console
  })
  runInNewContext(readFileSync(CLIENT, 'utf8'), context)
  return { Prefs: context.Prefs ?? context.window.Prefs, storage, context }
}

/** Cross-realm values compare by structure after a JSON round trip. */
const plain = value => JSON.parse(JSON.stringify(value))

// ---------------------------------------------------------------------------

describe('client and server agree', () => {
  const serverSource = readFileSync(SERVER_SPEC, 'utf8')
  const { Prefs } = loadPrefs()

  /** Pull one field out of a PREFERENCES entry without importing TypeScript. */
  const serverEntries = () => {
    const entries = []
    // Each entry is a `{ key: '…', … }` block; the fields are on their own
    // lines, which is what makes this readable rather than a parser.
    for (const block of serverSource.split(/\n {2}\{\n/).slice(1)) {
      const key = /key: '([^']+)'/.exec(block)?.[1]
      if (!key) continue
      // `values:` is either a literal array or the UI_LANGUAGES constant.
      const raw = /values: (\[[^\]]*\]|\w+)/.exec(block)?.[1]
      const values = raw === 'UI_LANGUAGES'
        ? [...(/export const UI_LANGUAGES = \[([^\]]*)\]/.exec(serverSource)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1])
        : raw
          ? [...raw.matchAll(/'([^']+)'/g)].map(m => m[1])
          : null
      const dflt = /default: ([^,\n]+)/.exec(block)?.[1]?.trim()
      entries.push({ key, values: values && values.length ? values : null, default: dflt })
    }
    return entries
  }

  it('parses a plausible number of entries from the server file', () => {
    // Without this the two assertions below pass trivially if the parse ever
    // stops matching anything — which is exactly how a drift guard rots.
    assert.ok(serverEntries().length >= 6, `only parsed ${serverEntries().length} server preferences`)
  })

  it('declares the same set of keys', () => {
    const serverKeys = serverEntries().map(e => e.key).sort()
    const clientKeys = Object.keys(plain(Prefs.DEFAULTS)).sort()
    assert.deepEqual(clientKeys, serverKeys)
  })

  it('declares the same allowed values', () => {
    const clientValues = plain(Prefs.VALUES)
    for (const entry of serverEntries()) {
      if (!entry.values) {
        assert.ok(!(entry.key in clientValues), `${entry.key} is boolean on the server but has an enum on the client`)
        continue
      }
      assert.deepEqual(clientValues[entry.key], entry.values, `${entry.key} enums differ`)
    }
  })

  it('declares the same defaults', () => {
    const clientDefaults = plain(Prefs.DEFAULTS)
    for (const entry of serverEntries()) {
      // The server writes some defaults as a constant (DEFAULT_LANGUAGE)
      // rather than a literal; resolve the one that exists.
      const expected = entry.default === 'DEFAULT_LANGUAGE'
        ? 'hu'
        : entry.default.replace(/^'|'$/g, '') === 'true'
          ? true
          : entry.default.replace(/^'|'$/g, '') === 'false'
            ? false
            : entry.default.replace(/^'|'$/g, '')
      assert.equal(clientDefaults[entry.key], expected, `${entry.key} defaults differ`)
    }
  })
})

// ---------------------------------------------------------------------------

describe('reading and writing', () => {
  let Prefs, storage

  beforeEach(() => { ({ Prefs, storage } = loadPrefs()) })

  it('answers with defaults before anything is stored', () => {
    assert.equal(Prefs.get('language.ui'), 'hu')
    assert.equal(Prefs.get('playback.variant'), 'sub')
    assert.equal(Prefs.get('content.adult'), false)
  })

  it('stores and reads back a change', () => {
    Prefs.set({ 'playback.variant': 'dub' }, { sync: false })
    assert.equal(Prefs.get('playback.variant'), 'dub')
  })

  it('namespaces storage per profile', () => {
    // A household can have a Hungarian child profile and an English adult one
    // on the same login; a shared key would collapse them into each other.
    Prefs.set({ 'language.ui': 'en' }, { sync: false })
    assert.ok([...storage._map.keys()].some(k => k.includes('profile-1')))
  })

  it('rejects an unknown key instead of storing it', () => {
    Prefs.set({ 'evil.key': 'x' }, { sync: false })
    assert.equal(Prefs.get('evil.key'), undefined)
  })

  it('repairs an invalid value to the default', () => {
    Prefs.set({ 'playback.variant': 'nonsense' }, { sync: false })
    assert.equal(Prefs.get('playback.variant'), 'sub')
  })

  it('reports only what actually changed', () => {
    Prefs.set({ 'language.ui': 'en' }, { sync: false })
    const second = Prefs.set({ 'language.ui': 'en', 'playback.variant': 'dub' }, { sync: false })
    assert.deepEqual(Object.keys(plain(second)), ['playback.variant'])
  })

  it('survives storage that throws', () => {
    // Private windows and blocked site data both do this, and a preference is
    // never worth breaking a page over.
    const hostile = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => {}
    }
    const { Prefs: p } = loadPrefs({ storage: hostile })
    assert.doesNotThrow(() => p.all())
    assert.equal(p.get('language.ui'), 'hu')
    assert.doesNotThrow(() => p.set({ 'language.ui': 'en' }, { sync: false }))
  })

  it('does not trap a viewer in the wizard when storage is unavailable', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => {}
    }
    const { Prefs: p } = loadPrefs({ storage: hostile })
    assert.equal(p.onboarded(), true)
  })
})

describe('change listeners', () => {
  it('notifies on a change and can be unsubscribed', () => {
    const { Prefs } = loadPrefs()
    const seen = []
    const off = Prefs.onChange(changed => seen.push(plain(changed)))
    Prefs.set({ 'language.ui': 'en' }, { sync: false })
    off()
    Prefs.set({ 'playback.variant': 'dub' }, { sync: false })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0], { 'language.ui': 'en' })
  })

  it('keeps notifying the others when one listener throws', () => {
    // A settings change that half-applies across the UI is worse than one
    // broken listener.
    const { Prefs } = loadPrefs()
    let reached = false
    Prefs.onChange(() => { throw new Error('boom') })
    Prefs.onChange(() => { reached = true })
    assert.doesNotThrow(() => Prefs.set({ 'language.ui': 'en' }, { sync: false }))
    assert.equal(reached, true)
  })
})

describe('first-visit language guess', () => {
  it('takes a language we speak from the browser', () => {
    assert.equal(loadPrefs({ languages: ['hu-HU'] }).Prefs.guessLanguage(), 'hu')
    assert.equal(loadPrefs({ languages: ['en-US', 'en'] }).Prefs.guessLanguage(), 'en')
  })

  it('walks past languages we do not speak', () => {
    assert.equal(loadPrefs({ languages: ['de-DE', 'fr', 'en-GB'] }).Prefs.guessLanguage(), 'en')
  })

  it('guesses Hungarian when the browser says nothing useful', () => {
    // This is a Hungarian site; anyone who wants English switches in one click.
    assert.equal(loadPrefs({ languages: ['de-DE', 'fr'] }).Prefs.guessLanguage(), 'hu')
  })
})
