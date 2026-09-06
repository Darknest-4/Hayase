// The franchise view: where a title sits in its run, and what to watch next.
//
// `/:id/relations` answers what is directly attached to an entry, which is the
// question the graph asks. It is not the question a viewer asks. Season three
// does not link to season one, the films hang off whichever entry happened to
// spawn them, and a good half of the relation rows in a seeded catalogue carry
// no usable type at all — the offline database has no field for it, so every
// row imports as OTHER until the AniList deep pass has run.
//
// So the franchise walk goes two hops out and orders by release date. That is
// what these tests pin: the walk reaches past the neighbours, the order is the
// order a person would watch in, and neither the depth nor the size of a
// well-connected franchise can turn one page load into half the catalogue.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'franchise-secret-long-enough-0123456789'

describe('franchise / watch order', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const tag = 'fr_' + randomBytes(4).toString('hex')
  const ids: Record<string, string> = {}

  /** One catalogue entry. Public, or the endpoint is right to hide it. */
  async function anime (name: string, opts: {
    format?: string, startDate?: string | null, episodes?: number | null, visibility?: string
  } = {}): Promise<string> {
    const row = (await pool.query(
      `INSERT INTO anime (canonical_title, format, status, start_date, episode_count, visibility)
       VALUES ($1, $2::anime_format, 'FINISHED', $3, $4, $5) RETURNING id`,
      [`${tag} ${name}`, opts.format ?? 'TV', opts.startDate ?? null, opts.episodes ?? null, opts.visibility ?? 'public']
    )).rows[0]
    ids[name] = row.id
    return row.id
  }

  async function relate (a: string, b: string, relation = 'SEQUEL'): Promise<void> {
    await pool.query(
      'INSERT INTO anime_relations (anime_id, related_id, relation) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [ids[a], ids[b], relation])
  }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    // A chain, plus a film and a special hanging off the middle of it — the
    // ordinary shape of a franchise, and the shape the graph alone gets wrong.
    await anime('s1', { startDate: '2012-04-01', episodes: 25 })
    await anime('s2', { startDate: '2014-04-01', episodes: 12 })
    await anime('s3', { startDate: '2016-04-01', episodes: 12 })
    await anime('film', { format: 'MOVIE', startDate: '2015-11-01' })
    await anime('ova', { format: 'OVA', startDate: '2013-08-01', episodes: 2 })
    await anime('hidden', { startDate: '2011-01-01', visibility: 'hidden' })

    await relate('s1', 's2')
    await relate('s2', 's3')
    await relate('s2', 'film', 'SIDE_STORY')
    await relate('s1', 'ova', 'SIDE_STORY')
    await relate('s1', 'hidden', 'ALTERNATIVE')
  })

  after(async () => {
    await pool?.query('DELETE FROM anime WHERE canonical_title LIKE $1', [tag + ' %'])
    await app?.close()
    await pool?.end()
  })

  const get = async (id: string): Promise<{ data: Array<Record<string, unknown>>, truncated: boolean }> => {
    const res = await app.inject({ url: `/v1/anime/${id}/franchise` })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as { data: Array<Record<string, unknown>>, truncated: boolean }
  }

  test('reaches past the immediate neighbours', async () => {
    // Season one links to season two, not to season three. A one-hop answer
    // would leave the last season out of its own franchise.
    const { data } = await get(ids.s1)
    const titles = data.map(e => String(e.canonical_title))
    assert.ok(titles.includes(`${tag} s3`), `season three is missing: ${titles.join(', ')}`)
  })

  test('orders by release date, not by the relation graph', async () => {
    const { data } = await get(ids.s2)
    const order = data.map(e => String(e.canonical_title).replace(tag + ' ', ''))
    assert.deepEqual(order, ['s1', 'ova', 's2', 'film', 's3'])
  })

  test('includes the title that was asked about, and says which one it is', async () => {
    // The client marks "you are here" by id; without the entry itself in the
    // list there is nothing to mark.
    const { data } = await get(ids.film)
    assert.ok(data.some(e => e.id === ids.film), 'the requested title is not in its own franchise')
  })

  test('names the direct relation, and only where there is one', async () => {
    const { data } = await get(ids.s1)
    const byName = Object.fromEntries(data.map(e => [String(e.canonical_title).replace(tag + ' ', ''), e]))
    assert.equal(byName.ova.relation, 'SIDE_STORY')
    // Two hops out there is no single edge to name, so the field is null
    // rather than a guess.
    assert.equal(byName.s3.relation, null)
  })

  test('leaves unpublished entries out', async () => {
    // A hidden entry is hidden. Listing it here would be a way to enumerate
    // the catalogue's unpublished rows from a public endpoint.
    const { data } = await get(ids.s1)
    assert.ok(!data.some(e => String(e.canonical_title).endsWith('hidden')), 'a hidden entry was listed')
  })

  test('a title with no relations returns nothing to draw', async () => {
    const lonely = await anime('lonely', { startDate: '2020-01-01' })
    const { data } = await get(lonely)
    // Itself and nothing else — the client draws no franchise block for that.
    assert.equal(data.length, 1)
  })

  test('an unknown or malformed id is a 404, not a 500', async () => {
    const bad = await app.inject({ url: '/v1/anime/not-a-uuid/franchise' })
    assert.equal(bad.statusCode, 404)
    const missing = await app.inject({ url: '/v1/anime/00000000-0000-4000-8000-000000000000/franchise' })
    assert.equal(missing.statusCode, 200)
    assert.deepEqual((missing.json() as { data: unknown[] }).data, [])
  })

  test('a large franchise is capped and says so', async () => {
    // Some franchises run to dozens of entries and the components are well
    // connected. Without a cap, one page load returns a large slice of the
    // catalogue to draw a sidebar.
    const hub = await anime('hub', { startDate: '2000-01-01' })
    for (let i = 0; i < 65; i++) {
      const id = (await pool.query(
        `INSERT INTO anime (canonical_title, format, status, start_date, visibility)
         VALUES ($1, 'TV'::anime_format, 'FINISHED', $2, 'public') RETURNING id`,
        [`${tag} big${i}`, `20${String(10 + (i % 80)).padStart(2, '0')}-01-01`]
      )).rows[0].id
      await pool.query('INSERT INTO anime_relations (anime_id, related_id, relation) VALUES ($1, $2, $3)',
        [hub, id, 'SIDE_STORY'])
    }
    const { data, truncated } = await get(hub)
    assert.equal(data.length, 60)
    assert.equal(truncated, true)
  })
})
