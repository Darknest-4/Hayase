// The chart helpers.
//
// They are the one piece of the admin overview whose output is not obviously
// right or wrong by looking at it: an axis can be drawn, be well-formed SVG,
// and still lie. These check the two things a reader trusts without checking —
// that the scale is honest, and that no two gridlines claim the same number.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

/** Just enough DOM to build SVG in. */
function makeContext () {
  const make = tag => ({
    tag,
    attrs: {},
    children: [],
    textContent: '',
    className: '',
    setAttribute (k, v) { this.attrs[k] = String(v) },
    getAttribute (k) { return this.attrs[k] },
    append (...kids) { this.children.push(...kids) }
  })
  const window = {}
  const context = {
    window,
    document: { createElement: make, createElementNS: (_ns, tag) => make(tag) },
    console
  }
  context.globalThis = context
  return context
}

/** Every node of a given tag, at any depth. */
function findAll (node, tag, out = []) {
  if (node.tag === tag) out.push(node)
  for (const kid of node.children ?? []) findAll(kid, tag, out)
  return out
}

const axisLabels = svg => findAll(svg, 'text')
  .filter(t => t.attrs['text-anchor'] === 'end')
  .map(t => t.textContent)

let Charts

before(() => {
  const context = makeContext()
  runInNewContext(readFileSync(join(here, '../js/charts.js'), 'utf8'), context)
  Charts = context.window.Charts
  assert.ok(Charts, 'the script must expose window.Charts')
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
})
