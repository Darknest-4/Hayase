// A kliens szintgörbéje ugyanaz, mint a kiszolgálóé.
//
// A kiszolgáló `levelFor`-ja (apps/api/src/modules/library/founder.ts) a
// profil szintjét írja; a kliens ugyanazt a számot rajzolja, és a haladásjelzőt
// is ebből számolja. Két képlet két szintet adott ugyanazon a lapon (2026-09).
// Itt a kiszolgáló forrásából olvassuk ki az állandókat, hogy egy egyoldalú
// módosítás ne csússzon át.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { EPISODE_XP, estimateXp, levelFor } from '../src/shared/lib/level.js'

const serverSource = readFileSync(new URL('../../api/src/modules/library/founder.ts', import.meta.url), 'utf8')
const progressSource = readFileSync(new URL('../../api/src/modules/library/progress.ts', import.meta.url), 'utf8')

describe('a szintgörbe', () => {
  it('a kiszolgálóéval azonos állandókból épül', () => {
    const fn = serverSource.slice(serverSource.indexOf('export function levelFor'))
    assert.match(fn, /let needed = 100/)
    assert.match(fn, /needed = Math\.round\(needed \* 1\.15\)/)
    assert.match(fn, /level < 999/)
  })

  it('ugyanannyi XP-t ír jóvá egy részért, mint a kiszolgáló', () => {
    const m = /const EPISODE_XP = (\d+)/.exec(progressSource)
    assert.ok(m, 'EPISODE_XP eltűnt a kiszolgálóról')
    assert.equal(EPISODE_XP, Number(m[1]))
  })

  it('a határokon jól számol', () => {
    assert.deepEqual(levelFor(0), { level: 1, into: 0, needed: 100 })
    assert.deepEqual(levelFor(99), { level: 1, into: 99, needed: 100 })
    assert.deepEqual(levelFor(100), { level: 2, into: 0, needed: 115 })
    assert.deepEqual(levelFor(214), { level: 2, into: 114, needed: 115 })
    assert.deepEqual(levelFor(215), { level: 3, into: 0, needed: 132 })
  })

  it('nem hasal el rossz bemeneten', () => {
    for (const bad of [undefined, null, NaN, -50, 'abc']) assert.equal(levelFor(bad).level, 1)
    assert.equal(estimateXp({}), 0)
    assert.equal(estimateXp({ episodes: 12 }), 120)
  })
})
