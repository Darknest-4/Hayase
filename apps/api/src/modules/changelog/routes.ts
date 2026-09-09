// /v1/changelog — the development log.
//
// Not part of the community surface, and on its own route for that reason:
// it is the project talking about itself, not people talking to each other.
//
// Read is public. A planned release is as much the point as a shipped one —
// "what is coming" is the half people actually check — so unreleased versions
// are served too, and the status says which is which rather than the list
// pretending everything on it is done.
//
// Writing is behind `changelog.manage`, which the editor role holds.

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'

import type { FastifyPluginAsync } from 'fastify'
import type pg from 'pg'

const STATUSES = ['planned', 'in_progress', 'released'] as const
const KINDS = ['added', 'changed', 'fixed', 'removed', 'security'] as const

/** One release with its lines, in the shape the page renders. */
const SELECT_RELEASES = `
  SELECT r.id, r.version, r.title, r.summary, r.status, r.released_on, r.position,
         COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'body', e.body)
                             ORDER BY e.position, e.kind)
              FROM release_entries e WHERE e.release_id = r.id),
           '[]'::jsonb
         ) AS entries
    FROM releases r`

const routes: FastifyPluginAsync = async fastify => {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { enum: [...STATUSES] },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async request => {
    const { status, limit = 50 } = request.query as { status?: string, limit?: number }
    const params: unknown[] = []
    let where = ''
    if (status) { params.push(status); where = `WHERE r.status = $${params.length}` }
    params.push(limit)

    // Ordered by an explicit position, not by the version string: "0.9.10"
    // sorts before "0.9.9" as text, and unreleased rows have no date to fall
    // back on. Planned first, because that is what the page leads with.
    const data = await query(
      `${SELECT_RELEASES} ${where}
        ORDER BY r.position DESC, r.released_on DESC NULLS FIRST
        LIMIT $${params.length}`,
      params
    )
    return { data }
  })

  fastify.get('/:version', async (request, reply) => {
    const { version } = request.params as { version: string }
    const release = await queryOne(`${SELECT_RELEASES} WHERE r.version = $1`, [version])
    if (!release) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'No such release' })
    return release
  })

  // ---- writing ----

  fastify.post('/', {
    onRequest: fastify.requirePermission('changelog.manage'),
    schema: {
      body: {
        type: 'object',
        required: ['version', 'title'],
        properties: {
          version: { type: 'string', minLength: 1, maxLength: 40 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          summary: { type: 'string', maxLength: 2000 },
          status: { enum: [...STATUSES], default: 'planned' },
          releasedOn: { type: 'string', format: 'date' },
          position: { type: 'integer', minimum: 0, maximum: 100000 },
          entries: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              required: ['kind', 'body'],
              properties: {
                kind: { enum: [...KINDS] },
                body: { type: 'string', minLength: 1, maxLength: 1000 }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const body = request.body as {
      version: string, title: string, summary?: string, status?: string,
      releasedOn?: string, position?: number, entries?: Array<{ kind: string, body: string }>
    }

    const clash = await queryOne('SELECT 1 FROM releases WHERE version = $1', [body.version])
    if (clash) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: `Version ${body.version} already exists` })
    }

    // A release and its lines are one edit. Half a release is worse than none:
    // the page would show a version heading with nothing under it.
    const release = await transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query(
        `INSERT INTO releases (version, title, summary, status, released_on, position)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT COALESCE(max(position), 0) + 10 FROM releases)))
         RETURNING id, version, title, status, released_on, position`,
        [body.version, body.title, body.summary ?? null, body.status ?? 'planned', body.releasedOn ?? null, body.position ?? null]
      )
      const created = rows[0]!
      await writeEntries(client, String(created.id), body.entries ?? [])
      return created
    })
    return reply.code(201).send(release)
  })

  fastify.patch('/:id', {
    onRequest: fastify.requirePermission('changelog.manage'),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          summary: { type: 'string', maxLength: 2000 },
          status: { enum: [...STATUSES] },
          releasedOn: { type: 'string', format: 'date' },
          position: { type: 'integer', minimum: 0, maximum: 100000 },
          entries: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              required: ['kind', 'body'],
              properties: {
                kind: { enum: [...KINDS] },
                body: { type: 'string', minLength: 1, maxLength: 1000 }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>

    const exists = await queryOne('SELECT 1 FROM releases WHERE id = $1', [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const map: Record<string, string> = {
      title: 'title', summary: 'summary', status: 'status', releasedOn: 'released_on', position: 'position'
    }
    await transaction(async (client: pg.PoolClient) => {
      const sets: string[] = []
      const params: unknown[] = [id]
      for (const [key, column] of Object.entries(map)) {
        if (body[key] !== undefined) { params.push(body[key]); sets.push(`${column} = $${params.length}`) }
      }
      if (sets.length) {
        await client.query(`UPDATE releases SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params)
      }
      // `entries` replaces the list rather than appending to it: the editor
      // sends the whole list back, and a partial merge would need ids the
      // editor does not track.
      if (Array.isArray(body.entries)) {
        await client.query('DELETE FROM release_entries WHERE release_id = $1', [id])
        await writeEntries(client, id, body.entries as Array<{ kind: string, body: string }>)
      }
    })

    return queryOne(`${SELECT_RELEASES} WHERE r.id = $1`, [id])
  })

  fastify.delete('/:id', {
    onRequest: fastify.requirePermission('changelog.manage')
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const gone = await queryOne('DELETE FROM releases WHERE id = $1 RETURNING version', [id])
    if (!gone) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return reply.code(204).send()
  })
}

/** Insert a release's lines, keeping the order they arrived in. */
async function writeEntries (
  client: pg.PoolClient,
  releaseId: string,
  entries: Array<{ kind: string, body: string }>
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    await client.query(
      'INSERT INTO release_entries (release_id, kind, body, position) VALUES ($1, $2, $3, $4)',
      [releaseId, entry.kind, entry.body, index]
    )
  }
}

export default routes
