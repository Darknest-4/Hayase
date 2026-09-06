// /v1/dev — developer portal API: become a developer, create/manage
// extension listings, upload versions (into the review pipeline), and read
// per-extension analytics. Publishing needs the extensions.publish
// permission (granted with the 'developer' role).

import { createHash } from 'node:crypto'

import { query, queryOne, transaction } from '../db.ts'
import { escalatedPermissions, validateManifest } from '../lib/extension-manifest.ts'
import { MAX_PACKAGE_BYTES, looksLikeSource, put, statBlob } from '../lib/package-store.ts'
import { enqueue } from '../lib/queue.ts'
import { fetchExternal, manifestFor, MAX_INDEX_BYTES, parseIndex, slugify } from '../lib/repository.ts'
import { audit } from '../lib/audit.ts'
import { WRITE_LIMIT } from '../plugins/security.ts'
import { emitEvent } from '../lib/webhooks.ts'

import { onUniqueViolation } from '../lib/db-errors.ts'
import { EXTENSION_TYPES } from '../lib/extension-manifest.ts'

import type { FastifyPluginAsync } from 'fastify'

// The one list, from the manifest validator — restating it here meant two
// places to change when a type is added, and no error if only one changed.
const TYPES = EXTENSION_TYPES
const SEMVER = /^\d+\.\d+\.\d+$/

const routes: FastifyPluginAsync = async fastify => {
  // ---------- developer profile ----------

  fastify.get('/me', { preHandler: fastify.authenticate }, async request => {
    const dev = await queryOne(
      'SELECT user_id, display_name, website, verified, created_at FROM extension_developers WHERE user_id = $1',
      [request.user.sub]
    )
    return { developer: dev ?? null }
  })

  // enrol as a developer (grants the developer role → extensions.publish)
  fastify.post('/register', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['displayName'],
        properties: {
          displayName: { type: 'string', minLength: 2, maxLength: 60 },
          website: { type: 'string', maxLength: 200 }
        }
      }
    }
  }, async (request, reply) => {
    const { displayName, website } = request.body as { displayName: string, website?: string }
    const dev = await transaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO extension_developers (user_id, display_name, website)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET display_name = $2, website = $3
         RETURNING user_id, display_name, website, verified, created_at`,
        [request.user.sub, displayName, website ?? null]
      )
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'developer'
         ON CONFLICT DO NOTHING`,
        [request.user.sub]
      )
      return rows[0]
    })
    return reply.code(201).send(dev)
  })

  // ---------- listings ----------

  fastify.get('/extensions', { preHandler: fastify.requirePermission('extensions.publish', { hide: true }) }, async request => {
    const data = await query(
      `SELECT e.id, e.slug, e.name, e.summary, e.type, e.status, e.install_count, e.rating_avg, e.rating_count, e.updated_at,
              (SELECT count(*) FROM extension_versions v WHERE v.extension_id = e.id) AS version_count,
              (SELECT count(*) FROM extension_versions v WHERE v.extension_id = e.id AND v.review_status = 'pending') AS pending_versions
       FROM extensions e WHERE e.owner_id = $1 ORDER BY e.updated_at DESC`,
      [request.user.sub]
    )
    return { data }
  })

  fastify.post('/extensions', {
    preHandler: fastify.requirePermission('extensions.publish', { hide: true }),
    schema: {
      body: {
        type: 'object',
        required: ['slug', 'name', 'summary', 'type'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9-]{3,64}$' },
          name: { type: 'string', minLength: 2, maxLength: 100 },
          summary: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 20000 },
          type: { enum: [...TYPES] }
        }
      }
    }
  }, async (request, reply) => {
    const { slug, name, summary, description, type } = request.body as {
      slug: string, name: string, summary: string, description?: string, type: string
    }

    /**
     * extensions.owner_id is a foreign key to extension_developers(user_id),
     * not to users(id). Holding the extensions.publish permission is therefore
     * not sufficient — the caller also needs a developer record, which
     * POST /v1/dev/register creates.
     *
     * Without this check the insert violated the FK and escaped as an opaque
     * 500: verified, a permitted user who had not registered got
     * "Internal Server Error" from the store's only entry point, with nothing
     * to indicate what was missing. GET /me and GET /extensions both answer
     * 200 for such a user, so the portal looks usable right up to this call.
     */
    const developer = await queryOne('SELECT 1 FROM extension_developers WHERE user_id = $1', [request.user.sub])
    if (!developer) {
      return reply.code(409).send({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Register as a developer first — POST /v1/dev/register'
      })
    }

    const taken = await queryOne('SELECT 1 FROM extensions WHERE slug = $1', [slug])
    if (taken) return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Slug already taken' })

    // The check above is a read followed by a write, so two parallel creates
    // of the same slug both pass it and one hits extensions_slug_key. That is
    // the same outcome the caller already has a 409 for, so it is reported as
    // one rather than as a 500 naming the constraint.
    const ext = await onUniqueViolation(
      async () => queryOne(
        `INSERT INTO extensions (slug, owner_id, name, summary, description, type, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft')
         RETURNING id, slug, name, summary, type, status, created_at`,
        [slug, request.user.sub, name, summary, description ?? null, type]
      ),
      () => undefined
    )
    if (!ext) return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Slug already taken' })
    return reply.code(201).send(ext)
  })

  // helper: assert the caller owns the extension
  async function ownedExtension (userId: string, slug: string): Promise<{ id: string, type: string } | undefined> {
    return queryOne<{ id: string, type: string }>(
      'SELECT id, type FROM extensions WHERE slug = $1 AND owner_id = $2',
      [slug, userId]
    )
  }

  // ---------- versions ----------

  /**
   * Upload the package bytes. Returns the content hash, which is then quoted
   * when publishing a version.
   *
   * The body is the raw source, not JSON: an extension package is a script,
   * and wrapping it in JSON would only cost an encode/decode round trip. The
   * hash is computed here from what actually arrived — a publisher never gets
   * to assert what their own bytes hash to.
   */
  fastify.post('/extensions/:slug/packages', {
    preHandler: fastify.requirePermission('extensions.publish', { hide: true }),
    // the global body limit is sized for JSON payloads; a package is larger
    bodyLimit: MAX_PACKAGE_BYTES,
    schema: { params: { type: 'object', properties: { slug: { type: 'string' } } } }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const ext = await ownedExtension(request.user.sub, slug)
    if (!ext) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const bytes = request.body as Buffer
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'Send the package source as the raw request body with Content-Type: application/javascript'
      })
    }
    if (!looksLikeSource(bytes)) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'A package must be UTF-8 source code'
      })
    }

    try {
      const stored = await put(bytes)
      return reply.code(201).send(stored)
    } catch (err) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400, detail: (err as Error).message
      })
    }
  })

  // Publish a version against an already-uploaded package. The manifest and
  // declared permissions are snapshotted here and static review is queued.
  fastify.post('/extensions/:slug/versions', {
    preHandler: fastify.requirePermission('extensions.publish', { hide: true }),
    schema: {
      params: { type: 'object', properties: { slug: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['version', 'packageHash', 'manifest'],
        properties: {
          version: { type: 'string' },
          // the hash returned by the package upload; size and key are derived
          // from the stored blob, never taken from the caller
          packageHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          changelog: { type: 'string', maxLength: 5000 },
          minAppVersion: { type: 'string' },
          manifest: { type: 'object' }
          // NOTE: permissions are read from the manifest, never from a separate
          // field — otherwise a caller could declare one set to the store and
          // ship another to the sandbox.
        }
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const body = request.body as {
      version: string, packageHash: string,
      changelog?: string, minAppVersion?: string, manifest: Record<string, unknown>
    }

    if (!SEMVER.test(body.version)) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'version must be semver (x.y.z)' })
    }

    const ext = await ownedExtension(request.user.sub, slug)
    if (!ext) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // A version can only reference bytes that were actually uploaded. This is
    // what makes the recorded hash meaningful: it names a blob the server
    // stored and hashed itself.
    const stored = await statBlob(body.packageHash)
    if (!stored) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'No uploaded package with that hash — POST the source to /v1/dev/extensions/' + slug + '/packages first'
      })
    }

    // The manifest is the contract the sandbox enforces, so it is validated
    // here and every declaration is taken from it.
    const check = validateManifest(body.manifest)
    const manifest = body.manifest as { id?: string, version?: string, type?: string, minAppVersion?: string }
    const mismatches: string[] = []
    if (manifest.id !== undefined && manifest.id !== slug) {
      mismatches.push(`manifest.id "${manifest.id}" must match the extension slug "${slug}"`)
    }
    if (manifest.version !== undefined && manifest.version !== body.version) {
      mismatches.push(`manifest.version "${manifest.version}" must match the published version "${body.version}"`)
    }
    if (manifest.type !== undefined && manifest.type !== ext.type) {
      mismatches.push(`manifest.type "${manifest.type}" must match the extension type "${ext.type}"`)
    }
    const problems = [...check.errors, ...mismatches]
    if (problems.length) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Invalid manifest', status: 400,
        detail: problems.join('; ')
      })
    }

    const dupe = await queryOne('SELECT 1 FROM extension_versions WHERE extension_id = $1 AND version = $2', [ext.id, body.version])
    if (dupe) return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Version already exists (versions are immutable)' })

    const version = await transaction(async client => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO extension_versions
           (extension_id, version, package_key, package_hash, package_size, manifest, changelog, min_app_version, review_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING id, version, review_status, created_at`,
        [ext.id, body.version, stored.hash, stored.hash, stored.size, body.manifest, body.changelog ?? null, manifest.minAppVersion ?? body.minAppVersion ?? null]
      )
      const versionId = rows[0]!.id
      for (const perm of check.permissions) {
        await client.query(
          'INSERT INTO extension_permissions (version_id, permission, hosts) VALUES ($1, $2, $3)',
          [versionId, perm.permission, perm.hosts]
        )
      }
      await client.query('UPDATE extensions SET status = $2 WHERE id = $1 AND status = $3', [ext.id, 'in_review', 'draft'])
      return rows[0]!
    })

    // A new version must never quietly gain capabilities: compare against the
    // last published version so review (and the update prompt) can show it.
    const previous = await query<{ permission: string, hosts: string[] }>(
      `SELECT p.permission, p.hosts FROM extension_permissions p
       JOIN extension_versions v ON v.id = p.version_id
       WHERE v.extension_id = $1 AND v.published_at IS NOT NULL
       ORDER BY v.published_at DESC`,
      [ext.id]
    )
    const escalations = previous.length ? escalatedPermissions(previous, check.permissions) : []

    // queue the static-analysis review step
    await enqueue('ext-review', { versionId: version.id, dedupe: `review:${version.id}` })
    await emitEvent('extension.submitted', {
      slug, version: body.version, developer: request.user.username,
      ...(escalations.length ? { escalations: escalations.join(', ') } : {})
    })

    return reply.code(201).send({ ...version, permissions: check.permissions, escalations })
  })

  // ---------- analytics ----------

  /**
   * Import every package in an external repository index.
   *
   * This is how an extension gets into the store without being one of the
   * packages that ship with the project: an operator points at an index, and
   * the packages in it become listings they own and are answerable for.
   *
   * The index is treated as hostile input throughout — see lib/repository.ts
   * for the reasoning. The part worth repeating here: the index never gets to
   * say what its packages hash to. The bytes are fetched, hashed and stored by
   * this server, so a lying index produces a different hash and the client
   * rejects the package rather than running it.
   *
   * Imported listings are owned by the importer and marked as third-party in
   * their description. This deployment vouches for none of them, and the
   * operator who imported one is the person who chose to.
   */
  fastify.post('/repositories/import', {
    preHandler: fastify.requirePermission('extensions.publish', { hide: true }),
    config: WRITE_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 2000 },
          // A dry run reports what would happen and writes nothing, so an
          // operator can look at a stranger's index before adopting it.
          dryRun: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { url, dryRun } = request.body as { url: string, dryRun?: boolean }

    const developer = await queryOne('SELECT 1 FROM extension_developers WHERE user_id = $1', [request.user.sub])
    if (!developer) {
      return reply.code(409).send({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: 'Enrol as a developer first — POST /v1/dev/register'
      })
    }

    let index: unknown
    try {
      const bytes = await fetchExternal(url, MAX_INDEX_BYTES)
      index = JSON.parse(bytes.toString('utf8'))
    } catch (err) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: `Could not read the index: ${(err as Error).message}`
      })
    }

    const { entries, problems } = parseIndex(index)
    const imported: Array<{ slug: string, name: string, version: string, hosts: string[], action: string }> = []

    for (const entry of entries) {
      const slug = slugify(entry.id)
      try {
        const bytes = await fetchExternal(entry.code, MAX_PACKAGE_BYTES)
        if (!looksLikeSource(bytes)) throw new Error('the package is not UTF-8 source code')

        const source = bytes.toString('utf8')
        const manifest = manifestFor(entry, source, url)
        const check = validateManifest(manifest)
        if (!check.valid) throw new Error(check.errors.join('; '))

        const hosts = check.permissions.find(p => p.permission === 'net:fetch')?.hosts ?? []
        if (dryRun) {
          imported.push({ slug, name: entry.name, version: entry.version, hosts, action: 'would import' })
          continue
        }

        // The server hashes what it fetched. A publisher — or an index —
        // never asserts what their own bytes hash to.
        const stored = await put(bytes)

        const action = await transaction(async client => {
          const { rows: extRows } = await client.query<{ id: string, inserted: boolean }>(
            `INSERT INTO extensions (slug, owner_id, name, summary, description, type, icon_key, accuracy, media_kind, languages, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published')
             ON CONFLICT (slug) DO UPDATE
                SET name = EXCLUDED.name, summary = EXCLUDED.summary,
                    description = EXCLUDED.description, updated_at = now()
             RETURNING id, (xmax = 0) AS inserted`,
            [slug, request.user.sub, manifest.name, manifest.summary, manifest.description, entry.type,
              entry.icon ?? null, manifest.accuracy, manifest.media, entry.languages ?? []]
          )
          const extension = extRows[0]!

          const { rows: versionRows } = await client.query<{ id: string }>(
            `INSERT INTO extension_versions
               (extension_id, version, package_key, package_hash, package_size, manifest, review_status, review_notes, published_at)
             VALUES ($1, $2, $3, $3, $4, $5::jsonb, 'approved', $6, now())
             ON CONFLICT (extension_id, version) DO UPDATE
                SET package_key = EXCLUDED.package_key, package_hash = EXCLUDED.package_hash,
                    package_size = EXCLUDED.package_size, manifest = EXCLUDED.manifest,
                    review_notes = EXCLUDED.review_notes, published_at = now()
             RETURNING id`,
            [extension.id, entry.version, stored.hash, stored.size, JSON.stringify(manifest),
              `imported from ${url} by ${request.user.username}`]
          )
          const versionId = versionRows[0]!.id

          await client.query('DELETE FROM extension_permissions WHERE version_id = $1', [versionId])
          for (const permission of check.permissions) {
            await client.query(
              'INSERT INTO extension_permissions (version_id, permission, hosts) VALUES ($1, $2, $3)',
              [versionId, permission.permission, permission.hosts]
            )
          }
          return extension.inserted ? 'imported' : 'updated'
        })

        await audit(request.user.sub, 'extension.imported', 'extension', slug,
          {}, { repository: url, version: entry.version, hosts })
        imported.push({ slug, name: entry.name, version: entry.version, hosts, action })
      } catch (err) {
        problems.push({ entry: entry.name, reason: (err as Error).message })
      }
    }

    return { repository: url, dryRun: dryRun === true, imported, problems }
  })

  fastify.get('/extensions/:slug/analytics', { preHandler: fastify.requirePermission('extensions.publish', { hide: true }) }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const ext = await ownedExtension(request.user.sub, slug)
    if (!ext) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const [totals, events, versions] = await Promise.all([
      queryOne(
        `SELECT install_count, rating_avg, rating_count FROM extensions WHERE id = $1`,
        [ext.id]
      ),
      query(
        `SELECT event, count(*) AS count FROM extension_events
         WHERE extension_id = $1 AND created_at > now() - interval '30 days'
         GROUP BY event`,
        [ext.id]
      ),
      query(
        `SELECT version, review_status, published_at, review_notes,
                (SELECT count(*) FROM extension_installs i WHERE i.version_id = v.id) AS installs
         FROM extension_versions v WHERE extension_id = $1 ORDER BY created_at DESC`,
        [ext.id]
      )
    ])
    return { totals, events, versions }
  })
}

export default routes
