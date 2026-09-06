// /v1/auth — register, login, refresh, logout, password change and recovery.
//
// Access tokens: JWT (15 min), bound to the session they were minted under.
// Refresh tokens: 256-bit random, stored as sha256 in sessions, rotated on
// every refresh. Reset tokens: 256-bit random, stored as sha256, single use.

import { createHash, randomBytes } from 'node:crypto'

import { config } from '../config.ts'
import { AUTH_LIMIT, REFRESH_LIMIT } from '../plugins/security.ts'
import { invalidateSession, revokeTokens } from '../plugins/auth.ts'
import { query, queryOne, transaction } from '../db.ts'
import { onUniqueViolation } from '../lib/db-errors.ts'
import { hashPassword, verifyPassword } from '../lib/password.ts'
import { deliverReset } from '../lib/reset-delivery.ts'
import { settings as siteSettings } from '../lib/site-settings.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * A real scrypt hash of a random secret, used to equalise login timing for
 * unknown accounts. Computed once at startup; it can never match a submitted
 * password because the input is never revealed.
 */
const DECOY_HASH = await hashPassword(randomBytes(32).toString('base64url'))

/** How long a reset link stays usable. Short: it is a full account credential. */
const RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MS ?? 3_600_000)

interface UserRow {
  token_version?: number
  id: string
  username: string
  password_hash: string | null
  status: string
}

const credentialsSchema = {
  type: 'object',
  required: ['identifier', 'password'],
  properties: {
    identifier: { type: 'string', minLength: 3, maxLength: 254 }, // email or username
    password: { type: 'string', minLength: 8, maxLength: 128 }
  }
} as const

/**
 * Write a new password and end every session the account has.
 *
 * Both callers — a deliberate change and a reset — mean the same thing by it:
 * whoever else was holding this account is now out. Doing it in one place is
 * what keeps the reset path from quietly forgetting the revocation.
 */
async function applyNewPassword (userId: string, newPassword: string, ip: string, event: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword)
  await transaction(async client => {
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash])
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
  })
  await revokeTokens(userId)
  await query('INSERT INTO security_logs (user_id, event, ip) VALUES ($1, $2, $3)', [userId, event, ip])
}

const routes: FastifyPluginAsync = async fastify => {
  /**
   * Mint a session and the pair of tokens that belong to it.
   *
   * Two independent revocation levers, because they answer different
   * questions:
   *
   *   `tv`  — users.token_version. Bumping it kills every token the account
   *           has, everywhere. That is what a ban, a password change or an
   *           explicit "sign out everywhere" wants.
   *   `sid` — the session this token was minted under. Revoking that one row
   *           kills this token and no other. That is what signing out of one
   *           device wants, and without it logout left the access token
   *           working for the rest of its 15 minutes: verified before this
   *           existed, a request with a logged-out token still answered 200.
   *
   * The session id costs nothing to carry and nothing to check — the request
   * already reads the users row to compare `tv`, and the session join rides
   * along on the same query.
   */
  async function issueTokens (user: { id: string, username: string, token_version?: number }, ip?: string, userAgent?: string) {
    const refreshToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000)

    const session = await queryOne<{ id: string }>(
      'INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [user.id, sha256(refreshToken), ip ?? null, userAgent ?? null, expiresAt]
    )
    // An INSERT … RETURNING that comes back empty means the write did not
    // happen. Minting a token for a session that does not exist would produce
    // a credential nothing can revoke, so this fails instead.
    if (!session) throw new Error('failed to create session')

    const version = user.token_version ?? (await queryOne<{ token_version: number }>(
      'SELECT token_version FROM users WHERE id = $1', [user.id]))?.token_version ?? 0
    const accessToken = fastify.jwt.sign({ sub: user.id, username: user.username, tv: version, sid: session.id })
    return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
  }

  fastify.post('/register', {
    config: AUTH_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['email', 'username', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_]+$' },
          password: { type: 'string', minLength: 8, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const { email, username, password } = request.body as { email: string, username: string, password: string }

    /*
     * Registration can be closed from the admin panel.
     *
     * It could not before: the setting was stored, echoed back to the client
     * as `site.registrationOpen`, and enforced nowhere. The form disappeared
     * and the endpoint kept accepting posts, so closing registration stopped
     * exactly the people who were using the UI honestly.
     *
     * 403 rather than 404: the endpoint plainly exists — the client just asked
     * for its config — and "closed" is the useful answer.
     */
    if (!await siteSettings.registrationOpen()) {
      return reply.code(403).send({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Registration is closed on this instance'
      })
    }

    const existing = await queryOne('SELECT 1 FROM users WHERE email = $1 OR username = $2', [email, username])
    if (existing) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Email or username already in use' })
    }

    const passwordHash = await hashPassword(password)

    // The check above is a courtesy, not a guarantee: two registrations racing
    // each other both pass it, and the unique index is what actually decides.
    // onUniqueViolation turns the loser into the same 409 the sequential path
    // gives — see lib/db-errors.ts for why this is a shared helper and not a
    // fifth hand-written try/catch.
    const user = await onUniqueViolation(
      async () => transaction(async client => {
        const { rows } = await client.query<{ id: string }>(
          'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
          [email, username, passwordHash]
        )
        const userId = rows[0]!.id
        // default role + default profile
        await client.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'user'`,
          [userId]
        )
        await client.query(
          'INSERT INTO user_profiles (user_id, display_name, is_default) VALUES ($1, $2, true)',
          [userId, username]
        )
        await client.query(
          'INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
          [userId, 'register', request.ip, request.headers['user-agent'] ?? null]
        )

        /**
         * Bootstrap: the first account on an instance with no administrator
         * becomes one.
         *
         * A fresh deployment otherwise has nobody who can reach the admin
         * panel and no documented way to get there — the operator has to write
         * SQL by hand, which is worse than this in every way that matters.
         *
         * The condition is "no administrator exists", not "this is the first
         * user". Those differ in exactly the case that matters: once anybody
         * holds the role, this path is dead, so it cannot hand out a second
         * one later — after a purge of the users table, say.
         *
         * The advisory lock is what makes it safe under concurrency. Without
         * it two registrations arriving together would both see no admin under
         * READ COMMITTED and both be promoted. It is taken before the check
         * and released with the transaction, so the second waits and then
         * finds the admin the first created.
         */
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['yume:admin-bootstrap'])
        const { rows: promoted } = await client.query<{ id: string }>(
          `INSERT INTO user_roles (user_id, role_id)
           SELECT $1, r.id FROM roles r
            WHERE r.slug = 'admin'
              AND NOT EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles ar ON ar.id = ur.role_id
                 WHERE ar.slug = 'admin'
              )
           RETURNING user_id AS id`,
          [userId]
        )
        if (promoted.length) {
          // Becoming an administrator is the single most consequential thing
          // that can happen to an account, and it happens here without anyone
          // approving it. It is recorded in both places somebody would look.
          await client.query(
            'INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
            [userId, 'admin_bootstrap', request.ip, request.headers['user-agent'] ?? null]
          )
          await client.query(
            // actor_id is uuid and subject_id is text, so the same parameter
            // has to be cast for each — without it Postgres deduces two types
            // for $1 and refuses to plan the statement.
            `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
             VALUES ($1::uuid, 'user.role.bootstrap', 'user', $1::text, '{}'::jsonb, $2::jsonb)`,
            [userId, JSON.stringify({ role: 'admin', reason: 'first account on an instance with no administrator' })]
          )
          request.log.warn({ userId, username }, 'first account promoted to administrator (no admin existed)')
        }
        return { id: userId, username }
      }),
      () => undefined
    )
    if (!user) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Email or username already in use' })
    }

    await emitEvent('user.registered', { username: user.username })
    const tokens = await issueTokens(user, request.ip, request.headers['user-agent'])
    return reply.code(201).send(tokens)
  })

  fastify.post('/login', { config: AUTH_LIMIT, schema: { body: credentialsSchema } }, async (request, reply) => {
    const { identifier, password } = request.body as { identifier: string, password: string }

    const user = await queryOne<UserRow>(
      'SELECT id, username, password_hash, status, token_version FROM users WHERE (email = $1 OR username = $1) AND deleted_at IS NULL',
      [identifier]
    )

    // Verify against a decoy hash when the account does not exist, so a missing
    // user costs the same ~scrypt time as a wrong password. Without this the
    // response time alone reveals which usernames/emails are registered.
    let valid: boolean
    if (user?.password_hash != null) {
      valid = await verifyPassword(password, user.password_hash)
    } else {
      await verifyPassword(password, DECOY_HASH) // never matches; burns equal time
      valid = false
    }

    if (!user || !valid) {
      await query('INSERT INTO security_logs (user_id, event, ip) VALUES ($1, $2, $3)', [user?.id ?? null, 'login_failed', request.ip])
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid credentials' })
    }
    if (user.status !== 'active') {
      return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: `Account ${user.status}` })
    }

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    await query('INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)', [user.id, 'login', request.ip, request.headers['user-agent'] ?? null])

    return issueTokens(user, request.ip, request.headers['user-agent'])
  })

  fastify.post('/refresh', {
    config: REFRESH_LIMIT,
    schema: { body: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } }
  }, async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string }

    const session = await queryOne<{ id: string, user_id: string, username: string }>(
      `SELECT s.id, s.user_id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
      [sha256(refreshToken)]
    )
    if (!session) {
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid refresh token' })
    }

    // rotation: revoke the used session, issue a fresh one
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [session.id])
    return issueTokens({ id: session.user_id, username: session.username }, request.ip, request.headers['user-agent'])
  })

  // the client uses this to decide whether to show moderation/admin UI
  fastify.get('/permissions', { preHandler: fastify.authenticate }, async request => {
    const rows = await query<{ slug: string }>(
      `SELECT DISTINCT p.slug
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = $1`,
      [request.user.sub]
    )
    return { permissions: rows.map(row => row.slug) }
  })

  /**
   * Sign out of this device.
   *
   * The session named by the access token is revoked whether or not the client
   * sends its refresh token, because the access token is what the caller is
   * holding right now. Revoking only the refresh token — which is all this
   * used to do — left the access token working for the rest of its 15 minutes.
   */
  fastify.post('/logout', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { refreshToken } = (request.body ?? {}) as { refreshToken?: string }
    const sid = request.user.sid

    if (sid) {
      await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sid, request.user.sub])
      invalidateSession(request.user.sub, sid)
    }
    // A client may also hand back a refresh token from a different session —
    // and a token minted before session binding existed has no sid at all.
    if (refreshToken) {
      await query('UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND user_id = $2', [sha256(refreshToken), request.user.sub])
    }
    return reply.code(204).send()
  })

  /**
   * Sign out everywhere.
   *
   * Distinct from /logout on purpose: this is the one that bumps
   * token_version, which invalidates every token the account holds on every
   * device. Somebody who thinks their account is compromised wants this;
   * somebody closing a laptop does not.
   */
  fastify.post('/logout-all', { preHandler: fastify.authenticate }, async (request, reply) => {
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [request.user.sub])
    await revokeTokens(request.user.sub)
    await query('INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [request.user.sub, 'logout_all', request.ip, request.headers['user-agent'] ?? null])
    return reply.code(204).send()
  })

  /**
   * Delete this account.
   *
   * The schema has anticipated this since the first migration — `deleted_at`,
   * and a comment saying the unique email and username are freed by an app
   * rename on delete — and no code ever performed it. A deletion request could
   * only be honoured by hand-written SQL, which is not a process anybody
   * should have to run under time pressure.
   *
   * Soft delete, and the reasons are not squeamishness:
   *
   *   * Moderation history has to survive. A hard delete would either cascade
   *     away the reports and audit entries that explain why an account was
   *     banned, or leave them pointing at nothing.
   *   * Content the person wrote is other people's context. Comments are kept
   *     and detached, not vanished mid-thread.
   *
   * What is actually erased is the identifying part: the email and username
   * are replaced with an irreversible per-account placeholder, so the address
   * cannot be recovered from the row, and both are freed for reuse. The
   * password hash goes, and every session with it.
   *
   * The password is required. Deleting an account is the most destructive
   * thing this API can do to a person, and a stolen access token must not be
   * enough to do it.
   */
  fastify.delete('/me', {
    config: AUTH_LIMIT,
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string', minLength: 1, maxLength: 200 } }
      }
    }
  }, async (request, reply) => {
    const { password } = request.body as { password: string }
    const userId = request.user.sub

    const user = await queryOne<{ password_hash: string | null, username: string }>(
      'SELECT password_hash, username FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    )
    if (!user) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // An account with no password (OAuth-only, once that exists) cannot prove
    // ownership this way, so it is refused rather than deleted on a weaker
    // check than everybody else's.
    if (!user.password_hash || !await verifyPassword(password, user.password_hash)) {
      await query('INSERT INTO security_logs (user_id, event, ip) VALUES ($1, $2, $3)',
        [userId, 'account_delete_failed', request.ip])
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Password is incorrect' })
    }

    await transaction(async client => {
      // A placeholder derived from the id: stable, unique, and reveals nothing
      // about who the account belonged to.
      const tag = sha256(userId).slice(0, 16)
      await client.query(
        `UPDATE users
            SET email = $2, username = $3, password_hash = NULL, mfa_secret = NULL,
                status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [userId, `deleted+${tag}@invalid`, `deleted_${tag}`]
      )
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
      // Everything that is only ever about this person and useful to nobody
      // else goes with the account.
      await client.query('DELETE FROM user_settings WHERE user_id = $1', [userId])
      await client.query('DELETE FROM password_resets WHERE user_id = $1', [userId])
      await client.query('DELETE FROM ws_tickets WHERE user_id = $1', [userId])
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1::uuid, 'user.deleted', 'user', $1::text, $2::jsonb, '{}'::jsonb)`,
        [userId, JSON.stringify({ username: user.username, reason: 'self-service deletion' })]
      )
    })

    // Outside the transaction: the token version bump is what makes every
    // outstanding access token stop working immediately.
    await revokeTokens(userId)
    await query('INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [userId, 'account_deleted', request.ip, request.headers['user-agent'] ?? null])
    await emitEvent('user.deleted', { username: user.username })

    return reply.code(204).send()
  })

  /**
   * Change a password.
   *
   * The current password is required even though the caller is already
   * authenticated: a stolen access token must not be enough to take ownership
   * of the account, and this is the endpoint that decides that.
   *
   * Every other session dies with the change. That is the point of changing a
   * password — leaving the attacker's session alive would defeat it.
   */
  fastify.post('/password', {
    config: AUTH_LIMIT,
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 8, maxLength: 128 },
          newPassword: { type: 'string', minLength: 8, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body as { currentPassword: string, newPassword: string }

    const user = await queryOne<{ password_hash: string | null }>(
      "SELECT password_hash FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
      [request.user.sub]
    )
    if (!user?.password_hash || !await verifyPassword(currentPassword, user.password_hash)) {
      await query('INSERT INTO security_logs (user_id, event, ip) VALUES ($1, $2, $3)',
        [request.user.sub, 'password_change_failed', request.ip])
      return reply.code(403).send({
        type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Current password is incorrect'
      })
    }
    if (newPassword === currentPassword) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400, detail: 'The new password must differ from the current one'
      })
    }

    await applyNewPassword(request.user.sub, newPassword, request.ip, 'password_changed')

    // The caller keeps working: they just proved they own the account, and
    // signing them out of the device they are typing on is hostile.
    const tokens = await issueTokens(
      { id: request.user.sub, username: request.user.username },
      request.ip, request.headers['user-agent']
    )
    return reply.send(tokens)
  })

  /**
   * Ask for a reset link.
   *
   * Always answers 204, whether or not the address exists. Anything else is an
   * account enumeration oracle, and this endpoint is unauthenticated by
   * necessity.
   *
   * **Delivery is the operator's.** This platform has no mail sender, and
   * adding one would be a dependency and a deployment surface for a single
   * feature. The token is emitted as an `auth.password_reset` event instead,
   * which the existing webhook system already delivers — an operator points it
   * at whatever they send mail with. Until they do, the flow is complete and
   * inert, which is the honest state for it to be in rather than a half-built
   * SMTP client nobody configured.
   */
  fastify.post('/forgot', {
    config: AUTH_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['identifier'],
        properties: { identifier: { type: 'string', minLength: 3, maxLength: 254 } }
      }
    }
  }, async (request, reply) => {
    const { identifier } = request.body as { identifier: string }

    const user = await queryOne<{ id: string, email: string, username: string }>(
      "SELECT id, email, username FROM users WHERE (email = $1 OR username = $1) AND status = 'active' AND deleted_at IS NULL",
      [identifier]
    )

    if (user) {
      // Supersede any outstanding request: a second click must not leave the
      // first token usable, or a stolen older email still opens the account.
      await query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id])

      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + RESET_TTL_MS)
      await query(
        'INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at) VALUES ($1, $2, $3, $4)',
        [user.id, sha256(token), request.ip, expiresAt]
      )
      await query('INSERT INTO security_logs (user_id, event, ip) VALUES ($1, $2, $3)',
        [user.id, 'password_reset_requested', request.ip])

      // The token goes to the operator's endpoint only — never through the
      // admin-managed webhook fan-out, which has a Discord formatter and would
      // render a live account credential into a chat channel. See
      // lib/reset-delivery.ts.
      await deliverReset(
        { email: user.email, username: user.username, token, expiresAt: expiresAt.toISOString() },
        (message, error) => { request.log.warn({ err: error }, message) }
      )
      // What the general webhooks DO get: that it happened, and to whom. No
      // token, so a subscriber cannot take over the account with it.
      await emitEvent('user.password_reset_requested', { username: user.username })
    }

    return reply.code(204).send()
  })

  /**
   * Consume a reset token and set a new password.
   *
   * Single use, time-limited, and marked used inside the same transaction that
   * writes the password — two requests arriving together must not both
   * succeed.
   */
  fastify.post('/reset', {
    config: AUTH_LIMIT,
    schema: {
      body: {
        type: 'object',
        required: ['token', 'newPassword'],
        properties: {
          token: { type: 'string', minLength: 20, maxLength: 200 },
          newPassword: { type: 'string', minLength: 8, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const { token, newPassword } = request.body as { token: string, newPassword: string }

    const claimed = await queryOne<{ user_id: string }>(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(token)]
    )
    if (!claimed) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'That reset link is invalid, already used, or expired — request a new one'
      })
    }

    await applyNewPassword(claimed.user_id, newPassword, request.ip, 'password_reset')
    return reply.code(204).send()
  })

  /**
   * Exchange the access token for a single-use WebSocket ticket.
   *
   * The socket used to be opened as /ws?token=<access token>, which wrote a
   * live credential into every reverse-proxy access log and the browser's
   * history. A ticket is worth nothing once used, expires in under a minute,
   * and is the only thing that ends up in those logs.
   */
  fastify.post('/ws-ticket', { preHandler: fastify.authenticate }, async request => {
    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 30_000)
    await query(
      'INSERT INTO ws_tickets (ticket, user_id, expires_at) VALUES ($1, $2, $3)',
      [sha256(ticket), request.user.sub, expiresAt]
    )
    return { ticket, expiresAt: expiresAt.toISOString() }
  })
}

export default routes
