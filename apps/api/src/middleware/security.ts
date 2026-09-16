// Security plugin: response hardening headers + request rate limiting.
//
// Registered early in app.ts so every route (REST, GraphQL and the static
// client) inherits it. Per-route overrides live next to the routes they
// protect — see AUTH_LIMIT / WRITE_LIMIT below.

import rateLimit from '@fastify/rate-limit'
import { internalTrustEnabled, isInternalRequest } from './internal-request.ts'
import fp from 'fastify-plugin'

import { config } from '../config.ts'
import { isLoadTestRequest, loadTestConfigured } from './load-test.ts'
import { settings as siteSettings, type RateLimits } from '../modules/settings/site-settings.ts'

import type { FastifyRequest } from 'fastify'

/**
 * Content-Security-Policy for the served web client.
 *
 * 'unsafe-inline' is required for style-src because the UI sets inline style
 * attributes (U.el's `style` option) and injects a <style> element for themes.
 * Scripts are all separate files, so script-src stays strict — which is the
 * directive that actually blocks XSS payloads.
 */
const CSP = [
  "default-src 'self'",
  // No blob: any more. It was there for the extension sandbox, which imported
  // a hash-verified package as a module from an in-memory blob; with the
  // sandbox gone, the allowance is one fewer way for injected script to reach
  // execution and nothing needs it.
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",      // artwork comes from AniList/MAL CDNs
  "media-src 'self' blob: https:",          // video sources are external by design
  "connect-src 'self' https:",              // AniList/Jikan/ani.zip are called from the client
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com", // trailers
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"                  // no embedding Yume itself
].join('; ')

const HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',          // no MIME sniffing
  'X-Frame-Options': 'DENY',                    // legacy companion to frame-ancestors
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Content-Security-Policy': CSP
}

/** Strict limit for credential endpoints: password hashing is deliberately
 *  expensive (scrypt N=2^17), so unbounded attempts are both a brute-force and
 *  a CPU-exhaustion vector. Tunable for operators running behind a shared NAT. */
/*
 * A korlátok futásidőben olvasódnak, nem induláskor.
 *
 * Eddig környezeti változók voltak, tehát az átállításuk újraindítást
 * jelentett — és az az egyetlen pillanat, amikor egy korlátot állítani kell,
 * az az, amikor épp folyik valami. Egy védelem, amihez telepítés kell, nem
 * védelem, hanem terv.
 *
 * A @fastify/rate-limit `max` és `timeWindow` mezője elfogad függvényt, és a
 * beállítás-olvasó gyorsítótárazott: kérésenként egy map-keresés, nem egy
 * lekérdezés. A környezeti változó marad az alapérték.
 */
const limit = (name: keyof RateLimits): {
  max: (req: FastifyRequest) => Promise<number>
  timeWindow: (req: FastifyRequest) => Promise<number>
} => ({
  max: async () => (await siteSettings.rateLimits())[name].max,
  timeWindow: async () => (await siteSettings.rateLimits())[name].windowSeconds * 1000
})

export const AUTH_LIMIT = { rateLimit: limit('auth') }

/** Refresh is called legitimately far more often than login. */
export const REFRESH_LIMIT = { rateLimit: limit('refresh') }

/** User-generated content: enough for real use, low enough to stop flooding. */
export const WRITE_LIMIT = { rateLimit: limit('write') }

export default fp(async fastify => {
  await fastify.register(rateLimit, {
    global: true,
    ...limit('global'),
    // Health checks must never be throttled — orchestrators poll them and a
    // 429 would be read as the service being down.
    //
    // A második kivétel a terheléses mérésé, és három feltételhez kötött
    // (kulcs + fejléc + forráscím); kulcs nélkül nem létezik. Enélkül egy
    // mérés a korlátot méri, nem a terméket — lásd middleware/load-test.ts.
    /*
     * A HARMADIK KIVÉTEL A SAJÁT RENDSZERÜNK.
     *
     * A worker, a bot, a mérőszkriptek és a karbantartó feladatok ugyanazon a
     * Docker-hálózaton futnak, és ugyanezt az API-t hívják. Ha őket
     * megfojtjuk, az nem védelem: a rendszer bénítja meg saját magát, pont
     * amikor dolgozik — és a hiba a legrosszabb helyen jelenik meg, egy
     * félbemaradt háttérfeladatban.
     *
     * A felismerés a TCP-kapcsolat túlsó végét nézi, nem fejlécet, és a
     * proxyfejlécek jelenléte kizárja a mentességet. Kívülről tehát nem
     * hamisítható — részletek az `internal-request.ts` fejlécében.
     */
    allowList: request =>
      request.url.startsWith('/v1/health') ||
      isInternalRequest(request) ||
      isLoadTestRequest(request),
    // trustProxy is on, so request.ip is the real client behind a reverse proxy
    keyGenerator: request => request.ip,
    // match the app's RFC 9457 error convention
    errorResponseBuilder: (_request, context) => ({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: `Rate limit exceeded — retry in ${context.after}.`
    })
  })

  // Egy bekapcsolva felejtett mentesség csendben rossz: semmi nem hibázik,
  // csak egy cím korlát nélkül jár. Induláskor kimondjuk, és a biztonsági
  // állapotjelentés is jelzi.
  /*
   * A BELSŐ MENTESSÉG KIMONDVA.
   *
   * Nem figyelmeztetés — ez az alapértelmezett és helyes állapot —, de
   * kimondjuk, mert egy mentesség, amiről csak a forráskód tud, előbb-utóbb
   * meglepetés lesz. Aki a naplót olvassa, lássa, mi van bekapcsolva.
   */
  fastify.log.info(
    { trustInternal: internalTrustEnabled() },
    internalTrustEnabled()
      ? 'a sebességkorlát nem vonatkozik a saját hálózatunkról, proxyfejléc nélkül érkező kérésekre ' +
        '(worker, bot, egészségjelző) — kikapcsolás: RATE_LIMIT_TRUST_INTERNAL=false'
      : 'RATE_LIMIT_TRUST_INTERNAL=false — a saját háttérfeladataink is a sebességkorlát alá esnek'
  )

  if (loadTestConfigured()) {
    fastify.log.warn(
      { ips: config.loadTestIps },
      'LOAD_TEST_KEY is set: the listed sources bypass rate limiting when they send the key. ' +
      'Unset it when the measurement is over.'
    )
  }

  fastify.addHook('onSend', async (request, reply, payload) => {
    for (const [header, value] of Object.entries(HEADERS)) reply.header(header, value)
    // HSTS only makes sense once traffic is actually HTTPS, and only in prod
    if (config.isProd && process.env.ENABLE_HSTS === 'true') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    /**
     * Authenticated responses must not be cached.
     *
     * These bodies are per-user — library entries, notifications, the account
     * itself — and they were leaving with no Cache-Control at all. A shared
     * cache is then free to apply its own heuristic freshness and hand one
     * user's data to the next, and the browser will happily restore a signed-in
     * page from the back/forward cache after sign-out.
     *
     * Only responses to a request that actually carried a credential are
     * marked, and only when the route has not set its own value: the
     * content-addressed package download is immutable by construction and its
     * `public, max-age=31536000, immutable` must survive.
     */
    if (request.headers.authorization && !reply.getHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store')
    }
    return payload
  })
})
