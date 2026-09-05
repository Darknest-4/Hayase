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

import { query, queryOne } from '../db.ts'
import { audit, type AuditAction } from '../lib/audit.ts'
import { WRITE_LIMIT } from '../plugins/security.ts'

import type { FastifyPluginAsync, preValidationHookHandler } from 'fastify'

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
  /**
   * The service-token gate.
   *
   * `preValidation`, not the handler body: Fastify validates the request
   * schema before the handler runs, so an in-handler check answered an
   * unauthenticated caller with 400 and a description of the schema. The
   * order matters — say "no" before saying anything else.
   */
  const requireServiceToken: preValidationHookHandler = async (request, reply) => {
    const presented = String(request.headers['x-service-token'] ?? '')
    if (!tokenMatches(presented, process.env.YUME_SERVICE_TOKEN ?? '')) {
      return await reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401 })
    }
  }

  fastify.post('/discord/audit', {
    config: WRITE_LIMIT,
    preValidation: requireServiceToken,
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

  /*
   * Message identity.
   *
   * The bot has no database of its own — deliberately, so it carries no `pg`
   * dependency and no credential for one. But it needs to remember which
   * Discord message is "the status board", or every refresh posts a new one.
   *
   * So it asks here. Three operations, all of them boring: read a key, write a
   * key, forget a key. Nothing secret passes through — a channel id and a
   * message id are public inside the server.
   */

  const KEY = { type: 'object', properties: { key: { type: 'string', maxLength: 200 } } }

  fastify.get('/discord/messages/:key', { preValidation: requireServiceToken, schema: { params: KEY } }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const row = await queryOne(
      'SELECT key, guild_id, channel_id, message_id, content_hash, edit_count FROM discord_messages WHERE key = $1',
      [key]
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return row
  })

  fastify.put('/discord/messages/:key', {
    config: WRITE_LIMIT,
    preValidation: requireServiceToken,
    schema: {
      params: KEY,
      body: {
        type: 'object',
        required: ['guildId', 'channelId', 'messageId', 'contentHash'],
        additionalProperties: false,
        properties: {
          guildId: { type: 'string', maxLength: 40 },
          channelId: { type: 'string', maxLength: 40 },
          messageId: { type: 'string', maxLength: 40 },
          contentHash: { type: 'string', maxLength: 64 },
          // False when the row is only being recorded for the first time, so a
          // fresh post does not read as an edit.
          edited: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const body = request.body as { guildId: string, channelId: string, messageId: string, contentHash: string, edited?: boolean }
    const row = await queryOne(
      `INSERT INTO discord_messages (key, guild_id, channel_id, message_id, content_hash, edit_count)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (key) DO UPDATE
          SET guild_id = excluded.guild_id,
              channel_id = excluded.channel_id,
              message_id = excluded.message_id,
              content_hash = excluded.content_hash,
              updated_at = now(),
              -- Counted only when the content actually moved. A board that
              -- rewrites itself every tick is a bug, and this is where it shows.
              edit_count = discord_messages.edit_count + CASE WHEN $6 THEN 1 ELSE 0 END
       RETURNING key, message_id, edit_count`,
      [key, body.guildId, body.channelId, body.messageId, body.contentHash, body.edited === true]
    )
    return reply.code(200).send(row)
  })

  fastify.delete('/discord/messages/:key', { preValidation: requireServiceToken, schema: { params: KEY } }, async (request, reply) => {
    const { key } = request.params as { key: string }
    await query('DELETE FROM discord_messages WHERE key = $1', [key])
    return reply.code(204).send()
  })
}

export default routes
