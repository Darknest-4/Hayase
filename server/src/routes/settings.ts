// /v1/me/settings — per-profile viewer preferences.
//
// The table this writes to (user_settings) has existed since migration 0001
// and had no code path until now; migration 0019 marked it PLANNED for exactly
// that reason. Nothing new was needed in the schema — the shape was already
// right: (profile_id, key, value jsonb) with a composite primary key, so a
// single preference is one upsert and no read-modify-write.
//
// Settings are per PROFILE, not per account. That is a real feature rather
// than an accident of the schema: one household can have a Hungarian child
// profile and an English adult profile on the same login.
//
// What may be stored is decided entirely by lib/preferences.ts. This file
// contains no list of keys.

import { query, queryOne } from '../db.ts'
import { PREFERENCES, coerce, isPreferenceKey, resolve } from '../lib/preferences.ts'

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

/** Onboarding state lives beside the preferences but is not one of them:
 *  it records an event, not a choice, so it is never offered in a settings UI. */
const ONBOARDING_KEY = 'onboarding.state'

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

async function readAll (profileId: string): Promise<{
  settings: Record<string, unknown>
  onboarding: Record<string, unknown> | null
}> {
  const rows = await query<{ key: string, value: unknown }>(
    'SELECT key, value FROM user_settings WHERE profile_id = $1', [profileId]
  )
  const stored: Record<string, unknown> = {}
  let onboarding: Record<string, unknown> | null = null
  for (const row of rows) {
    if (row.key === ONBOARDING_KEY) onboarding = row.value as Record<string, unknown>
    else stored[row.key] = row.value
  }
  return { settings: resolve(stored), onboarding }
}

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.authenticate)

  // ---- read ----
  fastify.get('/settings', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return
    const { settings, onboarding } = await readAll(profileId)
    return {
      settings,
      onboarding,
      // The client renders its settings screen from this rather than carrying
      // its own copy of the list, so the two cannot drift apart.
      spec: PREFERENCES
    }
  })

  // ---- write ----
  //
  // A partial patch, not a replace: the wizard writes four keys and the
  // settings screen writes one, and neither should have to send the rest.
  fastify.patch('/settings', {
    schema: {
      body: {
        type: 'object',
        properties: {
          settings: { type: 'object', additionalProperties: true },
          onboarding: { type: 'object', additionalProperties: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return

    const body = request.body as {
      settings?: Record<string, unknown>
      onboarding?: Record<string, unknown>
    }

    const incoming = body.settings ?? {}

    // An unknown key is a client bug and worth saying so — silently dropping
    // it produces a settings screen that appears to save and does not.
    const unknown = Object.keys(incoming).filter(key => !isPreferenceKey(key))
    if (unknown.length) {
      return reply.code(400).send({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `Unknown preference key(s): ${unknown.slice(0, 5).join(', ')}`
      })
    }

    const writes: Array<[string, unknown]> = []
    for (const [key, value] of Object.entries(incoming)) {
      const coerced = coerce(key, value)
      if (coerced !== undefined) writes.push([key, coerced])
    }

    if (body.onboarding) {
      writes.push([ONBOARDING_KEY, {
        ...body.onboarding,
        // Recorded server-side so a client clock cannot claim the wizard was
        // finished at a time it was not.
        at: new Date().toISOString()
      }])
    }

    if (writes.length) {
      // One statement, not one per key: a half-applied wizard would leave a
      // profile configured in a way the viewer never chose.
      await query(
        `INSERT INTO user_settings (profile_id, key, value)
         SELECT $1, k, v::jsonb
           FROM unnest($2::text[], $3::text[]) AS t(k, v)
         ON CONFLICT (profile_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [profileId, writes.map(w => w[0]), writes.map(w => JSON.stringify(w[1]))]
      )
    }

    const { settings, onboarding } = await readAll(profileId)
    return { settings, onboarding }
  })

  // ---- reset ----
  //
  // Deletes rather than writing defaults, so a later change to a default
  // reaches viewers who never expressed an opinion.
  fastify.delete('/settings', async (request, reply) => {
    const profileId = await resolveProfile(request, reply)
    if (!profileId) return
    await query('DELETE FROM user_settings WHERE profile_id = $1 AND key <> $2', [profileId, ONBOARDING_KEY])
    const { settings, onboarding } = await readAll(profileId)
    return { settings, onboarding }
  })
}

export default routes
