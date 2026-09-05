// Cast, staff, relations and recommendations: the import and the endpoints.
//
// All five tables have been in the schema since migration 0002 and all five
// were empty, because `MEDIA_FIELDS` never asked AniList for any of it — and
// above the tables there was nothing either: no endpoint over characters,
// staff or recommendations, and no client mapping. "No character data." was
// the only thing an anime page could say about a catalogue title.
//
// AniList cannot be reached from a test (and must not be: a suite that depends
// on somebody else's API fails for reasons that have nothing to do with the
// code). So the fetch is not exercised here — `upsertDeep` is fed a response
// shaped exactly like AniList's, and everything from there down is real: real
// tables, real constraints, real endpoints.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'deep-test-secret-long-enough-0123456789'

describe('deep AniList metadata', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let pool: pg.Pool
  let app: FastifyInstance
  let upsertDeep: typeof import('../src/workers/anilist-deep.ts').upsertDeep
  const made: string[] = []
  const madeCharacters: number[] = []
  const madePeople: number[] = []

  const uniqueId = (): number => 800_000_000 + Math.floor(Math.random() * 99_000_000)

  async function anime (anilistId?: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV', 'FINISHED', 'public') RETURNING id`, [`itest-deep-${randomUUID()}`])
    const id = rows[0]!.id
    made.push(id)
    await pool.query('INSERT INTO anime_mappings (anime_id, anilist_id) VALUES ($1, $2)', [id, anilistId ?? null])
    return id
  }

  before(async () => {
    const [db, { buildApp }] = await Promise.all([import('../src/db.ts'), import('../src/app.ts')])
    pool = db.pool as never
    ;({ upsertDeep } = await import('../src/workers/anilist-deep.ts'))
    app = await buildApp()
    await app.ready()
  })

  after(async () => {
    if (made.length) await pool.query('DELETE FROM anime WHERE id = ANY($1)', [made])
    if (madeCharacters.length) await pool.query('DELETE FROM characters WHERE anilist_id = ANY($1)', [madeCharacters])
    if (madePeople.length) await pool.query('DELETE FROM people WHERE anilist_id = ANY($1)', [madePeople])
    await app?.close()
    await pool?.end()
  })

  /** An AniList media payload, in the exact shape the deep query returns. */
  function payload (self: number, opts: { related?: number, recommended?: number } = {}): never {
    const characterId = uniqueId()
    const jaActor = uniqueId()
    const huActor = uniqueId()
    const director = uniqueId()
    madeCharacters.push(characterId)
    madePeople.push(jaActor, huActor, director)
    return {
      id: self,
      characters: {
        edges: [{
          role: 'MAIN',
          node: { id: characterId, name: { full: 'Test Protagonist', native: 'テスト' }, image: { large: 'https://img/c.png' }, description: 'A character.' },
          voiceActors: [
            { id: jaActor, name: { full: 'Japanese Actor', native: '声優' }, image: { large: 'https://img/ja.png' }, languageV2: 'JAPANESE' },
            { id: huActor, name: { full: 'Magyar Szinkron', native: null }, image: { large: 'https://img/hu.png' }, languageV2: 'HUNGARIAN' },
            // A language we do not store; it must be skipped, not crash.
            { id: uniqueId(), name: { full: 'Korean Actor', native: null }, image: null, languageV2: 'KOREAN' }
          ]
        }]
      },
      staff: { edges: [{ role: 'Director', node: { id: director, name: { full: 'Test Director', native: null }, image: { large: 'https://img/d.png' } } }] },
      relations: {
        edges: [
          ...(opts.related ? [{ relationType: 'SEQUEL', node: { id: opts.related, type: 'ANIME' } }] : []),
          // AniList emits relation types our CHECK constraint does not list,
          // and manga relations that have no row in `anime` at all.
          { relationType: 'SOURCE', node: { id: 999_999_991, type: 'MANGA' } },
          { relationType: 'CONTAINS', node: { id: 999_999_992, type: 'ANIME' } }
        ]
      },
      recommendations: {
        nodes: [
          ...(opts.recommended ? [{ rating: 42, mediaRecommendation: { id: opts.recommended, type: 'ANIME' } }] : []),
          { rating: 10, mediaRecommendation: { id: 999_999_993, type: 'ANIME' } }
        ]
      }
    } as never
  }

  test('writes the cast, its voices per language, and the staff', async () => {
    const selfId = uniqueId()
    const animeId = await anime(selfId)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const counts = await upsertDeep(client, payload(selfId), animeId)
      await client.query('COMMIT')
      assert.equal(counts.characters, 1)
      assert.equal(counts.voices, 2, 'the Korean actor is not stored, the other two are')
      assert.equal(counts.staff, 1)
    } finally { client.release() }

    const cast = await pool.query<{ name: string, role: string }>(
      `SELECT c.name, ac.role FROM anime_characters ac JOIN characters c ON c.id = ac.character_id
        WHERE ac.anime_id = $1`, [animeId])
    assert.equal(cast.rows.length, 1)
    assert.equal(cast.rows[0]!.role, 'MAIN')

    const voices = await pool.query<{ language: string, name: string }>(
      `SELECT cv.language, p.name FROM character_voices cv JOIN people p ON p.id = cv.person_id
        WHERE cv.anime_id = $1 ORDER BY cv.language`, [animeId])
    assert.deepEqual(voices.rows.map(r => r.language), ['hu', 'ja'],
      'a dub is a second credit, not a replacement for the original')

    const staff = await pool.query<{ role: string }>('SELECT role FROM anime_staff WHERE anime_id = $1', [animeId])
    assert.equal(staff.rows[0]!.role, 'Director')
  })

  test('links relations and recommendations that exist, skips the rest', async () => {
    const selfId = uniqueId()
    const relatedAl = uniqueId()
    const recAl = uniqueId()
    const animeId = await anime(selfId)
    const relatedId = await anime(relatedAl)
    const recId = await anime(recAl)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const counts = await upsertDeep(client, payload(selfId, { related: relatedAl, recommended: recAl }), animeId)
      await client.query('COMMIT')
      // The manga relation and the two ids that are not in the catalogue are
      // skipped: both columns are foreign keys into `anime`, and inventing a
      // row to satisfy one would put a title in the catalogue nobody imported.
      assert.equal(counts.relations, 1)
      assert.equal(counts.recommendations, 1)
    } finally { client.release() }

    const rel = await pool.query<{ related_id: string, relation: string }>(
      'SELECT related_id, relation FROM anime_relations WHERE anime_id = $1', [animeId])
    assert.equal(rel.rows.length, 1)
    assert.equal(rel.rows[0]!.related_id, relatedId)
    assert.equal(rel.rows[0]!.relation, 'SEQUEL')

    const rec = await pool.query<{ recommended_id: string, score: number, source: string }>(
      'SELECT recommended_id, score, source FROM anime_recommendations WHERE anime_id = $1', [animeId])
    assert.equal(rec.rows[0]!.recommended_id, recId)
    assert.equal(rec.rows[0]!.score, 42)
    assert.equal(rec.rows[0]!.source, 'import')
  })

  test('running it twice changes nothing', async () => {
    // The importer is meant to be resumable, so a second pass over a title
    // already done must update rather than duplicate. Without anilist_id on
    // characters and people (migration 0027) this would insert the cast again
    // on every run — names are not unique.
    const selfId = uniqueId()
    const animeId = await anime(selfId)
    const media = payload(selfId)

    for (let i = 0; i < 2; i++) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await upsertDeep(client, media, animeId)
        await client.query('COMMIT')
      } finally { client.release() }
    }

    const cast = await pool.query('SELECT 1 FROM anime_characters WHERE anime_id = $1', [animeId])
    const voices = await pool.query('SELECT 1 FROM character_voices WHERE anime_id = $1', [animeId])
    const staff = await pool.query('SELECT 1 FROM anime_staff WHERE anime_id = $1', [animeId])
    assert.equal(cast.rows.length, 1)
    assert.equal(voices.rows.length, 2)
    assert.equal(staff.rows.length, 1)
  })

  test('the endpoints serve what was imported', async () => {
    const selfId = uniqueId()
    const recAl = uniqueId()
    const animeId = await anime(selfId)
    const recId = await anime(recAl)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await upsertDeep(client, payload(selfId, { recommended: recAl }), animeId)
      await client.query('COMMIT')
    } finally { client.release() }

    const chars = await app.inject({ url: `/v1/anime/${animeId}/characters` })
    assert.equal(chars.statusCode, 200)
    const cast = (chars.json() as { data: Array<{ name: string, role: string, voices: Array<{ language: string }> }> }).data
    assert.equal(cast.length, 1)
    assert.equal(cast[0]!.role, 'MAIN')
    // Aggregated, not joined flat: one character with two voices is one row.
    assert.equal(cast[0]!.voices.length, 2)

    const staff = await app.inject({ url: `/v1/anime/${animeId}/staff` })
    assert.equal(staff.statusCode, 200)
    assert.equal((staff.json() as { data: unknown[] }).data.length, 1)

    const recs = await app.inject({ url: `/v1/anime/${animeId}/recommendations` })
    assert.equal(recs.statusCode, 200)
    const list = (recs.json() as { data: Array<{ id: string }> }).data
    assert.equal(list.length, 1)
    assert.equal(list[0]!.id, recId)

    // All three are public: the catalogue is readable without an account.
    for (const path of ['characters', 'staff', 'recommendations']) {
      assert.equal((await app.inject({ url: `/v1/anime/${animeId}/${path}` })).statusCode, 200, path)
    }
  })
})
