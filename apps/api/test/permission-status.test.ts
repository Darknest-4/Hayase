// The permission catalogue's `status` column must not start lying.
//
// The catalogue is deliberately ahead of the features that consume it: 389
// permissions are grantable, 18 are enforced by a route today. That is honest
// as long as the column says which is which — the Roles screen draws an
// "active" or "planned" badge from it, and an operator granting a planned
// permission can see that it protects nothing yet.
//
// Migration 0014 set it correctly and left a comment asking future work to
// keep it in sync with the `requirePermission()` call sites. A comment is not
// a mechanism: the moment somebody enforces a new permission and forgets the
// migration, the screen starts telling operators that a live permission is
// merely planned — or worse, that a planned one bites.
//
// This is the mechanism. It reads the call sites out of the source and
// compares them with what the database says.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { pool, query } from '../src/db.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const HAS_DB = Boolean(process.env.DATABASE_URL)

/** Every `requirePermission('x')` in the server source. */
function enforcedSlugs (dir = SRC, found = new Set<string>()): Set<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { enforcedSlugs(path, found); continue }
    if (!path.endsWith('.ts')) continue
    // The second argument is optional — admin routes pass `{ hide: true }` so
    // they answer 404 instead of 403 — so the slug is matched without
    // requiring the closing paren to follow it.
    for (const match of readFileSync(path, 'utf8').matchAll(/requirePermission\('([a-z0-9._]+)'/g)) {
      found.add(match[1]!)
    }
  }
  return found
}

describe('permission catalogue', () => {
  const enforced = [...enforcedSlugs()].sort()

  it('finds the call sites at all', () => {
    // A refactor that renamed the helper would otherwise make every assertion
    // below pass by finding nothing.
    assert.ok(enforced.length >= 10, `only found ${enforced.length} requirePermission call sites`)
  })

  it('enforces nothing that is not a permission-shaped slug', () => {
    for (const slug of enforced) assert.match(slug, /^[a-z0-9]+(\.[a-z0-9]+)+$/)
  })

  describe('against the database', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
    // Without this the pool keeps the process alive until its idle timeout,
    // which turns a 30 ms suite into a 30 second one.
    after(async () => { await pool.end() })

    it('every enforced permission exists in the catalogue', async () => {
      // `requirePermission` on a slug no table row grants is a route nobody
      // can ever reach — a 403 for everybody, including administrators.
      const rows = await query<{ slug: string }>('SELECT slug FROM permissions')
      const known = new Set(rows.map(r => r.slug))
      const missing = enforced.filter(slug => !known.has(slug))
      assert.deepEqual(missing, [], `enforced but not in the catalogue: ${missing.join(', ')}`)
    })

    it('every enforced permission is marked active', async () => {
      const rows = await query<{ slug: string }>("SELECT slug FROM permissions WHERE status = 'active'")
      const active = new Set(rows.map(r => r.slug))
      const understated = enforced.filter(slug => !active.has(slug))
      assert.deepEqual(understated, [],
        `enforced by a route but marked "planned" — the Roles screen is understating these: ${understated.join(', ')}. ` +
        'Add a migration setting status = \'active\' for them.')
    })

    it('nothing is marked active that no route enforces', async () => {
      const rows = await query<{ slug: string }>("SELECT slug FROM permissions WHERE status = 'active'")
      const overstated = rows.map(r => r.slug).filter(slug => !enforced.includes(slug))
      assert.deepEqual(overstated.sort(), [],
        `marked "active" but no route enforces them — the Roles screen is overstating these: ${overstated.join(', ')}`)
    })

    it('keeps the catalogue much larger than what is enforced, and says so', async () => {
      // This is the property the badge exists to communicate. If it ever
      // stopped being true the badge would be pointless, and if it is true
      // and unmarked the screen is misleading.
      const [{ total }] = await query<{ total: string }>('SELECT count(*) AS total FROM permissions')
      const [{ planned }] = await query<{ planned: string }>("SELECT count(*) AS planned FROM permissions WHERE status = 'planned'")
      assert.ok(Number(total) > enforced.length, 'the catalogue should be ahead of the code')
      assert.equal(Number(total) - Number(planned), enforced.length)
    })
  })
})
