// The Audit status section.
//
// Two things are worth pinning here, and neither is about rendering.
//
// The first is the name collision. There are two audits in this product — the
// log of what people did, and the report of what is wrong with the software —
// and they collided at the section key, the client method and the route. The
// route one would have stopped the application booting (YUME-AUDIT-0013). The
// section keys are checked here because a duplicate there is silent: the rail
// would draw two items and the second would never open.
//
// The second is that the page's numbers come from the data. The summary counts
// the findings it was handed rather than trusting the report's own `summary`
// header, so a file whose header disagrees with its body shows the
// disagreement — and a page about what is wrong with the software must never
// answer "nothing" on the strength of a number it did not check.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { install } from './support/browser.mjs'

let PageAdmin, YumeAPI

before(async () => {
  install()
  ;({ PageAdmin } = await import('../src/pages/admin.js'))
  ;({ YumeAPI } = await import('../src/shared/api/yume.js'))
})

describe('the two audits are kept apart', () => {
  it('gives every section its own key', () => {
    const keys = PageAdmin.SECTIONS.map(s => s.key)
    assert.equal(new Set(keys).size, keys.length,
      `two sections share a key: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`)
  })

  it('puts the report at audit and the log at audit-log', () => {
    const report = PageAdmin.SECTIONS.find(s => s.key === 'audit')
    const log = PageAdmin.SECTIONS.find(s => s.key === 'audit-log')

    // `audit` is the report, because /admin/audit is the address the page was
    // specified at and an address can only mean one thing.
    assert.equal(report?.render, 'renderAuditStatus')
    assert.equal(report?.perm, 'audit.read')
    assert.equal(log?.render, 'renderAudit')
    assert.equal(log?.perm, 'admin.users.manage')
    // A kettő NEVE is különbözzön, ne csak a kulcsa. Egymás mellett a rálban
    // a „Napló" és az „Auditállapot" összekeverhető volt: az egyik azt mondja
    // meg, ki mit csinált, a másik azt, mi a baj a szoftverrel.
    assert.notEqual(report?.label, log?.label)
    assert.ok(!report?.label.includes('Napló'), 'a kódaudit neve ne tartalmazza a „Napló" szót')
  })

  it('every section sits in a group the rail actually renders', () => {
    // A rál csoportonként épül: egy nem létező csoportkulcsú szakasz sehol
    // nem jelenik meg, és semmi nem hibázik tőle. A csoportok átrendezésekor
    // ez volt az, ami elrejtett volna egy képernyőt.
    const groups = new Set(PageAdmin.GROUPS.map(g => g.key))
    const orphans = PageAdmin.SECTIONS.filter(s => !groups.has(s.group)).map(s => `${s.key} → ${s.group}`)
    assert.deepEqual(orphans, [], 'sections in a group that does not exist')
  })

  it('no group is a dumping ground', () => {
    // Kilenc bejegyzés egy csoportban nem csoport, hanem maradék: ott kötött
    // ki minden, aminek nem volt jobb helye, és emiatt a rál alsó fele
    // átolvashatatlan volt.
    const counts = new Map()
    for (const section of PageAdmin.SECTIONS) counts.set(section.group, (counts.get(section.group) ?? 0) + 1)
    const crowded = [...counts].filter(([, n]) => n > 7).map(([g, n]) => `${g}: ${n}`)
    assert.deepEqual(crowded, [], 'groups with more than seven sections')
  })

  it('gives every section a renderer that exists', () => {
    for (const section of PageAdmin.SECTIONS) {
      assert.equal(typeof PageAdmin[section.render], 'function',
        `${section.key} names ${section.render}, which is not a method`)
    }
  })

  it('asks the server for the report on its own path', () => {
    // /v1/admin/audit is the log's. Two methods, two routes, no overlap.
    assert.equal(typeof YumeAPI.admin.auditReport, 'function')
    const source = readFileSync(fileURLToPath(new URL('../src/shared/api/yume.js', import.meta.url)), 'utf8')
    assert.match(source, /auditReport: \(\) => YumeAPI\._request\('\/v1\/admin\/audit\/report'/)
  })
})

describe('the section only appears for an account that holds audit.read', () => {
  // What render() filters on. An account with every other admin permission
  // must not see the item, because the item is a list of this instance's own
  // weak points and the route behind it answers 404 rather than 403.
  const visible = perms => PageAdmin.SECTIONS.filter(s => perms.includes(s.perm)).map(s => s.key)

  it('is hidden from an administrator who was not granted it', () => {
    const everythingElse = [...new Set(PageAdmin.SECTIONS.map(s => s.perm))].filter(p => p !== 'audit.read')
    assert.ok(!visible(everythingElse).includes('audit'))
    assert.ok(visible(everythingElse).includes('audit-log'), 'the log is a different grant and stays visible')
  })

  it('is shown to an account that holds it', () => {
    assert.deepEqual(visible(['audit.read']), ['audit'])
  })
})

describe('the summary counts what it was given', () => {
  const finding = (severity, status) => ({
    id: 'YUME-AUDIT-0001',
    severity,
    category: 'security',
    file: 'a.js',
    line: 1,
    title: 't',
    impact: 'i',
    suggestedFix: 'f',
    effort: 'S',
    status
  })

  /** The text of a rendered summary, with the stub DOM's children flattened. */
  const textOf = node => {
    if (node == null) return ''
    if (typeof node === 'string') return node
    return (node.textContent ?? '') + (node.children ?? []).map(textOf).join(' ')
  }

  it('counts severities from the findings rather than from a summary header', () => {
    const text = textOf(PageAdmin.auditSummary([
      finding('CRITICAL', 'open'),
      finding('HIGH', 'open'),
      finding('HIGH', 'fixed'),
      finding('LOW', 'wontfix')
    ]))
    assert.match(text, /1.*CRITICAL/s)
    assert.match(text, /2.*HIGH/s)
    assert.match(text, /0.*MEDIUM/s)
    assert.match(text, /1.*LOW/s)
  })

  it('splits open from fixed', () => {
    const text = textOf(PageAdmin.auditSummary([
      finding('HIGH', 'open'), finding('HIGH', 'open'), finding('LOW', 'fixed')
    ]))
    assert.match(text, /2 open/)
    assert.match(text, /1 fixed/)
  })

  it('reports the fixed share as a ratio and says what it measures', () => {
    const text = textOf(PageAdmin.auditSummary([
      finding('HIGH', 'fixed'), finding('HIGH', 'open'), finding('LOW', 'open'), finding('LOW', 'open')
    ]))
    assert.match(text, /1 of 4/)
    assert.match(text, /25%/)
    // The sentence is the point: a bar without it gets read as a grade.
    assert.match(text, /not a security score/)
  })

  it('does not divide by zero on an empty report', () => {
    const text = textOf(PageAdmin.auditSummary([]))
    assert.match(text, /0 of 0/)
    assert.ok(!/NaN/.test(text), 'an empty report produced NaN')
  })

  it('counts an unknown status as open rather than dropping it', () => {
    const text = textOf(PageAdmin.auditSummary([finding('HIGH', 'in-progress')]))
    assert.match(text, /1 open/)
  })
})

describe('severity is never only a colour', () => {
  it('puts the word in the badge', () => {
    for (const severity of PageAdmin.AUDIT_SEVERITIES) {
      const badge = PageAdmin.auditSeverityBadge(severity)
      assert.equal(badge.textContent, severity)
      assert.match(badge.className, new RegExp(`sev-${severity.toLowerCase()}\\b`))
    }
  })

  it('takes its colours from tokens rather than from hex', () => {
    const css = readFileSync(fileURLToPath(new URL('../css/style.css', import.meta.url)), 'utf8')
    const block = css.slice(css.indexOf('.sev-critical'), css.indexOf('.aud-showing'))
    assert.match(block, /--sev: var\(--severity-critical\)/)
    assert.match(block, /--sev: var\(--severity-high\)/)
    assert.match(block, /--sev: var\(--severity-medium\)/)
    assert.match(block, /--sev: var\(--severity-low\)/)
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(block), `a hex colour crept into the severity block: ${block}`)

    const tokens = readFileSync(fileURLToPath(new URL('../css/tokens.css', import.meta.url)), 'utf8')
    for (const name of ['critical', 'high', 'medium', 'low']) {
      assert.match(tokens, new RegExp(`--severity-${name}: var\\(--`),
        `--severity-${name} must alias an existing primitive, not introduce a colour`)
    }
  })
})

describe('the list is cards on a phone, not a sideways table', () => {
  const css = readFileSync(fileURLToPath(new URL('../css/style.css', import.meta.url)), 'utf8')

  it('never builds the list out of table elements', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/pages/admin.js', import.meta.url)), 'utf8')
    const section = source.slice(source.indexOf('auditFindingRow (finding)'), source.indexOf('auditSkeleton ()'))
    for (const tag of ['table', 'thead', 'tbody', 'tr', 'td', 'th']) {
      assert.ok(!section.includes(`U.el('${tag}'`), `the finding row builds a <${tag}>`)
    }
  })

  it('restacks the row at the narrow breakpoint', () => {
    // Below 560 the row's columns become named areas stacked down the card, so
    // nothing has to scroll sideways at 375.
    const narrow = css.slice(css.lastIndexOf('@media (max-width: 560px)'))
    assert.match(narrow, /\.aud-row-head\s*\{[^}]*grid-template-areas/s)
    assert.match(narrow, /\.aud-file\s*\{[^}]*overflow-wrap: anywhere/s)
  })
})
