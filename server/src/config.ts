// Environment configuration (12-factor). Fails fast on missing secrets in
// production; ships safe defaults for local development.

function env (key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback
  if (value === undefined) throw new Error(`Missing required env var: ${key}`)
  return value
}

const isProd = process.env.NODE_ENV === 'production'

export const config = {
  isProd,
  port: Number(env('PORT', '4000')),
  host: env('HOST', '0.0.0.0'),

  databaseUrl: env('DATABASE_URL', isProd ? undefined : 'postgres://yume:yume@localhost:5432/yume'),

  // JWT secrets MUST be provided in production
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-only-jwt-secret'),
  accessTokenTtl: '15m',
  refreshTokenTtlDays: 30,

  corsOrigins: env('CORS_ORIGINS', '*').split(','),

  // Optional infrastructure. Monitoring is capability-aware: a service is
  // probed only when its URL is configured here, otherwise it reports
  // "not_configured" instead of raising a false alarm. Yume itself needs none
  // of these today — Postgres is the only hard dependency.
  redisUrl: process.env.REDIS_URL,
  rabbitUrl: process.env.RABBITMQ_URL,
  openSearchUrl: process.env.OPENSEARCH_URL,
  minioUrl: process.env.MINIO_URL,

  /** Where the worker reaches this API to measure its response time. */
  selfUrl: env('SELF_URL', `http://127.0.0.1:${env('PORT', '4000')}`),

  /** Optional read-only Docker socket for container introspection (see docs). */
  dockerSocket: process.env.DOCKER_SOCKET
} as const
