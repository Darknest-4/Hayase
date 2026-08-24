// The preference spec, value coercion, and Accept-Language negotiation.
//
// All pure, so all of it runs without a database. The spec is the single place
// that says what a preference is called and what it may hold, so the first
// group guards its shape rather than its contents — a malformed entry there
// breaks the settings screen and the onboarding wizard at once.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PREFERENCES, UI_LANGUAGES, DEFAULT_LANGUAGE,
  coerce, defaults, isPreferenceKey, negotiate, requestLanguage, resolve, specFor
} from '../src/lib/preferences.ts'

describe('preference spec', () => {
  it('has no duplicate keys', () => {
    const keys = PREFERENCES.map(p => p.key)
    assert.equal(new Set(keys).size, keys.length)
  })

  it('gives every preference a default that is one of its own allowed values', () => {
    // A default outside the enum makes coerce() return an invalid value on
    // every unset preference, which is invisible until something downstream
    // switches on it.
    for (const spec of PREFERENCES) {
      if (!spec.values) {
        assert.equal(typeof spec.default, 'boolean', `${spec.key} has no enum so it must be boolean`)
        continue
      }
      assert.ok(spec.values.includes(spec.default as string), `${spec.key}: default ${String(spec.default)} not in enum`)
    }
  })

  it('gives every preference a label and a group the settings UI renders', () => {
    for (const spec of PREFERENCES) {
      assert.ok(spec.label && spec.label.length > 2, `${spec.key} has no usable label`)
      assert.ok(['language', 'playback', 'content'].includes(spec.group), `${spec.key} has group ${spec.group}`)
    }
  })

  it('offers a small enough onboarding set to fit three steps', () => {
    // More than about six and the wizard stops being answerable and people
    // click through it, which produces worse data than not asking.
    const onboarding = PREFERENCES.filter(p => p.onboarding)
    assert.ok(onboarding.length >= 3, 'the wizard needs something to ask')
    assert.ok(onboarding.length <= 6, `${onboarding.length} onboarding questions is too many for three steps`)
  })

  it('carries the sub/dub switch, which the watch page reads by name', () => {
    const variant = specFor('playback.variant')
    assert.ok(variant)
    assert.deepEqual([...(variant.values ?? [])], ['sub', 'dub', 'any'])
    assert.equal(variant.default, 'sub')
  })
})

describe('coerce', () => {
  it('accepts a valid enum value', () => {
    assert.equal(coerce('playback.variant', 'dub'), 'dub')
    assert.equal(coerce('language.ui', 'en'), 'en')
  })

  it('falls back to the default rather than throwing on nonsense', () => {
    // Preferences are cosmetic: a bad value must never fail a request or leave
    // a viewer with a broken screen.
    assert.equal(coerce('playback.variant', 'nonsense'), 'sub')
    assert.equal(coerce('playback.variant', 42), 'sub')
    assert.equal(coerce('playback.variant', null), 'sub')
    assert.equal(coerce('language.ui', ''), DEFAULT_LANGUAGE)
  })

  it('returns undefined for an unknown key so the route can reject it', () => {
    // An unknown key is a client bug worth surfacing, unlike a bad value.
    assert.equal(coerce('evil.key', 'x'), undefined)
    assert.equal(coerce('__proto__', 'x'), undefined)
    assert.equal(coerce('constructor', 'x'), undefined)
  })

  it('takes booleans as booleans and as the strings a form sends', () => {
    assert.equal(coerce('content.adult', true), true)
    assert.equal(coerce('content.adult', false), false)
    assert.equal(coerce('content.adult', 'true'), true)
    assert.equal(coerce('content.adult', 'false'), false)
  })

  it('does not treat a random string as true', () => {
    // `Boolean('no')` is true, which would turn "no" into "yes".
    assert.equal(coerce('content.adult', 'no'), false)
  })
})

describe('resolve', () => {
  it('fills in every default when nothing is stored', () => {
    assert.deepEqual(resolve({}), defaults())
    assert.deepEqual(resolve(), defaults())
  })

  it('applies stored values over the defaults', () => {
    const out = resolve({ 'language.ui': 'en', 'playback.variant': 'dub' })
    assert.equal(out['language.ui'], 'en')
    assert.equal(out['playback.variant'], 'dub')
    assert.equal(out['language.titles'], 'romaji', 'untouched keys keep their default')
  })

  it('drops keys that are no longer preferences', () => {
    // A preference removed from the spec leaves rows behind in user_settings;
    // they must not reappear in the resolved object.
    const out = resolve({ 'removed.preference': 'x', 'language.ui': 'en' })
    assert.ok(!('removed.preference' in out))
    assert.equal(out['language.ui'], 'en')
  })

  it('repairs a stored value that is no longer valid', () => {
    // An enum narrowed in a later release leaves invalid rows in the database.
    assert.equal(resolve({ 'playback.variant': 'gone' })['playback.variant'], 'sub')
  })
})

describe('isPreferenceKey', () => {
  it('recognises real keys and nothing else', () => {
    assert.equal(isPreferenceKey('language.ui'), true)
    assert.equal(isPreferenceKey('nope'), false)
    // Map-backed, so prototype keys are not accidental members.
    assert.equal(isPreferenceKey('toString'), false)
    assert.equal(isPreferenceKey('__proto__'), false)
  })
})

describe('Accept-Language', () => {
  it('picks a language we speak', () => {
    assert.equal(negotiate('hu'), 'hu')
    assert.equal(negotiate('en'), 'en')
  })

  it('treats a region tag as its base language', () => {
    assert.equal(negotiate('hu-HU'), 'hu')
    assert.equal(negotiate('en-GB,en;q=0.9'), 'en')
  })

  it('honours quality values instead of taking the first entry', () => {
    // Ignoring q picks the wrong language for anyone whose first choice we do
    // not speak — here, a German speaker who prefers Hungarian over English.
    assert.equal(negotiate('de;q=1.0, hu;q=0.9, en;q=0.8'), 'hu')
    assert.equal(negotiate('de, en;q=0.5, hu;q=0.9'), 'hu')
  })

  it('skips a language explicitly refused with q=0', () => {
    assert.equal(negotiate('hu;q=0, en;q=0.5'), 'en')
  })

  it('returns null when it cannot serve anything, so the caller decides', () => {
    assert.equal(negotiate('de,fr'), null)
    assert.equal(negotiate(''), null)
    assert.equal(negotiate(undefined), null)
    assert.equal(negotiate(null), null)
  })

  it('reads a wildcard as the site default', () => {
    assert.equal(negotiate('*'), DEFAULT_LANGUAGE)
  })

  it('survives a malformed header', () => {
    for (const header of [';;;', 'hu;q=', 'hu;q=abc', ',,,', 'hu;;q=0.5']) {
      assert.doesNotThrow(() => negotiate(header), `threw on ${header}`)
    }
    // A malformed q is treated as absent (1.0), not as zero — reading it as
    // zero would silently discard the entry.
    assert.equal(negotiate('hu;q=abc'), 'hu')
  })
})

describe('requestLanguage precedence', () => {
  it('lets an explicit choice beat everything', () => {
    assert.equal(requestLanguage({ explicit: 'en', stored: 'hu', header: 'hu' }), 'en')
  })

  it('lets a stored preference beat the browser header', () => {
    // The viewer said what they want; the browser only guessed.
    assert.equal(requestLanguage({ stored: 'en', header: 'hu-HU' }), 'en')
  })

  it('falls back to the header, then to the site default', () => {
    assert.equal(requestLanguage({ header: 'en-GB' }), 'en')
    assert.equal(requestLanguage({ header: 'de' }), DEFAULT_LANGUAGE)
    assert.equal(requestLanguage({}), DEFAULT_LANGUAGE)
  })

  it('ignores an unsupported explicit value instead of serving it', () => {
    // ?lang=de must not produce a German response we cannot render.
    assert.equal(requestLanguage({ explicit: 'de', header: 'en' }), 'en')
  })

  it('defaults to Hungarian, because this is a Hungarian site', () => {
    assert.equal(DEFAULT_LANGUAGE, 'hu')
    assert.deepEqual([...UI_LANGUAGES], ['hu', 'en'])
  })
})
