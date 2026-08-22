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

  // JWT secrets MUST be provided in production (validated above)
  jwtSecret: jwtSecret(),
  accessTokenTtl: '15m',
  refreshTokenTtlDays: 30,

  corsOrigins: corsOrigins(),

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
