// The audit report reader.
//
// This page's whole job is to say what is wrong with the software, so the one
// outcome it must never produce is a clean-looking screen it has not earned.
// A file that is missing, unparseable, or parseable-but-not-a-report all have
// to come back as failures rather than as an audit with no findings — which is
// what a permissive check would turn them into.
//
// So the validation here is positive: every field the page reads has to be
// present and the right type, and each of these cases is one field removed
// from an otherwise valid report.
//
// Pure unit tests — no network, no database, no server.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const { whatIsWrongWith, reportPath, runningCommit } =
  await import('../src/modules/audit/report-routes.ts')

/** A minimal report that must be accepted, so each case below is one change from valid. */
const valid = (): Record<string, unknown> => ({
  generatedAt: '2026-09-14T04:31:13Z',
  commit: '1eff72f45aecb8d925a0c4f28f56997f6457c6b0',
  summary: { critical: 1, high: 0, medium: 0, low: 0 },
  findings: [{
    id: 'YUME-AUDIT-0001',
    severity: 'CRITICAL',
    category: 'functional',
    file: 'apps/web/src/shared/state/store.js',
    line: 120,
    title: 'something',
    impact: 'something happens',
    suggestedFix: 'do the other thing',
    effort: 'S',
    status: 'fixed'
  }]
})

describe('what counts as a report', () => {
  it('accepts the shape the page reads', () => {
    assert.equal(whatIsWrongWith(valid()), null)
  })

  it('accepts a report with no findings', () => {
    const report = valid()
    report.findings = []
    assert.equal(whatIsWrongWith(report), null)
  })

  // Each of these is a document that parses as JSON and is not an audit. None
  // of them may be reported as "no findings".
  const broken: Array<[string, (r: Record<string, unknown>) => void]> = [
    ['generatedAt missing', r => { delete r.generatedAt }],
    ['generatedAt not a date', r => { r.generatedAt = 'the fourteenth' }],
    ['commit missing', r => { delete r.commit }],
    ['commit not a sha', r => { r.commit = 'HEAD' }],
    ['summary missing', r => { delete r.summary }],
    ['summary.high missing', r => { r.summary = { critical: 0, medium: 0, low: 0 } }],
    ['findings missing', r => { delete r.findings }],
    ['findings not an array', r => { r.findings = {} }],
    ['a finding with no id', r => { delete (r.findings as Array<Record<string, unknown>>)[0]!.id }],
    ['an unknown severity', r => { (r.findings as Array<Record<string, unknown>>)[0]!.severity = 'URGENT' }],
    ['an unknown category', r => { (r.findings as Array<Record<string, unknown>>)[0]!.category = 'vibes' }],
    ['an unknown status', r => { (r.findings as Array<Record<string, unknown>>)[0]!.status = 'maybe' }],
    ['an unknown effort', r => { (r.findings as Array<Record<string, unknown>>)[0]!.effort = 'XL' }],
    ['a line that is not a number', r => { (r.findings as Array<Record<string, unknown>>)[0]!.line = '120' }],
    ['no file', r => { delete (r.findings as Array<Record<string, unknown>>)[0]!.file }],
    ['no impact', r => { delete (r.findings as Array<Record<string, unknown>>)[0]!.impact }],
    ['no suggestedFix', r => { delete (r.findings as Array<Record<string, unknown>>)[0]!.suggestedFix }]
  ]

  for (const [name, break_] of broken) {
    it(`refuses ${name}`, () => {
      const report = valid()
      break_(report)
      const wrong = whatIsWrongWith(report)
      assert.ok(wrong, `${name} was accepted as a report`)
      assert.equal(typeof wrong, 'string', 'the reason has to be sayable on the page')
    })
  }

  it('refuses things that are not documents at all', () => {
    for (const value of [null, undefined, 42, 'a report', [], true]) {
      assert.ok(whatIsWrongWith(value), `${JSON.stringify(value) ?? 'undefined'} was accepted`)
    }
  })

  it('names the finding it could not read', () => {
    const report = valid()
    ;(report.findings as Array<Record<string, unknown>>)[0]!.severity = 'URGENT'
    assert.match(String(whatIsWrongWith(report)), /YUME-AUDIT-0001/)
  })
})

describe('the report this repository ships', () => {
  // The page has one data source, so a malformed one is a broken page. This is
  // the check that the file in the commit is the shape the reader accepts.
  const shipped = fileURLToPath(new URL('../../../docs/audit-2026-09.json', import.meta.url))

  it('is a report', () => {
    assert.equal(whatIsWrongWith(JSON.parse(readFileSync(shipped, 'utf8'))), null)
  })

  it('is where the route resolves to by default', () => {
    const previous = process.env.AUDIT_REPORT_PATH
    delete process.env.AUDIT_REPORT_PATH
    try {
      assert.equal(reportPath(), shipped)
    } finally {
      if (previous !== undefined) process.env.AUDIT_REPORT_PATH = previous
    }
  })

  it('has a summary that agrees with its own findings', () => {
    // The page recounts rather than trusting this, so a disagreement is not a
    // crash — but it is still a wrong number in the file, and the file is
    // reviewed in a diff, which is where this belongs.
    const report = JSON.parse(readFileSync(shipped, 'utf8'))
    const counted = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const finding of report.findings) counted[finding.severity.toLowerCase() as keyof typeof counted]++
    assert.deepEqual(report.summary, counted)
  })

  it('gives every finding an id of its own, in sequence', () => {
    const report = JSON.parse(readFileSync(shipped, 'utf8'))
    const ids = report.findings.map((f: { id: string }) => f.id)
    assert.equal(new Set(ids).size, ids.length, 'two findings share an id')
    ids.forEach((id: string, index: number) => {
      assert.equal(id, `YUME-AUDIT-${String(index + 1).padStart(4, '0')}`)
    })
  })
})

describe('the commit the running code was built from', () => {
  it('reads the stamp when the image carries one', async () => {
    const previous = process.env.SOURCE_COMMIT
    process.env.SOURCE_COMMIT = '1eff72f45aecb8d925a0c4f28f56997f6457c6b0'
    try {
      assert.equal(await runningCommit(), '1eff72f45aecb8d925a0c4f28f56997f6457c6b0')
    } finally {
      if (previous === undefined) delete process.env.SOURCE_COMMIT
      else process.env.SOURCE_COMMIT = previous
    }
  })

  it('ignores a stamp that is not a sha rather than reporting it', async () => {
    // An empty ARG produces SOURCE_COMMIT='' in the image, and "" must not be
    // shown as the commit that is running.
    const previous = process.env.SOURCE_COMMIT
    const previousGit = process.env.GIT_COMMIT
    process.env.SOURCE_COMMIT = ''
    process.env.GIT_COMMIT = 'unknown'
    try {
      // Falls through to the checkout, which is a sha here or null elsewhere;
      // what matters is that neither bad value comes back.
      const commit = await runningCommit()
      assert.ok(commit === null || /^[0-9a-f]{40}$/.test(commit))
    } finally {
      if (previous === undefined) delete process.env.SOURCE_COMMIT
      else process.env.SOURCE_COMMIT = previous
      if (previousGit === undefined) delete process.env.GIT_COMMIT
      else process.env.GIT_COMMIT = previousGit
    }
  })
})
