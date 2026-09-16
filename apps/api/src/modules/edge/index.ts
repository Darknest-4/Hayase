// YUME Edge — a forró út.
//
// Ez a fájl az, ami MINDEN kérésre lefut. Ezért a legfontosabb tulajdonsága
// nem az, hogy mit fog meg, hanem hogy mennyibe kerül:
//
//   * tiltáskeresés — memóriában, egy tízmásodperces pillanatképből;
//   * számlálók — memóriában, csúszó ablakkal;
//   * WAF — mintaillesztés az URL-en és a lekérdezésen, törzs nélkül;
//   * IP-intelligencia — memóriagyorsítótárból, ismeretlen címnél `null`;
//   * naplózás — pufferbe, kötegben kiírva.
//
// Adatbázis-lekérdezés a közös úton NINCS. Amikor mégis van (hálózati tiltás,
// ismeretlen cím), az a ritka eset, és a hívó kód sosem várja meg.
//
// A NEHÉZ ELEMZÉS A WORKERBEN VAN (`worker.ts`): a viselkedésminták
// kiértékelése, az IP-adatok frissítése, a napi összesítők. Ami itt fut, az
// annyi, amennyi a DÖNTÉSHEZ kell.
//
// A TÖRZSET SZÁNDÉKOSAN NEM NÉZZÜK a kérési útban. A Fastify a törzset a
// hitelesítés után, a séma szerint dolgozza fel; egy `onRequest` hookban még
// nincs is meg. A törzsvizsgálat ezért a `preHandler` szakaszban fut, és csak
// ott, ahol van törzs.

import { blocked, BanLookupFailed, autoBan } from './bans.ts'
import { cadence, hit, recent } from './counters.ts'
import { edgeConfig, inScope, type EdgeConfig } from './config.ts'
import { intelOf } from './ip-intel.ts'
import { recordDecision, recordSecurity } from './events.ts'
import { assess, noEvidence, sensitivityOf, type Assessment, type Evidence } from './risk.ts'
import { decide, onFailure, type Decision } from './policy.ts'
import { inspect, worst, type Hit } from './waf.ts'

import type { FastifyRequest } from 'fastify'

/**
 * A kérésenkénti korlátok.
 *
 * Ezek TÁGABBAK, mint a `@fastify/rate-limit` korlátai, és ez szándékos: az a
 * réteg a nyers mennyiséget fogja, ez a MINTÁT. Ami itt fennakad, az nem
 * attól gyanús, hogy sok, hanem attól, ahogy jön.
 */
const LIMITS = {
  ip: { burst: { max: 120, seconds: 10 }, sustained: { max: 1200, seconds: 300 }, cooldownSeconds: 0 },
  user: { burst: { max: 180, seconds: 10 }, sustained: { max: 2000, seconds: 300 }, cooldownSeconds: 0 },
  auth: { burst: { max: 10, seconds: 60 }, sustained: { max: 40, seconds: 3600 }, cooldownSeconds: 0 }
}

/** Amit a hook a kérésre akaszt, hogy a többi szakasz is lássa. */
export interface EdgeContext {
  decision: Decision
  assessment: Assessment
  evidence: Evidence
  waf: Hit[]
}

declare module 'fastify' {
  interface FastifyRequest {
    edge?: EdgeContext
  }
}

/**
 * Fejlécellentmondás.
 *
 * Nem az hiányzó böngészőazonosítót büntetjük — a `curl` is legitim, és az
 * egészségjelző sem küld böngészőfejléceket. Az ellentmondás számít: egy
 * böngészőnek valló azonosító `accept` fejléc nélkül, vagy egy `sec-fetch-*`
 * készlet fele.
 */
function headerAnomaly (request: FastifyRequest): boolean {
  const ua = request.headers['user-agent']
  if (typeof ua !== 'string' || !ua) {
    // Hiányzó azonosító: önmagában nem anomália, csak ha böngészőnek szóló
    // végpontot kér. Az API-t hívó szkriptek nem gyanúsak.
    return false
  }
  const claimsBrowser = /mozilla|chrome|safari|firefox|edg\//i.test(ua)
  if (!claimsBrowser) return false

  // Egy valódi böngésző mindig küld `accept`-et és `accept-language`-t.
  const hasAccept = typeof request.headers.accept === 'string'
  const hasLanguage = typeof request.headers['accept-language'] === 'string'
  return !hasAccept || !hasLanguage
}

/** Robotnak vallja magát? Ugyanaz a felismerés, mint a látogatottságnál. */
const BOT_UA = /bot|crawler|spider|crawling|slurp|headlesschrome|python-requests|go-http-client|curl\/|wget/i

/**
 * Az él kiértékelése egy kérésre.
 *
 * Kivételt SOHA nem dob: a hívó hook a `onFailure` szabály szerint dönt, ha
 * valami elhasal. Egy biztonsági réteg hibája nem lehet kiesés.
 */
export async function evaluate (request: FastifyRequest, config: EdgeConfig): Promise<EdgeContext> {
  const ip = request.ip
  const url = request.url
  const route = request.routeOptions?.url ?? null
  const userId = request.user?.sub ?? null

  const evidence = noEvidence()
  evidence.sensitivity = sensitivityOf(url)

  // ---- tiltás ----
  // Ez az egyetlen dolog, ami a pontszámtól függetlenül dönt.
  const ban = await blocked({ ip, userId, sessionId: request.user?.sid ?? null })

  // ---- számlálók ----
  // Beszámítjuk a kérést, és egyúttal megkapjuk az állást. A `hit` maga nem
  // utasít vissza — a visszautasítás a policy dolga.
  const byIp = hit('ip', ip, LIMITS.ip)
  evidence.perMinute = recent('ip', ip, 60)
  evidence.perHour = byIp.sustainedCount
  evidence.cadence = cadence('ip', ip)

  if (userId) hit('user', userId, LIMITS.user)

  // ---- a kérés önmagáról ----
  const ua = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : ''
  evidence.declaredBot = BOT_UA.test(ua)
  evidence.headerAnomaly = headerAnomaly(request)

  // ---- felderítés és hitelesítési visszaélés ----
  // Ezeket a válasz oldalán számoljuk (lásd `observe`), itt csak olvassuk.
  evidence.notFound = recent('ip+route', `${ip} 404`, 600)
  evidence.authFailures = recent('ip+route', `${ip} authfail`, 3600)
  evidence.history = recent('ip+route', `${ip} security`, 86_400)

  // ---- WAF ----
  // Törzs nélkül: az `onRequest` szakaszban még nincs feldolgozva. A törzs a
  // `inspectBody`-ban jön, a séma után.
  const waf = inspect({
    url,
    query: url.includes('?') ? url.slice(url.indexOf('?') + 1) : '',
    headers: request.headers as Record<string, unknown>
  })
  evidence.waf = waf

  // ---- IP-intelligencia ----
  // Gyorsítótárból. Ismeretlen címnél `null`, és az „nem tudjuk", nem „tiszta".
  evidence.intel = await intelOf(ip)

  const assessment = assess(evidence, config)
  const decision = decide(assessment, config, ban, waf)

  return { decision, assessment, evidence, waf }
}

/**
 * A kérés utáni megfigyelés.
 *
 * Amit csak a VÁLASZBÓL lehet tudni: hány nem létező címet kért, hány
 * sikertelen belépése volt. Ezek a következő kérés bizonyítékai.
 */
export function observe (request: FastifyRequest, statusCode: number): void {
  const ip = request.ip
  const url = request.url

  if (statusCode === 404) {
    hit('ip+route', `${ip} 404`, { burst: { max: 1e9, seconds: 600 }, sustained: { max: 1e9, seconds: 600 }, cooldownSeconds: 0 })
  }
  if (statusCode === 401 && url.startsWith('/v1/auth')) {
    hit('ip+route', `${ip} authfail`, { burst: { max: 1e9, seconds: 3600 }, sustained: { max: 1e9, seconds: 3600 }, cooldownSeconds: 0 })
  }
}

/** Egy biztonsági esemény megjegyzése ehhez a címhez — a jövőbeli pontozáshoz. */
function rememberSecurityEvent (ip: string): void {
  hit('ip+route', `${ip} security`, { burst: { max: 1e9, seconds: 86_400 }, sustained: { max: 1e9, seconds: 86_400 }, cooldownSeconds: 0 })
}

/**
 * A hook, ami a kérési útra kerül.
 *
 * Visszaad egy választ, ha a kérést vissza kell utasítani; `undefined`-ot, ha
 * mehet tovább.
 */
export async function guard (request: FastifyRequest): Promise<Decision | undefined> {
  let config: EdgeConfig
  try {
    config = await edgeConfig()
  } catch {
    // A beállítás olvasása elhasalt. Ez a legrosszabb pillanat arra, hogy
    // szigorúak legyünk: a saját konfigurációnk hibája ne tiltson ki senkit.
    return undefined
  }

  if (!config.enabled) return undefined
  if (!inScope(request.url, config)) return undefined

  let context: EdgeContext
  try {
    context = await evaluate(request, config)
  } catch (error) {
    // A kiértékelés elhasalt. A szabály útvonalanként dönt — lásd `onFailure`.
    const failure = onFailure(request.url, config)
    if (error instanceof BanLookupFailed) {
      console.error('edge: ban lookup failed, falling back to', failure.effective)
    }
    request.edge = { decision: failure, assessment: { score: 0, signals: [] }, evidence: noEvidence(), waf: [] }
    return failure.effective === 'block' ? failure : undefined
  }

  request.edge = context
  const { decision, assessment, waf } = context

  // ---- naplózás ----
  // Nem vár rá senki. Az `allow` kimarad — az a forgalom kilencvenkilenc
  // százaléka.
  recordDecision({
    at: new Date(),
    ip: request.ip,
    userId: request.user?.sub ?? null,
    route: request.routeOptions?.url ?? null,
    method: request.method,
    action: decision.action,
    score: decision.score,
    // A JELEK a pontszámaikkal, ahogy a kockázati motor kiszámolta. Ebből
    // lehet utólag megmondani, MIÉRT lett valaki blokkolva — egy puszta
    // pontszám erre nem válasz, és pont ezt kérdezik meg elsőként.
    signals: assessment.signals,
    rule: worst(waf)?.rule ?? null
  })

  // A súlyos eseményekről a biztonsági napló is tud. Ez az, amit egy operátor
  // lát a panelen — nem a döntések tízezre, hanem az, ami számít.
  const severe = decision.action === 'block' || decision.action === 'throttle'
  if (severe || waf.some(h => h.severity === 'critical')) {
    rememberSecurityEvent(request.ip)
    recordSecurity({
      userId: request.user?.sub ?? null,
      event: decision.ban ? 'edge_ban_hit' : waf.length ? 'waf_detection' : 'risk_block',
      ip: request.ip,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      route: request.routeOptions?.url ?? null,
      severity: decision.action === 'block' ? 'high' : 'medium',
      metadata: {
        score: decision.score,
        action: decision.action,
        effective: decision.effective,
        reason: decision.reason,
        rule: worst(waf)?.rule ?? null
      }
    })
  }

  // ---- automatikus tiltás ----
  // Csak éles üzemben, csak blokknál, és csak ha nincs már tiltás. Száraz
  // üzemben a rendszer mindent kiértékel és naplóz, de nem tilt.
  if (!config.dryRun && decision.action === 'block' && !decision.ban) {
    void autoBan(
      'ip', request.ip,
      decision.reason,
      waf.length ? 'waf' : 'risk',
      decision.score,
      config.banSeconds
    )
  }

  return decision.effective === 'block' || decision.effective === 'throttle' ? decision : undefined
}

