// GET /v1/admin/audit/report — the code audit, served from the file it is written in.
//
// Not /v1/admin/audit, which is where this was specified to go: that route
// already exists and belongs to the audit *trail* (analytics/routes.ts). Two
// different things called audit, and Fastify refuses a duplicate route at
// startup rather than at request time — so registering the second one would
// not have failed this page, it would have stopped the application booting.
// See YUME-AUDIT-0013.
//
// The report is a file in the repository rather than a table because it is
// written by a person (or by an agent doing an audit pass) and reviewed in a
// diff. Putting it in the database would mean an import step between the two
// and a second copy that can disagree with the one in the commit.
//
// Nothing here is cached. The file is ~20 KB, the route is permission-gated
// and rate-limited, and an operator opens it a few times a day; a cache would
// buy nothing and would have to be invalidated after a deploy.

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Where the report lives, resolved from this source file.
 *
 * Same shape of path as the migration runner and the web root — correct in a
 * checkout and in the image only because the image mirrors the repository
 * layout. apps/api/src/modules/audit → five levels up is the repository root.
 * apps/api/test/paths.test.ts keeps that honest.
 *
 * `docs/` is in .dockerignore, so the Dockerfile re-includes this one file and
 * copies it explicitly. Override with AUDIT_REPORT_PATH.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const DEFAULT_REPORT = join(REPO_ROOT, 'docs/audit-2026-09.json')

export const reportPath = (): string => process.env.AUDIT_REPORT_PATH ?? DEFAULT_REPORT

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const CATEGORIES = ['security', 'functional', 'database', 'frontend'] as const
const STATUSES = ['open', 'fixed', 'wontfix'] as const

export interface Finding {
  id: string
  severity: typeof SEVERITIES[number]
  category: typeof CATEGORIES[number]
  file: string
  line: number
  title: string
  impact: string
  suggestedFix: string
  effort: 'S' | 'M' | 'L'
  status: typeof STATUSES[number]
}

export interface AuditReport {
  generatedAt: string
  commit: string
  summary: { critical: number, high: number, medium: number, low: number }
  findings: Finding[]
}

/**
 * Is this actually a report?
 *
 * A file that parses as JSON and is not this shape must be reported as broken,
 * not rendered as an audit with no findings — "nothing wrong here" is the one
 * answer a page like this must never give by accident. So the check is
 * positive: every field the page reads has to be there and be the right type.
 *
 * Returns the first thing wrong, or null.
 */
export function whatIsWrongWith (value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the document is not an object'
  const report = value as Partial<AuditReport>

  if (typeof report.generatedAt !== 'string') return 'generatedAt is missing or not a string'
  if (Number.isNaN(Date.parse(report.generatedAt))) return 'generatedAt is not a date'
  if (typeof report.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(report.commit)) {
    return 'commit is missing or not a git sha'
  }
  if (typeof report.summary !== 'object' || report.summary === null) return 'summary is missing'
  for (const key of ['critical', 'high', 'medium', 'low'] as const) {
    if (typeof report.summary[key] !== 'number') return `summary.${key} is missing or not a number`
  }
  if (!Array.isArray(report.findings)) return 'findings is missing or not an array'

  for (const [index, raw] of report.findings.entries()) {
    const at = (what: string): string => `findings[${index}] (${(raw as Finding)?.id ?? 'no id'}): ${what}`
    if (typeof raw !== 'object' || raw === null) return at('not an object')
    const finding = raw as Partial<Finding>
    if (typeof finding.id !== 'string' || !finding.id) return at('id is missing')
    if (!SEVERITIES.includes(finding.severity as Finding['severity'])) return at(`severity ${String(finding.severity)} is not one of ${SEVERITIES.join(', ')}`)
    if (!CATEGORIES.includes(finding.category as Finding['category'])) return at(`category ${String(finding.category)} is not one of ${CATEGORIES.join(', ')}`)
    if (!STATUSES.includes(finding.status as Finding['status'])) return at(`status ${String(finding.status)} is not one of ${STATUSES.join(', ')}`)
    if (!['S', 'M', 'L'].includes(finding.effort as string)) return at('effort is not S, M or L')
    if (typeof finding.file !== 'string' || !finding.file) return at('file is missing')
    if (typeof finding.line !== 'number' || !Number.isInteger(finding.line)) return at('line is missing or not an integer')
    if (typeof finding.title !== 'string' || !finding.title) return at('title is missing')
    if (typeof finding.impact !== 'string') return at('impact is missing')
    if (typeof finding.suggestedFix !== 'string') return at('suggestedFix is missing')
  }
  return null
}

/**
 * The commit the running code was built from, if anything knows it.
 *
 * Three sources, in order of how much they can be trusted, and `null` when
 * none of them answers — which is the honest result inside an image that was
 * not stamped, because `.git` is in .dockerignore and there is nothing in the
 * container to read. The page says it cannot tell rather than implying the
 * audit is current, since "no warning" and "no information" must not look the
 * same on a page whose job is to say what is known.
 */
export async function runningCommit (): Promise<string | null> {
  const stamped = process.env.SOURCE_COMMIT ?? process.env.GIT_COMMIT
  if (stamped && /^[0-9a-f]{7,40}$/.test(stamped)) return stamped

  // A development checkout: read the ref the way git itself would.
  try {
    const head = (await readFile(join(REPO_ROOT, '.git/HEAD'), 'utf8')).trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
    if (!ref) return null
    const sha = (await readFile(join(REPO_ROOT, '.git', ref), 'utf8')).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

const routes: FastifyPluginAsync = async fastify => {
  /**
   * `hide: true`, so an account without audit.read is told the page does not
   * exist rather than that it exists and is closed to them. A 403 on this one
   * would confirm that the instance keeps a list of its own weak points.
   */
  fastify.get('/audit/report', {
    onRequest: fastify.requirePermission('audit.read', { hide: true })
  }, async (request, reply) => {
    const path = reportPath()
    const shown = relative(REPO_ROOT, path) || path

    let raw: string
    let modifiedAt: string
    try {
      const [contents, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      raw = contents
      modifiedAt = info.mtime.toISOString()
    } catch {
      // 503 rather than 404: the route exists and the caller may read it, there
      // is simply no report yet. A 404 here is the answer this route already
      // gives to somebody who lacks the permission, and the two must not be
      // confusable.
      return await reply.code(503).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: `No audit report at ${shown}. Generate one, or point AUDIT_REPORT_PATH at it.`
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return await reply.code(500).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: `The audit report at ${shown} is not valid JSON: ${(error as Error).message}`
      })
    }

    const wrong = whatIsWrongWith(parsed)
    if (wrong) {
      return await reply.code(500).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: `The audit report at ${shown} is not a report: ${wrong}`
      })
    }

    const report = parsed as AuditReport
    const running = await runningCommit()

    return {
      report,
      source: { path: shown, bytes: Buffer.byteLength(raw), modifiedAt },
      running: {
        commit: running,
        // Three answers, not two. `null` means nothing here knows which commit
        // is running, which is not the same as knowing the audit is current.
        stale: running === null ? null : !running.startsWith(report.commit) && !report.commit.startsWith(running)
      }
    }
  })
}

export default routes
