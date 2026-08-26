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
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    className: '',
    textContent: '',
    innerHTML: '',
    style: { cssText: '' },
    dataset: {},
    listeners: {},
    children: [],
    classList: {
      _owner: null,
      add (name) { this._owner.className = [...new Set([...this._owner.className.split(' ').filter(Boolean), name])].join(' ') },
      remove (name) { this._owner.className = this._owner.className.split(' ').filter(c => c && c !== name).join(' ') },
      contains (name) { return this._owner.className.split(' ').includes(name) },
      toggle (name, on) { (on ?? !this.contains(name)) ? this.add(name) : this.remove(name) }
    },
    replaceChildren (...kids) { this.children = kids.filter(k => k != null) },
    // The stub keeps no parent links, so a replaced node records what it
    // became and the test reads that instead.
    replaceWith (node) { this.replacedWith = node },
    setAttribute (k, v) { attrs.set(k, String(v)) },
    getAttribute (k) { return attrs.has(k) ? attrs.get(k) : null },
    hasAttribute (k) { return attrs.has(k) },
    addEventListener (type, fn) { this.listeners[type] = fn },
    append (...kids) { this.children.push(...kids.filter(k => k != null)) }
  }
  node.classList._owner = node
  return node
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
    for (const icon of ['https://cdn.example.com/i.png', '/icons/i.png']) {
      const node = Page._icon({ name: 'X', icon_key: icon })
      assert.equal(node.tagName, 'IMG')
      assert.equal(node.getAttribute('src'), icon)
    }
  })

  it('falls back to the first letter when there is no icon', () => {
    assert.equal(Page._icon({ name: 'plex' }).textContent, 'P')
  })

  it('falls back to the letter when a remote icon fails to load', () => {
    // An imported extension's icon is hosted by someone else. When that host
    // is gone — or the viewer blocks it — a broken-image glyph on the card
    // reads as the extension itself being broken.
    const img = Page._icon({ name: 'Nyaa', icon_key: 'https://nyaa.si/static/favicon.png' })
    assert.equal(img.tagName, 'IMG')
    img.listeners.error()
    assert.equal(img.replacedWith.textContent, 'N')
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

describe('the store detail page', () => {
  /** Render the detail view for a stubbed API and hand back the page root. */
  async function detail ({ ext = {}, installs = [], reviews = { data: [], mine: null } } = {}) {
    const root = makeElement('div')
    context.YumeAPI.extension = () => Promise.resolve({
      slug: 'aniskip',
      name: 'AniSkip',
      summary: 'Skips openings',
      type: 'metadata',
      developer: 'yume',
      install_count: 3,
      health: 'healthy',
      failures_7d: 0,
      versions: [],
      ...ext
    })
    context.YumeAPI.installedExtensions = () => Promise.resolve(installs)
    context.YumeAPI.extensionReviews = () => Promise.resolve(reviews)
    await Page._detail(root, ext.slug ?? 'aniskip')
    // _reviews() loads on its own microtask chain after _detail resolves.
    await new Promise(resolve => setTimeout(resolve, 0))
    return root
  }

  it('lists the permissions of the version an install would actually run', async () => {
    // What an extension is allowed to reach is the one thing worth reading
    // before pressing Install, so it is shown from the latest version rather
    // than merged across the history.
    const root = await detail({
      ext: {
        versions: [
          { version: '2.0.0', publishedAt: '2026-01-01', packageHash: 'a'.repeat(64), permissions: [{ permission: 'network', hosts: ['api.aniskip.com'] }] },
          { version: '1.0.0', publishedAt: '2025-01-01', packageHash: 'b'.repeat(64), permissions: [{ permission: 'storage', hosts: [] }] }
        ]
      }
    })
    const text = walk(root).map(n => n.textContent ?? '').join(' ')
    assert.match(text, /network/)
    assert.match(text, /api\.aniskip\.com/)
    assert.doesNotMatch(text, /storage/, 'a permission dropped in the new version must not still be advertised')
  })

  it('says an extension asks for nothing rather than showing an empty list', async () => {
    const root = await detail({ ext: { versions: [{ version: '1.0.0', publishedAt: '2026-01-01', permissions: [] }] } })
    assert.ok(walk(root).some(n => /no access beyond the sandbox/.test(n.textContent ?? '')))
  })

  it('reports no ratings instead of a zero score', async () => {
    // "★ 0.0" reads as an extension everybody hated; nobody has rated it.
    const root = await detail({ ext: { rating_avg: null, rating_count: 0 } })
    const text = walk(root).map(n => n.textContent ?? '').join(' ')
    assert.match(text, /No ratings yet/)
    assert.doesNotMatch(text, /★ 0\.0/)
  })

  it('offers the review form only to an account that installed it', async () => {
    const withoutInstall = await detail()
    assert.ok(walk(withoutInstall).some(n => /Install the extension to review it/.test(n.textContent ?? '')),
      'the server refuses the review anyway; asking first is not a kindness')

    const withInstall = await detail({ installs: [{ slug: 'aniskip', enabled: true, options: {}, option_schema: {} }] })
    assert.ok(find(withInstall, 'textarea').length === 1, 'an installed extension gets the form')
  })

  it('refuses to post a review with no rating picked', async () => {
    const sent = []
    context.YumeAPI.reviewExtension = (slug, body) => { sent.push({ slug, body }); return Promise.resolve({}) }
    const root = await detail({ installs: [{ slug: 'aniskip', enabled: true, options: {}, option_schema: {} }] })

    const post = find(root, 'button').find(b => /Post review/.test(label(b)))
    await post.listeners.click({ currentTarget: post })
    assert.equal(sent.length, 0, 'a rating-less review would be stored as no opinion at all')
    assert.ok(walk(root).some(n => /Pick a rating first/.test(n.textContent ?? '')))

    const stars = find(root, 'button').filter(b => label(b) === '★')
    assert.equal(stars.length, 5)
    stars[3].listeners.click({ currentTarget: stars[3] })
    await post.listeners.click({ currentTarget: post })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.rating, 4)
    delete context.YumeAPI.reviewExtension
  })

  it('pre-fills the form from the review this account already left', async () => {
    const root = await detail({
      installs: [{ slug: 'aniskip', enabled: true, options: {}, option_schema: {} }],
      reviews: {
        data: [{ id: 'r1', rating: 3, body: 'ok', author: 'me', created_at: '2026-01-01T00:00:00Z' }],
        mine: { id: 'r1', rating: 3, body: 'ok' }
      }
    })
    assert.equal(find(root, 'textarea')[0].value, 'ok')
    assert.ok(find(root, 'button').some(b => /Update review/.test(label(b))), 'replacing, not appending')
    assert.ok(find(root, 'button').some(b => /Delete/.test(label(b))))
  })

  it('does not offer a Report button on your own review', async () => {
    const root = await detail({
      installs: [{ slug: 'aniskip', enabled: true, options: {}, option_schema: {} }],
      reviews: {
        data: [
          { id: 'r1', rating: 3, author: 'me', created_at: '2026-01-01T00:00:00Z' },
          { id: 'r2', rating: 1, author: 'someone', created_at: '2026-01-02T00:00:00Z' }
        ],
        mine: { id: 'r1', rating: 3 }
      }
    })
    assert.equal(find(root, 'button').filter(b => /Report/.test(label(b))).length, 1)
  })

  it('reports a review under its own subject type, not the anime one', async () => {
    // `review` means an anime review and lives in a different table; sending
    // that type would point a moderator at an id that does not exist there.
    const sent = []
    context.YumeAPI.report = (...args) => { sent.push(args); return Promise.resolve({}) }
    context.window.prompt = () => 'spam'
    context.U.toast = () => {}
    const root = await detail({
      reviews: { data: [{ id: 'r2', rating: 1, author: 'someone', created_at: '2026-01-02T00:00:00Z' }], mine: null }
    })
    const button = find(root, 'button').find(b => /Report/.test(label(b)))
    await button.listeners.click({ currentTarget: button })
    assert.deepEqual(plain(sent[0]), ['extension_review', 'r2', 'spam'])
    delete context.YumeAPI.report
  })
})
