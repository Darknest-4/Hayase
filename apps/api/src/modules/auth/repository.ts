// Every statement the authentication module runs, in one place.
//
// The routes file was 618 lines with 34 inline queries, and the same
// `INSERT INTO security_logs …` written out eight times — which is how a ninth
// path gets added next month with the user_agent column quietly missing. More
// than the duplication, though, the problem was that "what does signing in
// touch" could only be answered by reading a route handler top to bottom,
// interleaved with rate-limit config, JSON schemas and reply shapes.
//
// So the SQL lives here and the handlers read as what they are: a decision
// about a request. That split is also what makes the security-relevant parts
// legible — every session revocation in the system is now four methods on one
// type, and the difference between them is a paragraph rather than a grep.
//
// It is deliberately not an ORM. The queries are the same queries; they just
// have names and one home.

import { Repository } from '@yume/database'

import { db } from '../../infrastructure/database/index.ts'

import type pg from 'pg'

export interface AccountRow {
  id: string
  username: string
  password_hash: string | null
  status: string
  token_version?: number
}

export interface NewAccount {
  email: string
  username: string
  passwordHash: string
  ip: string
  userAgent: string | null
}

export interface CreatedAccount {
  id: string
  username: string
  /** True when this account was handed the instance by the bootstrap below. */
  promoted: boolean
}

export class AuthRepository extends Repository {
  // ------------------------------------------------------------- accounts

  /** The row a login needs, by email or username. Deleted accounts excluded. */
  byIdentifier (identifier: string): Promise<AccountRow | undefined> {
    return this.queryOne<AccountRow>(
      `SELECT id, username, password_hash, status, token_version
         FROM users
        WHERE (email = $1 OR username = $1) AND deleted_at IS NULL`,
      [identifier]
    )
  }

  /** The row a reset request needs: active accounts only, with the address. */
  activeByIdentifier (identifier: string): Promise<{ id: string, email: string, username: string } | undefined> {
    return this.queryOne(
      `SELECT id, email, username
         FROM users
        WHERE (email = $1 OR username = $1) AND status = 'active' AND deleted_at IS NULL`,
      [identifier]
    )
  }

  /** Credentials for a self-service delete: the account need only exist. */
  credentialsOf (userId: string): Promise<{ password_hash: string | null, username: string } | undefined> {
    return this.queryOne(
      'SELECT password_hash, username FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    )
  }

  /** Credentials for a password change: the account must be usable. */
  activeCredentialsOf (userId: string): Promise<{ password_hash: string | null } | undefined> {
    return this.queryOne(
      "SELECT password_hash FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
      [userId]
    )
  }

  async identifierTaken (email: string, username: string): Promise<boolean> {
    return Boolean(await this.queryOne('SELECT 1 FROM users WHERE email = $1 OR username = $2', [email, username]))
  }

  async accountCount (): Promise<number> {
    const row = await this.queryOne<{ total: number }>('SELECT count(*)::int AS total FROM users')
    return Number(row?.total ?? 0)
  }

  markLoggedIn (userId: string): Promise<unknown> {
    return this.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId])
  }

  async tokenVersion (userId: string): Promise<number> {
    const row = await this.queryOne<{ token_version: number }>(
      'SELECT token_version FROM users WHERE id = $1', [userId])
    return row?.token_version ?? 0
  }

  /**
   * Create an account, its default role and profile — and, on an instance that
   * has no administrator, make it one.
   *
   * The bootstrap condition is "no administrator exists", not "this is the
   * first user". Those differ in exactly the case that matters: once anybody
   * holds the role this path is dead, so it cannot hand out a second one later
   * — after a purge of the users table, say.
   *
   * The advisory lock is what makes it safe under concurrency. Without it two
   * registrations arriving together would both see no admin under READ
   * COMMITTED and both be promoted. It is taken before the check and released
   * with the transaction, so the second waits and then finds the admin the
   * first created.
   */
  create (account: NewAccount): Promise<CreatedAccount> {
    return this.transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [account.email, account.username, account.passwordHash]
      )
      const userId = rows[0]!.id

      await client.query(
        "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'user'",
        [userId]
      )
      await client.query(
        'INSERT INTO user_profiles (user_id, display_name, is_default) VALUES ($1, $2, true)',
        [userId, account.username]
      )
      await client.query(
        'INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
        [userId, 'register', account.ip, account.userAgent]
      )

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
        /*
         * No catalogue is written into this account.
         *
         * It used to be: the bootstrap queued the founder job, which marked
         * every episode of every title watched, unlocked every achievement and
         * awarded the XP that follows. That is invented history, and it went
         * into the same tables the statistics, the leaderboard and the
         * analytics read — in production, 364,065 of the watch-progress rows
         * belonged to two profiles. Filling an account like that is now an
         * explicit operator action (`npm run seed:founder`, or the `founder`
         * compose profile), never a side effect of registering.
         */

        // Becoming an administrator is the single most consequential thing
        // that can happen to an account, and it happens here without anyone
        // approving it. It is recorded in both places somebody would look.
        await client.query(
          'INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
          [userId, 'admin_bootstrap', account.ip, account.userAgent]
        )
        await client.query(
          // actor_id is uuid and subject_id is text, so the same parameter has
          // to be cast for each — without it Postgres deduces two types for $1
          // and refuses to plan the statement.
          `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
           VALUES ($1::uuid, 'user.role.bootstrap', 'user', $1::text, '{}'::jsonb, $2::jsonb)`,
          [userId, JSON.stringify({ role: 'admin', reason: 'first account on an instance with no administrator' })]
        )
      }

      return { id: userId, username: account.username, promoted: promoted.length > 0 }
    })
  }

  /**
   * Erase the identifying part of an account and end every session it holds.
   *
   * Soft delete, and the reasons are not squeamishness: moderation history has
   * to survive a deletion, and content the person wrote is other people's
   * context. What is actually erased is the email, the username and the
   * password hash — the address cannot be recovered from the row afterwards,
   * and both identifiers are freed for reuse.
   */
  softDelete (userId: string, tag: string, username: string): Promise<void> {
    return this.transaction(async (client: pg.PoolClient) => {
      await client.query(
        `UPDATE users
            SET email = $2, username = $3, password_hash = NULL, mfa_secret = NULL,
                status = 'deleted', deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [userId, `deleted+${tag}@invalid`, `deleted_${tag}`]
      )
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
      // Everything that is only ever about this person, and useful to nobody
      // else, goes with the account.
      //
      // user_settings hangs off the profile, not the user: an account can hold
      // several profiles and the settings are per profile. This asked for a
      // user_id column that has never existed on that table, so the statement
      // raised 42703, the transaction rolled back, and self-service deletion
      // answered 500 for everybody — nothing was erased and no session was
      // ended. It failed closed, which is the one mercy in it.
      await client.query(
        'DELETE FROM user_settings WHERE profile_id IN (SELECT id FROM user_profiles WHERE user_id = $1)',
        [userId]
      )
      await client.query('DELETE FROM password_resets WHERE user_id = $1', [userId])
      await client.query('DELETE FROM ws_tickets WHERE user_id = $1', [userId])
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1::uuid, 'user.deleted', 'user', $1::text, $2::jsonb, '{}'::jsonb)`,
        [userId, JSON.stringify({ username, reason: 'self-service deletion' })]
      )
    })
  }

  /**
   * Write a new password and end every session at once.
   *
   * One statement pair in one transaction because both callers — a deliberate
   * change and a reset — mean the same thing by it: whoever else was holding
   * this account is now out. Splitting them is how a reset path quietly
   * forgets the revocation.
   */
  /**
   * Write a new password and end every session.
   *
   * `expectedHash` makes the write a COMPARE-AND-SWAP, and that is the point.
   * The deliberate-change path reads the stored hash, verifies the submitted
   * current password against it, and only then writes — three steps with no
   * lock between them. Two changes racing therefore both passed the check and
   * both wrote, and the later write won. Measured: three parallel changes, all
   * three answered 200.
   *
   * That is not only untidy. Somebody who knows the old password — the exact
   * person a password change exists to lock out — can have their write land
   * *after* the owner's, and the account ends up on the password they chose,
   * although by then the old one was no longer current. Requiring the hash to
   * be unchanged turns the second writer into a plain 403: the password you
   * checked against is not the password that is stored.
   *
   * The reset path passes no `expectedHash`, because there is no current
   * password to compare — the single-use token is what proves the claim, and
   * it is consumed atomically on its own.
   *
   * Returns false when nothing was written, i.e. the hash moved underneath us.
   */
  setPassword (userId: string, passwordHash: string, expectedHash?: string): Promise<boolean> {
    return this.transaction(async (client: pg.PoolClient) => {
      const written = await client.query(
        `UPDATE users SET password_hash = $2
          WHERE id = $1 AND ($3::text IS NULL OR password_hash = $3)`,
        [userId, passwordHash, expectedHash ?? null]
      )
      if (!written.rowCount) return false
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])
      return true
    })
  }

  // ------------------------------------------------------------- sessions

  /** Returns undefined when the insert did not happen — the caller must refuse to mint a token. */
  openSession (session: {
    userId: string, refreshHash: string, ip: string | null, userAgent: string | null, expiresAt: Date
    /** Melyik eszközről. Lásd `rememberDevice` — a `devices` sor azonosítója. */
    deviceId?: string | null | undefined
    /** The sign-in this refresh chain began with; `now()` for a sign-in itself. */
    startedAt?: Date | null | undefined
  }): Promise<{ id: string } | undefined> {
    return this.queryOne<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at, device_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, now())) RETURNING id`,
      [session.userId, session.refreshHash, session.ip, session.userAgent, session.expiresAt,
        session.deviceId ?? null, session.startedAt ?? null]
    )
  }

  /**
   * Az eszköz, amiről ez a munkamenet indult.
   *
   * A `devices` tábla a legelső migráció óta létezik, a `sessions.device_id`
   * idegen kulccsal hivatkozik rá — és soha nem írt bele senki. Emiatt a
   * „milyen eszközeim vannak bejelentkezve" kérdésre a felület sem tudott
   * válaszolni, pedig a séma előkészítette.
   *
   * Amit eszköznek tekintünk: PLATFORM + NÉV, nem ujjlenyomat. Ugyanarról a
   * gépről ugyanabból a böngészőből egy sor lesz, két különböző böngészőből
   * kettő — és ennél pontosabbat szándékosan nem akarunk tudni. Egy valódi
   * eszköz-ujjlenyomat követésre alkalmas, és ehhez a kérdéshez
   * („ismerős-e ez a gép") nem kell.
   */
  async rememberDevice (userId: string, platform: string, name: string | null): Promise<string | undefined> {
    const row = await this.queryOne<{ id: string }>(
      `WITH existing AS (
         UPDATE devices SET last_seen_at = now()
          WHERE user_id = $1 AND platform = $2 AND name IS NOT DISTINCT FROM $3
          RETURNING id
       ), created AS (
         INSERT INTO devices (user_id, platform, name)
         SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING id
       )
       SELECT id FROM existing UNION ALL SELECT id FROM created LIMIT 1`,
      [userId, platform, name]
    )
    return row?.id
  }

  /**
   * Trade a refresh token for its session, once.
   *
   * One statement: the session is claimed and retired together, so two
   * requests presenting the same token cannot both get a new session — which
   * the previous look-up-then-revoke pair allowed, leaving two live sessions
   * behind one token. Only an active account's session is claimed.
   */
  rotateSession (refreshHash: string): Promise<{ id: string, user_id: string, username: string, started_at: Date } | undefined> {
    return this.queryOne(
      `UPDATE sessions s SET revoked_at = now(), rotated_at = now()
         FROM users u
        WHERE s.refresh_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL
        RETURNING s.id, s.user_id, u.username, s.started_at`,
      [refreshHash]
    )
  }

  /** The session a refresh token WAS for, if a refresh already retired it. */
  rotatedSession (refreshHash: string): Promise<{ user_id: string, rotated_at: Date } | undefined> {
    return this.queryOne(
      'SELECT user_id, rotated_at FROM sessions WHERE refresh_hash = $1 AND rotated_at IS NOT NULL',
      [refreshHash]
    )
  }

  /** Sign out of one device. Scoped to the owner so a stolen id revokes nothing. */
  revokeOwnSession (sessionId: string, userId: string): Promise<unknown> {
    return this.query(
      'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [sessionId, userId]
    )
  }

  /** For a client handing back a refresh token from a different session. */
  revokeSessionByRefreshHash (refreshHash: string, userId: string): Promise<unknown> {
    return this.query(
      'UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND user_id = $2',
      [refreshHash, userId]
    )
  }

  /** Sign out everywhere. The token_version bump belongs to the caller. */
  revokeAllSessions (userId: string): Promise<unknown> {
    return this.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    )
  }

  // --------------------------------------------------------------- resets

  /**
   * Retire every outstanding reset for the account and open a new one — as
   * one locked unit. A second click must not leave the first token usable,
   * and two requests arriving together must not each retire the other's
   * predecessor and leave two usable tokens behind.
   */
  replaceReset (reset: { userId: string, tokenHash: string, ip: string, expiresAt: Date }): Promise<void> {
    return this.transaction(async (client: pg.PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`password-reset:${reset.userId}`])
      await client.query(
        'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.userId])
      await client.query(
        'INSERT INTO password_resets (user_id, token_hash, requested_ip, expires_at) VALUES ($1, $2, $3, $4)',
        [reset.userId, reset.tokenHash, reset.ip, reset.expiresAt])
    })
  }

  /**
   * Claim a reset token, single use.
   *
   * The UPDATE … RETURNING is the claim: two requests arriving together cannot
   * both come back with a row, so the second is refused rather than both
   * setting a password.
   */
  claimReset (tokenHash: string): Promise<{ user_id: string } | undefined> {
    return this.queryOne<{ user_id: string }>(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [tokenHash]
    )
  }

  // ---------------------------------------------------------------- other

  async permissionsOf (userId: string): Promise<string[]> {
    const rows = await this.query<{ slug: string }>(
      `SELECT DISTINCT p.slug
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1`,
      [userId]
    )
    return rows.map(row => row.slug)
  }

  openWsTicket (ticket: {
    hash: string, userId: string, expiresAt: Date, sessionId: string | null, tokenVersion: number | null
  }): Promise<unknown> {
    return this.query(
      'INSERT INTO ws_tickets (ticket, user_id, expires_at, session_id, token_version) VALUES ($1, $2, $3, $4, $5)',
      [ticket.hash, ticket.userId, ticket.expiresAt, ticket.sessionId, ticket.tokenVersion]
    )
  }


  /**
   * The security log.
   *
   * One method rather than the eight hand-written copies of this INSERT that
   * were spread through the routes — three of which omitted the user agent,
   * for no reason anybody recorded. `userId` is nullable because a failed
   * login against an address that does not exist still belongs in the log.
   */
  log (userId: string | null, event: string, ip: string, userAgent: string | null = null): Promise<unknown> {
    return this.query(
      'INSERT INTO security_logs (user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4)',
      [userId, event, ip, userAgent]
    )
  }
}

export const authRepository = new AuthRepository(db)
