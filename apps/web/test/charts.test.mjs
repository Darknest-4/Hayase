// The chart helpers.
//
// They are the one piece of the admin overview whose output is not obviously
// right or wrong by looking at it: an axis can be drawn, be well-formed SVG,
// and still lie. These check the two things a reader trusts without checking —
// that the scale is honest, and that no two gridlines claim the same number.

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

/** Just enough DOM to build SVG in — nodes that remember their own tag. */
function svgDocument () {
  const make = tag => ({
    tag,
    attrs: {},
    children: [],
    textContent: '',
    className: '',
    // Real elements have one, and the donut legend writes its swatch colour
    // through it rather than into an HTML string — see the escaping test below.
    style: {},
    setAttribute (k, v) { this.attrs[k] = String(v) },
    getAttribute (k) { return this.attrs[k] },
    append (...kids) { this.children.push(...kids) }
  })
  return { createElement: make, createElementNS: (_ns, tag) => make(tag) }
}

/** Every node of a given tag, at any depth. */
function findAll (node, tag, out = []) {
  if (node.tag === tag) out.push(node)
  for (const kid of node.children ?? []) findAll(kid, tag, out)
  return out
}

/*
 * AZ Y-TENGELY FELIRATAI — osztály szerint, nem igazítás szerint.
 *
 * Eddig a `text-anchor === 'end'` volt a szűrő. Ez nem a dolgot nevezte meg,
 * hanem egy megjelenési tulajdonságot, ami történetesen egybeesett vele —
 * és abban a pillanatban elromlott, hogy a szélső x-feliratok is befelé
 * igazodtak: a teszt egy „b" feliratot próbált számmá alakítani.
 */
const axisLabels = svg => findAll(svg, 'text')
  .filter(t => String(t.attrs.class ?? '').split(/\s+/).includes('chart-axis-y'))
  .map(t => t.textContent)

let Charts

before(async () => {
  install({ document: svgDocument() })
  ;({ Charts } = await import('../src/shared/ui/charts.js'))
  assert.ok(Charts, 'charts.js must export Charts')
})

describe('lines', () => {
  const labels = ['Sep 1', 'Sep 2', 'Sep 3', 'Sep 4']

  it('never labels the same gridline twice', () => {
    // A series topping out at 1 drew "0 1 1 1 1" up the axis: four ticks over
    // a range of one, each rounded to the nearest integer. An axis that
    // repeats a number is not a scale, it is decoration.
    for (const peak of [0, 1, 2, 3, 5, 7, 9, 23, 150, 1400]) {
      const svg = Charts.lines([{ name: 'x', values: [0, peak, peak, 0] }], { labels })
      const axis = axisLabels(svg)
      assert.equal(new Set(axis).size, axis.length, `peak ${peak} drew a repeated tick: ${axis.join(', ')}`)
    }
  })

  it('scales to a ceiling at or above the data, never below it', () => {
    // A line drawn past the top of its own chart is the worst failure this
    // could have: it reads as a plateau.
    for (const peak of [1, 4, 6, 12, 99, 101]) {
      const svg = Charts.lines([{ name: 'x', values: [0, peak] }], { labels: ['a', 'b'] })
      const top = axisLabels(svg)
        .map(t => Number(String(t).replace('k', '000')))
        .reduce((a, b) => Math.max(a, b), 0)
      assert.ok(top >= peak, `a peak of ${peak} was drawn on an axis topping out at ${top}`)
    }
  })

  it('draws one point per value, per series', () => {
    const svg = Charts.lines([
      { name: 'a', values: [1, 2, 3, 4] },
      { name: 'b', values: [4, 3, 2, 1] }
    ], { labels })
    assert.equal(findAll(svg, 'circle').length, 8)
    assert.equal(findAll(svg, 'polyline').length, 2)
  })

  it('fills under a single series only', () => {
    // Overlapping translucent fills read as a third colour that means nothing.
    const one = Charts.lines([{ name: 'a', values: [1, 2] }], { labels: ['a', 'b'] })
    const two = Charts.lines([
      { name: 'a', values: [1, 2] },
      { name: 'b', values: [2, 1] }
    ], { labels: ['a', 'b'] })
    assert.equal(findAll(one, 'polygon').length, 1)
    assert.equal(findAll(two, 'polygon').length, 0)
  })

  it('says what each point is', () => {
    const svg = Charts.lines([{ name: 'Active', values: [7] }], { labels: ['Sep 1'] })
    const titles = findAll(svg, 'title').map(t => t.textContent)
    assert.ok(titles.includes('Active · Sep 1: 7'), titles.join(' | '))
  })

  it('returns an empty chart rather than throwing on no data', () => {
    assert.doesNotThrow(() => Charts.lines([], { labels: [] }))
    assert.doesNotThrow(() => Charts.lines([{ name: 'a', values: [] }], { labels: [] }))
  })
})

describe('donut', () => {
  it('returns the ring alone when the caller draws its own legend', () => {
    // The built-in legend is positioned for a 200px canvas and collides with
    // anything laid out around a smaller ring.
    assert.equal(Charts.donut([{ label: 'a', value: 1, color: 'red' }], { legend: false }).tag, 'svg')
    assert.equal(Charts.donut([{ label: 'a', value: 1, color: 'red' }]).tag, 'div')
  })

  it('puts the label in the legend as text, never as markup', () => {
    // The legend row used to be an HTML string with `${d.label}` in it. The
    // labels are catalogue names, so reaching it needed a permission — but it
    // was an unescaped sink on a page an administrator opens, and nothing
    // stopped the next caller passing a username. YUME-AUDIT-0007.
    const hostile = '<img src=x onerror=alert(1)>'
    const wrap = Charts.donut([{ label: hostile, value: 1, color: 'red' }])

    const texts = []
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.textContent) texts.push(node.textContent)
      assert.equal(node.innerHTML, undefined, 'the legend must not be built from an HTML string')
      for (const kid of node.children ?? []) walk(kid)
    }
    walk(wrap)
    assert.ok(texts.includes(hostile), 'the label should still be shown, as text')
  })
})
