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

let App, YumeAPI, ADMIN_SECTIONS

/*
 * A VALÓDI SZAKASZLISTÁVAL MÉRÜNK, nem egy kitalálttal.
 *
 * Eddig ez a fájl egy négyelemű `SECTIONS` mintát tett `PageAdmin.SECTIONS`
 * helyére, és azon állított. Ez azt mérte, hogy a kapu helyesen olvas EGY
 * KITALÁLT listát — nem azt, hogy a YUME kapuja helyesen dönt. A kettő
 * akkor vált szét, amikor a lista saját modulba került, és kiderült, hogy
 * két állítás a minta hiányosságán állt:
 *
 *   `analytics.view`   a minta szerint semmit nem nyitott → a valóságban a
 *                      „Látogatottság" szakaszt nyitja;
 *   `settings.system`  a minta szerint csak visszaállítási jog → a
 *                      valóságban szakaszt nyit, tehát a panel jár neki.
 *
 * Egyik sem a kód hibája volt. A teszt premisszája volt hamis.
 */
before(async () => {
  install()
  ;({ App } = await import('../src/app/router.js'))
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
  ;({ ADMIN_SECTIONS } = await import('../src/shared/lib/admin-sections.js'))
  assert.ok(App, 'app.js must export App')
})

/** Egy jogosultság, ami bizonyítottan EGYETLEN szakaszt sem nyit. */
function nyitSemmit (...jeloltek) {
  const nyit = new Set(ADMIN_SECTIONS.map(s => s.perm).filter(Boolean))
  for (const j of jeloltek) {
    assert.ok(!nyit.has(j), `a(z) ${j} MOST MÁR nyit szakaszt — a teszt premisszája elavult`)
  }
  return jeloltek
}

/** Put the app in a given signed-in state and ask the gate. */
function gate (route, { signedIn = true, perms = [], config = {} } = {}) {
  mock.restoreAll()
  mock.method(YumeAPI, 'user', () => (signedIn ? { id: 'u1' } : null))
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
    // A jogosultságokat a VALÓDI listához mérjük: a `nyitSemmit` elbukik, ha
    // a panel egyszer szakaszt ad valamelyikhez, tehát ez az állítás nem tud
    // némán elavulni.
    for (const perm of nyitSemmit('comments.write', 'profile.edit')) {
      assert.equal(gate('admin', { perms: [perm] }).ok, false, perm)
    }
    assert.equal(gate('admin', { perms: nyitSemmit('comments.write', 'profile.edit') }).ok, false)
  })

  /*
   * A FORDÍTOTT IRÁNY IS KELL. Csak azt állítani, hogy valakit kizárunk,
   * félrevezet: egy elrontott kapu, ami MINDENKIT kizár, ettől még zöld
   * lenne. Aki tart egy szakasznyitó jogosultságot, az menjen be.
   */
  it('beengedi azt, akinek van szakasza', () => {
    for (const perm of ['admin.users.manage', 'community.moderate', 'analytics.view']) {
      assert.equal(gate('admin', { perms: [perm] }).ok, true, perm)
    }
  })

  it('keeps out an account with no permissions at all', () => {
    assert.equal(gate('admin', { perms: [] }).ok, false)
  })

  it('keeps out a signed-out visitor', () => {
    assert.equal(gate('admin', { signedIn: false, perms: ['admin.users.manage'] }).ok, false)
  })

  it('refuses a signed-out visitor the same way it refuses an unpermitted one', () => {
    // It used to answer `auth`, which the renderer draws as a sign-in card
    // headed with the flag's label — and a privileged refusal carries no flag,
    // so `gate.flag.label` threw and the visitor got a blank page. Opening
    // #/admin signed out, from a stale bookmark, painted nothing at all.
    //
    // Answering `permission` fixes both halves: nothing throws, and a visitor
    // who is not signed in learns exactly as much about the panel as one who
    // is signed in without the grant — which is nothing.
    assert.deepEqual(gate('admin', { signedIn: false }), { ok: false, kind: 'permission' })
    assert.deepEqual(gate('admin', { signedIn: false, perms: ['admin.users.manage'] }), { ok: false, kind: 'permission' })
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

  it('an administrator can still turn the panel off for everyone else', () => {
    const off = { flags: { 'page.admin': { enabled: false, access: 'permission', permission: 'analytics.view', label: 'Admin' } } }
    assert.equal(gate('admin', { perms: ['admin.users.manage'], config: off }).ok, false)
    assert.equal(gate('admin', { perms: ['community.moderate'], config: off }).ok, false)
    assert.equal(gate('admin', { perms: ['roles.manage'], config: off }).ok, false)
  })

  it('but the switch cannot lock out the only people who can switch it back', () => {
    // The panel is the only place page.admin can be turned back on. Before
    // this, turning it off ended every administrator's access for good and
    // left a database console as the way in. Whoever holds settings.system —
    // the permission that edits the flags — keeps the door.
    const off = { flags: { 'page.admin': { enabled: false, access: 'permission', permission: 'analytics.view', label: 'Admin' } } }
    assert.equal(gate('admin', { perms: ['settings.system', 'admin.users.manage'], config: off }).ok, true)
  })

  it('the recovery path is not a way past the permission check', () => {
    /*
     * A kikapcsolt `page.admin` a panelt nem zárja el az elől, aki
     * amúgy is bemehetne — de nem is NYITJA MEG annak, aki nem.
     *
     * A régi állítás `settings.system`-mel dolgozott, azzal az indoklással,
     * hogy az „csak a visszaállítás joga, nem szakaszjog". A valódi listában
     * viszont szakaszt nyit, tehát a panel jár neki — a minta hiányossága
     * miatt tűnt másnak.
     */
    const off = { flags: { 'page.admin': { enabled: false, access: 'permission', permission: 'analytics.view', label: 'Admin' } } }
    for (const perm of nyitSemmit('comments.write', 'profile.edit')) {
      assert.equal(gate('admin', { perms: [perm], config: off }).ok, false, perm)
    }
    assert.equal(gate('admin', { signedIn: false, perms: ['settings.system'], config: off }).ok, false,
      'kijelentkezve a visszaállítási út sem út')
  })

  it('the recovery path is only for the panel, not for ordinary pages', () => {
    // A disabled page stays disabled for everyone, administrators included:
    // it is reachable again from the panel, so nothing is lost by refusing it.
    const off = { flags: { 'page.community': { enabled: false, access: 'public', label: 'Community' } } }
    assert.equal(gate('community', { perms: ['settings.system'], config: off }).ok, false)
  })

  /*
   * EZ AZ ESET MEGSZŰNT, és ezt jobb kimondani, mint csendben törölni.
   *
   * A szakaszlista régen az adminpanel modulján lógott, ezért létezett olyan
   * állapot, hogy „még nem tudjuk, mire gátol a panel" — és a kapu erre
   * helyesen nemet mondott. A lista azóta saját modulban van
   * (`shared/lib/admin-sections.js`), STATIKUS importtal: a 279 kB-os panel
   * emiatt már nem terhel minden oldalbetöltést, a lista viszont mindig
   * megvan.
   *
   * Amit most őrizni kell, az nem a régi nemleges válasz, hanem az, hogy a
   * kapu és a panel UGYANAZT a listát olvassa — a széttartásuk volt az
   * eredeti hiba.
   */
  it('a kapu és a panel ugyanarra a szakaszlistára gátol', async () => {
    const { PageAdmin } = await import('../src/pages/admin.js')
    assert.equal(PageAdmin.SECTIONS, ADMIN_SECTIONS,
      'a panel saját másolatot tart a szakaszlistából')
    assert.ok(ADMIN_SECTIONS.length > 0, 'üres szakaszlistával ez semmit nem bizonyít')
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

// ---------------------------------------------------------------------------
// A PRIVÁT PÉLDÁNY
// ---------------------------------------------------------------------------
//
// `require_login` mellett a katalógus nem jár egy kijelentkezett látogatónak —
// és ilyenkor NEM egy lakatot mutatunk, hanem a kezdőképernyőt. Egy zárt
// ajtóval szemben az a különbség, hogy van mit nézni, és van hova menni.
//
// A kapu két irányban is elromolhat, és a második a veszélyesebb: ha a
// belépőlapot is elzárná, egy privát példányon senki nem tudna bejelentkezni.
// Ez nem elméleti — a `_gateExempt` egy háromelemű lista, és egy hiányzó elem
// pont ezt jelentené.

describe('a privát példány kapuja', () => {
  const privat = { site: { requireLogin: true, name: 'Yume' } }

  it('kijelentkezve a kezdőképernyőre terel, nem lakatra', () => {
    const verdict = gate('home', { signedIn: false, config: privat })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.kind, 'site-login')
  })

  it('a katalógus minden útvonala mögé odaáll', () => {
    for (const route of ['home', 'search', 'list', 'anime', 'community', 'schedule']) {
      assert.equal(gate(route, { signedIn: false, config: privat }).kind, 'site-login', route)
    }
  })

  /*
   * EZ A FONTOSABB IRÁNY. Ha a belépőlap is a kapu mögé kerülne, egy privát
   * példányon nem lenne mód bejelentkezni — a látogató a kezdőképernyőre
   * jutna, onnan a belépésre kattintana, és ugyanoda érkezne vissza.
   */
  it('a belépéshez vezető utak nyitva maradnak', () => {
    for (const route of ['login', 'landing', 'settings']) {
      assert.equal(gate(route, { signedIn: false, config: privat }).ok, true, route)
    }
  })

  it('belépve minden a szokásos módon jár', () => {
    assert.equal(gate('home', { signedIn: true, config: privat }).ok, true)
  })

  it('nyilvános példányon a kapu nem szól bele', () => {
    assert.equal(gate('home', { signedIn: false }).ok, true)
  })

  it('a kapu a kezdőképernyőt rajzolja, és leveszi az alkalmazás krómját', () => {
    // Az ikonsáv öt olyan helyre mutatna, ahová egy kijelentkezett látogató
    // nem juthat el.
    const router = readFileSync(join(here, '../src/app/router.js'), 'utf8')
    const branch = router.slice(router.indexOf("gate.kind === 'site-login'"), router.indexOf("} else if (gate.kind === 'auth')"))
    assert.match(branch, /Landing\.render/)
    assert.match(branch, /classList\.add\('landing-route'\)/)
  })
})
