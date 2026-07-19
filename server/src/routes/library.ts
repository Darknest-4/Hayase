// /v1/me — per-profile library, progress, continue-watching.
// All routes require auth + X-Profile-Id header (must belong to the user).

import { query, queryOne } from '../db.ts'
import { enqueue } from '../lib/queue.ts'

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

const LIBRARY_STATUSES = ['WATCHING', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REWATCHING'] as const

async function resolveProfile (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const profileId = request.headers['x-profile-id']
  if (typeof profileId !== 'string') {
    await reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Missing X-Profile-Id header' })
    return
  }
  const owned = await queryOne('SELECT 1 FROM user_profiles WHERE id = $1 AND user_id = $2', [profileId, request.user.sub])
  if (!owned) {
    await reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Profile does not belong to this account' })
    return
  }
  return profileId
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.get('/library', {
    schema: { querystring: { type: 'object', properties: { status: { enum: [...LIBRARY_STATUSES] } } } }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const { status } = request.query as { status?: string }
    const params: unknown[] = [profileId]
    if (status) params.push(status)

    const data = await query(
      `SELECT le.anime_id, le.status, le.progress, le.score, le.rewatches, le.updated_at,
              a.canonical_title, a.format, a.episode_count, a.next_airing_ep,
              img.object_key AS cover_key
       FROM library_entries le
       JOIN anime a ON a.id = le.anime_id
       LEFT JOIN anime_images img ON img.anime_id = a.id AND img.kind = 'cover' AND img.is_primary
       WHERE le.profile_id = $1 ${status ? 'AND le.status = $2' : ''}
       ORDER BY le.updated_at DESC`,
      params
    )
    return { data }
  })

  fastify.put('/library/:animeId', {
    schema: {
      params: { type: 'object', properties: { animeId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          status: { enum: [...LIBRARY_STATUSES] },
          progress: { type: 'integer', minimum: 0 },
          score: { type: 'number', minimum: 0, maximum: 10 },
          notes: { type: 'string', maxLength: 2000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const { animeId } = request.params as { animeId: string }
    const body = request.body as { status?: string, progress?: number, score?: number, notes?: string }

    const anime = await queryOne<{ episode_count: number | null }>('SELECT episode_count FROM anime WHERE id = $1', [animeId])
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // auto-complete when progress reaches the total
    let status = body.status
    if (status === undefined && body.progress !== undefined && anime.episode_count && body.progress >= anime.episode_count) {
      status = 'COMPLETED'
    }

    const entry = await queryOne(
      `INSERT INTO library_entries (profile_id, anime_id, status, progress, score, notes)
       VALUES ($1, $2, coalesce($3, 'PLANNING')::library_status, coalesce($4, 0), $5, $6)
       ON CONFLICT (profile_id, anime_id) DO UPDATE SET
         status = coalesce($3::library_status, library_entries.status),
         progress = coalesce($4, library_entries.progress),
         score = coalesce($5, library_entries.score),
         notes = coalesce($6, library_entries.notes)
       RETURNING *`,
      [profileId, animeId, status ?? null, body.progress ?? null, body.score ?? null, body.notes ?? null]
    )
    return entry
  })

  fastify.delete('/library/:animeId', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return
    const { animeId } = request.params as { animeId: string }
    await query('DELETE FROM library_entries WHERE profile_id = $1 AND anime_id = $2', [profileId, animeId])
    return reply.code(204).send()
  })

  fastify.get('/continue-watching', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const data = await query(
      `SELECT wp.episode_id, wp.anime_id, wp.position_sec, wp.duration_sec, wp.updated_at,
              e.number AS episode, e.title AS episode_title, e.thumbnail_key,
              a.canonical_title
       FROM watch_progress wp
       JOIN episodes e ON e.id = wp.episode_id
       JOIN anime a ON a.id = wp.anime_id
       WHERE wp.profile_id = $1 AND NOT wp.completed
       ORDER BY wp.updated_at DESC
       LIMIT 20`,
      [profileId]
    )
    return { data }
  })

  fastify.patch('/progress/:episodeId', {
    schema: {
      params: { type: 'object', properties: { episodeId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['positionSec'],
        properties: {
          positionSec: { type: 'number', minimum: 0 },
          durationSec: { type: 'number', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const { episodeId } = request.params as { episodeId: string }
    const { positionSec, durationSec } = request.body as { positionSec: number, durationSec?: number }

    const episode = await queryOne<{ anime_id: string }>('SELECT anime_id FROM episodes WHERE id = $1', [episodeId])
    if (!episode) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const completed = durationSec != null && durationSec > 0 && positionSec / durationSec >= 0.85

    // NOTE: direct write; swaps for the Redis write-behind path at scale
    // without changing this contract.
    const row = await queryOne<{ position_sec: string, completed: boolean, was_completed: boolean, updated_at: string }>(
      `INSERT INTO watch_progress (profile_id, episode_id, anime_id, position_sec, duration_sec, completed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (profile_id, episode_id) DO UPDATE SET
         position_sec = $4, duration_sec = coalesce($5, watch_progress.duration_sec),
         completed = watch_progress.completed OR $6, updated_at = now()
       RETURNING position_sec, completed,
                 (SELECT completed FROM watch_progress wp2 WHERE wp2.profile_id = $1 AND wp2.episode_id = $2) AS was_completed,
                 updated_at`,
      [profileId, episodeId, episode.anime_id, positionSec, durationSec ?? null, completed]
    )

    // first completion of this episode → history entry, XP, stats refresh
    if (completed && row?.completed) {
      const fresh = await queryOne<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM watch_history
           WHERE profile_id = $1 AND episode_id = $2 AND finished AND started_at > now() - interval '6 hours'
         ) AS exists`,
        [profileId, episodeId]
      )
      if (!fresh?.exists) {
        await query(
          `INSERT INTO watch_history (profile_id, episode_id, anime_id, watched_sec, finished, started_at, ended_at)
           VALUES ($1, $2, $3, $4, true, now(), now())`,
          [profileId, episodeId, episode.anime_id, Math.round(positionSec)]
        )
        await query(
          `INSERT INTO xp_events (profile_id, amount, reason, ref_id) VALUES ($1, 10, 'episode_watched', $2)`,
          [profileId, episodeId]
        )
        await enqueue('stats', { profileId, dedupe: `profile:${profileId}` })
      }
    }

    return { position_sec: row?.position_sec, completed: row?.completed, updated_at: row?.updated_at }
  })
}

export default routes
