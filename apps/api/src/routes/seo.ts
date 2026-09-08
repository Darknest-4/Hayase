// robots.txt, sitemap.xml, and the crawlable spelling of an anime page.
//
// Registered at the root rather than under /v1: these are not API endpoints,
// they are the three things a crawler asks a website for. See lib/seo.ts for
// why the path-shaped /anime/:id exists at all next to the client's #/anime/:id.
//
// Two rules run through the whole file:
//
//   * Nothing that is not public gets into the sitemap or gets an indexable
//     page. Hidden and unlisted catalogue entries, adult entries, and — if the
//     operator has made this a private instance — the entire site.
//   * Every value that reaches the HTML came out of the database, which means
//     out of an importer, which means it is not trusted. It is escaped at the
//     point of use by lib/seo.ts and nowhere else.

import { query, queryOne } from '../db.ts'
import { settings as siteSettings } from '../lib/site-settings.ts'
import {
  escapeHtml, publicOrigin, summarise, template, withMeta, type PageMeta
} from '../lib/seo.ts'

import type { FastifyPluginAsync } from 'fastify'

/** Where index.html lives. Supplied by app.ts, which already resolved it. */
export interface SeoOptions { webRoot: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * How many URLs the sitemap may list.
 *
 * The catalogue holds tens of thousands of rows and the sitemap protocol caps
 * a single file at 50,000 URLs / 50 MB. Rather than ship a six-megabyte
 * document nobody asked for, the most popular entries are listed and the rest
 * are reached by crawling from them. Raise SITEMAP_MAX_URLS if that is ever
 * the wrong trade for a given deployment.
 */
const MAX_URLS = Math.min(Number(process.env.SITEMAP_MAX_URLS ?? 10_000), 50_000)

/** The client routes a crawler is welcome to see. Everything else is operator or personal. */
const PUBLIC_PATHS = ['/', '/search', '/schedule', '/community']

/** The ones the SPA fallback would otherwise serve as indexable HTML. */
const DISALLOW = [
  '/v1/', '/graphql', '/graphiql', '/ws',
  '/admin', '/settings', '/dashboard', '/notifications',
  '/list', '/profile', '/profiles', '/w2g', '/watch'
]

interface AnimeSeo {
  id: string
  canonical_title: string
  synopsis: string | null
  format: string | null
  status: string | null
  season_year: number | null
  start_date: string | null
  episode_count: number | null
  average_score: number | null
  ratings_count: number | null
  is_adult: boolean
  visibility: string
  updated_at: Date
  anilist_id: number | null
  english_title: string | null
  cover: string | null
}

/** schema.org type for a catalogue format. Anything unrecognised is a series. */
function schemaType (format: string | null): string {
  return format === 'MOVIE' ? 'Movie' : 'TVSeries'
}

const routes: FastifyPluginAsync<SeoOptions> = async (fastify, opts) => {
  /**
   * robots.txt.
   *
   * Generated rather than shipped as a file so the Sitemap line carries the
   * origin the request actually arrived on, and so a private instance can say
   * "none of this" without an operator having to remember to edit a file after
   * flipping the switch in the admin panel.
   */
  fastify.get('/robots.txt', async (request, reply) => {
    const origin = publicOrigin(request)
    reply.type('text/plain; charset=utf-8')
    reply.header('Cache-Control', 'public, max-age=3600')

    if (await siteSettings.requiresLogin()) {
      // Nothing here is readable without an account, so there is nothing worth
      // crawling and a crawler filling the logs with 401s helps nobody.
      return `User-agent: *\nDisallow: /\n`
    }

    return [
      '# Yume',
      'User-agent: *',
      ...DISALLOW.map(path => `Disallow: ${path}`),
      ...PUBLIC_PATHS.map(path => `Allow: ${path}`),
      'Allow: /anime/',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      ''
    ].join('\n')
  })

  /**
   * sitemap.xml.
   *
   * Public, non-adult catalogue entries plus the handful of static pages.
   * `lastmod` is the row's own updated_at, so a re-crawl is triggered by the
   * metadata actually changing rather than by the sitemap being regenerated.
   */
  fastify.get('/sitemap.xml', async (request, reply) => {
    if (await siteSettings.requiresLogin()) {
      return reply.code(404).type('application/problem+json')
        .send({ type: 'about:blank', title: 'Not Found', status: 404 })
    }

    const origin = publicOrigin(request)
    const rows = await query<{ id: string, anilist_id: number | null, updated_at: Date }>(
      `SELECT a.id, m.anilist_id, a.updated_at
         FROM anime a
         LEFT JOIN anime_mappings m ON m.anime_id = a.id
        WHERE a.visibility = 'public' AND NOT a.is_adult
        ORDER BY a.popularity DESC NULLS LAST, a.id
        LIMIT $1`,
      [MAX_URLS]
    )

    const url = (loc: string, lastmod?: string, priority?: string): string =>
      ['  <url>', `    <loc>${escapeHtml(loc)}</loc>`,
        ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
        ...(priority ? [`    <priority>${priority}</priority>`] : []),
        '  </url>'].join('\n')

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...PUBLIC_PATHS.map(path => url(origin + path, undefined, path === '/' ? '1.0' : '0.6')),
      ...rows.map(row => url(
        `${origin}/anime/${row.anilist_id ?? row.id}`,
        new Date(row.updated_at).toISOString().slice(0, 10),
        '0.8'
      )),
      '</urlset>',
      ''
    ].join('\n')

    reply.type('application/xml; charset=utf-8')
    reply.header('Cache-Control', 'public, max-age=3600')
    return body
  })

  /**
   * /anime/:id — the app, served with a <head> about this anime.
   *
   * The body is index.html: the client takes over the moment it runs and
   * rewrites the URL to its own #/anime/:id form. What changes is the twelve
   * tags a crawler, a Discord unfurl or a Slack preview reads before any
   * script has executed.
   *
   * A miss answers 404 with the same page rather than a problem document,
   * because a browser landing here should still get the app — it is a real
   * navigation, not an API call.
   */
  fastify.get('/anime/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const origin = publicOrigin(request)
    const html = await template(opts.webRoot)
    reply.type('text/html; charset=utf-8')

    const numeric = /^\d{1,9}$/.test(id)
    const row = (numeric || UUID.test(id))
      ? await queryOne<AnimeSeo>(
          `SELECT a.id, a.canonical_title, a.synopsis, a.format, a.status, a.season_year,
                  a.start_date::text AS start_date, a.episode_count, a.average_score,
                  a.ratings_count, a.is_adult, a.visibility, a.updated_at,
                  m.anilist_id,
                  (SELECT t.title FROM anime_titles t
                    WHERE t.anime_id = a.id AND t.kind = 'english') AS english_title,
                  (SELECT i.object_key FROM anime_images i
                    WHERE i.anime_id = a.id AND i.kind = 'cover' AND i.is_primary
                    LIMIT 1) AS cover
             FROM anime a
             LEFT JOIN anime_mappings m ON m.anime_id = a.id
            WHERE ${numeric ? 'm.anilist_id = $1::int' : 'a.id = $1::uuid'}
              AND a.visibility <> 'hidden'`,
          [id]
        )
      : null

    // A private instance publishes no metadata at all: the catalogue is
    // behind the login gate, and a link preview that leaked a title would be
    // a hole straight through it.
    const priv = await siteSettings.requiresLogin()

    if (!row || priv) {
      reply.header('X-Robots-Tag', 'noindex')
      if (!row) reply.code(404)
      return withMeta(html, {
        title: 'Yume',
        description: 'Yume — anime tracking and discovery.',
        canonical: `${origin}/anime/${encodeURIComponent(id)}`,
        noindex: true
      })
    }

    const title = row.canonical_title
    const canonical = `${origin}/anime/${row.anilist_id ?? row.id}`
    // Adult and unlisted entries are reachable by direct link — that is what
    // "unlisted" means — but they are not offered to an index.
    const noindex = row.is_adult || row.visibility !== 'public'
    if (noindex) reply.header('X-Robots-Tag', 'noindex')

    const facts = [
      row.format,
      row.episode_count ? `${row.episode_count} rész` : null,
      row.season_year ? String(row.season_year) : null
    ].filter(Boolean).join(' · ')
    const synopsis = summarise(row.synopsis)
    const description = synopsis || (facts ? `${title} — ${facts}` : `${title} a Yume katalógusában.`)

    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': schemaType(row.format),
      name: title,
      url: canonical,
      description: summarise(row.synopsis, 400) || description
    }
    if (row.english_title && row.english_title !== title) jsonLd.alternateName = row.english_title
    if (row.cover) jsonLd.image = row.cover
    if (row.episode_count) jsonLd.numberOfEpisodes = row.episode_count
    if (row.start_date) jsonLd.datePublished = row.start_date
    // Only a rating somebody actually gave. schema.org requires ratingCount,
    // and an aggregateRating invented from an empty ratings table is exactly
    // the sort of thing a rich result gets a site penalised for.
    if (row.average_score != null && (row.ratings_count ?? 0) > 0) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: Number(row.average_score),
        ratingCount: Number(row.ratings_count),
        bestRating: 100,
        worstRating: 0
      }
    }

    const meta: PageMeta = {
      title: `${title} — Yume`,
      description,
      canonical,
      ogType: 'video.tv_show',
      noindex,
      jsonLd,
      ...(row.cover ? { image: row.cover } : {})
    }
    return withMeta(html, meta)
  })
}

export default routes
