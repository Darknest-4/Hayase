// A védőkorlát nem vehető ki csendben.
//
// A `npm test` egy előellenőrzésen megy át, ami megállítja a futást, ha a
// `DATABASE_URL` nem tesztadatbázisra mutat. Egy ilyen korlát pontosan addig
// ér valamit, amíg ott van — és a legkönnyebb módja annak, hogy eltűnjön, egy
// „csak most az egyszer" szerkesztés a package.json-ban, amit senki nem néz
// meg újra.
//
// Ez a teszt magát a parancsot olvassa.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}

describe('the tests refuse to run against production', () => {
  it('every test script goes through the guard first', () => {
    const missing = Object.entries(pkg.scripts)
      .filter(([name]) => name === 'test' || name.startsWith('test:'))
      .filter(([, command]) => !command.includes('test/guard.mjs'))
      .map(([name]) => name)

    assert.deepEqual(missing, [], 'these test scripts can write to the live database')
  })

  it('the guard runs BEFORE the tests, not after them', () => {
    // `guard && node --test` megállít; `node --test && guard` csak panaszkodik,
    // miután a suite már beírt harminc fiókot az éles adatbázisba.
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name !== 'test' && !name.startsWith('test:')) continue
      const guard = command.indexOf('test/guard.mjs')
      const runner = command.indexOf('--test')
      assert.ok(guard >= 0 && guard < runner, `${name}: az előellenőrzés a futtatás után van`)
    }
  })

  it('every test script still suppresses outbound webhooks', () => {
    // Ugyanaz a család: egy tesztfutás ne üzenjen a tulajdonos Discordjára.
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (name !== 'test' && !name.startsWith('test:')) continue
      assert.ok(command.includes('YUME_SUPPRESS_WEBHOOKS=1'), `${name}: kiüzenhet egy tesztfutásból`)
    }
  })
})
