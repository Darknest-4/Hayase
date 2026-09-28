// The endpoint inventory, from the routes the app actually registers.
//
//   node --experimental-strip-types scripts/list-routes.ts > ../../docs/api/endpoints.md
//
// docs/api/api.md used to be a specification written ahead of the code, and it
// listed endpoints that were never built (and missed dozens that were). This
// prints what exists; test/endpoint-inventory.test.ts fails when the document
// and the code disagree.
//
// Needs DATABASE_URL like the app itself (the connection is not used for the
// listing, but the app opens it while it starts).

import { buildApp } from '../src/app.ts'
import { pool } from '../src/infrastructure/database/index.ts'

export interface Endpoint { method: string, url: string }

/** The routes worth documenting: the API, not the static file server. */
export function documented (routes: Endpoint[]): Endpoint[] {
  const seen = new Set<string>()
  return routes
    .filter(r => r.method !== 'HEAD' && r.method !== 'OPTIONS')
    .filter(r => /^\/(v1|graphql|ws|media|anime|robots\.txt|sitemap\.xml|dashboard)(\/|$)/.test(r.url))
    .filter(r => {
      const key = `${r.method} ${r.url}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
}

/** Group heading for a path: /v1/admin/catalogue/... → "/v1/admin/catalogue". */
function groupOf (url: string): string {
  const parts = url.split('/').filter(Boolean)
  if (parts[0] !== 'v1') return '/' + (parts[0] ?? '')
  if (parts[1] === 'admin' || parts[1] === 'me') return '/' + parts.slice(0, 3).join('/')
  return '/' + parts.slice(0, 2).join('/')
}

export function render (routes: Endpoint[]): string {
  const lines = [
    '# Endpoint inventory',
    '',
    '> Generated from the routes the API registers — do not edit by hand.',
    '> Regenerate from `apps/api`, with `DATABASE_URL` set:',
    '> `node --experimental-strip-types scripts/list-routes.ts > ../../docs/api/endpoints.md`.',
    '> `test/endpoint-inventory.test.ts`',
    '> fails when this file and the code disagree. What each endpoint does, and',
    '> who may call it, is in [api.md](api.md) and next to the route in the source.',
    ''
  ]
  let group = ''
  for (const route of documented(routes)) {
    const next = groupOf(route.url)
    if (next !== group) {
      group = next
      lines.push('', `## \`${group}\``, '', '| Method | Path |', '|---|---|')
    }
    lines.push(`| ${route.method} | \`${route.url}\` |`)
  }
  return lines.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp()
  await app.ready()
  process.stdout.write(render(app.routeTable))
  await app.close()
  await pool.end().catch(() => {})
  process.exit(0)
}
