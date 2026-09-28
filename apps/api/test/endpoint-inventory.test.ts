// docs/api/endpoints.md lists exactly the routes the API registers.
//
// The API reference was written ahead of the code and never caught up: it
// documented endpoints that do not exist and left out dozens that do. The
// inventory is generated (scripts/list-routes.ts), and this fails the build
// when a route is added, removed or renamed without regenerating it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'endpoint-inventory-secret-long-enough-0123456789'

describe('the endpoint inventory', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  it('matches the routes the app registers', async () => {
    const [{ buildApp }, { render }] = await Promise.all([
      import('../src/app.ts'), import('../scripts/list-routes.ts')
    ])
    const app = await buildApp()
    await app.ready()
    try {
      const expected = render(app.routeTable)
      const actual = readFileSync(new URL('../../../docs/api/endpoints.md', import.meta.url), 'utf8')
      assert.equal(actual, expected,
        'docs/api/endpoints.md is out of date — regenerate it with scripts/list-routes.ts')
    } finally {
      await app.close()
    }
  })
})
