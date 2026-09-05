// /v1/reports — user-facing content reporting. The moderation queue that
// consumes these lives under /v1/admin/reports.

import { queryOne } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'
import { WRITE_LIMIT } from '../plugins/security.ts'

const SUBJECTS = ['comment', 'post', 'topic', 'review', 'user', 'extension', 'message', 'extension_review'] as const
const REASONS = ['spam', 'harassment', 'nsfw', 'spoiler', 'illegal', 'other'] as const

/**
 * The table each subject type lives in.
 *
 * Without this the endpoint accepted any well-formed uuid, so a report could
 * name a subject that has never existed. Moderators then get a queue entry
 * that opens to nothing, and since one report per (reporter, subject) is
 * allowed, a single account can mint an unbounded number of them by
 * generating fresh uuids — the moderation queue is the thing that breaks.
 *
 * The values are fixed literals matched to SUBJECTS, never request input, so
 * the interpolation below cannot carry anything a caller controls.
 */
const SUBJECT_TABLE: Record<typeof SUBJECTS[number], string> = {
  comment: 'comments',
  post: 'posts',
  topic: 'topics',
  review: 'reviews',
  user: 'users',
  extension: 'extensions',
  message: 'messages',
  // `review` is an anime review; an extension's store review is a different table
  extension_review: 'extension_reviews'
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.post('/', {
    config: WRITE_LIMIT,
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['subjectType', 'subjectId', 'reason'],
        properties: {
          subjectType: { enum: [...SUBJECTS] },
          subjectId: { type: 'string', format: 'uuid' },
          reason: { enum: [...REASONS] },
          details: { type: 'string', maxLength: 2000 }
        }
      }
    }
  }, async (request, reply) => {
    const { subjectType, subjectId, reason, details } = request.body as {
      subjectType: string, subjectId: string, reason: string, details?: string
    }

    const table = SUBJECT_TABLE[subjectType as typeof SUBJECTS[number]]
    const subject = table ? await queryOne(`SELECT 1 FROM ${table} WHERE id = $1`, [subjectId]) : undefined
    if (!subject) {
      return reply.code(404).send({
        type: 'about:blank', title: 'Not Found', status: 404, detail: 'That subject does not exist'
      })
    }

    // one open report per (reporter, subject); repeat reports are no-ops
    const existing = await queryOne(
      `SELECT id FROM reports WHERE reporter_id = $1 AND subject_type = $2 AND subject_id = $3 AND status IN ('open', 'reviewing')`,
      [request.user.sub, subjectType, subjectId]
    )
    if (existing) return reply.code(200).send({ status: 'already_reported' })

    const report = await queryOne(
      `INSERT INTO reports (reporter_id, subject_type, subject_id, reason, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, created_at`,
      [request.user.sub, subjectType, subjectId, reason, details ?? null]
    )
    await emitEvent('report.created', { subjectType, reason, reporter: request.user.username })
    return reply.code(201).send(report)
  })
}

export default routes
