// /v1/reports — user-facing content reporting. The moderation queue that
// consumes these lives under /v1/admin/reports.

import { queryOne } from '../db.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'
import { WRITE_LIMIT } from '../plugins/security.ts'

const SUBJECTS = ['comment', 'post', 'topic', 'review', 'user', 'extension', 'message'] as const
const REASONS = ['spam', 'harassment', 'nsfw', 'spoiler', 'illegal', 'other'] as const

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
