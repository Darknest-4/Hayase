// /v1/extensions — store browse/detail/install; /v1/me/extensions sync.

import { query, queryOne, transaction } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: { enum: ['torrent', 'nzb', 'http', 'subtitle', 'metadata', 'theme'] },
          sort: { enum: ['installs', 'rating', 'new'], default: 'installs' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 }
        }
      }
    }
  }, async request => {
    const { type, sort, limit } = request.query as { type?: string, sort?: string, limit?: number }
    const order = sort === 'rating' ? 'e.rating_avg DESC NULLS LAST' : sort === 'new' ? 'e.created_at DESC' : 'e.install_count DESC'

    const params: unknown[] = []
    if (type) params.push(type)
    params.push(limit ?? 25)

    const data = await query(
      `SELECT e.slug, e.name, e.summary, e.type, e.icon_key, e.accuracy, e.media_kind,
              e.languages, e.install_count, e.rating_avg, e.rating_count,
              d.display_name AS developer, d.verified AS developer_verified,
              v.version AS latest_version
       FROM extensions e
       JOIN extension_developers d ON d.user_id = e.owner_id
       LEFT JOIN LATERAL (
         SELECT version FROM extension_versions
         WHERE extension_id = e.id AND published_at IS NOT NULL
         ORDER BY published_at DESC LIMIT 1
       ) v ON true
       WHERE e.status = 'published' ${type ? 'AND e.type = $1' : ''}
       ORDER BY ${order}
       LIMIT $${params.length}`,
      params
    )
    return { data }
  })

  fastify.get('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const extension = await queryOne(
      `SELECT e.slug, e.name, e.summary, e.description, e.type, e.icon_key, e.accuracy,
              e.media_kind, e.languages, e.status, e.install_count, e.rating_avg, e.rating_count,
              d.display_name AS developer, d.verified AS developer_verified, d.website,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'version', v.version, 'changelog', v.changelog, 'publishedAt', v.published_at,
                 'packageKey', v.package_key, 'packageHash', v.package_hash, 'minAppVersion', v.min_app_version,
                 'permissions', (SELECT coalesce(jsonb_agg(jsonb_build_object('permission', p.permission, 'hosts', p.hosts)), '[]')
                                 FROM extension_permissions p WHERE p.version_id = v.id)
               ) ORDER BY v.published_at DESC), '[]')
               FROM extension_versions v WHERE v.extension_id = e.id AND v.published_at IS NOT NULL) AS versions
       FROM extensions e
       JOIN extension_developers d ON d.user_id = e.owner_id
       WHERE e.slug = $1 AND e.status IN ('published', 'deprecated')`,
      [slug]
    )
    if (!extension) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return extension
  })

  fastify.post('/:slug/install', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { slug } = request.params as { slug: string }

    const latest = await queryOne<{ extension_id: string, version_id: string }>(
      `SELECT e.id AS extension_id, v.id AS version_id
       FROM extensions e
       JOIN extension_versions v ON v.extension_id = e.id AND v.published_at IS NOT NULL
       WHERE e.slug = $1 AND e.status = 'published'
       ORDER BY v.published_at DESC LIMIT 1`,
      [slug]
    )
    if (!latest) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No published version' })

    const install = await transaction(async client => {
      const { rows } = await client.query(
        `INSERT INTO extension_installs (user_id, extension_id, version_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, extension_id) DO UPDATE SET enabled = true, version_id = $3
         RETURNING *`,
        [request.user.sub, latest.extension_id, latest.version_id]
      )
      await client.query('UPDATE extensions SET install_count = install_count + 1 WHERE id = $1', [latest.extension_id])
      await client.query(
        `INSERT INTO extension_events (extension_id, version_id, event) VALUES ($1, $2, 'install')`,
        [latest.extension_id, latest.version_id]
      )
      return rows[0]
    })
    const counts = await queryOne<{ install_count: number }>('SELECT install_count FROM extensions WHERE id = $1', [latest.extension_id])
    await emitEvent('extension.installed', { slug, action: 'install', installCount: counts?.install_count })
    return reply.code(201).send(install)
  })

  fastify.delete('/:slug/install', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const removed = await queryOne<{ extension_id: string }>(
      `DELETE FROM extension_installs ei
       USING extensions e
       WHERE e.id = ei.extension_id AND e.slug = $1 AND ei.user_id = $2
       RETURNING ei.extension_id`,
      [slug, request.user.sub]
    )
    if (removed) {
      await query('UPDATE extensions SET install_count = greatest(install_count - 1, 0) WHERE id = $1', [removed.extension_id])
      await query(`INSERT INTO extension_events (extension_id, event) VALUES ($1, 'uninstall')`, [removed.extension_id])
    }
    return reply.code(204).send()
  })
}

export default routes
