// /v1/integrations — inbound calls from Yume's own services.
//
// Only the Discord bot uses this today, for one thing: writing its moderation
// actions into `audit_logs`, so a ban issued through a slash command is in the
// same trail as one issued through the admin panel. A moderation system with
// two audit trails has none.
//
// Authenticated with a shared service token, not a user JWT. The bot is not a
// user: it has no account, holds no session, and must not be able to act as
// one. The token only opens this one route, and the route only writes a log
// line — the worst a leaked token buys is a fabricated audit entry, which is
// why the entry records that it came from Discord.

import { timingSafeEqual } from 'node:crypto'

import { audit, type AuditAction } from '../lib/audit.ts'
import { WRITE_LIMIT } from '../plugins/security.ts'

import type { FastifyPluginAsync } from 'fastify'

/** Constant-time compare that does not leak the secret's length either. */
function tokenMatches (presented: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still do a comparison so the timing does not distinguish "wrong length"
    // from "wrong value".
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** Exactly the actions the bot is allowed to record. */
const DISCORD_ACTIONS = new Set<string>([
  'discord.warn', 'discord.timeout', 'discord.kick', 'discord.ban',
  'discord.purge', 'discord.slowmode',
  'discord.role.create', 'discord.role.update', 'discord.category.create',
  'discord.channel.create', 'discord.channel.update', 'discord.webhook.create'
])

const routes: FastifyPluginAsync = async fastify => {
  fastify.post('/discord/audit', {
    config: WRITE_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['action', 'actor', 'subject'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', maxLength: 100, pattern: '^discord\\.[a-z._]+$' },
          actor: { type: 'string', maxLength: 40 },
          subject: { type: 'string', maxLength: 100 },
          detail: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const expected = process.env.YUME_SERVICE_TOKEN ?? ''
    const presented = String(request.headers['x-service-token'] ?? '')
    if (!tokenMatches(presented, expected)) {
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401 })
    }

    const { action, actor, subject, detail } = request.body as {
      action: string, actor: string, subject: string, detail?: Record<string, unknown>
    }

    // The schema's pattern only guarantees the shape `discord.something`; this
    // is the list the type actually allows. An unknown action is rejected
    // rather than written, so the trail cannot be seeded with invented verbs.
    if (!DISCORD_ACTIONS.has(action)) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400, detail: `unknown action: ${action}`
      })
    }

    // `actor_id` stays NULL: the Discord user id is not a Yume account id, and
    // putting it in a uuid column that references `users` would either fail or
    // point at somebody else. It goes in the payload, labelled.
    await audit(null, action as AuditAction, 'discord', subject.slice(0, 100), {}, {
      discordActorId: actor,
      subject,
      ...(detail ?? {})
    })

    return reply.code(202).send({ recorded: true })
  })
}

export default routes
