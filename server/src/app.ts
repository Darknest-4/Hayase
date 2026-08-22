// App factory: builds the configured Fastify instance (separated from
// index.ts so tests can build an app without binding a port).

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import mercurius from 'mercurius'
import Fastify from 'fastify'

import { config } from './config.ts'
import { recordError } from './lib/errors.ts'
import { schema, resolvers, loaders } from './graphql/schema.ts'
import wsPlugin from './lib/ws.ts'
import authPlugin from './plugins/auth.ts'
import securityPlugin from './plugins/security.ts'
import animeRoutes from './routes/anime.ts'
import authRoutes from './routes/auth.ts'
import commentRoutes from './routes/comments.ts'
import w2gRoutes from './routes/w2g.ts'
import adminRoutes from './routes/admin.ts'
import devRoutes from './routes/dev.ts'
import profileRoutes from './routes/profiles.ts'
import webhookRoutes from './routes/webhooks.ts'
import { publicConfig, adminConfig } from './routes/config.ts'
import roleRoutes from './routes/roles.ts'
import catalogueRoutes from './routes/catalogue.ts'
import { publicReadiness, adminMonitoring } from './routes/monitoring.ts'
import reportRoutes from './routes/reports.ts'
import extensionRoutes from './routes/extensions.ts'
import libraryRoutes from './routes/library.ts'

import type { FastifyError, FastifyInstance } from 'fastify'

export async function buildApp (): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.isProd ? 'info' : 'debug' },
    // Never a blanket true — see config.trustProxy for why that made the rate
    // limiter bypassable with a single header.
    trustProxy: config.trustProxy,
    // Cap request bodies. Nothing Yume accepts is large — the biggest payloads
    // are comment/review text and extension manifests — so this bounds memory
    // use from hostile requests. Fastify's default is the same 1 MB; setting it
    // explicitly makes the intent (and the place to change it) obvious.
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 1_048_576),
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs
  })

  // Extension packages are uploaded as raw source, not JSON — see
  // lib/package-store.ts. Only these content types bypass the JSON parser,
  // and the route that accepts them sets its own (larger) body limit.
  for (const mime of ['application/javascript', 'text/javascript', 'application/octet-stream']) {
    app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => { done(null, body) })
  }

  await app.register(securityPlugin)
  await app.register(cors, { origin: config.corsOrigins })
  await app.register(authPlugin)
  await app.register(wsPlugin)

  // GraphQL over the same service layer. Auth is optional per-request:
  // a valid bearer token populates userId/username; X-Profile-Id scopes
  // profile data (ownership re-checked in requireProfile).
  await app.register(mercurius, {
    schema,
    resolvers,
    loaders,
    graphiql: !config.isProd,
    context: async request => {
      const ctx: { userId?: string, username?: string, profileId?: string } = {}
      const auth = request.headers.authorization
      if (auth?.startsWith('Bearer ')) {
        try {
          const payload = app.jwt.verify<{ sub: string, username: string }>(auth.slice(7))
          ctx.userId = payload.sub
          ctx.username = payload.username
          const profileHeader = request.headers['x-profile-id']
          if (typeof profileHeader === 'string') {
            const { queryOne } = await import('./db.ts')
            const owned = await queryOne('SELECT 1 FROM user_profiles WHERE id = $1 AND user_id = $2', [profileHeader, payload.sub])
            if (owned) ctx.profileId = profileHeader
          }
        } catch { /* anonymous */ }
      }
      return ctx
    }
  })

  // Liveness: zero dependencies, always cheap — this is what Docker and load
  // balancers poll. Dependency-aware readiness lives at /v1/health/ready.
  app.get('/v1/health', async () => ({ status: 'ok' }))

  await app.register(publicConfig, { prefix: '/v1/config' })
  await app.register(adminConfig, { prefix: '/v1/admin/config' })
  await app.register(authRoutes, { prefix: '/v1/auth' })
  await app.register(animeRoutes, { prefix: '/v1/anime' })
  await app.register(libraryRoutes, { prefix: '/v1/me' })
  await app.register(profileRoutes, { prefix: '/v1/profiles' })
  await app.register(extensionRoutes, { prefix: '/v1/extensions' })
  await app.register(commentRoutes, { prefix: '/v1/comments' })
  await app.register(w2gRoutes, { prefix: '/v1/w2g' })
  await app.register(reportRoutes, { prefix: '/v1/reports' })
  await app.register(adminRoutes, { prefix: '/v1/admin' })
  await app.register(devRoutes, { prefix: '/v1/dev' })
  await app.register(webhookRoutes, { prefix: '/v1/admin/webhooks' })
  await app.register(roleRoutes, { prefix: '/v1/admin/roles' })
  await app.register(catalogueRoutes, { prefix: '/v1/admin/catalogue' })
  await app.register(publicReadiness, { prefix: '/v1/health' })
  await app.register(adminMonitoring, { prefix: '/v1/admin/monitoring' })

  // Serve the static web client from the same origin so the whole app runs as
  // one container/port (WEB_ROOT overrides; defaults to the repo's web/).
  const webRoot = process.env.WEB_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../../web')
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, index: 'index.html' })
    // SPA fallback: any non-API GET that isn't a real file returns index.html
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !/^\/(v1|graphql|graphiql|ws)\b/.test(request.url)) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).type('application/problem+json').send({ type: 'about:blank', title: 'Not Found', status: 404 })
    })
    app.log.info(`serving web client from ${webRoot}`)
  }

  // RFC 9457 problem+json for unhandled errors
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error(error)
      // Persist it so the admin error view reflects reality. Fire-and-forget:
      // the response must not wait on telemetry, and a telemetry failure must
      // never replace the error the caller actually hit.
      void recordError('api', error, {
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        statusCode: status,
        userId: (request.user as { sub?: string } | undefined)?.sub
      })
    }
    void reply.code(status).type('application/problem+json').send({
      type: 'about:blank',
      title: status >= 500 ? 'Internal Server Error' : error.message,
      status,
      detail: status >= 500 ? undefined : error.message
    })
  })

  return app
}
