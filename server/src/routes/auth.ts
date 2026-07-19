// /v1/auth — register, login, refresh, logout.
// Access tokens: stateless JWT (15 min). Refresh tokens: 256-bit random,
// stored as sha256 in sessions, rotated on every refresh.

import { createHash, randomBytes } from 'node:crypto'

import { config } from '../config.ts'
import { query, queryOne, transaction } from '../db.ts'
import { hashPassword, verifyPassword } from '../lib/password.ts'

import type { FastifyPluginAsync } from 'fastify'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

interface UserRow {
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

const routes: FastifyPluginAsync = async fastify => {
  async function issueTokens (user: { id: string, username: string }, ip?: string, userAgent?: string) {
    const refreshToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000)

    await query(
      'INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [user.id, sha256(refreshToken), ip ?? null, userAgent ?? null, expiresAt]
    )

    const accessToken = fastify.jwt.sign({ sub: user.id, username: user.username })
    return { accessToken, refreshToken, expiresAt: expiresAt.toISOString() }
  }

  fastify.post('/register', {
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

    const existing = await queryOne('SELECT 1 FROM users WHERE email = $1 OR username = $2', [email, username])
    if (existing) {
      return reply.code(409).send({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Email or username already in use' })
    }

    const passwordHash = await hashPassword(password)

    const user = await transaction(async client => {
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
      return { id: userId, username }
    })

    const tokens = await issueTokens(user, request.ip, request.headers['user-agent'])
    return reply.code(201).send(tokens)
  })

  fastify.post('/login', { schema: { body: credentialsSchema } }, async (request, reply) => {
    const { identifier, password } = request.body as { identifier: string, password: string }

    const user = await queryOne<UserRow>(
      'SELECT id, username, password_hash, status FROM users WHERE (email = $1 OR username = $1) AND deleted_at IS NULL',
      [identifier]
    )

    const valid = user?.password_hash != null && await verifyPassword(password, user.password_hash)
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

  fastify.post('/logout', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { refreshToken } = (request.body ?? {}) as { refreshToken?: string }
    if (refreshToken) {
      await query('UPDATE sessions SET revoked_at = now() WHERE refresh_hash = $1 AND user_id = $2', [sha256(refreshToken), request.user.sub])
    }
    return reply.code(204).send()
  })
}

export default routes
