// Publish the first-party extensions into the store.
//
//   node --experimental-strip-types scripts/publish-extensions.ts [--force]
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// The extensions in `extensions/` are source folders in the repository. The
// store lists rows in the `extensions` table. Nothing connected the two, so a
// fresh install browsed an empty store and every extension shipped with the
// project was invisible.
//
// This is the connection: it reads each package, validates its manifest with
// the same validator the publish endpoint uses, stores the bytes in the
// content-addressed package store, and records the version as approved and
// published.
//
// ---------------------------------------------------------------------------
// What it will not do
// ---------------------------------------------------------------------------
//   * It never creates a user. An account is a person; a shipped account with
//     a known password is a back door. The owner is an existing administrator
//     — the same rule migration 0021 uses to pick the first one.
//   * It never changes the status of an extension that already exists. An
//     operator who suspended one meant it, and a restart resurrecting it would
//     make the kill switch a suggestion.
//   * It never overwrites a published version with different bytes. Versions
//     are immutable, which is what makes the recorded hash worth checking;
//     changed code needs a version bump. `--force` overrides this for local
//     development, and says so loudly.

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pool, query, queryOne, transaction } from '../src/db.ts'
import { validateManifest } from '../src/lib/extension-manifest.ts'
import { looksLikeSource, put } from '../src/lib/package-store.ts'

import type { ExtensionManifest } from '../src/lib/extension-manifest.ts'

const ROOT = process.env.EXTENSIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions')
const FORCE = process.argv.includes('--force')

/** Publisher name shown on every store card these rows produce. */
const DEVELOPER_NAME = process.env.EXTENSIONS_DEVELOPER_NAME ?? 'Yume'

interface OwnerRow { id: string, username: string }

/**
 * Who owns the first-party extensions.
 *
 * `EXTENSIONS_OWNER` names an account (username or email) explicitly. Without
 * it, the oldest administrator — on a self-hosted install that is the person
 * who set it up, and it is the rule the admin bootstrap already follows.
 */
async function resolveOwner (): Promise<OwnerRow | undefined> {
  const named = process.env.EXTENSIONS_OWNER
  if (named) {
    return await queryOne<OwnerRow>(
      `SELECT id, username FROM users
        WHERE (username = $1 OR email = $1) AND deleted_at IS NULL`,
      [named]
    )
  }
  return await queryOne<OwnerRow>(
    `SELECT u.id, u.username FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.slug = 'admin' AND u.deleted_at IS NULL
      ORDER BY u.created_at ASC LIMIT 1`
  )
}

async function packages (): Promise<string[]> {
  const entries = await readdir(ROOT, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => join(ROOT, e.name)).sort()
}

/**
 * An emoji is not an image URL.
 *
 * `icon_key` is rendered as an `<img src>` when it is set, so storing "⏭️"
 * there would draw a broken image on every card. The client treats a value
 * that is not a URL as text — see web/js/pages/extensions.js — and this keeps
 * the two ends agreeing about what may be stored.
 */
const iconKey = (icon: string | undefined): string | null => (icon && icon.trim() ? icon.trim().slice(0, 200) : null)

interface Result { slug: string, action: 'published' | 'updated' | 'unchanged' | 'skipped', detail?: string }

async function publishOne (dir: string, ownerId: string): Promise<Result> {
  const manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(manifestRaw) as ExtensionManifest
  const slug = String(manifest.id ?? dir)

  const validation = validateManifest(manifest)
  if (!validation.valid) return { slug, action: 'skipped', detail: validation.errors.join('; ') }

  const source = await readFile(join(dir, 'index.js'))
  if (!looksLikeSource(source)) return { slug, action: 'skipped', detail: 'index.js is not source text' }

  const stored = await put(source)

  return await transaction(async client => {
    // ---- the store listing -------------------------------------------------
    // Existing rows keep their status: publishing must not undo a suspension.
    const { rows: extRows } = await client.query<{ id: string, inserted: boolean }>(
      `INSERT INTO extensions (slug, owner_id, name, summary, description, type, icon_key, accuracy, media_kind, languages, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published')
       ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name,
              summary = EXCLUDED.summary,
              description = EXCLUDED.description,
              icon_key = EXCLUDED.icon_key,
              accuracy = EXCLUDED.accuracy,
              media_kind = EXCLUDED.media_kind,
              languages = EXCLUDED.languages,
              updated_at = now()
       RETURNING id, (xmax = 0) AS inserted`,
      [slug, ownerId, manifest.name, manifest.summary, manifest.description ?? null, manifest.type,
        iconKey(manifest.icon), manifest.accuracy ?? 'medium', manifest.media ?? 'both', manifest.languages ?? []]
    )
    const extension = extRows[0]!

    // ---- the version -------------------------------------------------------
    const { rows: existingRows } = await client.query<{ id: string, package_hash: string }>(
      'SELECT id, package_hash FROM extension_versions WHERE extension_id = $1 AND version = $2',
      [extension.id, manifest.version]
    )
    const existing = existingRows[0]

    if (existing && existing.package_hash === stored.hash) {
      return { slug, action: extension.inserted ? 'published' : 'unchanged' }
    }
    if (existing && !FORCE) {
      return {
        slug,
        action: 'skipped',
        detail: `version ${manifest.version} is already published with different bytes — bump the version in manifest.json (or pass --force)`
      }
    }

    const { rows: versionRows } = await client.query<{ id: string }>(
      `INSERT INTO extension_versions
         (extension_id, version, package_key, package_hash, package_size, manifest, min_app_version, review_status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'approved', now())
       ON CONFLICT (extension_id, version) DO UPDATE
          SET package_key = EXCLUDED.package_key,
              package_hash = EXCLUDED.package_hash,
              package_size = EXCLUDED.package_size,
              manifest = EXCLUDED.manifest,
              min_app_version = EXCLUDED.min_app_version,
              published_at = now()
       RETURNING id`,
      [extension.id, manifest.version, stored.hash, stored.hash, stored.size, manifestRaw, manifest.minAppVersion ?? null]
    )
    const versionId = versionRows[0]!.id

    // ---- what the sandbox will enforce -------------------------------------
    // Replaced wholesale: a permission removed from the manifest must be gone
    // from the row the host reads, not merely absent from the new list.
    await client.query('DELETE FROM extension_permissions WHERE version_id = $1', [versionId])
    for (const permission of validation.permissions) {
      await client.query(
        'INSERT INTO extension_permissions (version_id, permission, hosts) VALUES ($1, $2, $3)',
        [versionId, permission.permission, permission.hosts]
      )
    }

    return { slug, action: existing ? 'updated' : 'published' }
  })
}

// ---------------------------------------------------------------------------

const owner = await resolveOwner()
if (!owner) {
  // Not an error: on a fresh database this runs before anybody has registered,
  // and the app must still start. Say what is missing and stop.
  console.log('publish-extensions: no administrator account yet — nothing published.')
  console.log('  Register an account (the first one becomes administrator), then run this again:')
  console.log('  docker compose --profile extensions run --rm extensions')
  await pool.end()
  process.exit(0)
}

await query(
  `INSERT INTO extension_developers (user_id, display_name, verified)
   VALUES ($1, $2, true)
   ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
  [owner.id, DEVELOPER_NAME]
)

const dirs = await packages()
console.log(`publish-extensions: ${dirs.length} package(s) from ${ROOT}, owned by ${owner.username} as "${DEVELOPER_NAME}"`)

let failed = 0
for (const dir of dirs) {
  try {
    const result = await publishOne(dir, owner.id)
    if (result.action === 'skipped') {
      failed++
      console.warn(`  ✗ ${result.slug}: ${result.detail}`)
    } else {
      console.log(`  ✓ ${result.slug}: ${result.action}`)
    }
  } catch (err) {
    failed++
    console.warn(`  ✗ ${dir}: ${(err as Error).message}`)
  }
}

await pool.end()
// A package that failed to publish is worth a non-zero exit for CI, but the
// Docker entrypoint runs this before the API starts — see the Dockerfile,
// where a failure here must not stop the app from booting.
process.exit(failed ? 1 : 0)
