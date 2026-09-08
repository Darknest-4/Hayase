// The router's second spelling of a route: "/anime/123" as well as "#/anime/123".
//
// A fragment is never sent to the server, so while "#/anime/123" was the only
// form, nothing outside a browser could be told which anime a URL was about —
// every crawler, link preview and share sheet saw index.html's generic <head>.
// The server now answers the path form with the app plus a <head> about that
// anime (apps/api/src/modules/seo/routes.ts) and the sitemap points at it, which only
// works if the client agrees that the path names a route.
//
// What is checked here is the agreement, and the two ways it could go wrong:
// a path that is not a route must not become one, and arriving on a path must
// leave the address bar in the app's own form rather than half in each.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, describe, it } from 'node:test'

import { install } from './support/browser.mjs'

const INDEX = new URL('../index.html', import.meta.url)

let App
/** Every replaceState the app performed, in order. */
let replaced = []

const location = { hash: '#/home', pathname: '/', search: '' }

before(async () => {
  install({
    location,
    history: { replaceState (_state, _title, url) { replaced.push(url) } }
  })
  ;({ App } = await import('../js/app.js'))
  assert.ok(App, 'app.js must export App')
})

beforeEach(() => { replaced = [] })

/** Put the fake browser at an address and ask the router where that is. */
function at (hash, pathname = '/', search = '') {
  Object.assign(location, { hash, pathname, search })
  return App.parseHash()
}

describe('reading a hash address', () => {
  it('still reads the app\'s own links', () => {
    const { route, arg, params } = at('#/anime/123?tab=episodes')
    assert.equal(route, 'anime')
    assert.equal(arg, '123')
    assert.equal(params.get('tab'), 'episodes')
  })

  it('an empty hash is home', () => {
    assert.equal(at('').route, 'home')
    assert.equal(at('#/').route, 'home')
  })

  it('the hash wins over the path, so a click never lands on the old page', () => {
    // Arriving on /anime/123 and then clicking "Home" leaves the pathname
    // where it was until the rewrite happens. Reading the path first would
    // send the viewer back to the anime they just navigated away from.
    assert.equal(at('#/home', '/anime/123').route, 'home')
  })
})

describe('reading a path address', () => {
  it('routes /anime/123 exactly like #/anime/123', () => {
    const { route, arg } = at('', '/anime/123')
    assert.equal(route, 'anime')
    assert.equal(arg, '123')
  })

  it('takes the query from the search string, where a path URL keeps it', () => {
    assert.equal(at('', '/anime/123', '?tab=episodes').params.get('tab'), 'episodes')
  })

  it('a path that is not a route is home, not a route named after it', () => {
    // The SPA fallback answers every unknown path with index.html, so this is
    // reachable by typo. Inventing a route from it would call an undefined
    // renderer; the not-found gate belongs to real routes, not to noise.
    for (const path of ['/nonsense', '/.env', '/wp-admin/setup-config.php']) {
      assert.equal(at('', path).route, 'home', path)
    }
  })

  it('survives a location with no pathname at all', () => {
    // Not hypothetical: several client tests construct exactly this window.
    Object.assign(location, { hash: '', search: '' })
    delete location.pathname
    assert.equal(App.parseHash().route, 'home')
  })
})

describe('normalising a path address', () => {
  it('rewrites the path form into the app\'s own hash form', () => {
    at('', '/anime/123', '?tab=episodes')
    App.normalisePath()
    assert.deepEqual(replaced, ['/#/anime/123?tab=episodes'])
  })

  it('leaves a hash address alone', () => {
    at('#/anime/123', '/')
    App.normalisePath()
    assert.deepEqual(replaced, [], 'an address already in hash form was rewritten')
  })

  it('leaves the site root alone', () => {
    at('', '/')
    App.normalisePath()
    assert.deepEqual(replaced, [], 'the root was rewritten to something else')
  })

  it('does not rewrite a path it refused to route', () => {
    at('', '/nonsense')
    App.normalisePath()
    assert.deepEqual(replaced, [], '/nonsense became /#/home')
  })
})

describe('what index.html asks the browser for', () => {
  const html = readFileSync(INDEX, 'utf8')

  it('asks for its scripts and styles from the root', () => {
    // Relative asset URLs resolve against the document, so on /anime/123 the
    // browser asked for /anime/js/app.js — and the SPA fallback answered every
    // one of those with index.html, a 200 of the wrong media type. The page
    // loaded with no scripts and no styles at all.
    for (const ref of html.match(/(?:src|href)="(?!https?:|#|\/)([^"]+)"/g) ?? []) {
      assert.fail(`index.html has a relative reference: ${ref}`)
    }
  })

  it('keeps the markers the server replaces the head between', () => {
    // Without them modules/seo/meta.ts silently serves the generic head, which is a
    // regression nothing else would notice.
    assert.ok(html.includes('<!--yume:seo-->'), 'the opening SEO marker is gone')
    assert.ok(html.includes('<!--/yume:seo-->'), 'the closing SEO marker is gone')
    assert.ok(html.indexOf('<title>') > html.indexOf('<!--yume:seo-->'),
      'the title sits outside the block the server replaces')
    assert.ok(html.indexOf('<title>') < html.indexOf('<!--/yume:seo-->'))
  })
})
