// Player 2.0 — beállítások és funkciókapcsolók.
//
// Egyik sem új rendszer: a YUME-nak van beállításkezelője és van flag-kezelője.
// Ezek ADAPTEREK fölöttük, és a tesztjük arról szól, amit hozzátesznek —
// séma-érvényesítés, migráció, és a négy döntési forrás sorrendje.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  PLAYER_PREFERENCE_SCHEMA, PLAYER_SCHEMA_VERSION,
  createPlayerPreferences, defaults, migrate, validate
} from '../src/features/player2/preferences/player-preferences.js'
import {
  PLAYER_FLAGS, createFlagEvaluator, detectCapabilities, detectPlatform
} from '../src/features/player2/flags/player-feature-flags.js'


const here = dirname(fileURLToPath(import.meta.url))

describe('a kód nem kérhet nem létező beállítást', () => {
  it('minden használt kulcs szerepel a sémában', () => {
    /*
     * EZ EGY EGÉSZ HIBAOSZTÁLY, nem egy hiba.
     *
     * A `get` és a `set` ISMERETLEN KULCSRA `undefined`-ot ad vissza, és nem
     * csinál semmit. Ez a helyes viselkedés — egy régi telepítés
     * beállításfájljában lehetnek olyan kulcsok, amiket már nem ismerünk —,
     * de azt is jelenti, hogy egy ELÍRT kulcs NÉMÁN nem működik.
     *
     * Négy ilyen volt a lejátszóban egyszerre, és mind a négy egy-egy néma
     * funkciót jelentett:
     *
     *   player.episode.autoNext  → az automatikus továbblépés SOHA nem sült el
     *   player.playback.rate     → a sebesség megjegyzése nem mentett
     *   player.subtitle.language → a nyelvi választás nem létezett
     *
     * Egyik sem dobott hibát, egyik sem hiányzott a naplóból.
     */
    const root = join(here, '../src/features/player2')
    const used = new Map()
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!entry.name.endsWith('.js')) continue
        const source = readFileSync(path, 'utf8')
        for (const match of source.matchAll(/prefs\??\.?(?:get|set)\s*\(\s*'(player\.[a-zA-Z0-9.]+)'/g)) {
          if (!used.has(match[1])) used.set(match[1], entry.name)
        }
      }
    }
    walk(root)

    assert.ok(used.size >= 6, `csak ${used.size} kulcshasználatot találtam — a keresés romlott el`)
    const unknown = [...used]
      .filter(([key]) => !(key in PLAYER_PREFERENCE_SCHEMA))
      .map(([key, file]) => `${key} (${file})`)
    assert.deepEqual(unknown, [], 'ezek a kulcsok nincsenek a sémában, tehát némán nem csinálnak semmit')
  })
})

describe('preference schema', () => {
  it('every key declares a default and a type', () => {
    for (const [key, spec] of Object.entries(PLAYER_PREFERENCE_SCHEMA)) {
      assert.ok('default' in spec, `${key}: nincs alapérték`)
      assert.ok(['boolean', 'number', 'string'].includes(spec.type), `${key}: ismeretlen típus`)
    }
  })

  it('every default passes its own validation', () => {
    for (const [key, spec] of Object.entries(PLAYER_PREFERENCE_SCHEMA)) {
      assert.equal(validate(key, spec.default), spec.default, `${key}: az alapérték nem érvényes a saját sémája szerint`)
    }
  })

  /*
   * Egy elrontott beállítás nem akadályozhatja meg a lejátszást. A legrosszabb,
   * ami történhet, hogy a néző alapértelmezéssel néz filmet.
   */
  it('falls back to the default instead of throwing', () => {
    assert.equal(validate('player.rate', 3), 1)
    assert.equal(validate('player.autoplay', 'igen'), true)
    assert.equal(validate('player.quality.preferred', '8k'), 'auto')
  })

  it('clamps a number into range rather than rejecting it', () => {
    assert.equal(validate('player.subtitle.size', 999), 200)
    assert.equal(validate('player.subtitle.size', 1), 50)
    assert.equal(validate('player.volume', 5), 1)
  })

  it('an unknown key is undefined, not a silent default', () => {
    assert.equal(validate('player.nincs.ilyen', 1), undefined)
  })

  it('defaults() covers the whole schema', () => {
    assert.deepEqual(Object.keys(defaults()).sort(), Object.keys(PLAYER_PREFERENCE_SCHEMA).sort())
  })
})

describe('preference migration', () => {
  it('keeps a value the viewer already chose', () => {
    assert.equal(migrate({ 'player.volume': 0.5 }).values['player.volume'], 0.5)
  })

  it('fills in what a new version added', () => {
    const { values } = migrate({ 'player.volume': 0.5 })
    assert.equal(values['player.ui.ambient'], PLAYER_PREFERENCE_SCHEMA['player.ui.ambient'].default)
  })

  /*
   * ADAT NEM VESZHET EL. Egy ismeretlen kulcs lehet egy ÚJABB verzió
   * beállítása — ha egy visszaállítás után a régi kód eldobná, a felhasználó
   * elveszítené, amit egyszer már beállított.
   */
  it('leaves an unknown key untouched instead of discarding it', () => {
    const { values } = migrate({ 'player.jovobeli.kulcs': 42 })
    assert.equal(values['player.jovobeli.kulcs'], 42)
  })

  it('repairs a corrupted stored value', () => {
    assert.equal(migrate({ 'player.rate': 'gyors' }).values['player.rate'], 1)
  })

  it('stamps the current schema version and reports where it came from', () => {
    const { values, migratedFrom } = migrate({})
    assert.equal(values['player.schemaVersion'], PLAYER_SCHEMA_VERSION)
    assert.equal(migratedFrom, 0)
  })

  it('is idempotent', () => {
    const once = migrate({ 'player.volume': 0.3 }).values
    assert.deepEqual(migrate(once).values, once)
  })
})

describe('preference adapter', () => {
  it('reads through to the underlying store, validated', () => {
    const prefs = createPlayerPreferences({ get: () => 999, set () {} })
    assert.equal(prefs.get('player.subtitle.size'), 200, 'a tárolt érték nem lett a sémára szorítva')
  })

  it('survives a store that throws', () => {
    const prefs = createPlayerPreferences({
      get () { throw new Error('nincs tárhely') },
      set () { throw new Error('nincs tárhely') }
    })
    assert.equal(prefs.get('player.autoplay'), true)
    assert.doesNotThrow(() => prefs.set('player.autoplay', false))
  })

  it('works with no underlying store at all', () => {
    const prefs = createPlayerPreferences(null)
    assert.equal(prefs.get('player.volume'), 1)
    assert.equal(prefs.set('player.volume', 0.5), 0.5)
    assert.equal(prefs.get('player.volume'), 0.5)
  })

  it('refuses to set a key outside the schema', () => {
    assert.equal(createPlayerPreferences(null).set('player.nincs', 1), undefined)
  })
})

describe('feature flags', () => {
  const evaluator = (over = {}) => createFlagEvaluator({
    featureOn: over.featureOn ?? (() => true),
    prefs: over.prefs,
    capabilities: over.capabilities ?? { pip: true, mediaSession: true },
    platform: over.platform ?? { touch: true, mobile: true }
  })

  it('every flag documents itself', () => {
    for (const [name, spec] of Object.entries(PLAYER_FLAGS)) {
      assert.ok(spec.desc?.length > 5, `${name}: nincs leírás`)
      assert.equal(typeof spec.core, 'boolean', `${name}: nincs core jelölés`)
    }
  })

  /*
   * Egy álkapcsoló, ami látszólag létezik, és amitől a lejátszó
   * használhatatlan lesz, rosszabb, mint a kimondott tény, hogy nem
   * kapcsolható.
   */
  it('a core flag cannot be switched off, even by the server', () => {
    assert.equal(evaluator({ featureOn: () => false }).isOn('player.controls'), true)
  })

  it('an unknown flag is off, not on', () => {
    assert.equal(evaluator().isOn('player.nincs_ilyen'), false)
  })

  /** A néző szava az első. */
  it('the viewer\'s preference wins over the server', () => {
    const prefs = { get: key => (key === 'player.ui.gestures' ? false : undefined) }
    assert.equal(evaluator({ prefs, featureOn: () => true }).isOn('player.mobile_gestures'), false)
  })

  /** A 22. pont: ne mutass gombot, ami nem működik. */
  it('a capability the browser lacks turns the flag off', () => {
    assert.equal(evaluator({ capabilities: { pip: false } }).isOn('player.pip'), false)
    assert.equal(evaluator({ capabilities: { pip: true } }).isOn('player.pip'), true)
  })

  it('gestures need a touch screen', () => {
    assert.equal(evaluator({ platform: { touch: false } }).isOn('player.mobile_gestures'), false)
  })

  it('the operator can still switch a non-core feature off', () => {
    assert.equal(evaluator({ featureOn: name => name !== 'player.ambient' }).isOn('player.ambient'), false)
  })

  /*
   * A hiányzó flag BEKAPCSOLT állapotot jelent — ez a meglévő featureOn
   * szerződése. Egy „biztonságos alapértelmezés", ami mindent letilt, üres
   * lejátszót adna az első látogatónak.
   */
  it('works with no flag source at all', () => {
    assert.equal(createFlagEvaluator({}).isOn('player.ambient'), true)
  })

  it('all() reports every flag for the debug layer', () => {
    assert.deepEqual(Object.keys(evaluator().all()).sort(), Object.keys(PLAYER_FLAGS).sort())
  })
})

describe('capability detection', () => {
  /*
   * A 35. pont: ne feltételezzük, hogy minden böngésző mindent tud. A
   * `document` hiánya (teszt, kiszolgálóoldal) nem hiba.
   */
  it('reports everything false rather than throwing without a DOM', () => {
    const caps = detectCapabilities({})
    for (const [name, value] of Object.entries(caps)) {
      assert.equal(typeof value, 'boolean', `${name} nem logikai érték`)
    }
    assert.equal(caps.pip, false)
  })

  it('detects platform without a navigator', () => {
    const platform = detectPlatform({})
    assert.equal(typeof platform.mobile, 'boolean')
    assert.equal(typeof platform.ios, 'boolean')
  })
})
