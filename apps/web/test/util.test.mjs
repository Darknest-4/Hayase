// Shared DOM helper tests.
//
// U.el is used by every page, so a trap in it is a trap everywhere. This
// exists because of one: setAttribute('selected', false) renders
// selected="false", and a boolean attribute is "on" when it is PRESENT
// whatever its value — so passing `selected: false` selected the option.
//
// The symptom was a status filter that displayed the last option in the list
// no matter which one was current, because every option got the attribute and
// the last one won.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

/** A DOM stub recording exactly what U.el does to an element. */
function makeElement (tag) {
  const attrs = new Map()
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    style: { cssText: '' },
    dataset: {},
    listeners: {},
    children: [],
    setAttribute (k, v) { attrs.set(k, String(v)) },
    getAttribute (k) { return attrs.has(k) ? attrs.get(k) : null },
    hasAttribute (k) { return attrs.has(k) },
    addEventListener (type, fn) { this.listeners[type] = fn },
    append (...kids) { this.children.push(...kids) }
  }
}

let U

before(() => {
  const window = {}
  const context = {
    window,
    document: { createElement: makeElement },
    console,
    navigator: { language: 'en' },
    Intl,
    setTimeout,
    clearTimeout
  }
  context.globalThis = context
  runInNewContext(readFileSync(join(here, '../js/util.js'), 'utf8'), context)
  U = window.U ?? context.U
  assert.ok(U?.el, 'util.js must expose el()')
})

describe('boolean attributes', () => {
  it('omits the attribute entirely when false', () => {
    // The regression. Present-but-"false" is still present, and the browser
    // reads presence as on.
    const node = U.el('option', { value: 'a', selected: false })
    assert.equal(node.hasAttribute('selected'), false)
  })

  it('sets the attribute when true', () => {
    const node = U.el('option', { value: 'a', selected: true })
    assert.equal(node.hasAttribute('selected'), true)
    assert.equal(node.getAttribute('selected'), '')
  })

  it('selects exactly one option out of several', () => {
    // What the bug actually looked like: every option carried the attribute,
    // so the last one won and the filter displayed the wrong value.
    const options = ['open', 'all', 'resolved', 'ignored']
      .map(v => U.el('option', { value: v, selected: v === 'open' }))
    assert.deepEqual(options.map(o => o.hasAttribute('selected')), [true, false, false, false])
  })

  it('still honours the empty-string spelling used across the client', () => {
    // 34 call sites spell it `...(cond ? { checked: '' } : {})` precisely
    // because booleans did not work. They must keep working.
    assert.equal(U.el('input', { checked: '' }).hasAttribute('checked'), true)
    assert.equal(U.el('input', {}).hasAttribute('checked'), false)
  })

  it('applies to every boolean attribute, not just selected', () => {
    for (const key of ['checked', 'disabled', 'required', 'readonly', 'multiple', 'hidden']) {
      assert.equal(U.el('input', { [key]: false }).hasAttribute(key), false, `${key}: false`)
      assert.equal(U.el('input', { [key]: true }).hasAttribute(key), true, `${key}: true`)
    }
  })
})

describe('other attribute handling', () => {
  it('skips null and undefined without setting anything', () => {
    const node = U.el('div', { title: null, id: undefined })
    assert.equal(node.hasAttribute('title'), false)
    assert.equal(node.hasAttribute('id'), false)
  })

  it('keeps 0 and the empty string, which are values and not absences', () => {
    assert.equal(U.el('input', { value: 0 }).getAttribute('value'), '0')
    assert.equal(U.el('input', { value: '' }).getAttribute('value'), '')
  })

  it('routes class, text and style to their properties', () => {
    const node = U.el('div', { class: 'a b', text: 'hello', style: 'color:red' })
    assert.equal(node.className, 'a b')
    assert.equal(node.textContent, 'hello')
    assert.equal(node.style.cssText, 'color:red')
    assert.equal(node.hasAttribute('class'), false, 'class is a property here, not an attribute')
  })

  it('binds on* handlers as listeners rather than attributes', () => {
    const fn = () => {}
    const node = U.el('button', { onclick: fn })
    assert.equal(node.listeners.click, fn)
    assert.equal(node.hasAttribute('onclick'), false)
  })

  it('drops null children so callers can use inline conditionals', () => {
    const node = U.el('div', {}, [U.el('span'), null, undefined, U.el('b')])
    assert.equal(node.children.length, 2)
  })
})
