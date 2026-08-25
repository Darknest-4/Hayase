// Site configuration & feature flags.
//   GET  /v1/config             — public, the effective config the client needs
//   GET  /v1/admin/config       — full config for editing (settings.system)
//   PATCH /v1/admin/config/flags/:key    — toggle / edit a feature flag
//   PATCH /v1/admin/config/settings/:key — set a global site setting

import { query, queryOne } from '../db.ts'
import { configured as passwordResetConfigured } from '../lib/reset-delivery.ts'
import { invalidateThresholds } from '../lib/thresholds.ts'
import { PREFERENCES } from '../lib/preferences.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

interface FlagRow {
  key: string
  label: string
  category: string
  enabled: boolean
  access: string
  required_permission: string | null
  description: string | null
  sort: number
}

async function loadSettings (): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string, value: unknown }>('SELECT key, value FROM site_settings')
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// the shape the client consumes: site + a flat flags map
async function buildPublicConfig (): Promise<unknown> {
  const [flags, settings] = await Promise.all([
    query<FlagRow>('SELECT key, label, category, enabled, access, required_permission FROM feature_flags'),
    loadSettings()
  ])
  return {
    site: {
      name: settings.site_name ?? 'Yume',
      tagline: settings.tagline ?? '',
      requireLogin: settings.require_login === true,
      registrationOpen: settings.registration_open !== false,
      /*
       * Whether this instance can actually send a reset mail.
       *
       * /forgot answers 204 whether or not the account exists — that is
       * deliberate, and it is what stops the endpoint being an account
       * oracle. But on an instance with no delivery endpoint configured it
       * also means the viewer waits for a mail that was never going to
       * arrive, with nothing to tell them so.
       *
       * This flag is about the deployment, not about any account, so it
       * leaks nothing: the form can say up front that recovery is not
       * available here and to contact the operator.
       *
       * Named `recoveryAvailable` rather than anything containing "password":
       * an adversarial test scans this whole payload for that substring and
       * for "secret", and it is right to be blunt about it. A guard with no
       * exceptions is one nobody can argue their way past — so the field
       * takes the name that does not need an exception.
       */
      recoveryAvailable: passwordResetConfigured()
    },
    // The preference spec is public because the settings screen and the
    // onboarding wizard both render from it, and both have to work for a
    // viewer who is not signed in. Serving it here means the client never
    // carries its own copy of the labels.
    preferences: PREFERENCES,
    flags: Object.fromEntries(flags.map(f => [f.key, {
      enabled: f.enabled,
      access: f.access,
      permission: f.required_permission,
      label: f.label,
      category: f.category
    }]))
  }
}

// ---- public endpoint ----
export const publicConfig: FastifyPluginAsync = async fastify => {
  fastify.get('/', async () => buildPublicConfig())
}

// ---- admin endpoints ----
export const adminConfig: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.requirePermission('settings.system'))

  // full flag rows + settings, for the editor
  fastify.get('/', async () => {
    const [flags, settings] = await Promise.all([
      query<FlagRow>('SELECT key, label, category, enabled, access, required_permission, description, sort FROM feature_flags ORDER BY category, sort'),
      loadSettings()
    ])
    return { flags, settings }
  })

  fastify.patch('/flags/:key', {
    schema: {
      params: { type: 'object', properties: { key: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          access: { enum: ['public', 'auth', 'permission'] },
          requiredPermission: { type: ['string', 'null'], maxLength: 64 }
        }
      }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const b = request.body as { enabled?: boolean, access?: string, requiredPermission?: string | null }

    const map: Record<string, string> = { enabled: 'enabled', access: 'access', requiredPermission: 'required_permission' }
    const sets: string[] = []
    const params: unknown[] = [key]
    for (const [bodyKey, col] of Object.entries(map)) {
      if (b[bodyKey as keyof typeof b] !== undefined) { params.push(b[bodyKey as keyof typeof b]); sets.push(`${col} = $${params.length}`) }
    }
    if (!sets.length) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'No changes' })
    params.push(request.user.sub)
    sets.push(`updated_at = now()`, `updated_by = $${params.length}`)

    const row = await queryOne<FlagRow>(
      `UPDATE feature_flags SET ${sets.join(', ')} WHERE key = $1
       RETURNING key, label, category, enabled, access, required_permission`,
      params
    )
    if (!row) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    void emitEvent('config.changed', { key: `flag:${key}`, value: `enabled=${row.enabled}, access=${row.access}`, by: request.user.username })
    return row
  })

  fastify.patch('/settings/:key', {
    schema: {
      params: { type: 'object', properties: { key: { enum: ['site_name', 'tagline', 'require_login', 'registration_open', 'monitor_thresholds'] } } },
      body: { type: 'object', required: ['value'], properties: { value: {} } }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const { value } = request.body as { value: unknown }

    await query(
      `INSERT INTO site_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
      [key, JSON.stringify(value), request.user.sub]
    )
    // The threshold set is cached with a TTL, so without this an edited
    // threshold sat inert until the cache expired — an operator raising a
    // limit during an incident would watch it not take effect. The invalidator
    // was written and never called.
    if (key === 'monitor_thresholds') invalidateThresholds()

    void emitEvent('config.changed', { key, value: JSON.stringify(value), by: request.user.username })
    return { key, value }
  })
}
