// App factory: builds the configured Fastify instance (separated from
// index.ts so tests can build an app without binding a port).

import cors from '@fastify/cors'
import Fastify from 'fastify'

import { config } from './config.ts'
import wsPlugin from './lib/ws.ts'
import authPlugin from './plugins/auth.ts'
import animeRoutes from './routes/anime.ts'
import authRoutes from './routes/auth.ts'
import commentRoutes from './routes/comments.ts'
import w2gRoutes from './routes/w2g.ts'
import extensionRoutes from './routes/extensions.ts'
import libraryRoutes from './routes/library.ts'

import type { FastifyError, FastifyInstance } from 'fastify'

export async function buildApp (): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.isProd ? 'info' : 'debug' },
    trustProxy: true
  })

  await app.register(cors, { origin: config.corsOrigins })
  await app.register(authPlugin)
  await app.register(wsPlugin)

  app.get('/v1/health', async () => ({ status: 'ok' }))

  await app.register(authRoutes, { prefix: '/v1/auth' })
  await app.register(animeRoutes, { prefix: '/v1/anime' })
  await app.register(libraryRoutes, { prefix: '/v1/me' })
  await app.register(extensionRoutes, { prefix: '/v1/extensions' })
  await app.register(commentRoutes, { prefix: '/v1/comments' })
  await app.register(w2gRoutes, { prefix: '/v1/w2g' })

  // RFC 9457 problem+json for unhandled errors
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) request.log.error(error)
    void reply.code(status).type('application/problem+json').send({
      type: 'about:blank',
      title: status >= 500 ? 'Internal Server Error' : error.message,
      status,
      detail: status >= 500 ? undefined : error.message
    })
  })

  return app
}
