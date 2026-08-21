// /v1/dev — developer portal API: become a developer, create/manage
// extension listings, upload versions (into the review pipeline), and read
// per-extension analytics. Publishing needs the extensions.publish
// permission (granted with the 'developer' role).

import { createHash } from 'node:crypto'

import { query, queryOne, transaction } from '../db.ts'
import { escalatedPermissions, validateManifest } from '../lib/extension-manifest.ts'
import { enqueue } from '../lib/queue.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const TYPES = ['torrent', 'nzb', 'http', 'subtitle', 'metadata', 'theme'] as const
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

  fastify.get('/extensions', { preHandler: fastify.requirePermission('extensions.publish') }, async request => {
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
    preHandler: fastify.requirePermission('extensions.publish'),
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

    const taken = await queryOne('SELECT 1 FROM extensions WHERE slug = $1', [slug])
    if (taken) return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Slug already taken' })

    const ext = await queryOne(
      `INSERT INTO extensions (slug, owner_id, name, summary, description, type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       RETURNING id, slug, name, summary, type, status, created_at`,
      [slug, request.user.sub, name, summary, description ?? null, type]
    )
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

  // Upload a version. The package (code + manifest) is submitted inline as a
  // base64 tarball reference; here we record it, snapshot the manifest and
  // declared permissions, and queue static review. Object-storage upload of
  // the bytes happens client-side to a presigned URL in production; in this
  // build the packageKey/hash are provided by the caller.
  fastify.post('/extensions/:slug/versions', {
    preHandler: fastify.requirePermission('extensions.publish'),
    schema: {
      params: { type: 'object', properties: { slug: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['version', 'packageKey', 'packageHash', 'packageSize', 'manifest'],
        properties: {
          version: { type: 'string' },
          packageKey: { type: 'string', maxLength: 300 },
          packageHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          packageSize: { type: 'integer', minimum: 1, maximum: 5_000_000 },
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
      version: string, packageKey: string, packageHash: string, packageSize: number,
      changelog?: string, minAppVersion?: string, manifest: Record<string, unknown>
    }

    if (!SEMVER.test(body.version)) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'version must be semver (x.y.z)' })
    }

    const ext = await ownedExtension(request.user.sub, slug)
    if (!ext) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

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
        [ext.id, body.version, body.packageKey, body.packageHash, body.packageSize, body.manifest, body.changelog ?? null, manifest.minAppVersion ?? body.minAppVersion ?? null]
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

  fastify.get('/extensions/:slug/analytics', { preHandler: fastify.requirePermission('extensions.publish') }, async (request, reply) => {
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
