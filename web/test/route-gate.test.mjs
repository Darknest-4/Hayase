// Who can reach the admin panel, and what the answer looks like when they cannot.
//
// The gate used to fail *open* in two places and asked a different question
// than the panel itself, which produced both halves of the same bug:
//
//   analyst    held `analytics.view` — the flag's permission — so the link
//              appeared, and every section inside then refused them
//   moderator  held `community.moderate`, a real section, but not the flag's
//              permission, so no link appeared at all
//
// Both are fixed by asking one question in one place: does this account hold
// any permission the panel's own sections require.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

/** A DOM node stub that answers anything asked of it. */
const element = () => ({
  style: {},
  dataset: {},
  classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
  children: [],
  hidden: false,
  append () {},
  prepend () {},
  replaceChildren () {},
  remove () {},
  addEventListener () {},
  removeEventListener () {},
  setAttribute () {},
  getAttribute: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  focus () {},
  scrollTo () {}
})

let App
let context

/** The app object, with just enough of a browser around it to construct. */
before(() => {
  const window = { location: { hash: '#/home' }, addEventListener () {} }
  context = {
    window,
    document: {
      createElement: () => element(),
      createTextNode: t => ({ textContent: t }),
      // A stub element rather than null: App.init() wires listeners onto
      // several nodes, and this file is not testing that it finds them.
      getElementById: () => element(),
      querySelector: () => element(),
      querySelectorAll: () => [],
      addEventListener () {},
      documentElement: element(),
      body: element()
    },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    URL,
    Promise,
    JSON,
    Date,
    Math,
    Object,
    Array,
    Set,
    Map,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    requestAnimationFrame: fn => fn(),
    C: {},
    U: { el: () => ({ append () {} }) },
    T: k => k,
    I18n: new Proxy({ locale: () => 'en' }, { get: (t, k) => k in t ? t[k] : () => undefined })
  }
  context.globalThis = context

  // app.js calls App.init() when it loads, which reaches for most of the
  // client. None of that is what this file tests, so the collaborators are
  // stubbed rather than loaded — a real Store would drag in localStorage, the
  // catalogue and the router.
  const noop = () => {}
  const quiet = new Proxy({}, { get: () => () => undefined })
  window.YumeAPI = {
    user: () => null,
    myPermissions: async () => [],
    available: async () => false,
    config: async () => null,
    base: () => ''
  }
  Object.assign(context, {
    YumeAPI: window.YumeAPI,
    Store: quiet,
    Prefs: quiet,
    Catalogue: quiet,
    Onboarding: quiet,
    LibrarySync: quiet,
    ExtensionHost: quiet
  })
  for (const key of ['Store', 'Prefs', 'Catalogue', 'Onboarding', 'LibrarySync', 'ExtensionHost']) window[key] = context[key]
  context.C = new Proxy({}, { get: () => () => ({ append: noop, classList: { add: noop, remove: noop, toggle: noop } }) })
  context.U = new Proxy({ el: () => ({ append: noop, classList: { add: noop, remove: noop, toggle: noop }, children: [] }) },
    { get: (target, key) => key in target ? target[key] : () => undefined })
  context.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }
  window.localStorage = context.localStorage
  window.sessionStorage = context.localStorage
  window.matchMedia = () => ({ matches: false, addEventListener: noop })
  // The panel's own section list is the source of truth the gate reads.
  window.PageAdmin = {
    SECTIONS: [
      { key: 'overview', perm: 'admin.analytics.view' },
      { key: 'users', perm: 'admin.users.manage' },
      { key: 'reports', perm: 'community.moderate' },
      { key: 'roles', perm: 'roles.manage' }
    ]
  }
  runInNewContext(readFileSync(join(here, '../js/app.js'), 'utf8'), context)
  App = window.App ?? context.App
  assert.ok(App, 'app.js must expose App')
})

/** Put the app in a given signed-in state and ask the gate. */
function gate (route, { signedIn = true, perms = [], config = {}, sections = true } = {}) {
  context.window.YumeAPI.user = () => signedIn ? { id: 'u1' } : null
  context.window.PageAdmin = sections
    ? { SECTIONS: [{ perm: 'admin.analytics.view' }, { perm: 'admin.users.manage' }, { perm: 'community.moderate' }, { perm: 'roles.manage' }] }
    : undefined
  App.perms = perms
  App.config = config === null
    ? null
    : { site: { requireLogin: false, name: 'Yume' }, flags: {}, ...config }
  return App._gateCheck(route)
}

describe('the admin gate', () => {
  it('lets in an account holding any section permission', () => {
    for (const perm of ['admin.analytics.view', 'admin.users.manage', 'community.moderate', 'roles.manage']) {
      assert.equal(gate('admin', { perms: [perm] }).ok, true, perm)
    }
  })

  it('lets in a moderator, who has a real section but not the old flag permission', () => {
    // The inverse half of the reported bug: a moderator could not see the link
    // to the moderation queue they are responsible for.
    assert.equal(gate('admin', { perms: ['community.moderate'] }).ok, true)
  })

  it('keeps out an account whose permission opens no section', () => {
    // `analytics.view` is the permission the old `page.admin` flag asked for,
    // and it opens nothing: every section wants `admin.analytics.view` or
    // another slug. It let people through to a wall.
    assert.equal(gate('admin', { perms: ['analytics.view'] }).ok, false)
    assert.equal(gate('admin', { perms: ['comments.write', 'anime.view'] }).ok, false)
  })

  it('keeps out an account with no permissions at all', () => {
    assert.equal(gate('admin', { perms: [] }).ok, false)
  })

  it('keeps out a signed-out visitor', () => {
    assert.equal(gate('admin', { signedIn: false, perms: ['admin.users.manage'] }).ok, false)
  })
})

describe('failing closed', () => {
  it('refuses the admin panel when the backend is unreachable', () => {
    // The old default was "config missing → everything on", which meant a
    // backend outage handed the admin link to everyone still holding a page.
    assert.equal(gate('admin', { perms: ['admin.users.manage'], config: null }).ok, false)
  })

  it('still lets ordinary pages work when the backend is unreachable', () => {
    // Failing closed everywhere would blank the site during an outage; the
    // catalogue is meant to stay browsable.
    assert.equal(gate('home', { config: null }).ok, true)
    assert.equal(gate('search', { config: null }).ok, true)
  })

  it('a missing feature flag row neither lets in nor locks out', () => {
    // Deleting one row from feature_flags used to make everyone an admin.
    // It must also not do the opposite: the permission is the authorisation,
    // the flag is only a kill switch.
    assert.equal(gate('admin', { perms: [], config: { flags: {} } }).ok, false, 'no permission, still out')
    assert.equal(gate('admin', { perms: ['admin.users.manage'], config: { flags: {} } }).ok, true, 'permission holder still in')
  })

  it('an administrator can still turn the panel off for everyone', () => {
    const off = { flags: { 'page.admin': { enabled: false, access: 'permission', permission: 'analytics.view', label: 'Admin' } } }
    assert.equal(gate('admin', { perms: ['admin.users.manage'], config: off }).ok, false)
  })

  it('refuses the admin panel when the panel module has not loaded', () => {
    // "We could not check" must mean no on a privileged route.
    assert.equal(gate('admin', { perms: ['admin.users.manage'], sections: false }).ok, false)
  })

  it('still allows an unconfigured ordinary page', () => {
    assert.equal(gate('community', { config: { flags: {} } }).ok, true)
  })
})

describe('what the refusal says', () => {
  const source = readFileSync(join(here, '../js/app.js'), 'utf8')

  it('answers a privileged route as "not found", naming no permission', () => {
    // A 403 that names the missing grant is a map for somebody probing: it
    // confirms the panel exists and says which permission to go after.
    assert.match(source, /PRIVILEGED\.includes\(route\)[\s\S]{0,400}Page not found/)
  })

  it('still names the permission for an ordinary gated page', () => {
    // A viewer refused Watch Together should be able to ask for it by name.
    assert.match(source, /requires the .{1,3}\$\{gate\.flag\.permission\}/)
  })

  it('does not read gate.flag without checking it exists', () => {
    // The privileged path produces a refusal with no flag attached, so the
    // old unconditional `gate.flag.label` would have thrown.
    assert.doesNotMatch(source, /text: `\$\{gate\.flag\.label\}/)
  })
})
