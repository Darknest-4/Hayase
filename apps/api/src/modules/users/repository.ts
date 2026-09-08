// Every statement the account-administration surface runs.
//
// Three of these methods change what an account is allowed to do, and each is
// a transaction for a reason worth stating rather than rediscovering:
//
//   * **Suspending or banning** revokes the sessions *and* bumps
//     token_version in the same unit. Revoking the refresh token alone left
//     the access token valid until it expired, so a banned account kept
//     working for up to fifteen minutes. Split across two statements outside a
//     transaction, a failure between them leaves exactly that gap.
//   * **A role change** writes the grant and the audit entry together. A
//     promotion that is not in the trail is indistinguishable from one nobody
//     made.
//   * **A forced sign-out** does the same pairing as the ban, and returns the
//     count, because "signed out of 4 devices" is the only part an operator
//     can check afterwards.
//
// Deliberately absent from the reads: IP addresses and user agents. `sessions`
// and `security_logs` hold both, and an operator deciding on a ban does not
// need them — counts and timestamps answer the same questions without putting
// a person's location on a screen. If a case genuinely needs them it should be
// its own permission, not a field that leaks into this one.

import { Repository } from '@yume/database'

import { db } from '../../infrastructure/database/index.ts'

import type pg from 'pg'

export interface StatusChange {
  userId: string
  status: string
  previousStatus: string
  reason: string
  actorId: string
}

export class UserRepository extends Repository {
  /**
   * How the list may be ordered.
   *
   * A fixed map, never the caller's string: the sort key reaches SQL as an
   * identifier and cannot be parameterised, so anything else here is an
   * injection. `newest` is the default and is typed as always present —
   * previously the fallback was itself optional and, being interpolated into a
   * template literal, an undefined one would have produced `ORDER BY
   * undefined` rather than a type error.
   */
  static readonly ORDER = {
    newest: 'u.created_at DESC',
    oldest: 'u.created_at ASC',
    active: 'u.last_login_at DESC NULLS LAST',
    name: 'u.username ASC'
  } as const

  static orderBy (sort: string | undefined): string {
    return UserRepository.ORDER[(sort ?? 'newest') as keyof typeof UserRepository.ORDER]
      ?? UserRepository.ORDER.newest
  }

  /** The WHERE fragment for "holds this role", given the parameter it is bound to. */
  static roleFilter (parameter: number): string {
    return `EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id
                     WHERE ur2.user_id = u.id AND r2.slug = $${parameter})`
  }

  // ------------------------------------------------------------- the list

  /** Counted before the page is cut, so a screen can say "50 of 812". */
  totals (filter: string, params: unknown[]): Promise<{ total: number, active: number, suspended: number, banned: number } | undefined> {
    return this.queryOne<{ total: number, active: number, suspended: number, banned: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE u.status = 'active')::int AS active,
              count(*) FILTER (WHERE u.status = 'suspended')::int AS suspended,
              count(*) FILTER (WHERE u.status = 'banned')::int AS banned
         FROM users u ${filter}`,
      params
    )
  }

  /**
   * One page of accounts, with the counts that make a name triageable.
   *
   * Each per-row count is an index lookup on a column the table is already
   * indexed by. They are what turns a list of names into something an operator
   * can act on: an account with no library and one comment is a different
   * problem from one with four hundred.
   */
  list (filter: string, order: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return this.query(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.last_login_at,
              u.email_verified_at,
              coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{}') AS roles,
              (SELECT count(*)::int FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
              (SELECT count(*)::int FROM comments c WHERE c.author_id = u.id) AS comments,
              (SELECT count(*)::int FROM reports rp WHERE rp.subject_type = 'user' AND rp.subject_id = u.id) AS reports_against
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       ${filter}
       GROUP BY u.id
       ORDER BY ${order}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  }

  // ------------------------------------------------------------ one account

  account (id: string): Promise<Record<string, unknown> | undefined> {
    return this.queryOne(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.updated_at,
              u.last_login_at, u.email_verified_at, u.deleted_at, u.token_version,
              (u.password_hash IS NOT NULL) AS has_password,
              (u.mfa_secret IS NOT NULL) AS mfa_enabled
         FROM users u WHERE u.id = $1`,
      [id]
    )
  }

  usernameOf (id: string): Promise<{ username: string } | undefined> {
    return this.queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [id])
  }

  identityOf (id: string): Promise<{ username: string, created_at: Date } | undefined> {
    return this.queryOne<{ username: string, created_at: Date }>(
      'SELECT username, created_at FROM users WHERE id = $1', [id])
  }

  statusOf (id: string): Promise<{ status: string } | undefined> {
    return this.queryOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])
  }

  /**
   * The eight small reads the account panel needs, run together.
   *
   * The screen is one request and should cost one round trip's worth of
   * latency, not nine — each of these is an indexed lookup, and Promise.all is
   * the whole optimisation.
   */
  panel (id: string): Promise<[
    Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>,
    Record<string, unknown> | undefined, Array<Record<string, unknown>>, Array<Record<string, unknown>>,
    Array<Record<string, unknown>>, Record<string, unknown> | undefined
  ]> {
    return Promise.all([
      this.query(
        `SELECT r.id, r.slug, r.name, ur.granted_at
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 ORDER BY r.slug`, [id]),
      this.query('SELECT id, slug, name FROM roles ORDER BY slug'),
      this.query(
        `SELECT p.id, p.display_name, p.is_default, p.created_at,
                (SELECT count(*)::int FROM library_entries le WHERE le.profile_id = p.id) AS library_entries,
                (SELECT count(*)::int FROM reviews rv WHERE rv.profile_id = p.id) AS reviews
           FROM user_profiles p WHERE p.user_id = $1 ORDER BY p.created_at`, [id]),
      this.queryOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active,
                max(created_at) AS newest,
                count(DISTINCT device_id) FILTER (WHERE device_id IS NOT NULL)::int AS devices
           FROM sessions WHERE user_id = $1`, [id]),
      this.query(
        `SELECT m.action, m.reason, m.created_at, mu.username AS moderator
           FROM moderation_actions m
           LEFT JOIN users mu ON mu.id = m.moderator_id
          WHERE m.subject_type = 'user' AND m.subject_id = $1
          ORDER BY m.created_at DESC LIMIT 20`, [id]),
      this.query(
        `SELECT event, count(*)::int AS n, max(created_at) AS last_at
           FROM security_logs WHERE user_id = $1
          GROUP BY event ORDER BY max(created_at) DESC`, [id]),
      this.query(
        `SELECT a.action, a.before, a.after, a.created_at, au.username AS actor
           FROM audit_logs a
           LEFT JOIN users au ON au.id = a.actor_id
          WHERE a.subject_type = 'user' AND a.subject_id = $1
          ORDER BY a.created_at DESC LIMIT 20`, [id]),
      this.queryOne(
        `SELECT
           (SELECT count(*)::int FROM comments c WHERE c.author_id = $1) AS comments,
           (SELECT count(*)::int FROM reports r WHERE r.reporter_id = $1) AS reports_filed,
           (SELECT count(*)::int FROM reports r WHERE r.subject_type = 'user' AND r.subject_id = $1) AS reports_against,
           (SELECT coalesce(sum(w.watched_sec), 0)::bigint FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1) AS watched_sec,
           (SELECT count(*)::int FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1 AND w.finished) AS episodes_finished,
           (SELECT max(w.started_at) FROM watch_history w
              JOIN user_profiles p ON p.id = w.profile_id WHERE p.user_id = $1) AS last_watched_at`,
        [id])
    ])
  }

  // ------------------------------------------------------------- decisions

  /**
   * Change an account's status, ending its sessions if it is no longer active.
   *
   * Returns how many sessions the decision ended. One transaction: the token
   * version bump has to land with the status change, or the account keeps
   * working on an access token that has already been issued.
   */
  async setStatus (change: StatusChange): Promise<number> {
    return this.transaction(async (client: pg.PoolClient) => {
      await client.query('UPDATE users SET status = $2 WHERE id = $1', [change.userId, change.status])
      let ended = 0
      if (change.status !== 'active') {
        const { rows } = await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
          [change.userId])
        ended = rows.length
        await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [change.userId])
      }
      const action = change.status === 'active' ? 'restore' : change.status === 'banned' ? 'ban' : 'suspend'
      await client.query(
        "INSERT INTO moderation_actions (moderator_id, action, subject_type, subject_id, reason) VALUES ($1, $2, 'user', $3, $4)",
        [change.actorId, action, change.userId, change.reason]
      )
      await client.query(
        "INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after) VALUES ($1, 'user.status', 'user', $2, $3, $4)",
        [change.actorId, change.userId, { status: change.previousStatus }, { status: change.status }]
      )
      return ended
    })
  }

  roleBySlug (slug: string): Promise<{ id: string, slug: string } | undefined> {
    return this.queryOne<{ id: string, slug: string }>(
      'SELECT id, slug FROM roles WHERE slug = $1', [slug])
  }

  /**
   * How many *other* accounts hold the administrator role.
   *
   * Zero means the account being demoted is the last one. The registration
   * bootstrap only fires on an instance with no administrator and every
   * account already exists by then, so an instance that demotes its last one
   * is not recoverable through any screen.
   */
  async otherAdmins (excludingUserId: string): Promise<number> {
    const row = await this.queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.slug = 'admin' AND ur.user_id <> $1`, [excludingUserId])
    return Number(row?.n ?? 0)
  }

  async holdsRole (userId: string, roleId: string): Promise<boolean> {
    const row = await this.queryOne<{ n: number }>(
      'SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])
    return Number(row?.n ?? 0) > 0
  }

  /**
   * Grant or revoke one role, with the audit entry in the same unit.
   *
   * Deliberately not written to moderation_actions. That table's `action` is a
   * closed set — hide, delete, warn, mute, suspend, ban, restore,
   * dismiss_report — and it means "something was done about misconduct".
   * Promoting a moderator is an administrative act, not a disciplinary one,
   * and widening the vocabulary to fit it would make the moderation history a
   * worse answer to the question it exists for.
   */
  setRole (grant: {
    userId: string, roleId: string, slug: string, granted: boolean,
    reason: string | null, actorId: string
  }): Promise<void> {
    return this.transaction(async (client: pg.PoolClient) => {
      if (grant.granted) {
        await client.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [grant.userId, grant.roleId])
      } else {
        await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
          [grant.userId, grant.roleId])
      }
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, $2, 'user', $3, $4, $5)`,
        // `before` and `after` are the same shape so the trail reads as a
        // change rather than as two unrelated objects: the screen lines them up
        // key by key, and a key on only one side is shown as a note.
        [grant.actorId, grant.granted ? 'user.role.grant' : 'user.role.revoke', grant.userId,
          { role: grant.slug, granted: !grant.granted },
          { role: grant.slug, granted: grant.granted, reason: grant.reason }]
      )
    })
  }

  /**
   * Sign an account out everywhere, and say how many sessions that was.
   *
   * The same pairing the ban path uses, for the same reason: revoking the
   * refresh tokens alone leaves the access tokens valid until they expire.
   */
  revokeAllSessions (userId: string, actorId: string, reason: string): Promise<number> {
    return this.transaction(async (client: pg.PoolClient) => {
      const { rows } = await client.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId])
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId])
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
         VALUES ($1, 'user.sessions.revoke', 'user', $2, $3, $4)`,
        [actorId, userId, { sessions: rows.length }, { sessions: 0, reason }]
      )
      return rows.length
    })
  }
}

export const userRepository = new UserRepository(db)
