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

import { query, queryOne, transaction } from '../../infrastructure/database/index.ts'
import { posture } from './posture.ts'
import { rateLimitDefaults, settings as siteSettings } from '../settings/site-settings.ts'

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
    label: 'Csak olvasható mód',
    description: 'Minden író kérés elutasítva. Az olvasás, a belépés és a kilépés továbbra is működik.',
    enforcedBy: 'apps/api/src/app.ts — a global onRequest hook refuses POST/PUT/PATCH/DELETE with 503'
  },
  {
    key: 'external_sync_enabled',
    safe: true,
    label: 'Külső metaadat-szinkron',
    description: 'A metaadat-futások elindulhatnak és futhatnak. Kapcsold ki, ha a forrás hibázik vagy korlátoz minket.',
    enforcedBy: 'apps/api/src/modules/metadata/worker.ts — startRun() refuses and handleMetadataJob() cancels'
  },
  {
    key: 'webhooks_enabled',
    safe: true,
    label: 'Kimenő webhookok',
    description: 'Az események sorba állhatnak és kimehetnek a beállított végpontokra.',
    enforcedBy: 'apps/api/src/modules/webhooks/delivery.ts — emitEvent() and deliver() both refuse'
  }
] as const

type ControlKey = typeof CONTROLS[number]['key']
const KEYS = CONTROLS.map(c => c.key)

const LIMIT_KEYS = ['global', 'auth', 'write', 'refresh'] as const
type LimitKey = typeof LIMIT_KEYS[number]

const LIMIT_LABELS: Record<LimitKey, string> = {
  global: 'Minden kérés',
  auth: 'Belépés és regisztráció',
  write: 'Írás (hozzászólás, könyvtár)',
  refresh: 'Munkamenet-frissítés'
}

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

    // A sebességkorlátok: mi van érvényben, mi az alapérték, és ami ezekből
    // következik — hogy a mostani érték a telepítésé-e vagy valakié.
    const limits = await siteSettings.rateLimits()
    const defaults = rateLimitDefaults()
    const rateLimits = LIMIT_KEYS.map(key => ({
      key,
      label: LIMIT_LABELS[key],
      max: limits[key].max,
      windowSeconds: limits[key].windowSeconds,
      defaultMax: defaults[key].max,
      defaultWindowSeconds: defaults[key].windowSeconds,
      custom: limits[key].max !== defaults[key].max ||
        limits[key].windowSeconds !== defaults[key].windowSeconds
    }))

    return { controls, context, rateLimits, engaged: controls.filter(c => c.engaged).map(c => c.key) }
  })

  /**
   * A sebességkorlátok átírása.
   *
   * Ugyanaz a jogosultság, ami a vészkapcsolókat is nyitja (`security.manage`),
   * és ugyanúgy auditált — ez a beállítás eldöntheti, hogy egy roham átmegy-e
   * vagy elakad, és „ki engedte fel" utólag kérdés lesz.
   *
   * Az indoklás kötelező, mint a vészkapcsolóknál. Egy szám, aminek nincs
   * története, egy hónap múlva megmagyarázhatatlan.
   *
   * Nincs felső korlát a `max`-on: egy üzemeltető feloldhatja a korlátot, ha
   * tudja, mit csinál. Alsó korlát van, mert a nulla nem korlát, hanem
   * kizárás — és az a `read_only` kapcsoló dolga, nem ezé.
   */
  fastify.patch('/limits', {
    schema: {
      body: {
        type: 'object',
        required: ['limits', 'reason'],
        additionalProperties: false,
        properties: {
          reason: { type: 'string', minLength: 3, maxLength: 500 },
          limits: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(LIMIT_KEYS.map(key => [key, {
              type: 'object',
              required: ['max', 'windowSeconds'],
              additionalProperties: false,
              properties: {
                max: { type: 'integer', minimum: 1, maximum: 1_000_000 },
                windowSeconds: { type: 'integer', minimum: 1, maximum: 86_400 }
              }
            }]))
          }
        }
      }
    }
  }, async request => {
    const { limits, reason } = request.body as {
      limits: Partial<Record<LimitKey, { max: number, windowSeconds: number }>>
      reason: string
    }

    const before = await siteSettings.rateLimits()
    // Az egész táblát írjuk, a részleges összefésülés után: a panel a teljes
    // képet küldi vissza, és egy fél mentés itt azt jelentené, hogy két korlát
    // közül az egyik a régi marad, némán.
    const merged = { ...before, ...limits }

    await transaction(async client => {
      await client.query(
        `INSERT INTO site_settings (key, value, updated_by) VALUES ('rate_limits', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now(), updated_by = $2`,
        [JSON.stringify(merged), request.user.sub]
      )
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'config.setting', 'config', 'rate_limits', $2, $3)`,
        [request.user.sub, before, { ...merged, reason }]
      )
    })
    // A korlátok kérésenként olvassák a gyorsítótárat, tehát ez azonnal hat —
    // enélkül a TTL lejártáig a régi érték élne, ami egy incidens közepén
    // harminc másodperc várakozás a semmiért.
    siteSettings.invalidate()

    return { limits: merged }
  })

  /**
   * The posture, computed on demand.
   *
   * Every entry inspects something and reports what it found; the score is
   * passing weight over applicable weight and nothing more. A page that shows
   * a number with no checks behind it is the most confident lie a dashboard
   * can tell, because the reader stops looking.
   *
   * Deliberately not cached. It reads a dozen small indexed counts, an
   * operator asks for it rarely, and a cached posture is a posture that can be
   * wrong at the moment somebody is relying on it.
   */
  fastify.get('/posture', async () => posture())

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

    const { emitEvent } = await import('../webhooks/delivery.ts')
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

    const { invalidatePermissions } = await import('../../middleware/auth.ts')
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
