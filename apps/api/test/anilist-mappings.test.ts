// External-id collisions in the AniList enricher.
//
// `anime_mappings.mal_id` is UNIQUE and the enricher wrote it blind, so when
// another anime already held the id the statement raised — and since 50 rows
// share one transaction, one collision discarded all fifty. A single run over
// 11 363 rows updated 8 326 and lost 9 650 to it.
//
// Two independent mechanisms fix that, and both are tested here because either
// one alone leaves the failure reachable:
//
//   * writeMalId never raises: it refuses the write and records the pair.
//   * a savepoint per row means anything *else* that raises costs one row.
//
// These need a database and skip cleanly without one.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'mapping-test-secret-long-enough-0123456789'

describe('MAL id collisions', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let writeMalId: typeof import('../src/workers/anilist.ts').writeMalId
  const made: string[] = []
  // Far above anything the real catalogue holds, so a collision here is ours.
  const freeMalId = (): number => 90_000_000 + Math.floor(Math.random() * 9_000_000)

  /** A bare anime row with a mappings row, returning its id. */
  async function anime (malId?: number): Promise<string> {
    const title = `itest-mapping-${randomUUID()}`
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO anime (canonical_title, format, status, visibility) VALUES ($1, 'TV', 'FINISHED', 'public') RETURNING id", [title])
    const id = rows[0]!.id
    made.push(id)
    await pool.query('INSERT INTO anime_mappings (anime_id, mal_id) VALUES ($1, $2)', [id, malId ?? null])
    return id
  }

  before(async () => {
    const db = await import('../src/db.ts')
    pool = db.pool as never
    ;({ writeMalId } = await import('../src/workers/anilist.ts'))
  })

  after(async () => {
    if (made.length) await pool.query('DELETE FROM anime WHERE id = ANY($1)', [made])
    await pool?.end()
  })

  test('attaches an id nobody holds', async () => {
    const id = await anime()
    const mal = freeMalId()
    const client = await pool.connect()
    try {
      assert.equal(await writeMalId(client, id, mal), 'written')
    } finally { client.release() }

    const { rows } = await pool.query<{ mal_id: number }>('SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [id])
    assert.equal(rows[0]!.mal_id, mal)
  })

  test('writing the same id again is a no-op, not a conflict', async () => {
    const mal = freeMalId()
    const id = await anime(mal)
    const client = await pool.connect()
    try {
      assert.equal(await writeMalId(client, id, mal), 'unchanged')
    } finally { client.release() }
    const { rows } = await pool.query('SELECT 1 FROM mapping_conflicts WHERE anime_id = $1', [id])
    assert.equal(rows.length, 0, 'an anime already holding the id is not in conflict with itself')
  })

  test('a taken id is refused, recorded, and does not raise', async () => {
    // The whole point: this used to throw and take 49 other rows with it.
    const mal = freeMalId()
    const holder = await anime(mal)
    const claimant = await anime()

    const client = await pool.connect()
    try {
      assert.equal(await writeMalId(client, claimant, mal), 'conflict')
    } finally { client.release() }

    const { rows } = await pool.query<{ mal_id: number | null }>(
      'SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [claimant])
    assert.equal(rows[0]!.mal_id, null, 'the claimant must not have been given the id')

    const held = await pool.query<{ mal_id: number }>('SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [holder])
    assert.equal(held.rows[0]!.mal_id, mal, 'the existing mapping must be untouched')

    const conflict = await pool.query<{ held_by: string, external_id: string, seen_count: number, source: string }>(
      "SELECT held_by, external_id, seen_count, source FROM mapping_conflicts WHERE anime_id = $1 AND provider = 'mal'",
      [claimant])
    assert.equal(conflict.rows.length, 1)
    assert.equal(conflict.rows[0]!.held_by, holder, 'the record must name who held it')
    assert.equal(conflict.rows[0]!.external_id, String(mal))
    assert.equal(conflict.rows[0]!.source, 'anilist-enrich')
  })

  test('re-running counts the collision again instead of duplicating it', async () => {
    // The importer is meant to be run repeatedly; a row per attempt would turn
    // the review queue into noise within a week.
    const mal = freeMalId()
    await anime(mal)
    const claimant = await anime()

    const client = await pool.connect()
    try {
      for (let i = 0; i < 3; i++) await writeMalId(client, claimant, mal)
    } finally { client.release() }

    const { rows } = await pool.query<{ seen_count: number }>(
      "SELECT seen_count FROM mapping_conflicts WHERE anime_id = $1 AND provider = 'mal'", [claimant])
    assert.equal(rows.length, 1, 'one row per (anime, provider, id)')
    assert.equal(rows[0]!.seen_count, 3)
  })

  test('the real import path enriches a row whose MAL id is taken', async () => {
    // The end the whole change exists for. Before, upsertMedia raised here and
    // the batch was lost; now the row gets its synopsis, cover and score, and
    // only the MAL id is withheld.
    const { loadCaches, upsertMedia } = await import('../src/workers/anilist.ts')
    const mal = freeMalId()
    const holder = await anime(mal)
    const claimant = await anime()
    const anilistId = 900_000_000 + Math.floor(Math.random() * 9_000_000)
    await pool.query('UPDATE anime_mappings SET anilist_id = $2 WHERE anime_id = $1', [claimant, anilistId])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const caches = await loadCaches(client)
      const enriched = await upsertMedia(client, {
        id: anilistId,
        idMal: mal,                       // already held by `holder`
        title: { romaji: 'Collision Test', userPreferred: 'Collision Test' },
        description: 'A synopsis that must survive the collision.',
        averageScore: 77,
        episodes: 12
      } as never, caches)
      assert.equal(enriched, true, 'the row must still be enriched')
      await client.query('COMMIT')
    } finally { client.release() }

    const { rows } = await pool.query<{ synopsis: string | null, average_score: number | null }>(
      'SELECT synopsis, average_score FROM anime WHERE id = $1', [claimant])
    assert.match(rows[0]!.synopsis ?? '', /must survive the collision/, 'the enrichment must be committed')
    assert.equal(Number(rows[0]!.average_score), 77)

    const mapping = await pool.query<{ mal_id: number | null }>(
      'SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [claimant])
    assert.equal(mapping.rows[0]!.mal_id, null, 'only the MAL id is withheld')

    const conflict = await pool.query<{ held_by: string }>(
      "SELECT held_by FROM mapping_conflicts WHERE anime_id = $1 AND provider = 'mal'", [claimant])
    assert.equal(conflict.rows[0]?.held_by, holder)
  })

  test('--retry-conflicts attaches an id once the collision is resolved', async () => {
    // The gap the ordinary run cannot close: a conflicted row already has its
    // synopsis, so `onlyMissing` will never look at it again.
    const { retryMappingConflicts } = await import('../src/workers/anilist.ts')
    const mal = freeMalId()
    const holder = await anime(mal)
    const claimant = await anime()

    const client = await pool.connect()
    try {
      assert.equal(await writeMalId(client, claimant, mal), 'conflict')
    } finally { client.release() }

    // Nothing changed yet: a retry must leave it recorded, not force it.
    await retryMappingConflicts()
    let open = await pool.query('SELECT resolved_at FROM mapping_conflicts WHERE anime_id = $1', [claimant])
    assert.equal(open.rows[0]!.resolved_at, null, 'an unresolved collision stays unresolved')

    // Now the duplicate is merged away, which is what frees the id.
    await pool.query('DELETE FROM anime WHERE id = $1', [holder])
    made.splice(made.indexOf(holder), 1)

    const { attached } = await retryMappingConflicts()
    assert.ok(attached >= 1)

    const mapping = await pool.query<{ mal_id: number }>(
      'SELECT mal_id FROM anime_mappings WHERE anime_id = $1', [claimant])
    assert.equal(mapping.rows[0]!.mal_id, mal, 'the id must now be attached')
    open = await pool.query('SELECT resolved_at FROM mapping_conflicts WHERE anime_id = $1', [claimant])
    assert.notEqual(open.rows[0]!.resolved_at, null, 'and the record closed')
  })

  test('a savepoint keeps one bad row from taking the batch with it', async () => {
    // This is the structure enrichFromAniList now uses. Without the savepoint
    // the failing statement aborts the transaction and the row written before
    // it is lost too — which is exactly what produced 9 650 missing rows.
    const mal = freeMalId()
    await anime(mal)              // holder, so the bad write below really fails
    const good1 = await anime()
    const bad = await anime()
    const good2 = await anime()

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const [id, malId] of [[good1, freeMalId()], [bad, mal], [good2, freeMalId()]] as const) {
        await client.query('SAVEPOINT row')
        try {
          // The *old* blind statement, on purpose: the savepoint has to hold
          // even when the write itself is the thing that raises.
          await client.query(
            'UPDATE anime_mappings SET mal_id = coalesce(mal_id, $2) WHERE anime_id = $1', [id, malId])
          await client.query('RELEASE SAVEPOINT row')
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT row')
        }
      }
      await client.query('COMMIT')
    } finally { client.release() }

    const { rows } = await pool.query<{ anime_id: string, mal_id: number | null }>(
      'SELECT anime_id, mal_id FROM anime_mappings WHERE anime_id = ANY($1)', [[good1, bad, good2]])
    const byId = new Map(rows.map(r => [r.anime_id, r.mal_id]))
    assert.notEqual(byId.get(good1), null, 'the row before the failure must survive')
    assert.notEqual(byId.get(good2), null, 'the row after the failure must still be written')
    assert.equal(byId.get(bad), null, 'only the failing row is rolled back')
  })
})
