// The extension store's install half.
//
// The store listed extensions and had no install button, no options form and
// no way to turn one off — so an extension could be browsed and never run, and
// the ones that need a server URL or a token had no way to be told either.
//
// Two failures are covered here specifically because both look like nothing is
// wrong: an emoji icon rendered as an <img src> (a broken image on every card
// the bundled extensions produce), and a token drawn in a plain text field.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

function makeElement (tag) {
  const attrs = new Map()
  return {
    tagName: tag.toUpperCase(),
    nodeType: 1,
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
    append (...kids) { this.children.push(...kids.filter(k => k != null)) }
  }
}

const textNode = data => ({ nodeType: 3, textContent: String(data) })

// The page builds its objects inside the vm realm, so deepEqual compares them
// against a different Object.prototype and fails on identical data.
const plain = value => JSON.parse(JSON.stringify(value))

/** Every descendant with a tag, flattened — the DOM stub keeps no parent links. */
function walk (node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const find = (node, tag) => walk(node).filter(n => n.tagName === tag.toUpperCase())

/**
 * The visible text of a node.
 *
 * `U.el(tag, {}, [createTextNode('Save')])` puts the label in a child node,
 * not in textContent, so matching on textContent alone finds nothing.
 */
const label = node => [node.textContent ?? '', ...(node.children ?? []).map(label)].join('')

let Page
let context

before(() => {
  const window = {}
  context = {
    window,
    document: { createElement: makeElement, createTextNode: textNode },
    console,
    navigator: { language: 'en' },
    Intl,
    setTimeout,
    clearTimeout
  }
  context.globalThis = context
  runInNewContext(readFileSync(join(here, '../js/util.js'), 'utf8'), context)
  context.U = window.U ?? context.U
  context.T = key => key
  context.I18n = { locale: () => 'en' }
  context.YumeAPI = { user: () => ({ id: 'u1' }) }
  runInNewContext(readFileSync(join(here, '../js/pages/extensions.js'), 'utf8'), context)
  Page = window.PageExtensions
  assert.ok(Page, 'extensions.js must expose PageExtensions')
})

describe('the icon', () => {
  it('draws an emoji as text, not as an image', () => {
    // Every bundled extension declares an emoji, so getting this wrong is a
    // broken image on every card in the store.
    const node = Page._icon({ name: 'AniSkip', icon_key: '⏭️' })
    assert.equal(node.nodeType, 3)
    assert.equal(node.textContent, '⏭️')
  })

  it('still draws a real image when the icon is a URL or a path', () => {
    for (const icon_key of ['https://cdn.example.com/i.png', '/icons/i.png']) {
      const node = Page._icon({ name: 'X', icon_key })
      assert.equal(node.tagName, 'IMG')
      assert.equal(node.getAttribute('src'), icon_key)
    }
  })

  it('falls back to the first letter when there is no icon', () => {
    assert.equal(Page._icon({ name: 'plex' }).textContent, 'P')
  })
})

describe('the options form', () => {
  const field = (key, spec, value) => {
    const changes = []
    const node = Page._optionField(key, spec, value, v => changes.push(v))
    return { node, changes }
  }

  it('hides a token instead of printing it on screen', () => {
    // A token is a password: it should not be readable over a shoulder or in
    // a screenshot of the settings panel.
    for (const key of ['api_token', 'access_key', 'password', 'client_secret']) {
      const { node } = field(key, { type: 'string' }, 'sekrit')
      assert.equal(find(node, 'input')[0].getAttribute('type'), 'password', key)
    }
    const { node } = field('server_url', { type: 'string' }, 'https://x')
    assert.equal(find(node, 'input')[0].getAttribute('type'), 'text')
  })

  it('offers exactly the declared choices for a select', () => {
    const { node } = field('types', { type: 'select', choices: ['op_ed', 'op', 'ed'] }, 'op')
    const options = find(node, 'option')
    assert.deepEqual(options.map(o => o.getAttribute('value')), ['op_ed', 'op', 'ed'])
    assert.equal(find(node, 'select')[0].value, 'op')
  })

  it('checks a boolean from the stored value, then from the default', () => {
    assert.equal(find(field('include_light', { type: 'boolean', default: true }, false).node, 'input')[0].checked, false)
    assert.equal(find(field('include_light', { type: 'boolean', default: true }, undefined).node, 'input')[0].checked, true)
  })

  it('treats an emptied number as unset rather than as zero', () => {
    // `Number('')` is 0, so a cleared "minimum length" field would silently
    // become a real setting of zero.
    const { node, changes } = field('min_length', { type: 'number', default: 5 }, 5)
    const input = find(node, 'input')[0]
    input.value = ''
    input.listeners.change({ currentTarget: input })
    assert.equal(changes[0], null)

    input.value = '12'
    input.listeners.change({ currentTarget: input })
    assert.equal(changes[1], 12)
  })

  it('shows the description the manifest wrote', () => {
    const { node } = field('feed_url', { type: 'string', description: 'Where your JSON feed lives.' })
    assert.ok(walk(node).some(n => n.textContent === 'Where your JSON feed lives.'))
  })
})

describe('the settings panel', () => {
  const ext = { slug: 'aniskip' }

  it('says so when an extension has nothing to configure', () => {
    const panel = Page._settings(ext, { option_schema: {}, options: {} })
    assert.ok(walk(panel).some(n => /nothing to configure/.test(n.textContent ?? '')))
  })

  it('draws one control per declared option', () => {
    const panel = Page._settings(ext, {
      option_schema: { types: { type: 'select', choices: ['op', 'ed'] }, min_length: { type: 'number' } },
      options: { types: 'op' }
    })
    assert.equal(find(panel, 'select').length, 1)
    assert.equal(find(panel, 'input').length, 1)
  })

  /** Press Save and return what reached the API. */
  async function save (install, edit) {
    const sent = []
    const reloads = []
    context.YumeAPI.configureExtension = (slug, body) => { sent.push({ slug, body }); return Promise.resolve({}) }
    const original = Page._reloadHost
    Page._reloadHost = async () => { reloads.push(1) }
    try {
      const panel = Page._settings(ext, install)
      edit?.(panel)
      const button = find(panel, 'button').find(b => /Save/.test(label(b)))
      await button.listeners.click({ currentTarget: button })
      return { sent, reloads, panel }
    } finally {
      Page._reloadHost = original
      delete context.YumeAPI.configureExtension
    }
  }

  it('submits every option, not only the edited one', async () => {
    // Options replace rather than merge server-side, so sending a partial set
    // would clear everything the viewer did not touch this time.
    const { sent } = await save({
      option_schema: { server_url: { type: 'string' }, api_token: { type: 'string' } },
      options: { server_url: 'https://media.example.com', api_token: 'abc' }
    }, panel => {
      const input = find(panel, 'input')[0]
      input.value = 'https://new.example.com'
      input.listeners.change({ currentTarget: input })
    })

    assert.equal(sent.length, 1)
    assert.equal(sent[0].slug, 'aniskip')
    assert.deepEqual(plain(sent[0].body.options), { server_url: 'https://new.example.com', api_token: 'abc' })
  })

  it('restarts the sandbox after saving, so the change is live', () => {
    // The worker was started with the old options and keeps using them until
    // it is replaced; without this the setting looks ignored.
    return save({ option_schema: { a: { type: 'string' } }, options: { a: '1' } })
      .then(({ reloads }) => assert.equal(reloads.length, 1))
  })

  it('shows the failure instead of reporting a save that did not happen', async () => {
    context.YumeAPI.configureExtension = () => Promise.reject(new Error('token rejected'))
    const panel = Page._settings(ext, { option_schema: { a: { type: 'string' } }, options: {} })
    const button = find(panel, 'button').find(b => /Save/.test(label(b)))
    await button.listeners.click({ currentTarget: button })
    delete context.YumeAPI.configureExtension
    assert.ok(walk(panel).some(n => n.textContent === 'token rejected'))
  })
})

describe('the page source', () => {
  const source = readFileSync(join(here, '../js/pages/extensions.js'), 'utf8')

  it('installs, configures and uninstalls through the API adapter', () => {
    for (const method of ['installExtension', 'configureExtension', 'uninstallExtension']) {
      assert.match(source, new RegExp(`YumeAPI\\.${method}\\(`))
    }
  })

  it('restarts the sandbox after a change, so it takes effect without a reload', () => {
    // The worker holds the options it was started with; a saved change that
    // does nothing until F5 reads as the setting being ignored.
    assert.match(source, /unloadAll\?\.\(\)[\s\S]{0,120}bootstrap\(\)/)
  })

  it('offers sign-in rather than a button that fails when pressed', () => {
    assert.match(source, /Sign in to install/)
  })

  it('does not let a failed install list break the store listing', () => {
    assert.match(source, /installedExtensions\(\)\.catch\(\(\) => \[\]\)/)
  })
})

describe('the API adapter', () => {
  const source = readFileSync(join(here, '../js/yume-api.js'), 'utf8')

  it('sends options with PATCH, which is what the route accepts', () => {
    assert.match(source, /configureExtension[\s\S]{0,400}method: 'PATCH'/)
  })

  it('omits an unset field rather than sending null over it', () => {
    assert.match(source, /if \(enabled !== undefined\) body\.enabled = enabled/)
    assert.match(source, /if \(options !== undefined\) body\.options = options/)
  })
})
