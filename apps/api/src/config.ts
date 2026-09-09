// Environment configuration (12-factor). Fails fast on missing secrets in
// production; ships safe defaults for local development.

function env (key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback
  if (value === undefined) throw new Error(`Missing required env var: ${key}`)
  return value
}

const isProd = process.env.NODE_ENV === 'production'

const DEV_JWT_SECRET = 'dev-only-jwt-secret'

/**
 * A JWT secret is the entire account-security boundary: anyone who knows it can
 * mint tokens for any user. Refuse to start in production with the development
 * placeholder or anything trivially short, instead of silently running insecure.
 */
function jwtSecret (): string {
  const secret = process.env.JWT_SECRET ?? (isProd ? undefined : DEV_JWT_SECRET)
  if (secret === undefined) throw new Error('Missing required env var: JWT_SECRET')
  if (isProd) {
    if (secret === DEV_JWT_SECRET || secret.includes('change-me')) {
      throw new Error('JWT_SECRET is still the development placeholder. Generate one with: openssl rand -base64 48')
    }
    if (secret.length < 32) {
      throw new Error('JWT_SECRET is too short (need at least 32 characters). Generate one with: openssl rand -base64 48')
    }
  }
  return secret
}

/**
 * Which upstream proxies may set X-Forwarded-For.
 *
 * `trustProxy: true` trusts that header from *anyone*, so a request could
 * simply declare its own client IP — and since the rate limiter keys on
 * request.ip, every fabricated address got its own fresh quota. That turned
 * the deliberately expensive login hash into both a brute-force and a
 * CPU-exhaustion vector. Measured before the fix: 8 of 8 login attempts got
 * through an exhausted limit by varying one header.
 *
 * The safe default is to trust nobody and use the real socket address.
 * Deployments behind a reverse proxy set TRUST_PROXY to that proxy's address
 * or subnet (e.g. the Docker network). A bare hop count is refused — see the
 * comment on the check below for what Fastify does with one now.
 */
function trustProxy (): boolean | string[] {
  const raw = process.env.TRUST_PROXY?.trim()
  if (!raw || raw === 'false') return false

  if (raw === 'true') {
    // Blanket trust is exactly the misconfiguration that made the rate limit
    // bypassable, so production refuses it rather than running exposed.
    if (isProd) {
      throw new Error(
        'TRUST_PROXY=true trusts X-Forwarded-For from any client, which lets anyone bypass rate limiting. ' +
        'Set it to your proxy\'s address or subnet, e.g. TRUST_PROXY=172.16.0.0/12'
      )
    }
    return true
  }

  /*
   * A bare hop count is refused, and this is a change.
   *
   * It used to be supported — TRUST_PROXY=1 meant "believe the last entry of
   * X-Forwarded-For" — and Fastify honoured it. As of Fastify 5.12 a numeric
   * trustProxy trusts *nobody*:
   *
   *     if (typeof tp === 'number') {
   *       // Hop-count-only trust cannot validate the immediate peer.
   *       return function () { return false }
   *     }
   *
   * They are right, and the reason matters here. A hop count cannot check who
   * the immediate peer is, so a client connecting directly can supply as many
   * hops as it likes and be believed. Failing closed is the correct answer.
   *
   * But failing closed *silently* is not, for this application. With nobody
   * trusted, request.ip is the reverse proxy's own address for every request,
   * and the rate limiter keys on request.ip — so the entire internet shares one
   * bucket. The limit still "works"; it just protects nothing and locks
   * everybody out together. That is a worse failure than the one the hop count
   * was trying to avoid, and it is invisible until it happens.
   *
   * So the misconfiguration is refused at boot instead, where somebody is
   * looking. There is a correct value and the message names it.
   */
  if (/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY=${raw} is a hop count, which Fastify no longer honours: since 5.12 a numeric ` +
      'value trusts nobody, so request.ip becomes the proxy and every client shares one rate-limit ' +
      'bucket. Set the proxy\'s address or subnet instead, e.g. TRUST_PROXY=172.16.0.0/12'
    )
  }

  return raw.split(',').map(entry => entry.trim()).filter(Boolean)
}

/**
 * CORS. In development anything goes; in production a wildcard would let any
 * site drive the API with a user's bearer token, so an unset CORS_ORIGINS means
 * same-origin only (which is what the single-container deployment needs).
 * Set CORS_ORIGINS explicitly to allow a separately hosted frontend.
 */
function corsOrigins (): string[] | boolean {
  const raw = process.env.CORS_ORIGINS
  if (!raw) return isProd ? false : true
  if (raw === '*') return isProd ? false : true
  return raw.split(',').map(origin => origin.trim()).filter(Boolean)
}

export const config = {
  isProd,
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),

  databaseUrl: env('DATABASE_URL', isProd ? undefined : 'postgres://yume:yume@localhost:5432/yume'),

  // Connection pool. Ten was too few to absorb a burst, and with no timeouts a
  // single runaway query could hold a connection indefinitely — ten of those
  // stalled the whole API while requests piled up invisibly on the pool wait.
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 20),
  dbConnectionTimeoutMs: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5_000),
  /** Server-side cap on any single statement. 0 disables it. */
  dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000),

  // Slow-drip requests would otherwise hold connections open indefinitely.
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMs: Number(process.env.CONNECTION_TIMEOUT_MS ?? 60_000),

  /*
   * JWT secrets MUST be provided in production — see jwtSecret() above.
   *
   * A getter, not a value, and that is the difference between a maintenance
   * script running and not running. Evaluating it here meant importing this
   * module *for any reason at all* demanded a token-signing secret: the
   * migration runner, the catalogue seeder and the founder seeder all import
   * the database module, which imports this one to read a pool timeout, and
   * every one of them died on `Missing required env var: JWT_SECRET` before
   * touching the database. None of them ever signs a token.
   *
   * The fail-fast guarantee is unchanged. It exists so the API refuses to
   * *start* with a missing or placeholder secret rather than failing at the
   * first sign-in, and middleware/auth.ts reads this while buildApp() is
   * registering — which is still boot, still before the first request.
   */
  get jwtSecret (): string { return jwtSecret() },
  accessTokenTtl: '15m',
  refreshTokenTtlDays: 30,

  corsOrigins: corsOrigins(),

  /** See trustProxy() — defaults to trusting nobody. */
  trustProxy: trustProxy(),

  // Optional infrastructure. Monitoring is capability-aware: a service is
  // probed only when its URL is configured here, otherwise it reports
  // "not_configured" instead of raising a false alarm. Yume itself needs none
  // of these today — Postgres is the only hard dependency.
  //
  // Redis is deliberately NOT adopted yet. It has two jobs waiting for it —
  // caching the RBAC permission lookup, and backing the WebSocket hub so more
  // than one app instance can share channels — but both are premature on a
  // single instance, and an unused dependency is one more thing to operate and
  // to fail. Adopt it when a second app instance is actually needed; until
  // then setting REDIS_URL only enables its health probe. See docs/redis.md.
  redisUrl: process.env.REDIS_URL,
  rabbitUrl: process.env.RABBITMQ_URL,
  openSearchUrl: process.env.OPENSEARCH_URL,
  minioUrl: process.env.MINIO_URL,

  /** Where the worker reaches this API to measure its response time. */
  selfUrl: env('SELF_URL', `http://127.0.0.1:${env('PORT', '4000')}`),

  /** Optional read-only Docker socket for container introspection (see docs). */
  dockerSocket: process.env.DOCKER_SOCKET
} as const
