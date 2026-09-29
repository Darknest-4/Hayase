// Stylesheet ordering.
//
// A media query carries no extra specificity. A rule written after one, with
// the same selector, wins outright — so a responsive override placed above the
// component it overrides silently does nothing.
//
// That is what happened here: the responsive block sat in the middle of
// style.css and four of its rules were dead, three of them the watch page. On
// a phone `.watch-side` kept `position: sticky` from its later rule, so the
// episode panel floated over the page instead of stacking under the player,
// and the content behind it was squeezed into a strip a few characters wide.
// Nothing errored; it just looked broken.
//
// The block lives at the end of the file now. This keeps it there.
//
// The second thing checked here has the same shape: a mistake that changes
// what the page looks like and reports nothing. `var(--text-dim)` is not an
// error — CSS resolves an undefined custom property to nothing and the
// declaration is simply dropped — so a plausible-looking token that was never
// defined produces unstyled text rather than a failure. Fifteen of them
// shipped in one sitting before this existed.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(here, '../css/style.css'), 'utf8')
const COMPONENTS = readFileSync(join(here, '../css/components.css'), 'utf8')
const ADMIN = readFileSync(join(here, '../css/admin.css'), 'utf8')
const PLAYER2 = readFileSync(join(here, '../css/player2.css'), 'utf8')
const MAINTENANCE = readFileSync(join(here, '../css/maintenance.css'), 'utf8')

/*
 * MINDEN LAP, AMIT A KLIENS BETÖLTHET.
 *
 * 2026-09 óta a képernyők saját lapjai a `css/pages/`, a több képernyőn
 * használt moduloké a `css/features/` alatt vannak, és lustán töltődnek (router:
 * ROUTE_STYLES). A token-ellenőrzés és a töréspont-szabályok mindegyikre
 * vonatkoznak. A `discord.css` egy másik alkalmazásé (a Discord-irányítópult),
 * az kimarad, ahogy eddig is.
 */
const LAZY = readdirSync(join(here, '../css'), { recursive: true })
  .map(String)
  .filter(name => name.endsWith('.css') && name.includes('/'))
  .sort()
  .map(name => [name, readFileSync(join(here, '../css', name), 'utf8')])

// Every sheet the browser may load after tokens.css. The undefined-token
// check below has to cover all of them: components.css is where the
// primitives live, and a token that resolves to nothing there drops a
// declaration on every screen at once rather than on one.
const SHEETS = [['style.css', CSS], ['components.css', COMPONENTS], ['admin.css', ADMIN], ['player2.css', PLAYER2], ['maintenance.css', MAINTENANCE], ...LAZY]

function rules (css) {
  const found = []
  let depth = 0
  let mediaDepth = -1
  let line = 0
  for (const raw of css.split('\n')) {
    line++
    const text = raw.trim()
    const opens = (text.match(/\{/g) ?? []).length
    const closes = (text.match(/\}/g) ?? []).length

    // A `@container` ugyanolyan feltételes szabály, mint a `@media` (a
    // lejátszó a saját szélességére kérdez, nem a nézetablakéra): a sorrendi
    // szabály rá is áll.
    if (/^@(media|container)[^{]*\{/.test(text)) {
      // A single-line query — `@media (…) { .x { … } }` — opens and closes on
      // this line. Skipping the brace count here left the scanner believing
      // every later rule sat inside it, which is how it reported a rule at
      // line 109 as a shadowed breakpoint when it is an ordinary rule.
      mediaDepth = depth
      depth += opens - closes
      if (depth <= mediaDepth) mediaDepth = -1
      continue
    }

    const match = /^([.#][^{@]+?)\s*\{/.exec(text)
    if (match) found.push({ line, selector: match[1].trim(), inMedia: mediaDepth >= 0 })
    depth += opens - closes
    if (mediaDepth >= 0 && depth <= mediaDepth) mediaDepth = -1
  }
  return found
}

/**
 * Ugyanaz a vizsgálat, lapkánként.
 *
 * Az admin.css a style.css UTÁN töltődik be, tehát benne egy sima szabály
 * elnémíthat egy korábbi lapkán álló töréspontos szabályt — a fájlon belüli
 * sorrend ezt nem fogja meg. Ez nem elméleti: a panel átalakításakor egy
 * áthozott `.user-history-when` pontosan ezt csinálta.
 */
function shadowedWithin (all) {
  const plain = new Map()
  for (const rule of all.filter(r => !r.inMedia)) {
    if (!plain.has(rule.selector)) plain.set(rule.selector, [])
    plain.get(rule.selector).push(rule.line)
  }
  const out = []
  for (const rule of all.filter(r => r.inMedia)) {
    const later = (plain.get(rule.selector) ?? []).find(l => l > rule.line)
    if (later !== undefined) out.push(`${rule.selector} at line ${rule.line} is overridden at line ${later}`)
  }
  return out
}

describe('a later stylesheet does not silently undo an earlier breakpoint', () => {
  /*
   * A SORREND: components.css → style.css → a lusta lapok (admin.css,
   * player2.css, maintenance.css, css/pages/*, css/features/*). A lusta lapok
   * EGYMÁSHOZ képesti sorrendje a látogatás sorrendjétől függ, tehát egyik sem
   * lapíthatja el egy másik töréspontját — egyik irányban sem.
   */
  const EAGER = [['components.css', COMPONENTS], ['style.css', CSS]]
  const LATER = [['admin.css', ADMIN], ['player2.css', PLAYER2], ['maintenance.css', MAINTENANCE], ...LAZY]

  it('no earlier sheet has a breakpoint a later sheet flattens', () => {
    const broken = []
    const check = (earlierName, earlier, laterName, later) => {
      const media = new Set(rules(earlier).filter(r => r.inMedia).map(r => r.selector))
      for (const rule of rules(later).filter(r => !r.inMedia)) {
        if (media.has(rule.selector)) {
          broken.push(`${earlierName} has a breakpoint for ${rule.selector}; ${laterName}:${rule.line} overrides it unconditionally`)
        }
      }
    }
    // components.css → style.css
    check(...EAGER[0], ...EAGER[1])
    // a keret → minden lusta lap
    for (const [eName, e] of EAGER) for (const [lName, l] of LATER) check(eName, e, lName, l)
    // lusta lap ↔ lusta lap, mindkét irányban
    for (const [aName, a] of LATER) {
      for (const [bName, b] of LATER) if (aName !== bName) check(aName, a, bName, b)
    }
    assert.deepEqual(broken, [], 'breakpoints flattened by a later sheet:\n  ' + broken.join('\n  '))
  })

  it('each sheet keeps its own breakpoints last', () => {
    for (const [name, sheet] of [...EAGER, ...LATER]) {
      const all = rules(sheet)
      if (!all.some(r => r.inMedia)) continue
      const lastMedia = Math.max(...all.filter(r => r.inMedia).map(r => r.line))
      const lastPlain = Math.max(...all.filter(r => !r.inMedia).map(r => r.line))
      assert.ok(lastMedia > lastPlain, `${name}: last breakpoint (${lastMedia}) must come after the last plain rule (${lastPlain})`)
      assert.deepEqual(shadowedWithin(all), [], `${name}: dead responsive rules`)
    }
  })
})

describe('responsive overrides are not shadowed', () => {
  const all = rules(CSS)

  it('parses a plausible number of rules', () => {
    // A brace-counting scan that quietly matches nothing would pass the real
    // assertion below while checking nothing.
    assert.ok(all.length > 200, `expected hundreds of rules, found ${all.length}`)
    assert.ok(all.some(r => r.inMedia), 'media-query rules must be recognised')
  })

  it('no media-query rule is overridden by a later rule with the same selector', () => {
    const plain = new Map()
    for (const rule of all.filter(r => !r.inMedia)) {
      if (!plain.has(rule.selector)) plain.set(rule.selector, [])
      plain.get(rule.selector).push(rule.line)
    }

    const shadowed = []
    for (const rule of all.filter(r => r.inMedia)) {
      const later = (plain.get(rule.selector) ?? []).find(l => l > rule.line)
      if (later !== undefined) {
        shadowed.push(`${rule.selector} at line ${rule.line} is overridden at line ${later}`)
      }
    }
    assert.deepEqual(shadowed, [], 'dead responsive rules:\n  ' + shadowed.join('\n  '))
  })

  it('the responsive block really is at the end', () => {
    // The property above holds trivially if there are no breakpoints left, so
    // this checks the arrangement that makes it hold.
    const lastMedia = Math.max(...all.filter(r => r.inMedia).map(r => r.line))
    const lastPlain = Math.max(...all.filter(r => !r.inMedia).map(r => r.line))
    assert.ok(lastMedia > lastPlain, `last breakpoint (${lastMedia}) must come after the last component rule (${lastPlain})`)
  })
})

describe('design tokens the stylesheet asks for', () => {
  const TOKENS = readFileSync(join(here, '../css/tokens.css'), 'utf8')

  /**
   * Every custom property *defined* anywhere the browser will see.
   *
   * The client scripts count too: a value that only exists per element — a
   * progress ring's percentage, a card's own accent — is set as an inline
   * style rather than in the sheet, and it is no less defined for that.
   */
  const inlineSources = readdirSync(join(here, '../src'), { recursive: true })
    .filter(name => String(name).endsWith('.js') && !String(name).startsWith('vendor'))
    .map(name => readFileSync(join(here, '../src', String(name)), 'utf8'))

  const defined = new Set(
    [TOKENS, ...SHEETS.map(([, source]) => source), ...inlineSources]
      .flatMap(source => [...source.matchAll(/(--[a-z0-9-]+)\s*:/gi)])
      .map(m => m[1])
  )

  it('defines a palette at all', () => {
    // Without this the assertion below passes by finding nothing to check.
    assert.ok(defined.size > 30, `only ${defined.size} custom properties found`)
  })

  it('never reads a token nothing defines', () => {
    const missing = new Map()
    // `var(--x, fallback)` is deliberate and fine — the fallback is the
    // author saying what to do when it is absent. Only a bare reference is a
    // claim that the token exists.
    for (const [file, source] of SHEETS) {
      for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
        const name = match[1]
        if (defined.has(name)) continue
        const line = source.slice(0, match.index).split('\n').length
        if (!missing.has(name)) missing.set(name, `${file}:${line}`)
      }
    }
    assert.deepEqual(
      [...missing].map(([name, where]) => `${name} (${where})`),
      [],
      'these resolve to nothing and silently drop the declaration'
    )
  })
})
