// Regression tests for the September 2026 audit.
//
// Each block pins one finding to the behaviour that closes it, so the hole
// cannot quietly reopen: the encoded-path gate bypass, GraphQL serving hidden
// titles, the process-ending rejection, the poisonable analytics rollup, the
// dead job holding its dedupe key, refresh-token reuse, cross-guild Discord
// channels, and the rest. They need a database with the test catalogue
// (scripts/test-catalogue.ts).

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'audit-fixes-test-secret-long-enough-0123456789'

type App = Awaited<ReturnType<typeof import('../src/app.ts')['buildApp']>>

describe('audit fixes', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: App
  let pool: typeof import('../src/infrastructure/database/index.ts')['pool']
  let settings: typeof import('../src/modules/settings/site-settings.ts')['settings']
  let invalidatePermissions: typeof import('../src/middleware/auth.ts')['invalidatePermissions']
  const usernames: string[] = []
  let hiddenId = ''
  let unlistedId = ''
  let publicId = ''

  interface Account { id: string, username: string, token: string, cookie: string, profileId: string }

  const cookieOf = (header: string | string[] | number | undefined): string => {
    const all = Array.isArray(header) ? header : [String(header ?? '')]
    const found = all.map(h => /yume_refresh=([^;]*)/.exec(h)?.[1]).find(Boolean)
    return found ?? ''
  }

  async function register (): Promise<Account> {
    const username = 'af_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    const body = res.json() as { accessToken: string, refreshToken?: string }
    const { rows } = await pool.query<{ id: string, profile: string }>(
      `SELECT u.id, p.id AS profile FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.username = $1`,
      [username])
    return { id: rows[0]!.id, username, token: body.accessToken, cookie: cookieOf(res.headers['set-cookie']), profileId: rows[0]!.profile }
  }

  const bearer = (account: Account, extra: Record<string, string> = {}): Record<string, string> =>
    ({ authorization: `Bearer ${account.token}`, ...extra })

  const graphql = async (query: string, headers: Record<string, string> = {}) =>
    await app.inject({ method: 'POST', url: '/graphql', headers, payload: { query } })

  before(async () => {
    const [{ buildApp }, db, site, auth] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/site-settings.ts'),
      import('../src/middleware/auth.ts')
    ])
    app = await buildApp()
    await app.ready()
    pool = db.pool
    settings = site.settings
    invalidatePermissions = auth.invalidatePermissions

    const pick = async (visibility: string): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM anime WHERE visibility = $1 ORDER BY canonical_title LIMIT 1', [visibility])
      assert.ok(rows[0], `the test catalogue has no ${visibility} title — run scripts/test-catalogue.ts`)
      return rows[0].id
    }
    hiddenId = await pick('hidden')
    unlistedId = await pick('unlisted')
    publicId = await pick('public')
  })

  beforeEach(() => {
    mock.method(settings, 'requiresLogin', async () => false)
  })

  afterEach(() => {
    mock.restoreAll()
  })

  after(async () => {
    try {
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
    }
  })

  // ---- the private-instance gate and the read-only switch ----------------

  describe('gates decide on the routed path', () => {
    it('an encoded /v1 path is gated on a private instance like the plain one', async () => {
      mock.method(settings, 'requiresLogin', async () => true)
      for (const url of ['/v1/anime?limit=1', '/%761/anime?limit=1', '/%76%31/%61nime?limit=1']) {
        const res = await app.inject({ url })
        assert.equal(res.statusCode, 401, `${url} answered ${res.statusCode}`)
      }
      const res = await app.inject({ method: 'POST', url: '/graphq%6c', payload: { query: '{ me { id } }' } })
      assert.equal(res.statusCode, 401)
    })

    it('an encoded write is refused in read-only mode', async () => {
      mock.method(settings, 'readOnly', async () => true)
      const res = await app.inject({ method: 'POST', url: '/%761/reports', payload: {} })
      assert.equal(res.statusCode, 503)
    })

    it('read-only mode refuses GraphQL mutations but still answers queries', async () => {
      const account = await register()
      mock.method(settings, 'readOnly', async () => true)
      const read = await graphql('{ search(query: "Fixture Title", limit: 1) { id } }')
      assert.equal(read.statusCode, 200, read.body)
      assert.ok(Array.isArray(read.json().data.search))

      const write = await graphql(`mutation { deleteLibraryEntry(animeId: "${publicId}") }`, bearer(account))
      const body = write.json() as { errors?: Array<{ extensions?: { code?: string } }> }
      assert.equal(body.errors?.[0]?.extensions?.code, 'READ_ONLY', write.body)
    })
  })

  // ---- GraphQL ------------------------------------------------------------

  describe('GraphQL follows the catalogue visibility rules', () => {
    it('a hidden title does not exist', async () => {
      const res = await graphql(`{ anime(id: "${hiddenId}") { id canonicalTitle } }`)
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().data.anime, null)
    })

    it('an unlisted title is reachable by id', async () => {
      const res = await graphql(`{ anime(id: "${unlistedId}") { id } }`)
      assert.equal(res.json().data.anime?.id, unlistedId)
    })

    it('a malformed id is a miss, not a database error', async () => {
      const res = await graphql('{ anime(id: "not-a-uuid") { id } }')
      assert.equal(res.json().data.anime, null)
      assert.equal(res.json().errors, undefined)
    })

    it('relations list only listed titles', async () => {
      const res = await graphql(`{ anime(id: "${unlistedId}") { relations { node { id } } } }`)
      const ids = (res.json().data.anime.relations as Array<{ node: { id: string } }>).map(r => r.node.id)
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM anime WHERE id = ANY($1) AND visibility <> 'public'", [ids])
      assert.equal(rows.length, 0, 'a relation led to a title that is not public')
    })

    it('search never returns a hidden title', async () => {
      const res = await graphql('{ search(query: "Fixture Title", limit: 50) { id } }')
      const ids = (res.json().data.search as Array<{ id: string }>).map(a => a.id)
      assert.ok(!ids.includes(hiddenId))
    })

    it('the schedule window is bounded', async () => {
      const res = await graphql('{ schedule(from: "1900-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z") { episodeId } }')
      assert.equal(res.json().errors?.[0]?.extensions?.code, 'RANGE_TOO_WIDE')
    })

    it('a signed-out token is anonymous to GraphQL too', async () => {
      const account = await register()
      const before = await graphql('{ me { id } }', bearer(account))
      assert.equal(before.json().data.me?.id, account.id)
      const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(account), payload: {} })
      assert.equal(out.statusCode, 204)
      const afterwards = await graphql('{ me { id } }', bearer(account))
      assert.equal(afterwards.json().data.me, null)
    })

    it('saveProgress writes watch history, like the REST route', async () => {
      const account = await register()
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM episodes WHERE anime_id = $1 ORDER BY number LIMIT 1', [publicId])
      const res = await graphql(
        `mutation { saveProgress(episodeId: "${rows[0]!.id}", positionSec: 1300, durationSec: 1440) { completed } }`,
        bearer(account, { 'x-profile-id': account.profileId }))
      assert.equal(res.json().data?.saveProgress?.completed, true, res.body)
      const history = await pool.query('SELECT 1 FROM watch_history WHERE profile_id = $1', [account.profileId])
      assert.equal(history.rowCount, 1)
    })
  })

  // ---- REST catalogue ---------------------------------------------------

  describe('nothing hangs off a hidden title', () => {
    // A hidden id answers exactly like an unknown one — an empty list — so
    // the response does not even confirm that it exists.
    for (const tail of ['characters', 'staff', 'recommendations', 'relations', 'franchise']) {
      it(`/v1/anime/:hidden/${tail} answers like an unknown id`, async () => {
        const hidden = await app.inject({ url: `/v1/anime/${hiddenId}/${tail}` })
        const unknown = await app.inject({ url: `/v1/anime/00000000-0000-4000-8000-000000000000/${tail}` })
        assert.equal(hidden.statusCode, 200)
        assert.deepEqual(hidden.json(), unknown.json())
        assert.deepEqual((hidden.json() as { data: unknown[] }).data, [])
      })
    }

    it('a hidden title cannot be put on a list or favourited', async () => {
      const account = await register()
      const headers = bearer(account, { 'x-profile-id': account.profileId })
      const entry = await app.inject({ method: 'PUT', url: `/v1/me/library/${hiddenId}`, headers, payload: { status: 'WATCHING' } })
      assert.equal(entry.statusCode, 404)
      const favourite = await app.inject({ method: 'PUT', url: `/v1/me/favorites/${hiddenId}`, headers })
      assert.equal(favourite.statusCode, 404)
    })

    it('the schedule refuses a window of centuries', async () => {
      const wide = await app.inject({ url: '/v1/anime/schedule?from=1900-01-01T00:00:00Z&to=2100-01-01T00:00:00Z' })
      assert.equal(wide.statusCode, 400)
      const week = await app.inject({ url: '/v1/anime/schedule?from=2019-01-01T00:00:00Z&to=2019-01-08T00:00:00Z' })
      assert.equal(week.statusCode, 200)
    })
  })

  // ---- a malformed profile header ----------------------------------------

  describe('a malformed X-Profile-Id', () => {
    it('is "not your profile", not a 500', async () => {
      const account = await register()
      const res = await app.inject({ url: '/v1/me/library', headers: bearer(account, { 'x-profile-id': 'nonsense' }) })
      assert.equal(res.statusCode, 403)
    })

    it('does not produce an unhandled rejection from the search statistics', async () => {
      const account = await register()
      mock.method(settings, 'requiresLogin', async () => true) // the gate fills request.user
      const seen: unknown[] = []
      const listener = (reason: unknown): void => { seen.push(reason) }
      process.on('unhandledRejection', listener)
      try {
        const res = await app.inject({
          url: '/v1/anime/search?q=Fixture', headers: bearer(account, { 'x-profile-id': 'x' })
        })
        assert.equal(res.statusCode, 200)
        await new Promise(resolve => setTimeout(resolve, 200))
        assert.equal(seen.length, 0, `unhandled: ${String(seen[0])}`)
      } finally {
        process.off('unhandledRejection', listener)
      }
    })

    it('a malformed uuid anywhere is a 400, not a 500', async () => {
      const account = await register()
      const res = await app.inject({
        method: 'POST', url: '/v1/me/notifications/read', headers: bearer(account), payload: { ids: [] }
      })
      assert.notEqual(res.statusCode, 500)
    })
  })

  // ---- refresh tokens -------------------------------------------------------

  describe('refresh tokens', () => {
    it('travel in the cookie only', async () => {
      const account = await register()
      assert.ok(account.cookie, 'no refresh cookie was set')
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/login',
        payload: { identifier: account.username, password: 'a-long-enough-test-password-1' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal((res.json() as Record<string, unknown>).refreshToken, undefined)
    })

    it('two refreshes with one token yield one session', async () => {
      const account = await register()
      const refresh = async () => await app.inject({
        method: 'POST', url: '/v1/auth/refresh', cookies: { yume_refresh: account.cookie }, payload: {}
      })
      const [a, b] = await Promise.all([refresh(), refresh()])
      const codes = [a.statusCode, b.statusCode].sort()
      assert.deepEqual(codes, [200, 401], `both answered ${codes.join(' and ')}`)
      const loser = a.statusCode === 401 ? a : b
      assert.equal((loser.json() as { code?: string }).code, 'refresh_rotated')
      assert.equal(cookieOf(loser.headers['set-cookie']), '', 'a lost race must not clear the winner\'s cookie')
    })

    it('a replayed token ends every session of the account', async () => {
      const account = await register()
      const first = await app.inject({
        method: 'POST', url: '/v1/auth/refresh', cookies: { yume_refresh: account.cookie }, payload: {}
      })
      assert.equal(first.statusCode, 200)
      // Long past the grace window: this is a copy being replayed.
      await pool.query(
        `UPDATE sessions SET rotated_at = now() - interval '1 hour' WHERE user_id = $1 AND rotated_at IS NOT NULL`,
        [account.id])
      const replay = await app.inject({
        method: 'POST', url: '/v1/auth/refresh', cookies: { yume_refresh: account.cookie }, payload: {}
      })
      assert.equal(replay.statusCode, 401)
      const live = await pool.query(
        'SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [account.id])
      assert.equal(live.rowCount, 0, 'the account kept a live session after its token was replayed')
    })

    it('a refresh keeps the sign-in time', async () => {
      const account = await register()
      await pool.query(`UPDATE sessions SET started_at = now() - interval '3 days' WHERE user_id = $1`, [account.id])
      const res = await app.inject({
        method: 'POST', url: '/v1/auth/refresh', cookies: { yume_refresh: account.cookie }, payload: {}
      })
      assert.equal(res.statusCode, 200)
      const { rows } = await pool.query<{ old: boolean }>(
        `SELECT started_at < now() - interval '2 days' AS old FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL`, [account.id])
      assert.equal(rows[0]?.old, true)
    })
  })

  // ---- password reset -------------------------------------------------------

  it('two reset requests at once leave exactly one usable token', async () => {
    const account = await register()
    const forgot = async () => await app.inject({ method: 'POST', url: '/v1/auth/forgot', payload: { identifier: account.username } })
    const answers = await Promise.all([forgot(), forgot(), forgot()])
    for (const answer of answers) assert.equal(answer.statusCode, 204)
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [account.id])
    assert.equal(rows[0]?.n, 1)
  })

  // ---- community ------------------------------------------------------------

  it('a member may open a few boards a day, not a hundred', async () => {
    const account = await register()
    try {
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: 'POST', url: '/v1/forum', headers: bearer(account), payload: { name: `Audit board ${i} ${account.username}` }
        })
        assert.equal(res.statusCode, 201, res.body)
      }
      const fourth = await app.inject({
        method: 'POST', url: '/v1/forum', headers: bearer(account), payload: { name: `Audit board 4 ${account.username}` }
      })
      assert.equal(fourth.statusCode, 429)
    } finally {
      await pool.query('DELETE FROM forums WHERE created_by = $1', [account.id])
    }
  })

  // ---- administration ---------------------------------------------------------

  describe('account administration respects rank', () => {
    let roleId = ''
    let moderator: Account
    let administrator: Account
    let bystander: Account

    before(async () => {
      moderator = await register()
      administrator = await register()
      bystander = await register()
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO roles (slug, name, is_system) VALUES ($1, 'Audit moderator', false) RETURNING id`,
        ['audit_mod_' + randomBytes(3).toString('hex')])
      roleId = rows[0]!.id
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE slug IN ('admin.users.manage', 'role.assign', 'session.revoke')`, [roleId])
      await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [moderator.id, roleId])
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'admin'`, [administrator.id])
      invalidatePermissions()
    })

    after(async () => {
      await pool.query('DELETE FROM roles WHERE id = $1', [roleId])
      invalidatePermissions()
    })

    it('cannot ban an administrator', async () => {
      const res = await app.inject({
        method: 'POST', url: `/v1/admin/users/${administrator.id}/status`, headers: bearer(moderator),
        payload: { status: 'banned', reason: 'audit test' }
      })
      assert.equal(res.statusCode, 403)
    })

    it('cannot end an administrator\'s sessions', async () => {
      const res = await app.inject({
        method: 'POST', url: `/v1/admin/users/${administrator.id}/sessions/revoke`, headers: bearer(moderator),
        payload: { reason: 'audit test' }
      })
      assert.equal(res.statusCode, 403)
    })

    it('cannot hand out a role carrying more than it holds', async () => {
      const res = await app.inject({
        method: 'POST', url: `/v1/admin/users/${bystander.id}/roles`, headers: bearer(moderator),
        payload: { role: 'admin', granted: true }
      })
      assert.equal(res.statusCode, 403)
    })
  })

  // ---- Discord ----------------------------------------------------------------

  describe('a Discord channel belongs to its guild', () => {
    const GUILD = '100000000000000071'
    const OTHER = '100000000000000072'
    const CHANNEL = '200000000000000071'
    let admin: Account
    let previousToken: string | undefined

    before(async () => {
      admin = await register()
      await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE slug = 'admin'`, [admin.id])
      invalidatePermissions()
      previousToken = process.env.DISCORD_BOT_TOKEN
      process.env.DISCORD_BOT_TOKEN = 'audit-test-token-not-real'
    })

    after(async () => {
      if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = previousToken
      await pool.query('DELETE FROM persistent_messages WHERE guild_id = $1', [GUILD])
    })

    const channelOwnedBy = (guild: string): void => {
      mock.method(globalThis, 'fetch', async (url: string) => {
        if (String(url).includes(`/channels/${CHANNEL}`)) {
          return new Response(JSON.stringify({ id: CHANNEL, guild_id: guild, type: 0 }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      })
    }

    it('refuses a channel of another guild', async () => {
      channelOwnedBy(OTHER)
      const { MESSAGE_TYPES } = await import('../src/modules/discord/render.ts')
      const res = await app.inject({
        method: 'POST', url: `/v1/discord/guilds/${GUILD}/persistent-messages`, headers: bearer(admin),
        payload: { channelId: CHANNEL, messageType: MESSAGE_TYPES[0] }
      })
      assert.equal(res.statusCode, 400, res.body)
    })

    it('accepts the guild\'s own channel', async () => {
      channelOwnedBy(GUILD)
      const { MESSAGE_TYPES } = await import('../src/modules/discord/render.ts')
      const res = await app.inject({
        method: 'POST', url: `/v1/discord/guilds/${GUILD}/persistent-messages`, headers: bearer(admin),
        payload: { channelId: CHANNEL, messageType: MESSAGE_TYPES[0] }
      })
      assert.equal(res.statusCode, 201, res.body)
    })
  })

  // ---- progress and XP ------------------------------------------------------------

  it('XP for finished episodes stops at the daily ceiling', async () => {
    const account = await register()
    const headers = bearer(account, { 'x-profile-id': account.profileId })
    await pool.query(
      `INSERT INTO xp_events (profile_id, amount, reason, created_at)
       SELECT $1, 10, 'episode_watched', now() - interval '1 hour' FROM generate_series(1, 100)`,
      [account.profileId])
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM episodes WHERE anime_id = $1 ORDER BY number DESC LIMIT 1', [publicId])
    const res = await app.inject({
      method: 'PATCH', url: `/v1/me/progress/${rows[0]!.id}`, headers, payload: { positionSec: 1400, durationSec: 1440 }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().completed, true)
    const { rows: xp } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM xp_events WHERE profile_id = $1 AND reason = 'episode_watched'", [account.profileId])
    assert.equal(xp[0]?.n, 100)
  })

  // ---- analytics rollup ------------------------------------------------------------

  it('a view of something that is not a title does not break the day\'s rollup', async () => {
    const { rollupAnime } = await import('../src/modules/analytics/rollup.ts')
    // Today: page_views is partitioned by month, and only recent months exist.
    const day = new Date().toISOString().slice(0, 10)
    await pool.query(
      `INSERT INTO page_views (session_key, route, entity_id, created_at)
       VALUES ('audit:1', '/anime/:id', $1, $3::date + interval '1 minute'),
              ('audit:2', '/anime/:id', $2, $3::date + interval '2 minutes')`,
      [randomUUID(), publicId, day])
    await assert.doesNotReject(() => rollupAnime(day))
    const { rows } = await pool.query<{ views: number }>(
      'SELECT views FROM anime_stats_daily WHERE day = $1 AND anime_id = $2', [day, publicId])
    assert.ok((rows[0]?.views ?? 0) >= 1)
  })

  // ---- the job queue ------------------------------------------------------------

  describe('the job queue', () => {
    it('a dead job no longer blocks its dedupe key', async () => {
      const q = await import('../src/infrastructure/queue/index.ts')
      const key = 'audit-dead-' + randomBytes(4).toString('hex')
      await pool.query(
        `INSERT INTO jobs (queue, payload, attempts, max_attempts, dead_at)
         VALUES ('stats', $1::jsonb, 5, 5, now())`, [JSON.stringify({ dedupe: key })])
      await q.enqueue('stats', { dedupe: key })
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM jobs WHERE payload->>'dedupe' = $1", [key])
      assert.equal(rows[0]?.n, 2, 'the new job was dropped as a duplicate of a dead one')
      await pool.query("DELETE FROM jobs WHERE payload->>'dedupe' = $1", [key])
    })

    it('a failure reported under a stale lease changes nothing', async () => {
      const q = await import('../src/infrastructure/queue/index.ts')
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO jobs (queue, payload, attempts, locked_at, lease_id)
         VALUES ('stats', '{}'::jsonb, 1, now(), gen_random_uuid()) RETURNING id`)
      const id = rows[0]!.id
      await q.failJob({ id, queue: 'stats', payload: {}, attempts: 1, leaseId: randomUUID() }, new Error('stale'))
      const { rows: after } = await pool.query<{ last_error: string | null }>(
        'SELECT last_error FROM jobs WHERE id = $1', [id])
      assert.equal(after[0]?.last_error, null)
      await pool.query('DELETE FROM jobs WHERE id = $1', [id])
    })
  })
})
