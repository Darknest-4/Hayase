// /v1/admin/translations — writing the Hungarian catalogue text.
//
// The catalogue holds 25,703 English synopses and no Hungarian ones, and that
// gap does not close by importing — somebody writes them. These endpoints are
// the tools for doing that, plus the one query an editor actually opens the
// admin panel to run: "what still needs translating, and which of those will
// the most people see?"
//
// Ordering the queue by popularity is the whole point. Translating 25,703
// entries is not going to happen; translating the 200 that people actually
// open is a week of work and covers most of what anyone reads.

import { query, queryOne } from '../db.ts'
import { audit } from '../lib/audit.ts'
import { UI_LANGUAGES } from '../lib/preferences.ts'

import type { FastifyPluginAsync } from 'fastify'

const LANGUAGES = [...UI_LANGUAGES]

/** Bounds that keep one bad paste from becoming a 2 MB row. */
const MAX_TITLE = 500
const MAX_SYNOPSIS = 8000

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.requirePermission('anime.edit', { hide: true }))

  // ---- the queue ----
  //
  // Most-watched first. `has_title` and `has_synopsis` are returned separately
  // because a title without a description is a normal half-done state and the
  // editor should be able to see which half is missing.
  fastify.get('/queue', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          offset: { type: 'integer', minimum: 0, default: 0 },
          // Untranslated hidden entries are not urgent — nobody can see them.
          publishedOnly: { type: 'boolean', default: true }
        }
      }
    }
  }, async request => {
    const { limit, offset, publishedOnly } = request.query as {
      limit: number, offset: number, publishedOnly: boolean
    }

    const where = publishedOnly ? "WHERE visibility = 'public'" : ''
    const [data, counts] = await Promise.all([
      query(
        `SELECT id, canonical_title, popularity, visibility, anilist_id, has_title, has_synopsis
           FROM anime_missing_translations
           ${where}
          ORDER BY popularity DESC NULLS LAST, canonical_title
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM anime_missing_translations ${where}`)
    ])
    return { data, total: counts?.total ?? 0, limit, offset }
  })

  // ---- how far along are we ----
  fastify.get('/progress', async () => {
    const row = await queryOne<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM anime)                                        AS total,
              (SELECT count(*)::int FROM anime WHERE visibility = 'public')            AS published,
              (SELECT count(*)::int FROM anime_translations
                WHERE language = 'hu' AND approved AND synopsis IS NOT NULL)           AS translated,
              (SELECT count(*)::int FROM anime_translations
                WHERE language = 'hu' AND NOT approved)                                AS drafts`
    )
    return row ?? {}
  })

  // ---- read one ----
  //
  // Returns the source text beside the translation, because translating from
  // memory of what the English said is how a description ends up describing a
  // different show.
  fastify.get('/anime/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const source = await queryOne(
      'SELECT id, canonical_title, synopsis FROM anime WHERE id = $1', [id]
    )
    if (!source) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const translations = await query(
      `SELECT language, title, synopsis, source, approved, updated_at, updated_by
         FROM anime_translations WHERE anime_id = $1`,
      [id]
    )
    return { source, translations }
  })

  // ---- write one ----
  fastify.put('/anime/:id/:language', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          language: { enum: LANGUAGES }
        }
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: MAX_TITLE, nullable: true },
          synopsis: { type: 'string', maxLength: MAX_SYNOPSIS, nullable: true },
          source: { enum: ['editorial', 'machine', 'import'], default: 'editorial' },
          approved: { type: 'boolean', default: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id, language } = request.params as { id: string, language: string }
    const body = request.body as {
      title?: string | null, synopsis?: string | null, source?: string, approved?: boolean
    }

    const anime = await queryOne<{ id: string }>('SELECT id FROM anime WHERE id = $1', [id])
    if (!anime) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // Blank is not a translation. Normalising here rather than at the CHECK
    // means the caller gets a clear 400 instead of a constraint-violation 500.
    const title = body.title?.trim() || null
    const synopsis = body.synopsis?.trim() || null
    if (!title && !synopsis) {
      return reply.code(400).send({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'A translation needs a title or a synopsis — send DELETE to remove one'
      })
    }

    // A machine draft is never approved on write, whatever the caller says:
    // the point of the flag is that a person looked at it, and a request that
    // sets both cannot be that person.
    const source = body.source ?? 'editorial'
    const approved = source === 'machine' ? false : body.approved !== false

    const before = await queryOne(
      'SELECT title, synopsis, source, approved FROM anime_translations WHERE anime_id = $1 AND language = $2',
      [id, language]
    )

    const row = await queryOne(
      `INSERT INTO anime_translations (anime_id, language, title, synopsis, source, approved, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (anime_id, language) DO UPDATE
         SET title = EXCLUDED.title,
             synopsis = EXCLUDED.synopsis,
             source = EXCLUDED.source,
             approved = EXCLUDED.approved,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING language, title, synopsis, source, approved, updated_at`,
      [id, language, title, synopsis, source, approved, request.user.sub]
    )

    // Catalogue text is what viewers read, so "who changed this and to what"
    // is a question that gets asked afterwards.
    await audit(
      request.user.sub,
      before ? 'anime.translation.update' : 'anime.translation.create',
      'anime',
      id,
      before ?? {},
      { language, title, synopsis, source, approved }
    )

    return row
  })

  // ---- remove one ----
  fastify.delete('/anime/:id/:language', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          language: { enum: LANGUAGES }
        }
      }
    }
  }, async (request, reply) => {
    const { id, language } = request.params as { id: string, language: string }
    const before = await queryOne(
      'SELECT title, synopsis, source, approved FROM anime_translations WHERE anime_id = $1 AND language = $2',
      [id, language]
    )
    if (!before) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    await query('DELETE FROM anime_translations WHERE anime_id = $1 AND language = $2', [id, language])
    await audit(request.user.sub, 'anime.translation.delete', 'anime', id, before, {})
    return reply.code(204).send()
  })

  // ---- episodes ----
  fastify.put('/episode/:id/:language', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          language: { enum: LANGUAGES }
        }
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: MAX_TITLE, nullable: true },
          synopsis: { type: 'string', maxLength: MAX_SYNOPSIS, nullable: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id, language } = request.params as { id: string, language: string }
    const body = request.body as { title?: string | null, synopsis?: string | null }

    const episode = await queryOne<{ id: string }>('SELECT id FROM episodes WHERE id = $1', [id])
    if (!episode) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const title = body.title?.trim() || null
    const synopsis = body.synopsis?.trim() || null
    if (!title && !synopsis) {
      return reply.code(400).send({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'A translation needs a title or a synopsis'
      })
    }

    return queryOne(
      `INSERT INTO episode_translations (episode_id, language, title, synopsis, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (episode_id, language) DO UPDATE
         SET title = EXCLUDED.title, synopsis = EXCLUDED.synopsis,
             updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING language, title, synopsis, updated_at`,
      [id, language, title, synopsis, request.user.sub]
    )
  })
}

export default routes
