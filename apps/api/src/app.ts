// App factory: builds the configured Fastify instance (separated from
// index.ts so tests can build an app without binding a port).

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import mediaRoutes from './modules/media/routes.ts'
import mercurius from 'mercurius'
import Fastify from 'fastify'

import { randomUUID } from 'node:crypto'

import { GraphQLError, type ValidationRule } from 'graphql'

import { config } from './config.ts'
import { query } from './infrastructure/database/index.ts'
import { errorCode } from './errors/codes.ts'
import { recordError } from './errors/reporting.ts'
import { noIndexPath } from './modules/seo/meta.ts'
import { settings as siteSettings } from './modules/settings/site-settings.ts'
import { schema, resolvers, loaders } from './graphql/schema.ts'
import wsPlugin from './infrastructure/websocket/index.ts'
import authPlugin, { tokenIsCurrent } from './middleware/auth.ts'
import securityPlugin from './middleware/security.ts'
import animeRoutes from './modules/catalogue/public-routes.ts'
import authRoutes from './modules/auth/routes.ts'
import commentRoutes from './modules/comments/routes.ts'
import w2gRoutes from './modules/watch-together/routes.ts'
import adminRoutes from './modules/admin/routes.ts'
import changelogRoutes from './modules/changelog/routes.ts'
import chatRoutes from './modules/chat/routes.ts'
import forumRoutes from './modules/forum/routes.ts'
import announcementRoutes from './modules/announcements/routes.ts'
import profileRoutes from './modules/profiles/routes.ts'
import webhookRoutes from './modules/webhooks/routes.ts'
import { publicConfig, adminConfig } from './modules/settings/config-routes.ts'
import { publicThemes, adminThemes } from './modules/themes/routes.ts'
import roleRoutes from './modules/authorization/routes.ts'
import catalogueRoutes from './modules/catalogue/admin-routes.ts'
import { publicReadiness, adminMonitoring } from './modules/system/routes.ts'
import reportRoutes from './modules/moderation/routes.ts'
import securityRoutes from './modules/security/routes.ts'
import backupRoutes from './modules/backups/routes.ts'
import analyticsAdmin from './modules/analytics/admin-routes.ts'
import edgeAdmin from './modules/edge/admin-routes.ts'
import { guard as edgeGuard, observe as edgeObserve } from './modules/edge/index.ts'
import analyticsCollect from './modules/analytics/collect-routes.ts'
import seoRoutes from './modules/seo/routes.ts'
import libraryRoutes from './modules/library/routes.ts'
import settingsRoutes from './modules/settings/routes.ts'
import translationRoutes from './modules/translations/routes.ts'

import type { FastifyError, FastifyInstance } from 'fastify'
import { renderStatusPage, wantsHtml } from './infrastructure/http/status-page.ts'
import { guard as maintenanceGuard } from './modules/maintenance/middleware.ts'
import { watch as watchMaintenance } from './modules/maintenance/cache.ts'
import { stopListener } from './infrastructure/queue/wake.ts'
import { adminMaintenance, publicStatus } from './modules/maintenance/routes.ts'
import { verifyMediaBase } from './modules/media/public-url.ts'

/**
 * Reject introspection queries.
 *
 * Mercurius has no switch for this — `graphiql: false` hides the IDE but the
 * schema stays readable — so it is enforced as a GraphQL validation rule,
 * which runs before any resolver.
 */
const noIntrospection: ValidationRule = context => ({
  Field (node) {
    if (node.name.value === '__schema' || node.name.value === '__type') {
      context.reportError(new GraphQLError('GraphQL introspection is disabled'))
    }
  }
})

export async function buildApp (): Promise<FastifyInstance> {
  const app = Fastify({
    // LOG_LEVEL is honoured so a test run can silence request logging: the
    // browser smoke test loads ~40 static files per page and the noise buries
    // the assertions it is there to report.
    logger: { level: process.env.LOG_LEVEL ?? (config.isProd ? 'info' : 'debug') },
    // A stable id per request, echoed back on every response. Without it a
    // user reporting "it failed at 14:03" cannot be tied to a log line, and a
    // 500 gives them nothing to quote.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    // Never a blanket true — see config.trustProxy for why that made the rate
    // limiter bypassable with a single header.
    trustProxy: config.trustProxy,
    // Cap request bodies. Nothing Yume accepts is large — the biggest payloads
    // are comment text and catalogue synopses — so this bounds memory
    // use from hostile requests. Fastify's default is the same 1 MB; setting it
    // explicitly makes the intent (and the place to change it) obvious.
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES ?? 1_048_576),
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.connectionTimeoutMs
  })

  await app.register(securityPlugin)
  // Reads and writes exactly one cookie: the HttpOnly refresh token. No
  // secret, because nothing here is signed — the token is a random 32 bytes
  // whose hash is a row in `sessions`, so the database is what validates it.
  await app.register(cookie)
  // `credentials` so the refresh cookie survives a cross-origin deployment —
  // a separately hosted web client, which is what CORS_ORIGINS is for. It is
  // only ever paired with an explicit origin list: `corsOrigins()` turns a
  // wildcard into `false` in production, and allowing credentials from `*` is
  // the combination that makes a cookie readable by any site that asks.
  //
  // Note for that deployment: the cookie is SameSite=Strict, which is right
  // for the single-origin container this normally runs as and will stop a
  // genuinely cross-site client from sending it. Such a deployment needs
  // SameSite=None, which needs Secure, which needs TLS on both ends.
  await app.register(cors, { origin: config.corsOrigins, credentials: config.corsOrigins !== false })
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
    /**
     * A GraphQL endpoint accepts a query the caller composes, so unlike REST
     * the cost of one request is not bounded by the route. Nested relations
     * (anime → relations → anime → …) let a short query ask for an enormous
     * result, which is a denial of service that needs no special tooling.
     *
     * Depth is capped, and query text is capped too — the parser runs before
     * any resolver, so an enormous document costs CPU whatever it asks for.
     */
    queryDepth: Number(process.env.GRAPHQL_MAX_DEPTH ?? 10),
    allowBatchedQueries: false,
    /**
     * Introspection publishes the whole schema — every type, field and
     * argument. Invaluable while developing, and in production it is a map
     * for anyone looking for a resolver to abuse. Mercurius has no flag for
     * this, so it is enforced as a validation rule.
     */
    validationRules: config.isProd ? [noIntrospection] : [],
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
            const { queryOne } = await import('./infrastructure/database/index.ts')
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

  /**
   * Error handling.
   *
   * This MUST be registered before any route: Fastify binds the handler that
   * exists in the encapsulation context at the moment a route is added, so a
   * handler set afterwards silently does not apply. It was set after the route
   * registrations, which meant none of this ran — route errors fell through to
   * Fastify's default handler, which returns the raw exception message. An
   * unauthenticated caller could read database error text, SQL state codes and
   * the offending value straight out of a 500.
   */
  /*
   * Every failure carries a code and the id that identifies it.
   *
   * The error handler below only sees errors that were *thrown*. Most of this
   * codebase's refusals are returned instead — `reply.code(404).send({...})`
   * for a hidden admin route, a 401 for a bad password, a 400 for a bad body —
   * and those went out with neither, so the two things a person needs in order
   * to report a failure were present on some of them and absent from most.
   *
   * Doing it on the way out is the only place that sees both kinds. The cost
   * is one parse per failed response and nothing at all on a successful one.
   *
   * Existing fields win: a handler that has already said `code` or `instance`
   * meant it.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload
    if (typeof payload !== 'string' || !payload.startsWith('{')) return payload
    const type = String(reply.getHeader('content-type') ?? '')
    if (!type.includes('json')) return payload

    try {
      const body = JSON.parse(payload) as Record<string, unknown>
      // Only problem documents. A route that answers 4xx with its own domain
      // shape is not ours to rewrite.
      if (typeof body.status !== 'number' || typeof body.title !== 'string') return payload
      if (body.code !== undefined && body.instance !== undefined) return payload

      body.instance ??= request.id
      body.code ??= errorCode(request.routeOptions?.url ?? request.url, reply.statusCode)
      return JSON.stringify(body)
    } catch {
      // Unparseable, or not ours. Send it exactly as it was.
      return payload
    }
  })

  /**
   * A `Retry-After` fejléc értéke másodpercben.
   *
   * A sebességkorlát számot tesz rá, de a szabvány HTTP-dátumot is enged —
   * és egy dátumot másodpercként értelmezve a visszaszámláló évezredeket
   * mutatna.
   */
  const retryAfterSeconds = (header: unknown): number | null => {
    if (typeof header === 'number') return header > 0 ? header : null
    if (typeof header !== 'string' || !header) return null
    if (/^\d+$/.test(header)) return Number(header) || null
    const at = Date.parse(header)
    if (!Number.isFinite(at)) return null
    return Math.max(1, Math.round((at - Date.now()) / 1000))
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Some throwers — the rate limiter's errorResponseBuilder among them —
    // reject with a plain object already in this app's problem+json shape
    // rather than an Error carrying statusCode. Passing those through
    // unchanged keeps their status: reading only `statusCode` turned every
    // 429 into a 500.
    // The route *pattern* where Fastify has one — /v1/anime/:id rather than
    // the id somebody happened to pass — so the same fault yields the same
    // code whatever it was called with.
    const route = request.routeOptions?.url ?? request.url

    const shaped = error as unknown as { status?: number, title?: string, detail?: string, type?: string }
    if (typeof shaped.status === 'number' && typeof shaped.title === 'string') {
      /*
       * A BÖNGÉSZŐNEK OLDAL JÁR, NEM JSON.
       *
       * A sebességkorlát válasza eddig `application/problem+json` volt minden
       * hívónak. Aki géppel hív, annak ez a helyes; aki viszont a címsorba
       * írta be a címet, az egy nyers JSON-t kapott a képernyőre — ami nem
       * hibaüzenet, hanem egy elrontott oldal látszata.
       *
       * A döntést az `Accept` fejléc hozza: a böngésző navigációja `text/html`-t
       * kér ELŐBB, a `fetch` és a `curl` nem. A `*​/*` szándékosan nem elég.
       */
      if (wantsHtml(request.headers.accept)) {
        const seconds = retryAfterSeconds(reply.getHeader('retry-after'))
        return reply.code(shaped.status).type('text/html; charset=utf-8').send(renderStatusPage({
          status: shaped.status,
          title: shaped.status === 429 ? 'Túl sok kérés' : (shaped.title ?? 'Hiba'),
          message: shaped.status === 429
            ? 'Egy kicsit gyorsan érkeztek a kérések erről a hálózatról. Ez nem tiltás — pár másodperc múlva folytathatod.'
            : 'A kérést most nem tudjuk kiszolgálni.',
          retryAfter: seconds,
          requestId: request.id,
          // Oda vissza, ahonnan jött — nem a főoldalra.
          retryHref: request.url
        }))
      }
      return reply.code(shaped.status).type('application/problem+json')
        .send({ ...shaped, instance: request.id, code: errorCode(route, shaped.status) })
    }

    const status = error.statusCode ?? 500
    const code = errorCode(route, status)
    if (status >= 500) {
      request.log.error(error)
      // Persist it so the admin error view reflects reality. Fire-and-forget:
      // the response must not wait on telemetry, and a telemetry failure must
      // never replace the error the caller actually hit.
      //
      // `requestId` is what makes the id in the response body worth quoting:
      // without it the message asked a user to carry a number that led
      // nowhere, because the occurrence an operator can search did not have it.
      void recordError('api', error, {
        route,
        method: request.method,
        statusCode: status,
        code,
        requestId: request.id,
        userId: (request.user as { sub?: string } | undefined)?.sub
      })
    }
    void reply.code(status).type('application/problem+json').send({
      type: 'about:blank',
      title: status >= 500 ? 'Internal Server Error' : error.message,
      status,
      // A 5xx body must not leak internals, but it can carry the id that ties
      // the report to the log line and the recorded error group.
      detail: status >= 500 ? `Request ${request.id} failed — quote this id when reporting it` : error.message,
      instance: request.id,
      code
    })
  })

  /*
   * A hiányzó törzs nem hiba ott, ahol semmi sem kötelező benne.
   *
   * Egy `POST` törzs nélkül és egy `POST {}` ugyanazt kéri — de a séma az
   * elsőre 400-at adott („body must be object"), mert az AJV a `undefined`-ot
   * nem tekinti objektumnak. Ez néma hibákat okozott a hívó oldalán, és
   * egyszer biztonságit is: a törzs nélküli `POST /v1/auth/logout` 400-at
   * kapott, a munkamenet NEM lett visszavonva, és a hozzáférési token további
   * tizenöt percig működött. A böngészőkliens csak azért kerülte el, mert
   * mindig küld `{}`-t; a `navigator.sendBeacon`, a `curl` és bármely másik
   * kliens nem köteles.
   *
   * A szabály szűk szándékosan: CSAK akkor egészítjük ki `{}`-ra a törzset, ha
   * az útvonal sémája egyetlen mezőt sem követel meg. Ahol van `required`, ott
   * a hiányzó törzs továbbra is 400 — a hiányzó jelszó hiányzó jelszó marad.
   */
  app.addHook('preValidation', async (request) => {
    if (request.body !== undefined && request.body !== null) return
    const body = request.routeOptions?.schema?.body as
      { type?: string, required?: unknown } | undefined
    if (!body || body.type !== 'object') return
    if (Array.isArray(body.required) && body.required.length) return
    request.body = {}
  })

  // The global body limit is sized for REST payloads; a GraphQL document is
  // parsed before anything else, so it gets its own, tighter ceiling.
  app.addHook('preValidation', async (request, reply) => {
    if (request.url.startsWith('/graphql') && typeof (request.body as { query?: string })?.query === 'string') {
      const document = (request.body as { query: string }).query
      if (document.length > Number(process.env.GRAPHQL_MAX_LENGTH ?? 8_000)) {
        return reply.code(413).send({
          type: 'about:blank', title: 'Payload Too Large', status: 413,
          detail: 'GraphQL query is too long'
        })
      }
    }
  })

  /*
   * Private instances: the whole API needs a signed-in caller.
   *
   * `require_login` was stored, echoed back in /v1/config, and enforced only
   * by the web client's route gate — which is a suggestion, not a lock. An
   * operator who switched their instance to private still served the entire
   * catalogue, and every other read endpoint, to anyone who called the API
   * directly or simply opened it in a second browser.
   *
   * Three paths stay open, because they are what a signed-out caller needs in
   * order to stop being signed out: the readiness probes (a private instance
   * must still be monitorable), the config document that tells the client the
   * site is private in the first place, and the auth endpoints themselves.
   * Everything else under /v1 and /graphql needs a live token.
   *
   * The setting is read through the cached reader, so the common case — a
   * public instance — costs one map lookup per request, not a query.
   */
  const loginExempt = /^\/v1\/(health|config|auth)\b/
  app.addHook('onRequest', async (request, reply) => {
    if (!/^\/(v1|graphql)\b/.test(request.url)) return
    if (loginExempt.test(request.url)) return
    if (!await siteSettings.requiresLogin()) return
    try {
      await request.jwtVerify()
    } catch {
      return reply.code(401).send({
        type: 'about:blank', title: 'Unauthorized', status: 401,
        detail: 'This instance is private — sign in to continue'
      })
    }
    // A banned account or a revoked session must not keep the door open on an
    // instance whose whole point is that it is closed.
    if (!await tokenIsCurrent(request.user)) {
      return reply.code(401).send({
        type: 'about:blank', title: 'Unauthorized', status: 401,
        detail: 'This session has been revoked — sign in again'
      })
    }
  })

  /*
   * Read-only mode.
   *
   * The emergency lever: refuse everything that writes, keep everything that
   * reads. For an instance under attack, mid-incident, or being restored — a
   * site that answers but changes nothing is a far better state than one that
   * is switched off, and it is the state you actually want while working out
   * what happened.
   *
   * Three exemptions, each of them the reason the mode is survivable:
   *
   *   * /v1/auth — sign-in, refresh and sign-out. Locking people out of their
   *     own sessions is not what read-only means, and an operator who cannot
   *     sign in cannot turn it off.
   *   * /v1/admin/config — the switch itself. Without this the mode has no
   *     exit that is not a database console.
   *   * /v1/admin/security — the other emergency controls, for the same reason.
   *   * /v1/admin/backups — and this one is not a convenience. A restore is
   *     REFUSED unless the instance is in read-only mode, because a write
   *     arriving mid-restore either vanishes or lands in a half-restored
   *     database. Without this exemption the two rules met in the middle and
   *     the restore button could never be pressed at all: read-only is its
   *     precondition, and read-only is what blocked it.
   *
   * 503 with Retry-After, not 403: nothing is wrong with the caller or their
   * permissions, the instance is deliberately not accepting this right now,
   * and a client that retries later is behaving correctly.
   *
   * Background jobs are untouched. This is about what the site accepts from
   * outside; freezing the worker would stop the stats and partition
   * maintenance that keep the instance healthy while somebody works.
   */
  /*
   * YUME Edge — a kockázati réteg.
   *
   * A sebességkorlát UTÁN fut, és szándékosan: az a nyers mennyiséget fogja
   * meg, olcsón, és ami ott fennakad, azzal itt már nem kell foglalkozni. Ez
   * a réteg a MINTÁT nézi — mit kér, honnan, milyen ütemben, milyen
   * előzménnyel.
   *
   * Alapból SZÁRAZON fut: mindent kiértékel és naplóz, de semmit nem utasít
   * vissza. Így a bekapcsolása nem kockázat, és egy hét múlva a naplóból
   * lehet eldönteni, hol állnak a küszöbök. Az éles üzemre váltás egy
   * beállítás a panelen.
   *
   * Kivételt nem dob és nem is enged ki: a `guard` maga kezeli a hibáit a
   * fail-open/fail-closed szabály szerint. Egy biztonsági réteg hibája ne
   * legyen kiesés.
   */
  app.addHook('onRequest', async (request, reply) => {
    const decision = await edgeGuard(request)
    if (!decision) return

    if (decision.effective === 'throttle') {
      return reply.code(429)
        .header('Retry-After', String(decision.retryAfter ?? 30))
        .send({
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          detail: 'Túl sok kérés érkezett erről a címről. Próbáld újra kicsit később.'
        })
    }

    return reply.code(403)
      .header('Retry-After', String(decision.retryAfter ?? 60))
      .send({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        // A pontszámot és a jeleket SZÁNDÉKOSAN nem adjuk vissza: abból egy
        // támadó megtudná, melyik jel mennyit ér, és addig hangolna, amíg
        // alá nem megy. A naplóban minden benne van.
        detail: 'A kérést a biztonsági réteg visszautasította.'
      })
  })

  /*
   * KARBANTARTÁSI MÓD.
   *
   * A sebességkorlát és a kockázati réteg UTÁN fut, és szándékosan: azok
   * olcsóbbak, és amit ott elutasítunk, azzal itt már nem kell foglalkozni.
   * A hitelesítés ELŐTT viszont — a döntéshez elég a szerep, ha már megvan, és
   * egy karbantartás alatt álló oldalon nem akarunk minden kérésre tokent
   * ellenőrizni.
   *
   * Kérésenként NULLA adatbázis-lekérdezés: a beállítás memóriából jön,
   * értesítéssel és lejárati idővel frissítve. Adatbázishoz csak akkor
   * nyúlunk, ha a kérésen TÉNYLEGESEN van mentességi jegy.
   */
  app.addHook('onRequest', maintenanceGuard)

  /*
   * Feliratkozás a karbantartás változásaira.
   *
   * A meglévő, újracsatlakozó hallgató kapcsolatot használja — nem nyit
   * másodikat. Ha nincs még kapcsolat (az API folyamatban nem fut a
   * feladatsor), a feliratkozás elindítja.
   */
  watchMaintenance()

  /*
   * A hallgató kapcsolat a folyamat lezárásakor is záruljon.
   *
   * Egy élő PostgreSQL-kapcsolat életben tartja az eseményhurkot: enélkül a
   * `app.close()` visszatér, a folyamat mégsem lép ki. Élesben ez „a konténer
   * nem áll le"-ként jelentkezne, tesztben pedig egy örökre váró futásként —
   * és az utóbbi meg is történt.
   */
  app.addHook('onClose', async () => { stopListener() })

  /*
   * A beállított képforrás ellenőrzése — induláskor, egyszer, a háttérben.
   *
   * Nem tartja fel az indulást, és nem esik vissza magától: egyetlen dolga,
   * hogy ha a cím nem szolgál ki, azt VALAKI MEGTUDJA. Enélkül az oldal
   * minden képe törött, és a naplóban egy sor sincs róla — a hiba a látogató
   * böngészőjében történik, nem nálunk.
   */
  app.ready(() => {
    void (async () => {
      try {
        const { queryOne } = await import('./infrastructure/database/index.ts')
        const row = await queryOne<{ mirror_key: string }>(
          'SELECT mirror_key FROM anime_images WHERE mirror_key IS NOT NULL LIMIT 1'
        )
        await verifyMediaBase(row?.mirror_key ?? null, app.log)
      } catch {
        // Az ellenőrzés hibája nem akadályozhatja az indulást.
      }
    })()
  })

  /*
   * A RÉGI CSAK-OLVASHATÓ KAPCSOLÓ.
   *
   * Megmarad, változatlan viselkedéssel. Nem azért, mert nem lehetne beolvasztani
   * a `READ_ONLY` módba, hanem mert egy meglévő telepítés viselkedése nem
   * változhat meg csendben egy átállástól: aki ma be van kapcsolva, annak
   * holnap is pontosan ugyanaz történjen.
   *
   * A kettő EGYÜTT hat, és a szigorúbb nyer — a karbantartás hookja fentebb
   * fut, tehát ami ott elbukik, ide el sem jut.
   */
  const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  const readOnlyExempt = /^\/v1\/(auth|admin\/(config|security|backups|maintenance))\b/
  app.addHook('onRequest', async (request, reply) => {
    if (!WRITES.has(request.method)) return
    if (!/^\/(v1|graphql)\b/.test(request.url)) return
    if (readOnlyExempt.test(request.url)) return
    if (!await siteSettings.readOnly()) return
    return reply.code(503).header('Retry-After', '120').send({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'This instance is in read-only mode and is not accepting changes right now'
    })
  })

  await app.register(publicStatus, { prefix: '/v1/status' })
  await app.register(adminMaintenance, { prefix: '/v1/admin/maintenance' })
  await app.register(publicConfig, { prefix: '/v1/config' })
  await app.register(publicThemes, { prefix: '/v1/themes' })
  await app.register(adminThemes, { prefix: '/v1/admin/themes' })
  await app.register(adminConfig, { prefix: '/v1/admin/config' })
  await app.register(authRoutes, { prefix: '/v1/auth' })
  await app.register(animeRoutes, { prefix: '/v1/anime' })
  await app.register(libraryRoutes, { prefix: '/v1/me' })
  await app.register(settingsRoutes, { prefix: '/v1/me' })
  await app.register(profileRoutes, { prefix: '/v1/profiles' })
  await app.register(announcementRoutes, { prefix: '/v1/announcements' })
  await app.register(commentRoutes, { prefix: '/v1/comments' })
  await app.register(forumRoutes, { prefix: '/v1/forum' })
  await app.register(chatRoutes, { prefix: '/v1/chat' })
  await app.register(changelogRoutes, { prefix: '/v1/changelog' })
  await app.register(w2gRoutes, { prefix: '/v1/w2g' })
  await app.register(reportRoutes, { prefix: '/v1/reports' })
  await app.register(adminRoutes, { prefix: '/v1/admin' })
  await app.register(translationRoutes, { prefix: '/v1/admin/translations' })
  await app.register(webhookRoutes, { prefix: '/v1/admin/webhooks' })
  await app.register(roleRoutes, { prefix: '/v1/admin/roles' })
  await app.register(catalogueRoutes, { prefix: '/v1/admin/catalogue' })
  await app.register(securityRoutes, { prefix: '/v1/admin/security' })
  await app.register(backupRoutes, { prefix: '/v1/admin/backups' })
  await app.register(analyticsAdmin, { prefix: '/v1/admin/analytics' })
  await app.register(edgeAdmin, { prefix: '/v1/admin/edge' })
  // Látogatottság: egyetlen, hitelesítés nélkül is hívható végpont, ami
  // pontosan egy dolgot fogad el a klienstől (melyik oldalra lépett). Minden
  // más a kiszolgálóé — lásd modules/analytics/collect-routes.ts.
  await app.register(analyticsCollect, { prefix: '/v1/analytics' })
  await app.register(publicReadiness, { prefix: '/v1/health' })
  await app.register(adminMonitoring, { prefix: '/v1/admin/monitoring' })

  /*
   * What of the web root is actually the client.
   *
   * `web/` is the document root, and it holds more than the browser runs:
   * apps/web/test/ lives there, so nineteen test files — including the end-to-end
   * ones, which spell out the admin permission model and the security
   * invariants they check — were downloadable from the deployment. `COPY web/`
   * put them in the image too.
   *
   * An allowlist rather than a list of things to exclude. Excluding is a
   * promise to remember every future directory somebody adds under web/;
   * allowing is a statement of what the page loads, which is short, changes
   * rarely, and fails closed.
   *
   * A refused path is not an error: it falls through to the SPA handler and
   * gets index.html, exactly like any other address with no file behind it. A
   * probe learns nothing about what is there — which is the same reason
   * `/.env` and `/../apps/api/src/config.ts` already answered with the page
   * rather than with a 403 that would have confirmed the path shape.
   *
   * This is about not shipping what the browser has no use for. It is *not*
   * an attempt to hide the client's own code: the browser has to download and
   * run js/ and css/ for the site to work, so anything served there is
   * readable by anybody who loads the page, and no amount of server
   * configuration changes that.
   */
  const CLIENT_DIRS = ['assets', 'css', 'src']
  const CLIENT_FILES = ['index.html', 'favicon.ico', 'robots.txt', 'manifest.webmanifest']

  const allowedPath = (pathName: string): boolean => {
    const clean = pathName.replace(/^\/+/, '')
    if (clean === '' || CLIENT_FILES.includes(clean)) return true
    const top = clean.split('/')[0]
    return top !== undefined && CLIENT_DIRS.includes(top)
  }

  // Serve the static web client from the same origin so the whole app runs as
  // one container/port (WEB_ROOT overrides; defaults to the repo's web/).
  const webRoot = process.env.WEB_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '../../web')
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      index: 'index.html',
      // Never a directory index. It is off by default; saying so is cheap and
      // the failure mode — an index of the client's whole asset tree — is the
      // kind that arrives by upgrade rather than by edit.
      list: false,
      dotfiles: 'ignore',
      allowedPath
    })
    /**
     * robots.txt, sitemap.xml, and /anime/:id with a real <head>.
     *
     * Registered after fastify-static so it shares the same resolved webRoot,
     * and it wins over the static wildcard because find-my-way prefers a
     * literal segment to a `*`. See lib/seo.ts for why a path-shaped anime
     * route exists alongside the client's own #/anime/:id.
     */
    await app.register(seoRoutes, { webRoot })

    /*
     * A letükrözött katalógusképek. Ugyanazért kerül ide, amiért a `seoRoutes`:
     * a `find-my-way` a literális szegmenst elébe helyezi a statikus `*`-nak,
     * tehát a `/media/...` ide fut be, nem a fájlkiszolgálóhoz.
     */
    await app.register(mediaRoutes)

    /**
     * SPA fallback: any non-API GET that isn't a real file returns index.html.
     *
     * Except a file the client asked for by name. `/#/anything` is a route and
     * gets the page; `/src/pages/gone.js` is a missing asset and gets a 404.
     *
     * The difference used to be invisible, and it cost a day. A module that
     * stops resolving — moved by a restructure, mistyped in a path — was
     * answered with index.html and a 200. The browser refuses to execute HTML
     * as a module, so the page went blank, while every check an operator makes
     * reported health: the JS URL returned 200 and the server logged nothing,
     * because as far as it knew nothing had gone wrong.
     *
     * Anything under the client's own directories is a file request, whatever
     * it ends in, and so are the handful of files served from the root.
     */
    const isClientAsset = (url: string): boolean => {
      const pathName = url.split('?')[0] ?? ''
      const clean = pathName.replace(/^\/+/, '')
      if (CLIENT_FILES.includes(clean)) return true
      const top = clean.split('/')[0]
      return top !== undefined && CLIENT_DIRS.includes(top)
    }

    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !/^\/(v1|graphql|graphiql|ws)\b/.test(request.url) && !isClientAsset(request.url)) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).type('application/problem+json').send({ type: 'about:blank', title: 'Not Found', status: 404 })
    })
    app.log.info(`serving web client from ${webRoot}`)
  }

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id)

    /**
     * Keep the API and the operator surface out of search indexes.
     *
     * `/admin` is not an API path — it is an ordinary client route, and the
     * SPA fallback answers it with index.html and a 200. Without this, a
     * crawler indexes an instance's admin panel, and the sign-in refusal it
     * renders is no comfort: the URL is then a public fact. The route also
     * emits <meta name="robots">, because a crawler that reads only one of the
     * two exists in both directions.
     */
    if (noIndexPath(request.url) && !reply.getHeader('X-Robots-Tag')) {
      reply.header('X-Robots-Tag', 'noindex')
    }

    /**
     * RFC 9457 says a problem document is served as application/problem+json.
     * The error handler sets that, but the many routes that build their own
     * 404/403/400 with reply.code(...).send({ type, title, status }) inherit
     * Fastify's default application/json — so byte-identical bodies arrived
     * under two different media types depending on which code path produced
     * them. A client that switches on Content-Type sees an error document as
     * an ordinary payload.
     *
     * Corrected here rather than in each route: one rule, and a route added
     * later cannot forget it. Only a body that really is a problem document
     * is relabelled, so ordinary JSON is untouched.
     */
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      const type = reply.getHeader('Content-Type')
      if (typeof type === 'string' && type.startsWith('application/json')) {
        try {
          const body = JSON.parse(payload) as { type?: unknown, title?: unknown, status?: unknown }
          if (typeof body.title === 'string' && typeof body.status === 'number' && typeof body.type === 'string') {
            reply.header('Content-Type', 'application/problem+json; charset=utf-8')
          }
        } catch { /* not JSON after all — leave it alone */ }
      }
    }
    return payload
  })

  /**
   * Sampled response timing.
   *
   * performance_metrics was created, partitioned and given a retention policy,
   * and then never written to — the maintenance job has been keeping empty
   * partitions tidy. The table's own comment specifies 1% sampling, which is
   * what this does: enough to see a p95 move, cheap enough to ignore.
   *
   * The route pattern is recorded, never the URL, so an id in a path cannot
   * turn into a million distinct labels (or leak into an analytics table).
   */
  const SAMPLE_RATE = Number(process.env.PERF_SAMPLE_RATE ?? 0.01)
  app.addHook('onResponse', async (request, reply) => {
    // Amit csak a VÁLASZBÓL lehet tudni: hány nem létező címet kért ez a cím,
    // hány sikertelen belépése volt. Ezek a KÖVETKEZŐ kérés bizonyítékai, és
    // memóriában gyűlnek — nincs írás.
    edgeObserve(request, reply.statusCode)

    // Always keep the slow ones: a 1% sample of a rare 3-second request is
    // usually zero rows, which is exactly the request worth seeing.
    const elapsed = reply.elapsedTime
    if (Math.random() >= SAMPLE_RATE && elapsed < 1_000) return
    void query(
      'INSERT INTO performance_metrics (metric, value_ms, labels) VALUES ($1, $2, $3)',
      ['api.latency', elapsed.toFixed(2), {
        route: request.routeOptions?.url ?? 'unmatched',
        method: request.method,
        status: reply.statusCode
      }]
    ).catch(() => {}) // telemetry must never affect the response
  })


  return app
}
