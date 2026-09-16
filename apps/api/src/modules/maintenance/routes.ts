// A karbantartás végpontjai.
//
// KÉT CSOPORT, két bizalmi körrel:
//
//   * `/v1/status` — NYILVÁNOS. Csak annyit mond, amennyit a látogatónak
//     tudnia kell, és semmit azon túl (27. pont);
//   * `/v1/admin/maintenance` — `security.manage` jogosultsághoz kötve. A
//     karbantartás bekapcsolása ugyanabba a körbe tartozik, mint a csak
//     olvasható üzemmód: nem tartalmi szerkesztés, hanem üzemeltetés.

import { announce, config as cachedConfig, configNow, stats } from './cache.ts'
import { decide } from './policy.ts'
import { effectiveMode, formatInZone, secondsUntilChange, toDate } from './schedule.ts'
import { history, recordEvent, save } from './repository.ts'
import { MODE, MODES, SCOPES, isRestricting, parseMode, parseScope } from './state.ts'
import * as bypass from './bypass.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * A nyilvános státusz.
 *
 * AMIT NEM AD KI: belső okot, adatbázis-állapotot, infrastruktúra-részletet,
 * admin-információt, biztonsági metaadatot. Ezt a listát a 27. pont sorolja
 * fel, és a mezőkészlet itt szándékosan rövid — ami nincs benne, azt nem
 * lehet véletlenül kiszivárogtatni.
 */
export const publicStatus: FastifyPluginAsync = async fastify => {
  fastify.get('/', async (_request, reply) => {
    const configuration = cachedConfig()
    const now = new Date()
    const mode = configuration.enabled ? effectiveMode(configuration.mode, configuration.window, now) : MODE.OFF
    const seconds = secondsUntilChange(configuration.mode, configuration.window, now)

    // A státusz SOHA nem gyorsítótárazható: pont a változását akarjuk látni.
    reply.header('Cache-Control', 'no-store')

    return {
      status: isRestricting(mode) ? 'maintenance' : 'operational',
      mode,
      scope: configuration.scope,
      title: configuration.title || null,
      message: configuration.publicMessage || null,
      startsAt: configuration.window.startsAt?.toISOString() ?? null,
      estimatedEnd: configuration.window.endsAt?.toISOString() ?? null,
      estimatedEndLocal: formatInZone(configuration.window.endsAt, configuration.timezone),
      timezone: configuration.timezone,
      retryAfter: seconds,
      // A verzió a kliensnek szól: ebből tudja, hogy változott-e valami,
      // anélkül, hogy az egészet összehasonlítaná.
      version: configuration.version
    }
  })
}

const SAFE_TEXT = 2000

/**
 * A beérkező szöveg megtisztítása.
 *
 * A látogató elé kerül, tehát rövid és nyers. A vezérlőkarakterek kiesnek:
 * azoknak sem a HTML-oldalon, sem a JSON-válaszban nincs helyük, és egy
 * beszúrt újsor a naplóban két sornak látszana.
 */
function text (value: unknown, max = 200): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max)
}

export const adminMaintenance: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requirePermission('security.manage', { hide: true }))

  const actorOf = (request: { user?: unknown }): string | null =>
    (request.user as { sub?: string } | undefined)?.sub ?? null

  /** A jelenlegi állapot, mindennel, ami az admin felülethez kell. */
  fastify.get('/', async () => {
    const configuration = await configNow()
    const now = new Date()
    return {
      config: {
        ...configuration,
        window: {
          startsAt: configuration.window.startsAt?.toISOString() ?? null,
          endsAt: configuration.window.endsAt?.toISOString() ?? null
        }
      },
      effectiveMode: configuration.enabled
        ? effectiveMode(configuration.mode, configuration.window, now)
        : MODE.OFF,
      secondsUntilChange: secondsUntilChange(configuration.mode, configuration.window, now),
      startsAtLocal: formatInZone(configuration.window.startsAt, configuration.timezone),
      endsAtLocal: formatInZone(configuration.window.endsAt, configuration.timezone),
      modes: MODES,
      scopes: SCOPES,
      cache: stats(),
      bypasses: await bypass.live(),
      history: await history(20)
    }
  })

  /** Mentés — MINDIG új verzió, sosem felülírás. */
  fastify.put('/', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const before = await configNow()

    const mode = parseMode(body.mode)
    const startsAt = toDate(body.startsAt)
    const endsAt = toDate(body.endsAt)

    // Az ablak sorrendjét az adatbázis is őrzi, de itt adunk rá értelmes
    // hibaüzenetet — egy megszorítás-hiba a felületen nem olvasható.
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      return reply.code(400).send({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'A karbantartás vége nem lehet a kezdete előtt.'
      })
    }

    const saved = await save({
      mode,
      scope: parseScope(body.scope),
      enabled: body.enabled === true,
      startsAt,
      endsAt,
      estimatedEndAt: toDate(body.estimatedEndAt),
      timezone: text(body.timezone, 60) || 'Europe/Budapest',
      title: text(body.title, 120),
      publicMessage: text(body.publicMessage, SAFE_TEXT),
      allowExistingSessions: body.allowExistingSessions === true,
      drainSeconds: Number(body.drainSeconds ?? 0),
      actorId: actorOf(request)
    })

    await recordEvent({
      action: mode === MODE.EMERGENCY ? 'maintenance.emergency_activated' : 'maintenance.updated',
      actorId: actorOf(request),
      before: { mode: before.mode, scope: before.scope, enabled: before.enabled, version: before.version },
      after: saved ? { mode: saved.mode, scope: saved.scope, enabled: saved.enabled, version: saved.version } : null,
      ip: request.ip
    })

    // A saját példány AZONNAL frissül, a többi az értesítésből — vagy
    // legkésőbb a lejárati időből.
    await announce(saved?.version ?? 0)
    return { config: saved, cache: stats() }
  })

  /**
   * Előnézet — a 11. pont.
   *
   * NEM aktivál semmit: egy kitalált beállítással lefuttatja a döntést, és
   * megmondja, mi TÖRTÉNNE. Így az admin a bekapcsolás előtt látja, kit
   * zárna ki és mit.
   */
  fastify.post('/preview', async request => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const draft = {
      ...await configNow(),
      enabled: body.enabled !== false,
      mode: parseMode(body.mode),
      scope: parseScope(body.scope),
      window: { startsAt: toDate(body.startsAt), endsAt: toDate(body.endsAt) },
      title: text(body.title, 120),
      publicMessage: text(body.publicMessage, SAFE_TEXT)
    }
    const now = toDate(body.at) ?? new Date()

    // Néhány jellemző hívó — ebből látszik, kit érint a beállítás.
    const probes = [
      { label: 'látogató, katalógus', url: '/v1/anime', method: 'GET', roles: [] as string[] },
      { label: 'látogató, lejátszó', url: '/v1/anime/episodes/x', method: 'GET', roles: [] as string[] },
      { label: 'látogató, hozzászólás', url: '/v1/comments', method: 'POST', roles: [] as string[] },
      { label: 'bejelentkezett, keresés', url: '/v1/search?q=x', method: 'GET', roles: ['user'] },
      { label: 'admin, katalógus', url: '/v1/anime', method: 'GET', roles: ['admin'] },
      { label: 'admin, karbantartás', url: '/v1/admin/maintenance', method: 'PUT', roles: ['admin'] },
      { label: 'egészségjelző', url: '/v1/health', method: 'GET', roles: [] as string[] },
      { label: 'worker (belső)', url: '/v1/anime', method: 'POST', roles: [] as string[], internal: true }
    ]

    return {
      effectiveMode: draft.enabled ? effectiveMode(draft.mode, draft.window, now) : MODE.OFF,
      at: now.toISOString(),
      results: probes.map(probe => {
        const decision = decide(draft, now, {
          url: probe.url,
          method: probe.method,
          roles: probe.roles,
          internal: probe.internal === true
        })
        return { label: probe.label, kind: decision.kind, reason: decision.reason }
      })
    }
  })

  /** Új mentességi jegy. A jegy EGYSZER jön vissza — utána sehol nem érhető el. */
  fastify.post('/bypass', async request => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const actorId = actorOf(request)
    const issued = await bypass.issue({
      actorId,
      label: text(body.label, 120),
      scope: body.scope as string | undefined,
      minutes: Number(body.minutes ?? bypass.DEFAULT_TTL_MINUTES)
    })
    await recordEvent({
      action: 'maintenance.bypass_created',
      actorId,
      before: null,
      // A JEGY MAGA NEM MEGY A NAPLÓBA. Az auditnak az kell, hogy KI adott ki
      // jegyet és mire — nem az, hogy mi volt az.
      after: { id: issued.id, scope: issued.scope, expiresAt: issued.expiresAt, label: issued.label },
      ip: request.ip,
      subjectId: issued.id
    })
    return {
      token: issued.token,
      id: issued.id,
      scope: issued.scope,
      expiresAt: issued.expiresAt.toISOString(),
      header: bypass.BYPASS_HEADER,
      note: 'A jegy csak most látható. Fejlécben vagy sütiben küldd, sosem az URL-ben.'
    }
  })

  /** Visszavonás. */
  fastify.delete('/bypass/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const done = await bypass.revoke(id, actorOf(request))
    if (!done) {
      return reply.code(404).send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Nincs ilyen élő mentességi jegy.'
      })
    }
    return { revoked: true, id }
  })
}
