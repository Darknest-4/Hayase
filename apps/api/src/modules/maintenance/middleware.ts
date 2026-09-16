// A köztesréteg — itt találkozik a döntés a HTTP-vel.
//
// A 4. pont legfontosabb mondata: A FRONTEND SOHA NE LEGYEN BIZTONSÁGI HATÁR.
// A kliens megjelenítheti a karbantartási oldalt, de ami ténylegesen megvédi
// a rendszert, az ez a hook — minden kérésen, a szerveren.
//
// A GYAKORI ÚT OLCSÓ: gyorsítótárból olvasott beállítás, tiszta függvény,
// egyetlen összehasonlítás. Adatbázishoz csak akkor nyúlunk, ha a kérésen
// TÉNYLEGESEN van mentességi jegy — az pedig ritka.

import { BYPASS_COOKIE, BYPASS_HEADER, check as checkBypass, verifySignature } from './bypass.ts'
import { DECISION, decide, type Decision } from './policy.ts'
import { config as cachedConfig } from './cache.ts'
import { isInternalRequest } from '../../middleware/internal-request.ts'
import { renderStatusPage, wantsHtml } from '../../infrastructure/http/status-page.ts'
import { MODE } from './state.ts'

import type { FastifyReply, FastifyRequest } from 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    maintenance?: Decision
  }
}

/** A jegy a kérésről: fejlécből vagy sütiből. SOHA nem a lekérdezésből. */
function tokenFrom (request: FastifyRequest): string | undefined {
  const header = request.headers[BYPASS_HEADER]
  if (typeof header === 'string' && header) return header
  const cookie = request.headers.cookie
  if (typeof cookie !== 'string' || !cookie.includes(BYPASS_COOKIE)) return undefined
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === BYPASS_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** A hívó szerepei, ha a hitelesítés már lefutott. */
function rolesOf (request: FastifyRequest): readonly string[] {
  const user = request.user as { roles?: unknown } | undefined
  return Array.isArray(user?.roles) ? user.roles.map(String) : []
}

/**
 * A döntés meghozatala egy kérésre.
 *
 * Kivételt SOHA nem dob: egy elhasalt karbantartás-ellenőrzés nem lehet
 * kiesés. Hiba esetén átengedünk — ugyanaz a szabály, mint a biztonsági
 * rétegnél, és ugyanazért: a saját hibánk ne zárja ki a látogatókat.
 */
export async function evaluate (request: FastifyRequest): Promise<Decision> {
  const configuration = cachedConfig()

  // A jegy ellenőrzése CSAK akkor, ha van jegy ÉS egyáltalán korlátozunk. Egy
  // kikapcsolt karbantartás mellett a jegy kérdése fel sem merül.
  let hasBypassToken = false
  if (configuration.enabled && configuration.mode !== MODE.OFF) {
    const token = tokenFrom(request)
    // Az olcsó aláírás-ellenőrzés előbb: egy szemét érték így nem terheli az
    // adatbázist.
    if (token && verifySignature(token).ok) {
      const result = await checkBypass(token, request.url)
      hasBypassToken = result.valid
      if (!result.valid) request.log.debug({ reason: result.reason }, 'karbantartási jegy elutasítva')
    }
  }

  const session = request.user as { iat?: number } | undefined
  return decide(configuration, new Date(), {
    url: request.url,
    method: request.method,
    roles: rolesOf(request),
    hasBypassToken,
    internal: isInternalRequest(request),
    hasSession: Boolean(request.user),
    // A JWT `iat` másodpercben van; a kiürítés pillanatokat hasonlít össze.
    sessionStartedAt: typeof session?.iat === 'number' ? new Date(session.iat * 1000) : null
  })
}

/**
 * A válasz, amit a visszautasított kérő kap.
 *
 * Böngészőnek OLDAL, gépnek JSON — ugyanaz a szabály, mint a
 * sebességkorlátnál, és ugyanaz a közös oldalrajzoló.
 *
 * Amit a válasz NEM tartalmaz (5. pont): adatbázis-információt, belső
 * gépnevet, hívásvermet, titkot, infrastruktúra-részletet. Az `reason` mező
 * a NAPLÓBA megy, nem a válaszba.
 */
export function respond (request: FastifyRequest, reply: FastifyReply, decision: Decision): FastifyReply {
  const configuration = cachedConfig()
  const retryAfter = decision.retryAfter ?? 120

  reply.header('Retry-After', String(retryAfter))
  reply.header('Cache-Control', 'no-store')
  reply.header('X-Yume-Maintenance', 'true')
  reply.header('X-Request-ID', String(request.id))

  if (wantsHtml(request.headers.accept)) {
    return reply.code(503).type('text/html; charset=utf-8').send(renderStatusPage({
      status: 503,
      title: configuration.title || 'Karbantartás',
      message: configuration.publicMessage || 'A YUME rövidesen újra elérhető lesz.',
      retryAfter,
      requestId: String(request.id)
    }))
  }

  return reply.code(503).type('application/json; charset=utf-8').send({
    error: {
      code: 'YUME_MAINTENANCE',
      mode: decision.mode,
      scope: decision.scope,
      message: configuration.publicMessage || 'YUME is temporarily unavailable.',
      retryAfter,
      requestId: String(request.id)
    }
  })
}

/**
 * A hook, ami a kérési útra kerül.
 *
 * `undefined`-ot ad, ha a kérés mehet tovább; különben ő maga válaszol.
 */
export async function guard (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  let decision: Decision
  try {
    decision = await evaluate(request)
  } catch (error) {
    // A saját hibánk nem zárhat ki senkit.
    request.log.error({ err: error }, 'a karbantartás kiértékelése elhasalt — a kérés átengedve')
    return undefined
  }

  request.maintenance = decision
  if (decision.kind === DECISION.ALLOW) return undefined

  request.log.info({
    mode: decision.mode, scope: decision.scope, reason: decision.reason, url: request.url
  }, 'karbantartás: kérés visszautasítva')

  return respond(request, reply, decision)
}
