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

  corsOrigins: env('CORS_ORIGINS', '*').split(',')
} as const
