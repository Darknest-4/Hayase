// Profile numbers: server-authoritative where it should be, local everywhere else.
//
// The failure that matters is not a missing number — it is a *wrong* one that
// looks right: a profile with no server history overwriting a browser tally
// with zeroes, which reads to the viewer as having lost their watch time.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

function makeElement (tag) {
  const attrs = new Map()
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    isConnected: true,
    style: { cssText: '' },
    dataset: {},
    listeners: {},
    children: [],
    setAttribute (k, v) { attrs.set(k, String(v)) },
    getAttribute (k) { return attrs.has(k) ? attrs.get(k) : null },
    hasAttribute (k) { return attrs.has(k) },
    addEventListener (t, fn) { this.listeners[t] = fn },
    append (...kids) { this.children.push(...kids.filter(k => k != null)) },
    // Enough of a selector engine for `[data-stat="x"] b`.
    querySelector (selector) {
      const match = /\[data-stat="([^"]+)"\]/.exec(selector)
      if (!match) return null
      const walk = n => {
        if (n?.getAttribute?.('data-stat') === match[1]) {
          return n.children.find(c => c.tagName === 'B') ?? null
        }
        for (const child of n?.children ?? []) {
          const hit = walk(child)
          if (hit) return hit
        }
        return null
      }
      return walk(node)
    }
  }
  return node
}

let context, ProfileStats, storage

before(() => {
  const window = {}
  storage = new Map()
  context = {
    window,
    document: { createElement: makeElement },
    console,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: k => storage.delete(k)
    },
    Store: { activeProfileId: () => 'p1' },
    setTimeout,
    clearTimeout
  }
  context.globalThis = context
  runInNewContext(readFileSync(join(here, '../js/profile-stats.js'), 'utf8'), context)
  ProfileStats = window.ProfileStats
  assert.ok(ProfileStats, 'profile-stats.js must expose ProfileStats')
})

beforeEach(() => {
  storage.clear()
  context.window.LibrarySync = undefined
  context.window.I18n = { locale: () => 'en-GB' }
})

const serverRow = (over = {}) => ({
  minutes_watched: 1500,
  episodes_watched: 62,
  anime_completed: 4,
  mean_score: '8.25',
  level: 3,
  xp_total: 620,
  genre_breakdown: { Action: 900, Comedy: 600 },
  ...over
})

describe('reading the account\'s numbers', () => {
  it('normalises what the server sends', async () => {
    context.window.LibrarySync = { stats: async () => serverRow() }
    const row = await ProfileStats.refresh()
    assert.equal(row.minutes, 1500)
    assert.equal(row.episodes, 62)
    assert.equal(row.completed, 4)
    assert.equal(row.meanScore, 8.25)
    assert.equal(row.level, 3)
    assert.deepEqual(Object.keys(row.genres).sort(), ['Action', 'Comedy'])
  })

  it('keeps the answer for the next visit', async () => {
    context.window.LibrarySync = { stats: async () => serverRow() }
    await ProfileStats.refresh()
    context.window.LibrarySync = { stats: async () => null }
    assert.equal((await ProfileStats.refresh()).minutes, 1500)
    assert.equal(ProfileStats.cached().minutes, 1500)
  })

  it('caches per profile, so two people in one browser do not see each other', async () => {
    context.window.LibrarySync = { stats: async () => serverRow() }
    await ProfileStats.refresh()
    context.Store.activeProfileId = () => 'p2'
    assert.equal(ProfileStats.cached(), null)
    context.Store.activeProfileId = () => 'p1'
    assert.equal(ProfileStats.cached().minutes, 1500)
  })

  it('returns null rather than throwing when signed out or offline', async () => {
    context.window.LibrarySync = undefined
    assert.equal(await ProfileStats.refresh(), null)
    context.window.LibrarySync = { stats: async () => { throw new Error('offline') } }
    await assert.rejects(() => ProfileStats.refresh())
  })

  it('refuses an all-zero answer instead of blanking a real tally', async () => {
    // A profile that has watched nothing *through this client* would otherwise
    // replace the browser's own count with zeroes — which looks like the
    // viewer's history was deleted.
    context.window.LibrarySync = { stats: async () => serverRow() }
    await ProfileStats.refresh()

    context.window.LibrarySync = {
      stats: async () => serverRow({ minutes_watched: 0, episodes_watched: 0, anime_completed: 0 })
    }
    assert.equal((await ProfileStats.refresh()).minutes, 1500)
  })

  it('survives a corrupted cache entry', async () => {
    storage.set('yume-stats::p1', '{not json')
    assert.equal(ProfileStats.cached(), null)
  })
})

describe('formatting watch time the way the screens spell it', () => {
  it('uses days past a day, hours past an hour, minutes below', () => {
    assert.equal(ProfileStats.formatMinutes(4530), '3d 3h')
    assert.equal(ProfileStats.formatMinutes(750), '12h 30m')
    assert.equal(ProfileStats.formatMinutes(45), '45m')
    assert.equal(ProfileStats.formatMinutes(0), '0m')
  })
})

describe('patching a rendered card row', () => {
  const card = (stat, value) => {
    const el = makeElement('div')
    el.setAttribute('data-stat', stat)
    const b = makeElement('b')
    b.textContent = value
    el.append(b)
    return el
  }

  const row = () => {
    const wrap = makeElement('div')
    wrap.append(card('watchTime', '0h'), card('episodes', '0'), card('completed', '0'), card('meanScore', '—'))
    return wrap
  }

  it('replaces the local numbers with the account\'s', async () => {
    context.window.LibrarySync = { stats: async () => serverRow() }
    const wrap = row()
    await ProfileStats.hydrate(wrap)
    // 1500 minutes is 25 hours, and past a day the screens say days.
    assert.equal(wrap.querySelector('[data-stat="watchTime"] b').textContent, '1d 1h')
    assert.equal(wrap.querySelector('[data-stat="episodes"] b').textContent, '62')
    assert.equal(wrap.querySelector('[data-stat="completed"] b').textContent, '4')
    assert.equal(wrap.querySelector('[data-stat="meanScore"] b').textContent, '8.3')
  })

  it('leaves the local numbers alone when there is no server answer', async () => {
    context.window.LibrarySync = { stats: async () => null }
    const wrap = row()
    await ProfileStats.hydrate(wrap)
    assert.equal(wrap.querySelector('[data-stat="watchTime"] b').textContent, '0h')
  })

  it('does not write into a screen the viewer has already navigated away from', async () => {
    // hydrate() resolves after a network round trip; by then the node may be
    // detached, and writing to it would be work nobody sees.
    context.window.LibrarySync = { stats: async () => serverRow() }
    const wrap = row()
    wrap.isConnected = false
    await ProfileStats.hydrate(wrap)
    assert.equal(wrap.querySelector('[data-stat="episodes"] b').textContent, '0')
  })

  it('ignores a null root rather than throwing', async () => {
    assert.equal(await ProfileStats.hydrate(null), null)
  })

  it('leaves the mean score alone when the server has none', async () => {
    context.window.LibrarySync = { stats: async () => serverRow({ mean_score: null }) }
    const wrap = row()
    await ProfileStats.hydrate(wrap)
    assert.equal(wrap.querySelector('[data-stat="meanScore"] b').textContent, '—')
  })
})

describe('the screens that use it', () => {
  const source = name => readFileSync(join(here, `../js/pages/${name}.js`), 'utf8')

  for (const page of ['profile', 'analytics', 'dashboard']) {
    it(`${page} marks its cards and hydrates them`, () => {
      const src = source(page)
      assert.match(src, /'data-stat'/, `${page} must mark which card holds which figure`)
      assert.match(src, /ProfileStats\?\.hydrate\(/, `${page} must hydrate`)
    })
  }

  it('is loaded by the page', () => {
    assert.match(readFileSync(join(here, '../index.html'), 'utf8'), /js\/profile-stats\.js/)
  })
})
