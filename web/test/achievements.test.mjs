// The achievement catalogue exists twice, and must not drift.
//
// The definitions are the server's: it measures a profile against its own
// watch history, library and favourites, and records the grants, so nothing
// the client says can earn one. The client keeps a copy to render from while
// signed out — and a copy of a list is a list that goes stale. This is what
// stops that.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

// The client catalogue is built inside the vm realm, so deepEqual compares it
// against a different Array.prototype and fails on identical data.
const plain = value => JSON.parse(JSON.stringify(value))
const { CATALOGUE, evaluate } = await import('../../server/src/lib/achievements.ts')

let clientCatalogue

before(() => {
  const window = {}
  const context = {
    window,
    document: { createElement: () => ({ style: {}, dataset: {}, append () {}, setAttribute () {} }) },
    console,
    Store: { list: () => ({}), history: () => [], favourites: () => [], activeProfile: () => null },
    U: { el: () => ({ append () {} }) },
    T: k => k,
    I18n: { locale: () => 'en' }
  }
  context.globalThis = context
  runInNewContext(readFileSync(join(here, '../js/pages/achievements.js'), 'utf8'), context)
  clientCatalogue = window.PageAchievements.CATALOG
})

describe('the two catalogues agree', () => {
  it('lists the same achievements in the same order', () => {
    assert.deepEqual(plain(clientCatalogue.map(a => a.slug)), CATALOGUE.map(a => a.slug))
  })

  it('agrees on every target', () => {
    for (const server of CATALOGUE) {
      const client = clientCatalogue.find(a => a.slug === server.slug)
      assert.equal(client.target, server.target, `${server.slug}: target differs`)
    }
  })

  it('agrees on every name and tier', () => {
    for (const server of CATALOGUE) {
      const client = clientCatalogue.find(a => a.slug === server.slug)
      assert.equal(client.name, server.name, `${server.slug}: name differs`)
      assert.equal(client.tier, server.tier, `${server.slug}: tier differs`)
    }
  })

  it('is seeded into the database by a migration', () => {
    // Grants point at catalogue rows; without them nothing can be unlocked.
    const sql = readFileSync(join(here, '../../db/migrations/0024_achievements_seed.sql'), 'utf8')
    for (const a of CATALOGUE) {
      assert.match(sql, new RegExp(`'${a.slug}'`), `${a.slug} is missing from the seed`)
    }
  })
})

describe('evaluating a profile', () => {
  const context = {
    episodes: 60,
    minutes: 1500,
    completed: 2,
    library: 12,
    planning: 3,
    favourites: 1,
    scored: 0,
    bestDay: 4,
    activeDays: 5,
    genreCount: 7,
    formatCount: 2
  }

  it('unlocks what the numbers earn and nothing else', () => {
    const rows = evaluate(context, new Map())
    const unlocked = rows.filter(r => r.unlocked).map(r => r.slug)
    assert.deepEqual(unlocked.sort(), ['first-episode', 'first-finish', 'getting-into-it', 'day-one'].sort())
  })

  it('caps progress at the target so a bar never overflows', () => {
    const rows = evaluate({ ...context, episodes: 999999 }, new Map())
    for (const row of rows) assert.ok(row.current <= row.target, `${row.slug} reported ${row.current}/${row.target}`)
  })

  it('keeps an achievement that was already granted, even if the number fell', () => {
    // Removing a title from a library must not take back something earned.
    const rows = evaluate({ ...context, episodes: 0 }, new Map([['binge-watcher', '2026-01-01T00:00:00Z']]))
    const row = rows.find(r => r.slug === 'binge-watcher')
    assert.equal(row.unlocked, true)
    assert.equal(row.unlockedAt, '2026-01-01T00:00:00Z')
    assert.equal(row.current, 0, 'progress still reflects the present')
  })

  it('treats a missing measurement as zero rather than throwing', () => {
    const rows = evaluate({}, new Map())
    assert.equal(rows.length, CATALOGUE.length)
    assert.equal(rows.every(r => r.current === 0), true)
  })

  it('awards XP worth having but not worth farming', () => {
    // Every achievement carries XP, and the gold ones carry more than bronze.
    assert.ok(CATALOGUE.every(a => a.xp > 0))
    const bronze = Math.max(...CATALOGUE.filter(a => a.tier === 'bronze').map(a => a.xp))
    const gold = Math.min(...CATALOGUE.filter(a => a.tier === 'gold').map(a => a.xp))
    assert.ok(gold > bronze, `gold starts at ${gold}, bronze reaches ${bronze}`)
  })

  it('measures every metric the catalogue refers to', () => {
    // A typo in a metric name would silently make an achievement unreachable.
    const measured = new Set(Object.keys(context))
    for (const a of CATALOGUE) {
      assert.ok(measured.has(a.metric), `${a.slug} counts "${a.metric}", which nothing measures`)
    }
  })
})

describe('the screen', () => {
  const source = readFileSync(join(here, '../js/pages/achievements.js'), 'utf8')

  it('prefers the server and falls back to the browser', () => {
    assert.match(source, /_fromServer\(\)/)
    assert.match(source, /_evaluateLocally\(\)/)
  })

  it('reports nothing to the server', () => {
    // The screen must not be able to grant anything; it only reads.
    assert.ok(!/method: 'POST'|method: 'PUT'/.test(source), 'the achievements screen writes to the server')
  })

  it('does not draw into a screen the viewer has left', () => {
    assert.match(source, /pad\.isConnected/)
  })
})
