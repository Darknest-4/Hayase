// /v1/admin/security — the emergency controls.
//
// Separate from /v1/admin/config on purpose, and not only for tidiness:
//
//   * These are gated by `security.manage`, not `settings.system`. Renaming
//     the site and putting the whole instance into read-only mode are not the
//     same decision, and an editor who may do the first should not inherit
//     the second.
//   * Read-only mode exempts this prefix, because a lever with no exit that
//     is not a database console is not a lever anybody will pull.
//
// Every switch here has an enforcement point elsewhere in the server, and the
// GET says where. A control whose "enforced by" is empty does not belong in
// this file.

import { query, queryOne, transaction } from '../db.ts'
import { settings as siteSettings } from '../lib/site-settings.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * The switches, and what actually reads each one.
 *
 * `safe` is the value that means "nothing is being held back" — the screen
 * uses it to say which controls are currently engaged without hardcoding the
 * polarity of each one, since `read_only: true` and `webhooks_enabled: false`
 * are both the abnormal state.
 */
const CONTROLS = [
  {
    key: 'read_only',
    safe: false,
    label: 'Read-only mode',
    description: 'Refuse every request that writes. Reading, signing in and signing out keep working.',
    enforcedBy: 'server/src/app.ts — a global onRequest hook refuses POST/PUT/PATCH/DELETE with 503'
  },
  {
    key: 'external_sync_enabled',
    safe: true,
    label: 'External metadata sync',
    description: 'Allow metadata runs to start and to keep running. Turn off when an upstream is failing or rate-limiting us.',
    enforcedBy: 'server/src/workers/metadata.ts — startRun() refuses and handleMetadataJob() cancels'
  },
  {
    key: 'webhooks_enabled',
    safe: true,
    label: 'Outbound webhooks',
    description: 'Allow events to be queued and delivered to configured endpoints.',
    enforcedBy: 'server/src/lib/webhooks.ts — emitEvent() and deliver() both refuse'
  }
] as const

type ControlKey = typeof CONTROLS[number]['key']
const KEYS = CONTROLS.map(c => c.key)

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requirePermission('security.manage', { hide: true }))

  /** Every control, its current value, and whether it is currently holding something back. */
  fastify.get('/', async () => {
    const loaded = await siteSettings.load()
    const controls = CONTROLS.map(c => {
      const value = loaded[c.key] === undefined ? c.safe : loaded[c.key] === true
      return { ...c, value, engaged: value !== c.safe }
    })

    // What the levers would actually be acting on, so an operator can see the
    // cost of throwing one before they throw it.
    const context = await queryOne<{ sessions: number, hooks: number, runs: number }>(
      `SELECT
         (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS sessions,
         (SELECT count(*)::int FROM webhooks WHERE enabled) AS hooks,
         (SELECT count(*)::int FROM metadata_runs WHERE status IN ('queued', 'running')) AS runs`)

    return { controls, context, engaged: controls.filter(c => c.engaged).map(c => c.key) }
  })

  /**
   * Throw one control.
   *
   * A reason is required and is written to the audit log. These are the
   * changes somebody asks about afterwards — "who put the site into read-only
   * mode at 3am" — and an audit row that says only *what* changed answers half
   * the question.
   */
  fastify.post('/:key', {
    schema: {
      params: { type: 'object', properties: { key: { enum: KEYS } } },
      body: {
        type: 'object',
        required: ['value', 'reason'],
        properties: {
          value: { type: 'boolean' },
          reason: { type: 'string', minLength: 3, maxLength: 500 }
        }
      }
    }
  }, async request => {
    const { key } = request.params as { key: ControlKey }
    const { value, reason } = request.body as { value: boolean, reason: string }
    const control = CONTROLS.find(c => c.key === key)!

    const before = await queryOne<{ value: unknown }>('SELECT value FROM site_settings WHERE key = $1', [key])
    const was = before?.value === undefined ? control.safe : before.value === true

    await transaction(async client => {
      await client.query(
        `INSERT INTO site_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = now(), updated_by = $3`,
        [key, JSON.stringify(value), request.user.sub]
      )
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'config.setting', 'config', $2, $3, $4)`,
        [request.user.sub, key, { [key]: was }, { [key]: value, reason }]
      )
    })
    // The readers are cached, so without this the lever takes effect whenever
    // the TTL happens to expire — which is not what "emergency" means.
    siteSettings.invalidate()

    const { emitEvent } = await import('../lib/webhooks.ts')
    // Deliberately after the write: turning webhooks off should not announce
    // itself through the webhooks it just turned off, and turning them back on
    // should.
    void emitEvent('config.changed', {
      key,
      label: control.label,
      previous: String(was),
      value: String(value),
      by: request.user.username
    })

    return { key, value, engaged: value !== control.safe }
  })

  /**
   * Sign every account out, everywhere.
   *
   * The response to a leaked token, a compromised signing key, or a session
   * store somebody no longer trusts. Sessions are revoked and every account's
   * token version is bumped in one transaction — revoking the refresh tokens
   * alone would leave access tokens working until they expired, which on an
   * incident timeline is exactly the window that matters.
   *
   * The caller is signed out too. That is correct rather than unfortunate:
   * "everybody except me" is not the guarantee this is meant to give.
   */
  fastify.post('/revoke-all-sessions', {
    schema: {
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } }
      }
    }
  }, async request => {
    const { reason } = request.body as { reason: string }

    const revoked = await transaction(async client => {
      const { rows } = await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id')
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE deleted_at IS NULL')
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'user.sessions.revoke', 'config', 'all-sessions', $2, $3)`,
        [request.user.sub, { sessions: rows.length }, { sessions: 0, reason }]
      )
      return rows.length
    })

    const { invalidatePermissions } = await import('../plugins/auth.ts')
    invalidatePermissions()

    await query(
      `INSERT INTO security_logs (user_id, event, ip, user_agent)
       VALUES ($1, 'revoke_all_sessions', $2, $3)`,
      [request.user.sub, request.ip, request.headers['user-agent'] ?? null]
    )

    return { revoked }
  })
}

export default routes
