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
import { resolveVideo } from './video-resolver.ts'
import { loadRoles, sessionStartedAt, tokenIsCurrent } from '../../middleware/auth.ts'
import { pathOf } from '../../infrastructure/http/request-path.ts'

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
    if (name !== BYPASS_COOKIE) continue
    /*
     * A hibás kódolás NEM kivétel. A `decodeURIComponent` egy `%E0`-ra
     * `URIError`-t dob, a guard pedig a kiértékelés hibájára átenged — így
     * egy szándékosan elrontott süti a karbantartás teljes megkerülése volt.
     */
    try {
      return decodeURIComponent(rest.join('='))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Ki a hívó — csak akkor kérdezzük meg, ha a döntés ezen múlik. */
interface Identity {
  roles: readonly string[]
  sessionStartedAt: Date | null
}

/**
 * A hívó szerepei és a bejelentkezése kezdete, érvényes token esetén.
 *
 * A JWT-ben NINCS szerep, és az `onRequest` szakaszban a `request.user` csak
 * akkor van kitöltve, ha a privát példány kapuja már ellenőrizte a tokent. A
 * korábbi `rolesOf` ezért mindig üres listát adott: a személyzeti kivétel és a
 * kiürítési idő halott kód volt. Itt maga a karbantartás ellenőriz — de csak
 * akkor, ha a kérést egyébként visszautasítanánk, így a normál forgalomra ez
 * nulla költség.
 *
 * A kezdet a bejelentkezés ideje (`sessions.started_at`), nem a hozzáférési
 * token `iat`-ja: az negyedóránként megújul, tehát a kiürítés mindenkit
 * „új munkamenetnek" látott volna, aki közben frissített.
 */
async function identify (request: FastifyRequest): Promise<Identity | null> {
  let payload = request.user
  if (!payload?.sub) {
    const header = request.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    try {
      payload = await request.jwtVerify()
    } catch {
      return null
    }
  }
  if (!await tokenIsCurrent(payload)) return null
  const [roles, startedAt] = await Promise.all([
    loadRoles(payload.sub),
    payload.sid ? sessionStartedAt(payload.sid) : Promise.resolve(null)
  ])
  return { roles, sessionStartedAt: startedAt }
}

/**
 * A döntés meghozatala egy kérésre.
 *
 * Kivételt SOHA nem dob: egy elhasalt karbantartás-ellenőrzés nem lehet
 * kiesés. Hiba esetén átengedünk — ugyanaz a szabály, mint a biztonsági
 * rétegnél, és ugyanazért: a saját hibánk ne zárja ki a látogatókat.
 */
export async function evaluate (request: FastifyRequest, as: { method?: string } = {}): Promise<Decision> {
  const configuration = cachedConfig()
  // Az útvonal, amin a router illeszt — nem a nyers cél. Lásd
  // infrastructure/http/request-path.ts: a `/%761/...` a hatókör-szűrést is
  // kikerülte.
  const url = pathOf(request)
  /*
   * A GraphQL az olvasást is POST-tal küldi, tehát a metódus nála nem mond
   * semmit. Olvasásként engedjük át; a mutációkat a GraphQL `preExecution`
   * hookja utasítja el műveletenként (`writesAllowed`).
   */
  const method = as.method ?? (url === '/graphql' ? 'GET' : request.method)

  // A jegy ellenőrzése CSAK akkor, ha van jegy ÉS egyáltalán korlátozunk. Egy
  // kikapcsolt karbantartás mellett a jegy kérdése fel sem merül.
  let hasBypassToken = false
  if (configuration.enabled && configuration.mode !== MODE.OFF) {
    const token = tokenFrom(request)
    // Az olcsó aláírás-ellenőrzés előbb: egy szemét érték így nem terheli az
    // adatbázist.
    if (token && verifySignature(token).ok) {
      const result = await checkBypass(token, url)
      hasBypassToken = result.valid
      if (!result.valid) request.log.debug({ reason: result.reason }, 'karbantartási jegy elutasítva')
    }
  }

  const facts = {
    url,
    method,
    hasBypassToken,
    internal: isInternalRequest(request)
  }
  const first = decide(configuration, new Date(), facts)
  if (first.kind === DECISION.ALLOW) return first

  // Visszautasítanánk. Csak most derül ki, számít-e, ki a hívó.
  const who = await identify(request)
  if (!who) return first
  return decide(configuration, new Date(), {
    ...facts,
    roles: who.roles,
    hasSession: true,
    sessionStartedAt: who.sessionStartedAt
  })
}

/**
 * Fogadna-e most ÍRÁST ez a kérés.
 *
 * A GraphQL-nek kell: ott a metódusból nem derül ki, hogy a művelet ír-e, ezért
 * a mutáció maga kérdezi meg — ugyanazzal a döntéssel, mint egy POST.
 */
export async function writesAllowed (request: FastifyRequest): Promise<boolean> {
  try {
    return (await evaluate(request, { method: 'POST' })).kind === DECISION.ALLOW
  } catch {
    // Ugyanaz a szabály, mint a guardé: a saját hibánk nem zár ki senkit.
    return true
  }
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
export async function respond (request: FastifyRequest, reply: FastifyReply, decision: Decision): Promise<FastifyReply> {
  const configuration = cachedConfig()
  const retryAfter = decision.retryAfter ?? 120

  reply.header('Retry-After', String(retryAfter))
  reply.header('Cache-Control', 'no-store')
  reply.header('X-Yume-Maintenance', 'true')
  reply.header('X-Request-ID', String(request.id))

  if (wantsHtml(request.headers.accept)) {
    /*
     * A videó keresése CSAK a HTML-ágon.
     *
     * Egy gépi hívó 503-a percenként ezerszer is előfordulhat, és egy
     * könyvtárolvasás mindegyikhez fölösleges lemezmunka lenne. A
     * karbantartási OLDALT viszont ember nézi, és ott a videó a lényeg.
     *
     * Elhasalni sem tud: hiányzó könyvtár vagy videó esetén `null` jön
     * vissza, és az oldal ugyanúgy teljes.
     */
    let video: { url: string, type: string } | null = null
    try { video = await resolveVideo(null) } catch { video = null }

    return reply.code(503).type('text/html; charset=utf-8').send(renderStatusPage({
      status: 503,
      title: configuration.title || 'Karbantartás',
      message: configuration.publicMessage || 'A YUME rövidesen újra elérhető lesz.',
      retryAfter,
      requestId: String(request.id),
      retryHref: request.url,
      video
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

  return await respond(request, reply, decision)
}
