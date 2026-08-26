// /v1/me — per-profile library, progress, continue-watching.
// All routes require auth + X-Profile-Id header (must belong to the user).

import { query, queryOne } from '../db.ts'
import { enqueue } from '../lib/queue.ts'
import { WRITE_LIMIT } from '../plugins/security.ts'
import { recomputeProfileStats } from '../workers/stats.ts'
import { evaluate, grantNew, measure } from '../lib/achievements.ts'

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
              m.anilist_id, img.object_key AS cover_key
       FROM library_entries le
       JOIN anime a ON a.id = le.anime_id
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
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
              a.canonical_title,
              -- The client keys everything on AniList ids, so without this it
              -- cannot match a row back to the title it is holding. That is
              -- why the resume positions this endpoint returns were written
              -- to the server and never read back into a second device.
              m.anilist_id
       FROM watch_progress wp
       JOIN episodes e ON e.id = wp.episode_id
       JOIN anime a ON a.id = wp.anime_id
       LEFT JOIN anime_mappings m ON m.anime_id = a.id
       WHERE wp.profile_id = $1 AND NOT wp.completed
       ORDER BY wp.updated_at DESC
       LIMIT 20`,
      [profileId]
    )
    return { data }
  })

  /*
   * Favourites.
   *
   * The table has existed since the profile migration with no code behind it,
   * so a viewer's favourites lived in one browser and nowhere else — the one
   * piece of the library that did not follow them to a second device.
   *
   * Keyed by the profile, like the rest of the library, and typed: the schema
   * already anticipates favouriting a character or a studio, so the column
   * stays rather than being collapsed to anime-only.
   *
   * Spelled the American way here, matching the `favorites` table and the
   * path docs/api.md has specified all along. The client says "favourites"
   * because that is what the interface says to the reader — the split is
   * deliberate, and this note is here so it does not read as a typo.
   */
  fastify.get('/favorites', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const data = await query(
      `SELECT f.subject_type, f.subject_id, f.created_at, m.anilist_id
         FROM favorites f
         LEFT JOIN anime_mappings m ON f.subject_type = 'anime' AND m.anime_id = f.subject_id
        WHERE f.profile_id = $1
        ORDER BY f.created_at DESC
        LIMIT 500`,
      [profileId]
    )
    return { data }
  })

  fastify.put('/favorites/:animeId', {
    config: WRITE_LIMIT,
    schema: { params: { type: 'object', properties: { animeId: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return
    const { animeId } = request.params as { animeId: string }

    // A favourite pointing at nothing is a broken row on somebody's profile
    // screen, so the subject is checked rather than trusted.
    const exists = await queryOne('SELECT 1 FROM anime WHERE id = $1', [animeId])
    if (!exists) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await query(
      `INSERT INTO favorites (profile_id, subject_type, subject_id) VALUES ($1, 'anime', $2)
       ON CONFLICT DO NOTHING`,
      [profileId, animeId]
    )
    return reply.code(204).send()
  })

  fastify.delete('/favorites/:animeId', {
    schema: { params: { type: 'object', properties: { animeId: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return
    const { animeId } = request.params as { animeId: string }
    await query(
      `DELETE FROM favorites WHERE profile_id = $1 AND subject_type = 'anime' AND subject_id = $2`,
      [profileId, animeId]
    )
    return reply.code(204).send()
  })

  /**
   * The profile's own numbers.
   *
   * The stats worker has been computing these into `profile_stats` from
   * `watch_history` — which only started filling once the client began
   * reporting measured completions — and nothing could read the result. The
   * client computed its own from browser storage instead, which is why the
   * same account showed different totals on two machines.
   *
   * Recomputed on demand when the row is missing or stale: the worker's own
   * schedule is fine for aggregate reporting, but a viewer opening their
   * profile expects the episode they finished a minute ago to be in there.
   */
  fastify.get('/stats', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const stale = await queryOne<{ fresh: boolean }>(
      `SELECT (updated_at > now() - interval '2 minutes') AS fresh FROM profile_stats WHERE profile_id = $1`,
      [profileId]
    )
    if (!stale?.fresh) await recomputeProfileStats(profileId)

    const row = await queryOne(
      `SELECT xp_total, level, minutes_watched, episodes_watched, anime_completed,
              mean_score, genre_breakdown, updated_at
         FROM profile_stats WHERE profile_id = $1`,
      [profileId]
    )
    // A profile that has watched nothing has no row until the first recompute;
    // returning zeroes beats returning a 404 for "you are new here".
    return row ?? {
      xp_total: 0, level: 1, minutes_watched: 0, episodes_watched: 0,
      anime_completed: 0, mean_score: null, genre_breakdown: {}, updated_at: null
    }
  })

  /**
   * The achievement catalogue with this profile's progress against it.
   *
   * The catalogue is served rather than assumed, so the client renders one
   * list instead of holding its own copy of the definitions — and a new
   * achievement appears without shipping a client.
   *
   * Progress is measured live, and anything newly earned is granted here as
   * well as by the stats worker.
   *
   * Granting from a read looks wrong until you notice the alternative: the
   * screen would show an achievement as unlocked — because the numbers earn
   * it — while no grant row and no XP existed until a worker happened to run.
   * With the worker stopped that state is permanent, and it is invisible.
   *
   * It is safe because the grant is decided entirely by the server's own
   * measurements: opening the screen cannot make a claim, only cause one to be
   * checked. The insert is idempotent and the XP is keyed on the achievement,
   * so checking twice grants once.
   */
  fastify.get('/achievements', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    // Before measuring, so a freshly earned one comes back already granted
    // rather than as "unlocked, ask again later".
    try {
      await grantNew(profileId)
    } catch (err) {
      request.log.warn({ err }, 'could not grant achievements')
    }

    const [context, rows] = await Promise.all([
      measure(profileId),
      query<{ slug: string, unlocked_at: string }>(
        `SELECT a.slug, pa.unlocked_at
           FROM profile_achievements pa
           JOIN achievements a ON a.id = pa.achievement_id
          WHERE pa.profile_id = $1`,
        [profileId]
      )
    ])

    return {
      data: evaluate(context, new Map(rows.map(r => [r.slug, r.unlocked_at]))),
      context
    }
  })

  /*
   * The account's notification inbox.
   *
   * These rows have existed, and been written by the notify worker, since the
   * jobs migration — a monitoring alert fans one out to every operator, for
   * instance. Nothing could read them: the only accessor was a GraphQL field,
   * and the web client speaks REST exclusively. So the inbox filled up and
   * stayed invisible, which is the same as not having one.
   *
   * Scoped to the user rather than the profile: an alert is addressed to the
   * person, not to whichever profile they happen to be watching under.
   */
  fastify.get('/notifications', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean', default: false },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async request => {
    const { unreadOnly, limit } = request.query as { unreadOnly?: boolean, limit?: number }
    const data = await query(
      `SELECT id, type, payload, read_at, created_at
         FROM notifications
        WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT $2`,
      [request.user.sub, limit ?? 50]
    )
    return { data }
  })

  /**
   * Mark notifications read.
   *
   * An explicit id list, or everything when none is given — the inbox has a
   * "mark all read" button and sending fifty ids to express that would be
   * silly. The WHERE clause is scoped to the caller either way, so an id
   * belonging to somebody else matches nothing rather than erroring.
   */
  fastify.post('/notifications/read', {
    config: WRITE_LIMIT,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', maxItems: 200, items: { type: 'string', format: 'uuid' } }
        }
      }
    }
  }, async request => {
    const { ids } = (request.body ?? {}) as { ids?: string[] }
    const rows = ids?.length
      ? await query<{ id: string }>(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL RETURNING id',
        [request.user.sub, ids]
      )
      : await query<{ id: string }>(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id',
        [request.user.sub]
      )
    return { marked: rows.length }
  })

  fastify.patch('/progress/:episodeId', {
    schema: {
      params: { type: 'object', properties: { episodeId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['positionSec'],
        properties: {
          positionSec: { type: 'number', minimum: 0 },
          durationSec: { type: 'number', minimum: 0 },
          // The client's own verdict, from time actually spent playing.
          completed: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const { episodeId } = request.params as { episodeId: string }
    const body = request.body as { positionSec: number, durationSec?: number, completed?: boolean }
    const { positionSec, durationSec } = body

    const episode = await queryOne<{ anime_id: string }>('SELECT anime_id FROM episodes WHERE id = $1', [episodeId])
    if (!episode) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    /*
     * Who decides an episode was watched.
     *
     * There were two answers to that and they never met. The client measures
     * the seconds the video actually played (web/js/watch-time.js) because
     * position alone credits dragging the scrubber to the end. The server
     * computed its own verdict from `positionSec / durationSec`, and the
     * client has never sent `durationSec` — so the server's rule could not
     * fire, and `watch_history`, `xp_events`, `watch_stats_daily` and
     * `profile_stats` stayed empty on every deployment.
     *
     * The measurement is the answer, and only the client can take it. It is
     * accepted here, with a floor: a completion claim that arrives at a
     * position under a minute and under half the runtime is not a measurement,
     * it is a malformed or forged call. That floor is not a security boundary
     * — a client that lies about position can lie about anything, and XP is
     * cosmetic — it just stops an obviously wrong call from writing history.
     *
     * The positional rule stays as the fallback for a caller that sends a
     * duration and no verdict.
     */
    const positional = durationSec != null && durationSec > 0 && positionSec / durationSec >= 0.85
    const plausible = positionSec >= 60 || (durationSec != null && durationSec > 0 && positionSec / durationSec >= 0.5)
    const completed = body.completed === true ? plausible : positional

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
