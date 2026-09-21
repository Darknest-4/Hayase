// A szolgáltatók adminfelülete — listázás, ki/be kapcsolás, sorrend.
//
// A KIKAPCSOLÁS AZ EGYETLEN DOLOG, AMIT EGY MEGSZŰNT SZOLGÁLTATÓ ELTÁVOLÍTÁSA
// IGÉNYEL. Nem telepítés, nem kódmódosítás: egy kapcsoló. Az adapter a kódban
// maradhat, a beállításai a táblában, és ha a szolgáltató visszajön, egy
// kattintás visszahozza.
//
// JOGOSULTSÁG: `video_source.edit` — ugyanaz, mint ami egy forrás
// szerkesztéséhez kell. A szolgáltató letiltása ugyanabba a körbe tartozik,
// mint egy rossz forrás kivétele; nem külön hatalom, és nem is a teljes
// rendszerbeállítás.
//
// `hide: true`: az adminfelület MINDEN végpontja letagadja magát annak, aki
// nem léphet be — lásd a jogosultsági állás tesztjét.

import * as health from './health.ts'
import * as registry from './registry.ts'
import { clearCache } from './resolve.ts'
import { audit } from '../audit/audit.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  /**
   * Minden szolgáltató — a KIKAPCSOLTAK IS.
   *
   * Az adminfelületnek azt kell mutatnia, ami VAN, nem azt, ami épp fut. Egy
   * kikapcsolt szolgáltató eltüntetése a listából pont azt a kapcsolót venné
   * el, amivel vissza lehetne kapcsolni.
   */
  fastify.get('/', {
    onRequest: fastify.requirePermission('video_source.view', { hide: true })
  }, async () => {
    const entries = await registry.all()
    return {
      data: entries.map(entry => ({
        slug: entry.provider.id,
        label: entry.label,
        enabled: entry.enabled,
        priority: entry.priority,
        config: entry.config,
        health: health.snapshot(entry.provider.id)
      }))
    }
  })

  /** Egy szolgáltató eseményei — „mióta romlik?". */
  fastify.get('/:slug/events', {
    onRequest: fastify.requirePermission('video_source.view', { hide: true }),
    schema: {
      params: { type: 'object', properties: { slug: { type: 'string', maxLength: 64 } }, required: ['slug'] },
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const { limit } = request.query as { limit?: number }
    if (!registry.known().some(p => p.id === slug)) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    return { data: await health.history(slug, limit ?? 20) }
  })

  /**
   * A KAPCSOLÓ.
   *
   * A gyorsítótárakat AZONNAL eldobjuk — a regiszterét és a feloldásét is.
   * Enélkül egy kikapcsolt szolgáltató még öt percig kiszolgálná a korábban
   * feloldott címeit, és az üzemeltető joggal hinné, hogy a kapcsoló nem
   * működik.
   */
  fastify.patch('/:slug', {
    onRequest: fastify.requirePermission('video_source.edit', { hide: true }),
    schema: {
      params: { type: 'object', properties: { slug: { type: 'string', maxLength: 64 } }, required: ['slug'] },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          priority: { type: 'integer', minimum: 0, maximum: 1000 },
          label: { type: 'string', maxLength: 120, nullable: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const body = request.body as { enabled?: boolean, priority?: number, label?: string | null }

    if (!registry.known().some(p => p.id === slug)) {
      return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }
    if (body.enabled === undefined && body.priority === undefined && body.label === undefined) {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Nincs mit változtatni'
      })
    }

    const elotte = (await registry.all()).find(e => e.provider.id === slug)
    await registry.setState(slug, body)
    clearCache()
    const utana = (await registry.all()).find(e => e.provider.id === slug)

    /*
     * NAPLÓZVA. Egy kikapcsolt szolgáltató első tünete az, hogy „eltűntek a
     * források" — és ilyenkor az első kérdés, hogy ki és mikor kapcsolta ki.
     */
    await audit(
      request.user.sub, 'provider.update', 'provider', slug,
      elotte ? { enabled: elotte.enabled, priority: elotte.priority, label: elotte.label } : null,
      utana ? { enabled: utana.enabled, priority: utana.priority, label: utana.label } : null
    )

    return {
      slug,
      enabled: utana?.enabled ?? true,
      priority: utana?.priority ?? 100,
      label: utana?.label ?? slug
    }
  })
}

export default routes
