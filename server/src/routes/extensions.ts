// /v1/extensions — store browse/detail/install, plus the install sync the
// client needs to load extensions into its sandbox.

import { query, queryOne, transaction } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'
import { WRITE_LIMIT } from '../plugins/security.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Extension health thresholds.
 *
 * The client reports failures (`error`, `load_failure`); it deliberately does
 * NOT report successes, because one event per extension call would dwarf every
 * other table in the database. So health is measured as *failures per active
 * install per week* — a rate that stays comparable as an extension grows.
 *
 *   healthy   🟢  under 1 failure per 10 installs per week
 *   unstable  🟡  under 1 failure per 2 installs per week
 *   broken    🔴  at or above that
 *
 * A brand-new extension with no installs and no failures reports as `unknown`
 * rather than being flattered with a green badge.
 */
export const HEALTH_THRESHOLDS = { unstable: 0.1, broken: 0.5 } as const

export function classifyHealth (failures: number, installs: number): 'healthy' | 'unstable' | 'broken' | 'unknown' {
  if (installs === 0) return failures > 0 ? 'broken' : 'unknown'
  const rate = failures / installs
  if (rate >= HEALTH_THRESHOLDS.broken) return 'broken'
  if (rate >= HEALTH_THRESHOLDS.unstable) return 'unstable'
  return 'healthy'
}

/** Failure counts over the last 7 days, keyed by extension id. */
async function recentFailures (): Promise<Map<string, { errors: number, loadFailures: number }>> {
  const rows = await query<{ extension_id: string, errors: string, load_failures: string }>(
    `SELECT extension_id,
            count(*) FILTER (WHERE event = 'error') AS errors,
            count(*) FILTER (WHERE event = 'load_failure') AS load_failures
     FROM extension_events
     WHERE created_at > now() - interval '7 days' AND event IN ('error', 'load_failure')
     GROUP BY extension_id`
  )
  return new Map(rows.map(r => [r.extension_id, { errors: Number(r.errors), loadFailures: Number(r.load_failures) }]))
}

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
      `SELECT e.id, e.slug, e.name, e.summary, e.type, e.icon_key, e.accuracy, e.media_kind,
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

    // health is a cheap join in memory: one grouped query for the whole page
    const failures = await recentFailures()
    return {
      data: data.map(row => {
        const f = failures.get(row.id as string) ?? { errors: 0, loadFailures: 0 }
        const total = f.errors + f.loadFailures
        return {
          ...row,
          id: undefined, // internal id stays server-side; the slug is the handle
          health: classifyHealth(total, Number(row.install_count ?? 0)),
          failures_7d: total
        }
      })
    }
  })

  /**
   * Everything the client needs to load this account's extensions into the
   * sandbox: the pinned version, its integrity hash and the permissions the
   * host will enforce. Suspended extensions are still listed, with their
   * status, so the client can drop them (the remote kill switch).
   */
  fastify.get('/installed', { preHandler: fastify.authenticate }, async request => {
    const data = await query(
      `SELECT e.id AS extension_id, e.slug, e.name, e.type, e.accuracy, e.status, e.install_count,
              i.enabled, i.auto_update, i.options,
              v.id AS version_id, v.version, v.package_key, v.package_hash, v.min_app_version,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('permission', p.permission, 'hosts', p.hosts)), '[]')
                 FROM extension_permissions p WHERE p.version_id = v.id) AS permissions
       FROM extension_installs i
       JOIN extensions e ON e.id = i.extension_id
       JOIN extension_versions v ON v.id = i.version_id
       WHERE i.user_id = $1
       ORDER BY e.name`,
      [request.user.sub]
    )

    const failures = await recentFailures()
    return {
      data: data.map(row => {
        const f = failures.get(row.extension_id as string) ?? { errors: 0, loadFailures: 0 }
        return { ...row, health: classifyHealth(f.errors + f.loadFailures, Number(row.install_count ?? 0)) }
      })
    }
  })

  fastify.get('/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const extension = await queryOne(
      `SELECT e.slug, e.name, e.summary, e.description, e.type, e.icon_key, e.accuracy,
              e.media_kind, e.languages, e.status, e.install_count, e.rating_avg, e.rating_count,
              d.display_name AS developer, d.verified AS developer_verified, d.website,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', v.id, 'version', v.version, 'changelog', v.changelog, 'publishedAt', v.published_at,
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

    const failures = await queryOne<{ errors: string, load_failures: string }>(
      `SELECT count(*) FILTER (WHERE event = 'error') AS errors,
              count(*) FILTER (WHERE event = 'load_failure') AS load_failures
       FROM extension_events e
       JOIN extensions x ON x.id = e.extension_id
       WHERE x.slug = $1 AND e.created_at > now() - interval '7 days'`,
      [slug]
    )
    const total = Number(failures?.errors ?? 0) + Number(failures?.load_failures ?? 0)
    return {
      ...extension,
      health: classifyHealth(total, Number(extension.install_count ?? 0)),
      failures_7d: total
    }
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

  /**
   * Anonymous failure telemetry from the sandbox. Rate-limited and strictly
   * shaped: an event name from the fixed vocabulary plus a short, non-PII
   * detail. Nothing here identifies the reporting user.
   */
  fastify.post('/:slug/events', {
    preHandler: fastify.authenticate,
    config: WRITE_LIMIT,
    schema: {
      params: { type: 'object', properties: { slug: { type: 'string', maxLength: 64 } } },
      body: {
        type: 'object',
        required: ['event'],
        additionalProperties: false,
        properties: {
          // only failure reporting is accepted here; install/uninstall/update
          // are recorded server-side where they actually happen
          event: { enum: ['error', 'load_failure'] },
          message: { type: 'string', maxLength: 200 },
          versionId: { type: 'string', format: 'uuid' },
          appVersion: { type: 'string', maxLength: 20 }
        }
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const body = request.body as { event: string, message?: string, versionId?: string, appVersion?: string }

    const ext = await queryOne<{ id: string }>('SELECT id FROM extensions WHERE slug = $1', [slug])
    if (!ext) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await query(
      `INSERT INTO extension_events (extension_id, version_id, event, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [ext.id, body.versionId ?? null, body.event,
        JSON.stringify({ message: body.message?.slice(0, 200) ?? null, appVersion: body.appVersion ?? null })]
    )
    return reply.code(202).send({ recorded: true })
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
