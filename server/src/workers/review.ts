// Extension review worker: static analysis of a submitted version's
// manifest + declared permissions. Auto-approves low-risk versions; flags
// permission escalations for human review (extensions.review).
// Job payload: { versionId }
//
// In production the package bytes are fetched from object storage and the
// code is scanned (no eval, no undeclared network hosts, size caps). This
// build performs the manifest/permission checks that don't need the bytes;
// the code scan is the same shape applied to the fetched source.

import { query, queryOne } from '../db.ts'
import { notify } from './notify.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { Job } from '../lib/queue.ts'

interface VersionRow {
  id: string
  extension_id: string
  version: string
  manifest: Record<string, unknown>
  package_size: number
  owner_id: string
  slug: string
}

// permissions that always require a human to approve
const SENSITIVE = new Set(['query:media', 'net:fetch'])

export interface ReviewResult {
  decision: 'approved' | 'flagged' | 'rejected'
  notes: string
}

export function analyzeManifest (manifest: Record<string, unknown>, permissions: Array<{ permission: string, hosts: string[] }>): ReviewResult {
  const problems: string[] = []

  if (Number(manifest.manifestVersion) < 3) problems.push('manifestVersion must be >= 3')
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('missing manifest.name')

  // net:fetch must declare a non-empty, plausible host allowlist
  for (const perm of permissions) {
    if (perm.permission === 'net:fetch') {
      if (!perm.hosts.length) problems.push('net:fetch declared without host allowlist')
      for (const host of perm.hosts) {
        if (host === '*' || host.includes('*')) problems.push(`wildcard host not allowed: ${host}`)
        if (!/^[a-z0-9.-]+$/i.test(host)) problems.push(`invalid host: ${host}`)
      }
    }
  }

  if (problems.length) {
    return { decision: 'rejected', notes: problems.join('; ') }
  }

  const needsHuman = permissions.some(p => SENSITIVE.has(p.permission))
  return needsHuman
    ? { decision: 'flagged', notes: 'Sensitive permissions (' + permissions.filter(p => SENSITIVE.has(p.permission)).map(p => p.permission).join(', ') + ') — awaiting human review.' }
    : { decision: 'approved', notes: 'Auto-approved: no sensitive permissions.' }
}

export async function reviewVersion (versionId: string): Promise<ReviewResult> {
  const version = await queryOne<VersionRow>(
    `SELECT v.id, v.extension_id, v.version, v.manifest, v.package_size, e.owner_id, e.slug
     FROM extension_versions v JOIN extensions e ON e.id = v.extension_id
     WHERE v.id = $1 AND v.review_status = 'pending'`,
    [versionId]
  )
  if (!version) return { decision: 'rejected', notes: 'version not found or already reviewed' }

  const permissions = await query<{ permission: string, hosts: string[] }>(
    'SELECT permission, hosts FROM extension_permissions WHERE version_id = $1',
    [versionId]
  )

  const result = analyzeManifest(version.manifest, permissions)

  if (result.decision === 'approved') {
    // publish immediately
    await query(
      `UPDATE extension_versions SET review_status = 'approved', published_at = now(), review_notes = $2 WHERE id = $1`,
      [versionId, result.notes]
    )
    await query(`UPDATE extensions SET status = 'published' WHERE id = $1`, [version.extension_id])
  } else if (result.decision === 'rejected') {
    await query(`UPDATE extension_versions SET review_status = 'rejected', review_notes = $2 WHERE id = $1`, [versionId, result.notes])
  } else {
    // flagged: leave pending, notify reviewers-side handled by human queue.
    await query(`UPDATE extension_versions SET review_notes = $2 WHERE id = $1`, [versionId, result.notes])
  }

  // tell the developer the outcome
  await notify(version.owner_id, 'extension_review', {
    slug: version.slug, version: version.version, decision: result.decision, notes: result.notes
  })
  await emitEvent('extension.reviewed', { slug: version.slug, version: version.version, decision: result.decision, notes: result.notes })

  return result
}

export async function handleReviewJob (job: Job): Promise<void> {
  const { versionId } = job.payload as { versionId: string }
  await reviewVersion(versionId)
}
