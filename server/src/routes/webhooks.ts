// /v1/admin/webhooks — CRUD + test fire for outbound webhooks.
// Permission-gated (admin.webhooks.manage). Secrets are never returned.

import { query, queryOne } from '../db.ts'
import { deliver, WEBHOOK_EVENTS, type WebhookEvent } from '../lib/webhooks.ts'
import { checkOutboundUrl } from '../lib/ssrf.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.requirePermission('admin.webhooks.manage', { hide: true }))

  // list available event types (for the UI's per-event toggles)
  fastify.get('/events', async () => ({ events: WEBHOOK_EVENTS }))

  fastify.get('/', async () => {
    const data = await query(
      `SELECT w.id, w.name, w.url, w.format, w.events, w.enabled, w.failure_count,
              w.last_success_at, w.last_error, w.created_at,
              (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS delivery_count
       FROM webhooks w ORDER BY w.created_at DESC`
    )
    return { data }
  })

  fastify.get('/:id/deliveries', async request => {
    const { id } = request.params as { id: string }
    const data = await query(
      `SELECT event, status_code, error, duration_ms, created_at
       FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [id]
    )
    return { data }
  })

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          url: { type: 'string', pattern: '^https?://', maxLength: 500 },
          format: { enum: ['discord', 'json'], default: 'discord' },
          events: { type: 'array', items: { enum: [...WEBHOOK_EVENTS] } },
          secret: { type: 'string', maxLength: 200 },
          enabled: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    const b = request.body as { name: string, url: string, format?: string, events?: string[], secret?: string, enabled?: boolean }

    // Rejected here as well as at delivery, so a mistake surfaces while the
    // operator is still looking at the form.
    const verdict = await checkOutboundUrl(b.url)
    if (!verdict.ok) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: `That URL cannot be used: it ${verdict.reason}. Set WEBHOOK_ALLOWED_HOSTS to permit an internal host deliberately.`
      })
    }
    const hook = await queryOne(
      `INSERT INTO webhooks (name, url, format, events, secret, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, url, format, events, enabled, created_at`,
      [b.name, b.url, b.format ?? 'discord', b.events ?? [], b.secret ?? null, b.enabled ?? true, request.user.sub]
    )
    return reply.code(201).send(hook)
  })

  fastify.patch('/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          url: { type: 'string', pattern: '^https?://', maxLength: 500 },
          format: { enum: ['discord', 'json'] },
          events: { type: 'array', items: { enum: [...WEBHOOK_EVENTS] } },
          secret: { type: 'string', maxLength: 200 },
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>

    const sets: string[] = []
    const params: unknown[] = [id]
    for (const key of ['name', 'url', 'format', 'events', 'secret', 'enabled'] as const) {
      if (b[key] !== undefined) {
        params.push(b[key])
        sets.push(`${key} = $${params.length}`)
      }
    }
    // re-enabling clears the failure counter so it starts fresh
    if (b.enabled === true) sets.push('failure_count = 0, last_error = NULL')
    if (!sets.length) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Nothing to update' })

    const hook = await queryOne(
      `UPDATE webhooks SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, name, url, format, events, enabled, failure_count`,
      params
    )
    if (!hook) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    return hook
  })

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    await query('DELETE FROM webhooks WHERE id = $1', [id])
    return reply.code(204).send()
  })

  // fire a test event immediately (synchronous so the UI shows the result)
  fastify.post('/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string }
    const hook = await queryOne<{ id: string, name: string }>('SELECT id, name FROM webhooks WHERE id = $1', [id])
    if (!hook) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    try {
      await deliver(id, 'webhook.test' as WebhookEvent, { name: hook.name }, new Date().toISOString())
      return { delivered: true }
    } catch (e) {
      return reply.code(502).send({ type: 'about:blank', title: 'Delivery failed', status: 502, detail: (e as Error).message })
    }
  })
}

export default routes
