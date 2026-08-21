// Security plugin: response hardening headers + request rate limiting.
//
// Registered early in app.ts so every route (REST, GraphQL and the static
// client) inherits it. Per-route overrides live next to the routes they
// protect — see AUTH_LIMIT / WRITE_LIMIT below.

import rateLimit from '@fastify/rate-limit'
import fp from 'fastify-plugin'

import { config } from '../config.ts'

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
  "script-src 'self'",
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
export const AUTH_LIMIT = {
  rateLimit: {
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
    timeWindow: process.env.AUTH_RATE_LIMIT_WINDOW ?? '15 minutes'
  }
}

/** Refresh is called legitimately far more often than login. */
export const REFRESH_LIMIT = {
  rateLimit: {
    max: Number(process.env.REFRESH_RATE_LIMIT_MAX ?? 60),
    timeWindow: process.env.REFRESH_RATE_LIMIT_WINDOW ?? '15 minutes'
  }
}

/** User-generated content: enough for real use, low enough to stop flooding. */
export const WRITE_LIMIT = {
  rateLimit: {
    max: Number(process.env.WRITE_RATE_LIMIT_MAX ?? 30),
    timeWindow: process.env.WRITE_RATE_LIMIT_WINDOW ?? '5 minutes'
  }
}

export default fp(async fastify => {
  await fastify.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    // Health checks must never be throttled — orchestrators poll them and a
    // 429 would be read as the service being down.
    allowList: request => request.url.startsWith('/v1/health'),
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

  fastify.addHook('onSend', async (_request, reply, payload) => {
    for (const [header, value] of Object.entries(HEADERS)) reply.header(header, value)
    // HSTS only makes sense once traffic is actually HTTPS, and only in prod
    if (config.isProd && process.env.ENABLE_HSTS === 'true') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })
})
