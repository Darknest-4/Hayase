// /v1/admin/catalogue — catalogue management for staff.
// Anime create/edit/delete + visibility control, and per-anime episode
// add/edit/delete. Every mutation is permission-gated (anime.* / episode.*)
// and, unlike the public /v1/anime routes, these see hidden entries so
// operators can find and restore them.

import { query, queryOne, pool, transaction } from '../db.ts'
import { audit } from '../lib/audit.ts'
import { enqueue } from '../lib/queue.ts'
import { activeRun, coverage, requestCancel, startRun, RunInProgress } from '../workers/metadata.ts'
import { findDuplicates, lockFields, mergeAnime, unlockFields, MANAGED_FIELDS } from '../lib/metadata.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']
const STATUSES = ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS']
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL']
const VISIBILITIES = ['public', 'unlisted', 'hidden']

// editable anime columns → their JSON-schema fragment (used for PATCH/POST)
const ANIME_FIELDS = {
  canonical_title: { type: 'string', minLength: 1, maxLength: 500 },
  format: { enum: FORMATS },
  status: { enum: STATUSES },
  season: { type: ['string', 'null'], enum: [...SEASONS, null] },
  season_year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 },
  episode_count: { type: ['integer', 'null'], minimum: 0 },
  episode_duration: { type: ['integer', 'null'], minimum: 0 },
  synopsis: { type: ['string', 'null'], maxLength: 8000 },
  source_material: { type: ['string', 'null'], maxLength: 40 },
  is_adult: { type: 'boolean' },
  visibility: { enum: VISIBILITIES }
} as const

const EPISODE_FIELDS = {
  number: { type: 'number', minimum: 0 },
  absolute_number: { type: ['integer', 'null'] },
  title: { type: ['string', 'null'], maxLength: 500 },
  synopsis: { type: ['string', 'null'], maxLength: 4000 },
  air_date: { type: ['string', 'null'], format: 'date-time' },
  duration: { type: ['integer', 'null'], minimum: 0 },
  is_filler: { type: 'boolean' },
  is_recap: { type: 'boolean' },
  // Editorial surface state. Defaults to hidden at the database level: on a
  // Hungarian site the subtitle arrives days after the episode does, so an
  // imported episode must not be offered before somebody publishes it.
  visibility: { enum: VISIBILITIES }
} as const

// build a partial UPDATE from a whitelist; returns null when nothing to set
function buildUpdate (body: Record<string, unknown>, allowed: string[]): { sql: string, values: unknown[] } | null {
  const sets: string[] = []
  const values: unknown[] = []
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      values.push(body[key])
      sets.push(`${key} = $${values.length}`)
    }
  }
  if (!sets.length) return null
  return { sql: sets.join(', '), values }
}

const routes: FastifyPluginAsync = async fastify => {
  // reading the catalogue (incl. hidden rows) requires at least anime.view
  fastify.addHook('preHandler', fastify.requirePermission('anime.view', { hide: true }))

  // ---- list / search (all visibilities) ----
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: 200 },
          visibility: { enum: VISIBILITIES },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async request => {
    const { q, visibility, limit = 30, offset = 0 } = request.query as
      { q?: string, visibility?: string, limit?: number, offset?: number }
    const where: string[] = []
    const params: unknown[] = []
    if (q) { params.push(q); where.push(`(a.canonical_title % $${params.length} OR a.canonical_title ILIKE '%' || $${params.length} || '%')`) }
    if (visibility) { params.push(visibility); where.push(`a.visibility = $${params.length}`) }
    params.push(limit, offset)

    const rows = await query(
      `SELECT a.id, a.canonical_title, a.format, a.status, a.season, a.season_year,
              a.episode_count, a.is_adult, a.visibility, a.updated_at,
              (SELECT count(*) FROM episodes e WHERE e.anime_id = a.id) AS episode_rows,
              img.object_key AS cover_key
       FROM anime a
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
    const totalRow = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM anime a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
      params.slice(0, params.length - 2)
    )
    return { data: rows, total: Number(totalRow?.n ?? 0) }
  })

  // ---- single anime for editing (sees hidden) ----
  fastify.get('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const anime = await queryOne(
      `SELECT id, canonical_title, format, status, season, season_year, start_date, end_date,
              episode_count, episode_duration, age_rating, is_adult, synopsis, country,
              source_material, visibility, popularity, average_score,
              locked_fields, metadata_sources, created_at, updated_at
       FROM anime WHERE id = $1`,
      [id]
    )
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return anime
  })

  // ---- create ----
  fastify.post('/', {
    preHandler: fastify.requirePermission('anime.create', { hide: true }),
    schema: {
      body: {
        type: 'object',
        required: ['canonical_title'],
        additionalProperties: false,
        properties: ANIME_FIELDS
      }
    }
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const created = await queryOne<{ id: string, canonical_title: string }>(
      `INSERT INTO anime (canonical_title, format, status, season, season_year, episode_count,
                          episode_duration, synopsis, source_material, is_adult, visibility)
       VALUES ($1, coalesce($2,'TV')::anime_format, coalesce($3,'FINISHED')::anime_status,
               $4::anime_season, $5, $6, $7, $8, $9, coalesce($10,false), coalesce($11,'public'))
       RETURNING id, canonical_title`,
      [body.canonical_title, body.format ?? null, body.status ?? null, body.season ?? null,
        body.season_year ?? null, body.episode_count ?? null, body.episode_duration ?? null,
        body.synopsis ?? null, body.source_material ?? null, body.is_adult ?? null, body.visibility ?? null]
    )
    await audit(request.user.sub, 'anime.create', 'anime', created?.id ?? null, null, { title: created?.canonical_title })
    void emitEvent('catalogue.changed', { action: 'created', title: created?.canonical_title, by: request.user.username })
    return reply.code(201).send(created)
  })

  // ---- edit metadata / visibility ----
  fastify.patch('/:id', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: ANIME_FIELDS }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    const upd = buildUpdate(body, Object.keys(ANIME_FIELDS))
    if (!upd) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'No editable fields provided' })

    upd.values.push(id)
    const row = await queryOne<{ id: string, canonical_title: string, visibility: string }>(
      `UPDATE anime SET ${upd.sql} WHERE id = $${upd.values.length}
       RETURNING id, canonical_title, visibility`,
      upd.values
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // A human just set these values: lock them so the AniList importer and any
    // other automatic source stop overwriting them on the next run.
    await lockFields(pool, id, Object.keys(body))

    await audit(request.user.sub, 'anime.edit', 'anime', id, null, { fields: Object.keys(body) })

    const action = Object.prototype.hasOwnProperty.call(body, 'visibility') ? `visibility → ${row.visibility}` : 'edited'
    void emitEvent('catalogue.changed', { action, title: row.canonical_title, by: request.user.username })
    return row
  })

  // ---- delete ----
  fastify.delete('/:id', {
    preHandler: fastify.requirePermission('anime.delete', { hide: true }),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const row = await queryOne<{ canonical_title: string }>('DELETE FROM anime WHERE id = $1 RETURNING canonical_title', [id])
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    await audit(request.user.sub, 'anime.delete', 'anime', id, { title: row.canonical_title }, null)
    void emitEvent('catalogue.changed', { action: 'deleted', title: row.canonical_title, by: request.user.username })
    return reply.code(204).send()
  })

  // ---- episodes ----
  fastify.get('/:id/episodes', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const exists = await queryOne('SELECT 1 FROM anime WHERE id = $1', [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    // Deliberately unfiltered: the admin list exists to show staff what is
    // NOT published, so filtering it would hide exactly what they came for.
    const data = await query(
      `SELECT id, number, absolute_number, title, synopsis, thumbnail_key,
              air_date, duration, is_filler, is_recap, visibility
       FROM episodes WHERE anime_id = $1 ORDER BY number`,
      [id]
    )
    return { data }
  })

  fastify.post('/:id/episodes', {
    preHandler: fastify.requirePermission('episode.create', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['number'], additionalProperties: false, properties: EPISODE_FIELDS }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    const anime = await queryOne<{ canonical_title: string }>('SELECT canonical_title FROM anime WHERE id = $1', [id])
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    const dup = await queryOne('SELECT 1 FROM episodes WHERE anime_id = $1 AND number = $2', [id, body.number])
    if (dup) return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: `Episode ${body.number} already exists` })

    const ep = await queryOne(
      `INSERT INTO episodes (anime_id, number, absolute_number, title, synopsis, air_date, duration, is_filler, is_recap)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8,false), coalesce($9,false))
       RETURNING id, number, title, air_date, duration, is_filler, is_recap, visibility`,
      [id, body.number, body.absolute_number ?? null, body.title ?? null, body.synopsis ?? null,
        body.air_date ?? null, body.duration ?? null, body.is_filler ?? null, body.is_recap ?? null]
    )
    void emitEvent('catalogue.changed', { action: `+ episode ${body.number}`, title: anime.canonical_title, by: request.user.username })
    return reply.code(201).send(ep)
  })

  fastify.patch('/episodes/:eid', {
    preHandler: fastify.requirePermission('episode.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { eid: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: EPISODE_FIELDS }
    }
  }, async (request, reply) => {
    const { eid } = request.params as { eid: string }
    const body = request.body as Record<string, unknown>
    const upd = buildUpdate(body, Object.keys(EPISODE_FIELDS))
    if (!upd) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'No editable fields provided' })
    upd.values.push(eid)
    const ep = await queryOne(
      `UPDATE episodes SET ${upd.sql} WHERE id = $${upd.values.length}
       RETURNING id, anime_id, number, title, air_date, duration, is_filler, is_recap, visibility`,
      upd.values
    )
    if (!ep) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // Publishing is an editorial act, and "who put this live" is exactly the
    // question asked afterwards. Only a visibility change is recorded — an
    // edited synopsis is not the same kind of event.
    if (typeof body.visibility === 'string') {
      await audit(request.user.sub, 'episode.visibility', 'episode', String((ep as Record<string, unknown>).id),
        null, { visibility: body.visibility, number: (ep as Record<string, unknown>).number })
    }
    return ep
  })

  /**
   * Publish or unpublish a whole season at once.
   *
   * The realistic workflow is per-anime, not per-episode: a batch of subtitles
   * lands and twelve episodes go live together. Doing that one PATCH at a time
   * is twelve chances to miss one, and a half-published season is the failure
   * this whole feature exists to prevent.
   *
   * `from` and `to` bound it, so "publish 1-6 now, the rest when they are
   * ready" is one call rather than a decision per episode.
   */
  fastify.post('/:id/episodes/visibility', {
    preHandler: fastify.requirePermission('episode.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['visibility'],
        additionalProperties: false,
        properties: {
          visibility: { enum: VISIBILITIES },
          from: { type: 'integer', minimum: 0 },
          to: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { visibility, from, to } = request.body as { visibility: string, from?: number, to?: number }

    const anime = await queryOne<{ canonical_title: string }>('SELECT canonical_title FROM anime WHERE id = $1', [id])
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const params: unknown[] = [id, visibility]
    const bounds: string[] = []
    if (from !== undefined) { params.push(from); bounds.push(`number >= $${params.length}`) }
    if (to !== undefined) { params.push(to); bounds.push(`number <= $${params.length}`) }

    const changed = await query<{ number: number }>(
      `UPDATE episodes SET visibility = $2, updated_at = now()
        WHERE anime_id = $1 ${bounds.length ? 'AND ' + bounds.join(' AND ') : ''}
          AND visibility IS DISTINCT FROM $2
        RETURNING number`,
      params
    )

    await audit(request.user.sub, 'episode.visibility', 'anime', id, null, {
      visibility, from: from ?? null, to: to ?? null, count: changed.length
    })
    if (changed.length) {
      void emitEvent('catalogue.changed', {
        action: `${visibility} × ${changed.length} episode(s)`,
        title: anime.canonical_title,
        by: request.user.username
      })
    }
    return { visibility, changed: changed.length, episodes: changed.map(row => row.number) }
  })

  fastify.delete('/episodes/:eid', {
    preHandler: fastify.requirePermission('episode.delete', { hide: true }),
    schema: { params: { type: 'object', properties: { eid: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { eid } = request.params as { eid: string }
    const ep = await queryOne('DELETE FROM episodes WHERE id = $1 RETURNING number', [eid])
    if (!ep) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return reply.code(204).send()
  })

  // ---- metadata provenance: release a field back to the importers ----
  fastify.post('/:id/unlock', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['fields'],
        additionalProperties: false,
        properties: {
          fields: { type: 'array', maxItems: 40, items: { enum: [...MANAGED_FIELDS] } }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { fields } = request.body as { fields: string[] }
    const exists = await queryOne('SELECT 1 FROM anime WHERE id = $1', [id])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    await unlockFields(pool, id, fields)
    await audit(request.user.sub, 'anime.unlock', 'anime', id, null, { fields })
    const row = await queryOne('SELECT locked_fields FROM anime WHERE id = $1', [id])
    return row
  })

  // ---- duplicate detection ----
  // Read-only: it proposes pairs, a human confirms each merge.
  fastify.get('/duplicates', {
    preHandler: fastify.requirePermission('anime.merge', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        properties: {
          threshold: { type: 'number', minimum: 0.5, maximum: 0.99, default: 0.86 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        }
      }
    }
  }, async request => {
    const { threshold, limit } = request.query as { threshold?: number, limit?: number }
    return { data: await findDuplicates(pool, { threshold, limit }) }
  })

  // ---- merge two entries ----
  // Destructive and irreversible, so it is never automatic: the duplicate
  // scan only suggests, an operator with anime.merge confirms.
  fastify.post('/:id/merge', {
    preHandler: fastify.requirePermission('anime.merge', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['sourceId'],
        additionalProperties: false,
        properties: { sourceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { sourceId } = request.body as { sourceId: string }
    if (id === sourceId) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Cannot merge an entry into itself' })
    }
    const both = await query<{ id: string, canonical_title: string }>(
      'SELECT id, canonical_title FROM anime WHERE id = ANY($1::uuid[])', [[id, sourceId]])
    if (both.length !== 2) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await transaction(client => mergeAnime(client, id, sourceId))
    const target = both.find(r => r.id === id)
    const source = both.find(r => r.id === sourceId)
    // A merge deletes a row permanently, so it is the single most important
    // catalogue action to be able to reconstruct afterwards.
    await audit(request.user.sub, 'anime.merge', 'anime', id,
      { merged: source?.canonical_title, mergedId: sourceId }, { kept: target?.canonical_title })
    void emitEvent('catalogue.changed', {
      action: `merged "${source?.canonical_title}" into`, title: target?.canonical_title, by: request.user.username
    })
    return { id, merged: sourceId }
  })

  // ---- metadata synchronisation ----
  //
  // The AniList passes used to be reachable only over SSH, which meant the
  // catalogue's freshness was known to whoever last ran the script and to
  // nobody else. These four routes are the panel behind that.

  /** Coverage, the run in flight, and the recent history — one screen's data. */
  fastify.get('/metadata', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true })
  }, async () => {
    const [stats, active, runs] = await Promise.all([
      coverage(),
      activeRun(),
      query(`SELECT r.id, r.kind, r.scope, r.max_items, r.status, r.processed, r.total,
                    r.updated_rows, r.counts, r.error, r.created_at, r.started_at, r.finished_at,
                    u.username AS started_by
               FROM metadata_runs r
               LEFT JOIN users u ON u.id = r.started_by
              ORDER BY r.created_at DESC
              LIMIT 15`)
    ])
    return { coverage: stats, active: active ?? null, runs }
  })

  fastify.post('/metadata/runs', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true }),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { enum: ['basic', 'deep'] },
          scope: { enum: ['missing', 'all'] },
          // A first run on a new deployment wants a small number to check the
          // shape of what comes back before committing to half an hour.
          limit: { type: 'integer', minimum: 1, maximum: 100000 }
        }
      }
    }
  }, async (request, reply) => {
    const body = request.body as { kind?: string, scope?: string, limit?: number }
    const kind = body.kind ?? 'basic'
    const scope = body.scope ?? 'missing'

    let run
    try {
      run = await startRun({
        kind: kind as 'basic' | 'deep',
        scope: scope as 'missing' | 'all',
        limit: body.limit ?? null,
        startedBy: request.user.sub
      })
    } catch (err) {
      if (err instanceof RunInProgress) {
        return reply.code(409).send({
          type: 'about:blank', title: 'Conflict', status: 409, detail: err.message
        })
      }
      throw err
    }

    await enqueue('metadata', { runId: run.id })
    await audit(request.user.sub, 'metadata.sync', 'metadata_run', run.id,
      null, { kind, scope, limit: body.limit ?? null })
    return reply.code(202).send({ id: run.id, kind, scope, status: 'queued' })
  })

  fastify.post('/metadata/runs/:id/cancel', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true }),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    // Cooperative: the pass notices at its next batch boundary. Saying so is
    // the difference between a button that looks broken and one that is
    // honest about a half-minute of paced requests still in flight.
    if (!await requestCancel(id)) {
      return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return { id, status: 'cancelled' }
  })

  /**
   * External ids an importer could not write because another anime held them.
   *
   * Mostly AniList season splits against one MAL entry rather than corruption
   * — but the pairs are also where real duplicates in the catalogue surface,
   * and nobody goes looking in a table they were never shown.
   */
  fastify.get('/metadata/conflicts', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true })
  }, async () => {
    return query(
      `SELECT c.id, c.provider, c.external_id, c.source, c.seen_count, c.first_seen, c.last_seen,
              c.anime_id, a.canonical_title AS anime_title,
              c.held_by, h.canonical_title AS holder_title
         FROM mapping_conflicts c
         JOIN anime a ON a.id = c.anime_id
         LEFT JOIN anime h ON h.id = c.held_by
        WHERE c.resolved_at IS NULL
        ORDER BY c.seen_count DESC, c.last_seen DESC
        LIMIT 100`
    )
  })

  fastify.post('/metadata/conflicts/:id/resolve', {
    preHandler: fastify.requirePermission('anime.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9]+$' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { resolution: { type: 'string', maxLength: 200 } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { resolution } = (request.body ?? {}) as { resolution?: string }
    const row = await queryOne<{ id: string }>(
      `UPDATE mapping_conflicts SET resolved_at = now(), resolution = $2
        WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
      [id, resolution ?? 'reviewed']
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return { id, resolved: true }
  })
}

export default routes
