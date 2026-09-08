// The SEO layer: what a crawler, a link preview or a share sheet sees.
//
// Yume's client is a hash router. `#/anime/123` is a fragment, and a fragment
// is never sent to the server — so for every URL the site has ever produced,
// the only <head> anybody outside a browser could read was index.html's
// generic one. Every anime shared to Discord, Slack, Twitter or a search
// index looked like the same page: "Yume — anime tracking and discovery".
//
// The fix is not to render the app on the server. It is to give the catalogue
// a second, path-shaped spelling of the same route:
//
//     #/anime/123   the app's own link, unchanged
//     /anime/123    the same page, but the server sees the id and can answer
//                   with a <head> about *that* anime
//
// The client router understands both (web/js/app.js), and rewrites the second
// into the first on arrival, so a human never has two URLs to think about.
//
// Everything below is built from data an importer wrote — titles and synopses
// come from AniList and MAL — which is to say from text this project does not
// control. It is interpolated into HTML, into attributes and into a
// <script type="application/ld+json"> block, three contexts with three
// different escaping rules and one shared failure mode. Hence the escaping
// helpers at the top, and server/test/seo.test.ts, which is mostly about them.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'

import type { FastifyRequest } from 'fastify'

/** Marks the block in web/index.html that a per-page <head> replaces. */
const OPEN = '<!--yume:seo-->'
const CLOSE = '<!--/yume:seo-->'

/**
 * Escape for HTML text and for a double-quoted attribute value.
 *
 * The apostrophe is included even though nothing here emits single-quoted
 * attributes: the cost is nothing and it removes the need for the next person
 * to check which of the two this helper was written for.
 */
export function escapeHtml (value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Serialise a JSON-LD document for embedding in a <script> element.
 *
 * JSON escaping is not enough here. Inside <script> the HTML parser is still
 * looking for `</script`, so a synopsis containing that sequence would end the
 * block early and everything after it would be parsed as markup. `<` and `>`
 * are escaped to their \u form, which is legal JSON and inert to the parser;
 * `&` follows for the same reason. U+2028/2029 are legal in JSON strings but
 * not in JavaScript string literals, which is a separate old trap.
 */
export function jsonLdScript (data: unknown): string {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script type="application/ld+json">${json}</script>`
}

/**
 * The absolute origin to build canonical and sitemap URLs from.
 *
 * PUBLIC_URL wins, and on a real deployment it should be set: the fallback
 * reads the Host header, which the *client* chooses. A crawler that follows a
 * link with a forged Host would otherwise be handed a canonical pointing at
 * somebody else's domain, which is how a site donates its search ranking to a
 * stranger. So the fallback is validated to look like a hostname and nothing
 * else — no path, no credentials, no whitespace — and anything odd falls back
 * further to the configured self URL rather than being echoed.
 */
export function publicOrigin (request?: Pick<FastifyRequest, 'headers' | 'protocol'>): string {
  const configured = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured

  const host = String(request?.headers?.host ?? '')
  if (/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) {
    const forwarded = String(request?.headers?.['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
    const proto = config.trustProxy && (forwarded === 'https' || forwarded === 'http')
      ? forwarded
      : (request?.protocol ?? (config.isProd ? 'https' : 'http'))
    return `${proto}://${host}`
  }
  return config.selfUrl.replace(/\/+$/, '')
}

/**
 * Turn a provider synopsis into a meta description.
 *
 * AniList descriptions are HTML — <br>, <i>, the occasional <a> — and Google
 * shows around 155 characters, so this strips the markup, collapses the
 * whitespace and cuts on a word boundary. The tag strip is for readability,
 * NOT for safety: the result still goes through escapeHtml at the point of
 * use, because a description is attacker-influenced text either way.
 */
export function summarise (raw: string | null | undefined, limit = 155): string {
  const text = String(raw ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > limit * 0.5 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

export interface PageMeta {
  title: string
  description: string
  canonical: string
  /** Absolute URL of the share image, when there is one. */
  image?: string | undefined
  /** Open Graph object type. */
  ogType?: string
  /** Set for anything that must not be indexed — adult, unlisted, missing. */
  noindex?: boolean
  jsonLd?: unknown
  /** Extra <link rel="alternate"> hreflang entries, as [lang, href]. */
  siteName?: string
}

/** The <head> block for one page. Every value is escaped exactly once, here. */
export function metaTags (meta: PageMeta): string {
  const e = escapeHtml
  const tags = [
    `<title>${e(meta.title)}</title>`,
    `<meta name="description" content="${e(meta.description)}" />`,
    `<link rel="canonical" href="${e(meta.canonical)}" />`,
    `<meta property="og:type" content="${e(meta.ogType ?? 'website')}" />`,
    `<meta property="og:site_name" content="${e(meta.siteName ?? 'Yume')}" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(meta.canonical)}" />`,
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${e(meta.title)}" />`,
    `<meta name="twitter:description" content="${e(meta.description)}" />`
  ]
  if (meta.image) {
    tags.push(`<meta property="og:image" content="${e(meta.image)}" />`)
    tags.push(`<meta name="twitter:image" content="${e(meta.image)}" />`)
  }
  // noindex is emitted as a tag *and* as a header by the route, because a
  // crawler that only reads headers and one that only parses HTML both exist.
  if (meta.noindex) tags.push('<meta name="robots" content="noindex, nofollow" />')
  if (meta.jsonLd) tags.push(jsonLdScript(meta.jsonLd))
  return tags.join('\n  ')
}

/**
 * index.html, cached until the file changes.
 *
 * A stat per request rather than a read: in the container the file never
 * changes, and during development it changes often and a stale <head> would be
 * a confusing thing to debug. Both are cheap next to the database query the
 * caller has already made.
 */
let cached: { mtimeMs: number, html: string } | null = null

export async function template (webRoot: string): Promise<string> {
  const path = join(webRoot, 'index.html')
  const { mtimeMs } = await stat(path)
  if (cached?.mtimeMs === mtimeMs) return cached.html
  const html = await readFile(path, 'utf8')
  cached = { mtimeMs, html }
  return html
}

/** Drop the cached template. For tests. */
export function forgetTemplate (): void { cached = null }

/**
 * Put a page's <head> block into index.html.
 *
 * If the markers are missing — somebody edited the file, or a different client
 * is being served from WEB_ROOT — the page is returned untouched rather than
 * mangled. Losing the meta tags degrades a link preview; losing the page does
 * not degrade, it breaks.
 */
export function withMeta (html: string, meta: PageMeta): string {
  const start = html.indexOf(OPEN)
  const end = html.indexOf(CLOSE)
  if (start === -1 || end === -1 || end < start) return html
  return html.slice(0, start + OPEN.length) + '\n  ' + metaTags(meta) + '\n  ' + html.slice(end)
}

/**
 * Paths that must never be indexed, whatever answers them.
 *
 * The API and the operator surface. `/admin` and friends are ordinary client
 * routes served by the SPA fallback, so without this they are indexable HTML
 * that happens to render a sign-in refusal — which puts a site's admin panel
 * in a search index, an invitation nobody sent.
 */
const NO_INDEX = /^\/(v1|graphql|graphiql|ws|admin|settings|dashboard|notifications|list|profile|profiles|w2g|watch)(\/|$|\?)/

export function noIndexPath (url: string): boolean {
  return NO_INDEX.test(url.split('?')[0] ?? url)
}
