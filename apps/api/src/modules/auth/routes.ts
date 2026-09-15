// /v1/auth — register, login, refresh, logout, password change and recovery.
//
// Access tokens: JWT (15 min), bound to the session they were minted under.
// Refresh tokens: 256-bit random, stored as sha256 in sessions, rotated on
// every refresh. Reset tokens: 256-bit random, stored as sha256, single use.
//
// No SQL below this line. Every statement is a named method on
// AuthRepository (./repository.ts), which is what makes the security-relevant
// parts of this file legible: a handler here is a decision about a request,
// and what that decision touches in the database has a name.

import { createHash, randomBytes } from 'node:crypto'
import { fromRequest, recordAccountEvent } from '../analytics/account-events.ts'
import { shapeOf } from '../analytics/visitor.ts'

import { config } from '../../config.ts'
import { AUTH_LIMIT, REFRESH_LIMIT } from '../../middleware/security.ts'
import { invalidateSession, revokeTokens } from '../../middleware/auth.ts'
import { onUniqueViolation } from '@yume/database'
import { authRepository as accounts } from './repository.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { deliverReset } from './reset-delivery.ts'
import { settings as siteSettings } from '../settings/site-settings.ts'
import { emitEvent } from '../webhooks/delivery.ts'

import type { FastifyPluginAsync, FastifyReply } from 'fastify'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * A real scrypt hash of a random secret, used to equalise login timing for
 * unknown accounts. Computed once at startup; it can never match a submitted
 * password because the input is never revealed.
 */
const DECOY_HASH = await hashPassword(randomBytes(32).toString('base64url'))

/** How long a reset link stays usable. Short: it is a full account credential. */
const RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_MS ?? 3_600_000)

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
  await accounts.setPassword(userId, await hashPassword(newPassword))
  await revokeTokens(userId)
  await accounts.log(userId, event, ip)
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
  /**
   * Where the refresh token lives now.
   *
   * It used to be handed to the client in the response body and kept in
   * localStorage, which meant a credential good for thirty days was readable
   * by any script running on the origin. `HttpOnly` takes that away: an
   * injected script can still *use* the session while the page is open —
   * the browser attaches the cookie to its own fetches — but it can no longer
   * copy the token out and keep the account for a month from somewhere else.
   * Losing persistence is most of the damage.
   *
   * `Path` scopes it to the two routes that read it, so it is not sent with
   * every catalogue image request. `SameSite=Strict` because nothing
   * cross-site ever needs to refresh a session, and `Secure` outside
   * development because a cookie without it is sent in clear over http.
   */
  const REFRESH_COOKIE = 'yume_refresh'
  const refreshCookieOptions = {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict' as const,
    path: '/v1/auth',
    maxAge: config.refreshTokenTtlDays * 86_400
  }

  /**
   * A `devices.platform` oszlop hét értéket enged meg (CHECK), és a
   * böngészőazonosítóból kiolvasott oprendszernevek nem ezek. A leképezés
   * itt áll, egy helyen — a 'web' az, ami mindig igaz, ha nem tudunk jobbat.
   */
  const DEVICE_PLATFORMS: Record<string, string> = {
    Windows: 'windows', macOS: 'macos', Linux: 'linux', ChromeOS: 'linux',
    Android: 'android', iOS: 'ios', iPadOS: 'ios'
  }

  async function issueTokens (
    user: { id: string, username: string, token_version?: number },
    reply: FastifyReply,
    ip?: string,
    userAgent?: string
  ) {
    const refreshToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000)

    /*
     * Melyik eszközről.
     *
     * A `devices` tábla és a `sessions.device_id` idegen kulcs az első
     * migráció óta megvan, és soha nem írt bele senki — ezért a „milyen
     * eszközeim vannak bejelentkezve" kérdésre a felület sem tudott
     * válaszolni, pedig a séma előkészítette.
     *
     * A böngészőazonosítóból két dolgot veszünk ki: a platformot és egy
     * emberi nevet („Chrome Windowson"). Se többet, se pontosabbat: egy valódi
     * eszköz-ujjlenyomat követésre alkalmas, és ehhez a kérdéshez nem kell.
     *
     * Legjobb szándék szerint: ha ez elhasal, a belépés attól még megtörténik.
     */
    let deviceId: string | undefined
    try {
      const shape = shapeOf(userAgent)
      const platform = DEVICE_PLATFORMS[shape.os] ?? 'web'
      deviceId = await accounts.rememberDevice(
        user.id, platform, shape.browser === 'ismeretlen' ? null : `${shape.browser} · ${shape.os}`)
    } catch (error) {
      fastify.log.warn({ err: error }, 'device fingerprint failed; the session is created without one')
    }

    const session = await accounts.openSession({
      userId: user.id,
      refreshHash: sha256(refreshToken),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      expiresAt,
      deviceId
    })
    // An INSERT … RETURNING that comes back empty means the write did not
    // happen. Minting a token for a session that does not exist would produce
    // a credential nothing can revoke, so this fails instead.
    if (!session) throw new Error('failed to create session')

    const version = user.token_version ?? await accounts.tokenVersion(user.id)
    const accessToken = fastify.jwt.sign({ sub: user.id, username: user.username, tv: version, sid: session.id })

    reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions)

    /*
     * The token is still in the body, and that is deliberate for now.
     *
     * A deploy must not sign everybody out. A client loaded before this change
     * has the old code, stores what it is given and sends it back in the body;
     * one loaded after ignores the field and relies on the cookie. Both work
     * against this server, which is what makes the change rollable rather than
     * a flag day.
     *
     * It costs nothing today — the current client no longer writes it down, so
     * the value is transient — and the field comes out once no client that
     * reads it can still be running. See docs/security/refresh-cookie.md.
     */
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

    if (await accounts.identifierTaken(email, username)) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Email or username already in use' })
    }

    const passwordHash = await hashPassword(password)

    // The check above is a courtesy, not a guarantee: two registrations racing
    // each other both pass it, and the unique index is what actually decides.
    // onUniqueViolation turns the loser into the same 409 the sequential path
    // gives — see packages/database/src/errors.ts for why this is a shared
    // helper and not a fifth hand-written try/catch.
    const created = await onUniqueViolation(
      async () => accounts.create({
        email, username, passwordHash, ip: request.ip, userAgent: request.headers['user-agent'] ?? null
      }),
      () => undefined
    )
    if (!created) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Email or username already in use' })
    }
    if (created.promoted) {
      request.log.warn({ userId: created.id, username }, 'first account promoted to administrator (no admin existed)')
    }
    const user = created

    // How many accounts exist now, and whether this one was handed the
    // instance. A bare username told a receiver nothing it could act on: the
    // hundredth signup and the very first one — which the bootstrap makes an
    // administrator — looked identical.
    await emitEvent('user.registered', {
      username: user.username,
      userId: user.id,
      totalUsers: await accounts.accountCount(),
      promotedToAdmin: user.promoted,
      registeredAt: new Date().toISOString()
    })
    // A fiók saját előzménye. A `security_logs` sora már megvan (a
    // tárolóban, IP-vel); ez a másik oldal: az, amit a fióknak magának is meg
    // lehet mutatni, és aminek hivatkozási száma van — REG_000001.
    await recordAccountEvent('REG', {
      userId: user.id,
      ...fromRequest(request),
      metadata: { username: user.username, promotedToAdmin: user.promoted }
    })

    const tokens = await issueTokens(user, reply, request.ip, request.headers['user-agent'])
    return reply.code(201).send(tokens)
  })

  fastify.post('/login', { config: AUTH_LIMIT, schema: { body: credentialsSchema } }, async (request, reply) => {
    const { identifier, password } = request.body as { identifier: string, password: string }

    const user = await accounts.byIdentifier(identifier)

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
      await accounts.log(user?.id ?? null, 'login_failed', request.ip)
      // A megadott azonosítót NEM írjuk bele: egy nem létező fióknál az
      // nem a fiók előzménye, hanem egy idegen által begépelt szöveg —
      // adhat e-mail-címet, jelszót elgépelve, bármit.
      await recordAccountEvent('LOGIN_FAILED', {
        userId: user?.id ?? null,
        result: 'failed',
        ...fromRequest(request),
        metadata: { reason: user ? 'bad_password' : 'no_such_account' }
      })
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid credentials' })
    }
    if (user.status !== 'active') {
      await recordAccountEvent('LOGIN', {
        userId: user.id, result: 'blocked', ...fromRequest(request), metadata: { status: user.status }
      })
      return reply.code(403).send({ type: 'about:blank', title: 'Forbidden', status: 403, detail: `Account ${user.status}` })
    }

    await accounts.markLoggedIn(user.id)
    await accounts.log(user.id, 'login', request.ip, request.headers['user-agent'] ?? null)
    await recordAccountEvent('LOGIN', { userId: user.id, ...fromRequest(request) })

    return issueTokens(user, reply, request.ip, request.headers['user-agent'])
  })

  /**
   * Cookie first, body second.
   *
   * The cookie is where the token lives now and the body is the compatibility
   * path — a client loaded before the change still sends it there, and one
   * loaded after sends nothing at all. Which is also why `refreshToken` is no
   * longer required by the schema: a request carrying only the cookie has an
   * empty body, and rejecting it at validation would refuse exactly the
   * clients this is for.
   */
  fastify.post('/refresh', {
    config: REFRESH_LIMIT,
    schema: {
      body: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } }
      }
    }
  }, async (request, reply) => {
    const fromBody = (request.body as { refreshToken?: string } | null)?.refreshToken
    const refreshToken = request.cookies[REFRESH_COOKIE] ?? fromBody
    if (!refreshToken) {
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'No refresh token' })
    }

    const session = await accounts.sessionByRefreshHash(sha256(refreshToken))
    if (!session) {
      // The cookie names a session that no longer exists — revoked, expired,
      // or from a database this browser has outlived. Clearing it stops the
      // client retrying with it on every load for the next thirty days.
      reply.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path })
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Invalid refresh token' })
    }

    // rotation: revoke the used session, issue a fresh one
    await accounts.revokeSession(session.id)
    return issueTokens({ id: session.user_id, username: session.username }, reply, request.ip, request.headers['user-agent'])
  })

  // the client uses this to decide whether to show moderation/admin UI
  fastify.get('/permissions', { preHandler: fastify.authenticate }, async request => {
    return { permissions: await accounts.permissionsOf(request.user.sub) }
  })

  /**
   * Sign out of this device.
   *
   * The session named by the access token is revoked whether or not the client
   * sends its refresh token, because the access token is what the caller is
   * holding right now. Revoking only the refresh token — which is all this
   * used to do — left the access token working for the rest of its 15 minutes.
   */
  /**
   * The body is optional and always has been — a client may hand back a
   * refresh token from another session, or none at all — but "optional" and
   * "unvalidated" are different things, and these were the only two write
   * routes in the API reading `request.body` without a schema. Declaring it
   * costs nothing and closes the one gap in otherwise complete coverage.
   */
  const logoutBody = {
    type: 'object',
    additionalProperties: false,
    properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 512 } }
  }

  fastify.post('/logout', { preHandler: fastify.authenticate, schema: { body: logoutBody } }, async (request, reply) => {
    const { refreshToken } = (request.body ?? {}) as { refreshToken?: string }
    const sid = request.user.sid

    if (sid) {
      await accounts.revokeOwnSession(sid, request.user.sub)
      invalidateSession(request.user.sub, sid)
    }
    // A client may also hand back a refresh token from a different session —
    // and a token minted before session binding existed has no sid at all. The
    // cookie is checked for the same reason, and is the usual case now.
    const alsoRevoke = request.cookies[REFRESH_COOKIE] ?? refreshToken
    if (alsoRevoke) {
      await accounts.revokeSessionByRefreshHash(sha256(alsoRevoke), request.user.sub)
    }
    // Signing out has to take the credential away, not only the row it points
    // at: a cookie left behind is a thirty-day token in the browser of
    // somebody who just asked to be signed out.
    await recordAccountEvent('LOGOUT', {
      userId: request.user.sub, sessionId: sid ?? null, ...fromRequest(request)
    })
    reply.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path })
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
  // Törzsséma nélkül, szándékosan: ez az útvonal nem olvas törzset. A
  // deklarált séma azt jelentette, hogy egy törzs *nélküli* POST 400-at kapott
  // („body must be object") — pont ez a hívás pedig az, amit valaki akkor
  // keres, amikor úgy érzi, feltörték a fiókját, és nyers curl-lel vagy egy
  // másik klienssel próbálja. A `{}` megkövetelése ott csapda, nem védelem.
  fastify.post('/logout-all', { preHandler: fastify.authenticate }, async (request, reply) => {
    await accounts.revokeAllSessions(request.user.sub)
    await revokeTokens(request.user.sub)
    await accounts.log(request.user.sub, 'logout_all', request.ip, request.headers['user-agent'] ?? null)
    await recordAccountEvent('SESSIONS_REVOKED_ALL', { userId: request.user.sub, ...fromRequest(request) })
    reply.clearCookie(REFRESH_COOKIE, { path: refreshCookieOptions.path })
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

    const user = await accounts.credentialsOf(userId)
    if (!user) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // An account with no password (OAuth-only, once that exists) cannot prove
    // ownership this way, so it is refused rather than deleted on a weaker
    // check than everybody else's.
    if (!user.password_hash || !await verifyPassword(password, user.password_hash)) {
      await accounts.log(userId, 'account_delete_failed', request.ip)
      return reply.code(401).send({ type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'Password is incorrect' })
    }

    // A placeholder derived from the id: stable, unique, and reveals nothing
    // about who the account belonged to.
    await accounts.softDelete(userId, sha256(userId).slice(0, 16), user.username)

    // Outside the transaction: the token version bump is what makes every
    // outstanding access token stop working immediately.
    await revokeTokens(userId)
    await accounts.log(userId, 'account_deleted', request.ip, request.headers['user-agent'] ?? null)
    // A törlés puha: a fiók sora marad, tehát az előzménye is maradhat — és
    // pont ez az az esemény, amit utólag a leggyakrabban keresnek.
    await recordAccountEvent('ACCOUNT_DELETE', { userId, ...fromRequest(request) })
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

    const user = await accounts.activeCredentialsOf(request.user.sub)
    if (!user?.password_hash || !await verifyPassword(currentPassword, user.password_hash)) {
      await accounts.log(request.user.sub, 'password_change_failed', request.ip)
      await recordAccountEvent('PASSWORD_CHANGE', {
        userId: request.user.sub, result: 'failed', ...fromRequest(request),
        metadata: { reason: 'wrong_current_password' }
      })
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
    await recordAccountEvent('PASSWORD_CHANGE', { userId: request.user.sub, ...fromRequest(request) })

    // The caller keeps working: they just proved they own the account, and
    // signing them out of the device they are typing on is hostile.
    const tokens = await issueTokens(
      { id: request.user.sub, username: request.user.username },
      reply, request.ip, request.headers['user-agent']
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

    const user = await accounts.activeByIdentifier(identifier)

    if (user) {
      // Supersede any outstanding request: a second click must not leave the
      // first token usable, or a stolen older email still opens the account.
      await accounts.supersedeResets(user.id)
      // Csak akkor, ha a fiók létezik. A válasz a hívónak így is ugyanaz
      // (nem áruljuk el, van-e ilyen fiók), de nem létező fióknak nincs
      // előzménye, amibe írni lehetne.
      await recordAccountEvent('PASSWORD_RESET_REQUEST', { userId: user.id, ...fromRequest(request) })

      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + RESET_TTL_MS)
      await accounts.openReset({ userId: user.id, tokenHash: sha256(token), ip: request.ip, expiresAt })
      await accounts.log(user.id, 'password_reset_requested', request.ip)

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

    const claimed = await accounts.claimReset(sha256(token))
    if (!claimed) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'That reset link is invalid, already used, or expired — request a new one'
      })
    }

    await applyNewPassword(claimed.user_id, newPassword, request.ip, 'password_reset')
    await recordAccountEvent('PASSWORD_RESET', { userId: claimed.user_id, ...fromRequest(request) })
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
    await accounts.openWsTicket(sha256(ticket), request.user.sub, expiresAt)
    return { ticket, expiresAt: expiresAt.toISOString() }
  })
}

export default routes
