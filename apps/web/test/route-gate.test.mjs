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
import { before, describe, it, mock } from 'node:test'

import { install } from './support/browser.mjs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let App, YumeAPI, PageAdmin

/** The section list a loaded admin panel would present. */
const SECTIONS = [
  { perm: 'admin.analytics.view' },
  { perm: 'admin.users.manage' },
  { perm: 'community.moderate' },
  { perm: 'roles.manage' }
]

before(async () => {
  install()
  ;({ App } = await import('../src/app/router.js'))
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
  ;({ PageAdmin } = await import('../src/pages/admin.js'))
  assert.ok(App, 'app.js must export App')
})

/** Put the app in a given signed-in state and ask the gate. */
function gate (route, { signedIn = true, perms = [], config = {}, sections = true } = {}) {
  mock.restoreAll()
  mock.method(YumeAPI, 'user', () => (signedIn ? { id: 'u1' } : null))
  // "the panel module has not loaded" used to be an absent global. An import
  // is always there, so the same situation is a panel with no sections to
  // offer — which is what the gate actually reads.
  PageAdmin.SECTIONS = sections ? SECTIONS : undefined
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
  const source = readFileSync(join(here, '../src/app/router.js'), 'utf8')

  it('answers a privileged route as "not found", naming no permission', () => {
    // A 403 that names the missing grant is a map for somebody probing: it
    // confirms the panel exists and says which permission to go after.
    //
    // Matched on the branch condition rather than on how far apart two strings
    // happen to sit: the two cases that must look identical — a route that
    // does not exist, and a privileged route this viewer may not open — are
    // rendered from one branch precisely so they cannot drift apart, and a
    // distance assertion broke the moment that branch grew a second condition.
    const branch = source.match(/gate\.kind === 'not-found'[^{]*\{([\s\S]*?)\n {4}\} else/)
    assert.ok(branch, 'the shared not-found branch is gone')
    // Comments are allowed to discuss permissions — explaining why one is not
    // named is the point of them. What must not appear is the value.
    const rendered = branch[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.match(rendered, /Page not found/)
    assert.doesNotMatch(rendered, /gate\.flag/, 'the refusal reached for the flag it must not name')
  })

  it('renders an address with no page behind it as not found, not as home', () => {
    // Falling back to the home page made every dead deep link — a renamed
    // route, a typo, a stale bookmark — look like it had worked.
    assert.match(source, /const handler = this\.routes\[route\]\s*\n\s{4}if \(!handler\)/)
    assert.doesNotMatch(source, /this\.routes\[route\] \?\? this\.routes\.home/)
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
