// The second AniList pass: cast, staff, relations and recommendations.
//
// ---------------------------------------------------------------------------
// Why this is a separate pass
// ---------------------------------------------------------------------------
// `enrichFromAniList` asks for 50 media at a time and gets back scalars — a
// title, a score, a synopsis. Attaching a cast to that query multiplies the
// response by the number of characters per show and runs into AniList's query
// complexity limit, so the fast pass would become the slow pass for everybody,
// including the people who only wanted a synopsis.
//
// So: fewer media per request, its own progress, its own flag. The catalogue
// stays usable while this runs, and a failure here does not cost the basic
// enrichment that already succeeded.
//
// ---------------------------------------------------------------------------
// What ends up where
// ---------------------------------------------------------------------------
//   characters + anime_characters   the cast, with MAIN/SUPPORTING/BACKGROUND
//   people + character_voices       voice actors, per language (so a dub is
//                                   a separate credit, not a replacement)
//   people + anime_staff            director, composer, character design…
//   anime_relations                 sequels, prequels, side stories
//   anime_recommendations           "if you liked this"
//
// All five were empty before this existed. The tables have been in the schema
// since migration 0002; nothing ever wrote to them.

import { pool, transaction } from '../db.ts'

import type pg from 'pg'

const ANILIST_URL = 'https://graphql.anilist.co'
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Pause between requests. AniList allows 90/min; this stays well under. */
const DELAY_MS = Number(process.env.AL_DELAY_MS ?? 2000)

/**
 * Media per request.
 *
 * Deliberately small. Each one carries up to 25 characters with their voice
 * actors, 15 staff credits, its relations and 10 recommendations, and AniList
 * rejects a query whose *complexity* is too high long before the response gets
 * large. Ten is a size that has room to spare.
 */
const DEEP_BATCH = Number(process.env.AL_DEEP_BATCH ?? 10)

/** Voice-actor languages worth storing. Japanese always; the rest for dubs. */
const VOICE_LANGUAGES = ['JAPANESE', 'ENGLISH', 'HUNGARIAN'] as const

/**
 * AniList's relation vocabulary is wider than ours.
 *
 * `anime_relations.relation` has a CHECK constraint listing nine values, and
 * AniList emits thirteen. The four it does not share are folded into OTHER
 * rather than dropped: a relation nobody has a name for is still a relation,
 * and losing it would leave a hole in the relation tree the UI walks.
 */
const RELATION_MAP: Record<string, string> = {
  SEQUEL: 'SEQUEL',
  PREQUEL: 'PREQUEL',
  SIDE_STORY: 'SIDE_STORY',
  PARENT: 'PARENT',
  SUMMARY: 'SUMMARY',
  ALTERNATIVE: 'ALTERNATIVE',
  SPIN_OFF: 'SPIN_OFF',
  ADAPTATION: 'ADAPTATION',
  CHARACTER: 'OTHER',
  SOURCE: 'OTHER',
  COMPILATION: 'OTHER',
  CONTAINS: 'OTHER',
  OTHER: 'OTHER'
}

const CHARACTER_ROLES = new Set(['MAIN', 'SUPPORTING', 'BACKGROUND'])

export interface DeepMedia {
  id: number
  characters?: { edges?: Array<{
    role?: string | null
    node?: { id: number, name?: { full?: string | null, native?: string | null } | null, image?: { large?: string | null } | null, description?: string | null } | null
    voiceActors?: Array<{ id: number, name?: { full?: string | null, native?: string | null } | null, image?: { large?: string | null } | null, languageV2?: string | null }> | null
  }> | null } | null
  staff?: { edges?: Array<{
    role?: string | null
    node?: { id: number, name?: { full?: string | null, native?: string | null } | null, image?: { large?: string | null } | null } | null
  }> | null } | null
  relations?: { edges?: Array<{ relationType?: string | null, node?: { id: number, type?: string | null } | null }> | null } | null
  recommendations?: { nodes?: Array<{ rating?: number | null, mediaRecommendation?: { id: number, type?: string | null } | null }> | null } | null
}

const DEEP_FIELDS = `
  id
  characters(sort: [ROLE, RELEVANCE], perPage: 25) {
    edges {
      role
      node { id name { full native } image { large } description(asHtml: false) }
      voiceActors { id name { full native } image { large } languageV2 }
    }
  }
  staff(perPage: 15) {
    edges { role node { id name { full native } image { large } } }
  }
  relations { edges { relationType node { id type } } }
  recommendations(sort: RATING_DESC, perPage: 10) {
    nodes { rating mediaRecommendation { id type } }
  }`

/** Fetch the deep fields for a small batch of AniList ids. */
export async function fetchDeepBatch (ids: number[]): Promise<DeepMedia[]> {
  const query = `query ($ids: [Int]) { Page(perPage: ${DEEP_BATCH}) { media(id_in: $ids, type: ANIME) { ${DEEP_FIELDS} } } }`
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { ids } })
  })
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60)
    await sleep((retry + 1) * 1000)
    return fetchDeepBatch(ids)
  }
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`)
  const body = await res.json() as { data?: { Page?: { media?: DeepMedia[] } }, errors?: Array<{ message: string }> }
  if (body.errors?.length) throw new Error('AniList: ' + body.errors.map(e => e.message).join('; '))
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? 99)
  if (remaining <= 2) await sleep(60_000)
  return body.data?.Page?.media ?? []
}

const clean = (s?: string | null): string | null => {
  const v = (s ?? '').trim()
  return v ? v.slice(0, 2000) : null
}

/**
 * Find or create a character by its AniList id, returning our uuid.
 *
 * Upsert on `anilist_id` rather than on the name: several characters are
 * called "Akira", and matching on the name would merge them into one.
 */
async function upsertCharacter (client: pg.PoolClient, node: NonNullable<NonNullable<NonNullable<DeepMedia['characters']>['edges']>[number]['node']>): Promise<string | null> {
  const name = clean(node.name?.full)
  if (!name) return null
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO characters (anilist_id, name, native_name, image_key, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (anilist_id) DO UPDATE
        SET name = excluded.name,
            native_name = excluded.native_name,
            image_key = excluded.image_key,
            description = coalesce(excluded.description, characters.description)
     RETURNING id`,
    [node.id, name, clean(node.name?.native), clean(node.image?.large), clean(node.description)]
  )
  return rows[0]?.id ?? null
}

/** Same, for a voice actor or staff member. */
async function upsertPerson (client: pg.PoolClient, node: { id: number, name?: { full?: string | null, native?: string | null } | null, image?: { large?: string | null } | null }): Promise<string | null> {
  const name = clean(node.name?.full)
  if (!name) return null
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO people (anilist_id, name, native_name, image_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (anilist_id) DO UPDATE
        SET name = excluded.name, native_name = excluded.native_name, image_key = excluded.image_key
     RETURNING id`,
    [node.id, name, clean(node.name?.native), clean(node.image?.large)]
  )
  return rows[0]?.id ?? null
}

/** Our anime uuid for an AniList id, or null when the show is not in the catalogue. */
async function localId (client: pg.PoolClient, anilistId: number): Promise<string | null> {
  const { rows } = await client.query<{ anime_id: string }>(
    'SELECT anime_id FROM anime_mappings WHERE anilist_id = $1', [anilistId]
  )
  return rows[0]?.anime_id ?? null
}

export interface DeepCounts { characters: number, voices: number, staff: number, relations: number, recommendations: number }

/**
 * Write one media's cast, staff, relations and recommendations.
 *
 * Every insert is `ON CONFLICT DO UPDATE` or `DO NOTHING`, so the whole thing
 * is repeatable: running it twice writes the same rows, and a show whose cast
 * has changed on AniList gets the change rather than a second copy.
 *
 * Relations and recommendations that point outside our catalogue are skipped
 * rather than stubbed. Both columns are foreign keys into `anime`, and
 * inventing a row to satisfy one would put a title in the catalogue that
 * nobody imported and nothing can play.
 */
export async function upsertDeep (client: pg.PoolClient, media: DeepMedia, animeId: string): Promise<DeepCounts> {
  const counts: DeepCounts = { characters: 0, voices: 0, staff: 0, relations: 0, recommendations: 0 }

  // ---- cast, and the voices behind it -------------------------------------
  for (const edge of media.characters?.edges ?? []) {
    if (!edge?.node) continue
    const role = CHARACTER_ROLES.has(String(edge.role)) ? String(edge.role) : 'BACKGROUND'
    const characterId = await upsertCharacter(client, edge.node)
    if (!characterId) continue

    await client.query(
      `INSERT INTO anime_characters (anime_id, character_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (anime_id, character_id) DO UPDATE SET role = excluded.role`,
      [animeId, characterId, role]
    )
    counts.characters++

    for (const actor of edge.voiceActors ?? []) {
      // A credit is per language: the Japanese and the Hungarian voice of one
      // character are two rows, not a contest between them.
      const language = String(actor?.languageV2 ?? 'JAPANESE').toUpperCase()
      if (!VOICE_LANGUAGES.includes(language as typeof VOICE_LANGUAGES[number])) continue
      const personId = await upsertPerson(client, actor)
      if (!personId) continue
      await client.query(
        `INSERT INTO character_voices (character_id, anime_id, person_id, language)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        // 'ja' / 'en' / 'hu' — the two-letter form the player and the sub/dub
        // switch already speak.
        [characterId, animeId, personId, language.toLowerCase().slice(0, 2)]
      )
      counts.voices++
    }
  }

  // ---- production staff ----------------------------------------------------
  for (const edge of media.staff?.edges ?? []) {
    if (!edge?.node) continue
    const role = clean(edge.role)
    if (!role) continue                       // the role is part of the key
    const personId = await upsertPerson(client, edge.node)
    if (!personId) continue
    await client.query(
      'INSERT INTO anime_staff (anime_id, person_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [animeId, personId, role.slice(0, 200)]
    )
    counts.staff++
  }

  // ---- the relation graph --------------------------------------------------
  for (const edge of media.relations?.edges ?? []) {
    const node = edge?.node
    if (!node || node.type !== 'ANIME') continue          // manga has no row here
    const relation = RELATION_MAP[String(edge.relationType)] ?? 'OTHER'
    const relatedId = await localId(client, node.id)
    if (!relatedId || relatedId === animeId) continue     // CHECK forbids self-relations
    await client.query(
      'INSERT INTO anime_relations (anime_id, related_id, relation) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [animeId, relatedId, relation]
    )
    counts.relations++
  }

  // ---- recommendations -----------------------------------------------------
  for (const node of media.recommendations?.nodes ?? []) {
    const rec = node?.mediaRecommendation
    if (!rec || rec.type !== 'ANIME') continue
    const recommendedId = await localId(client, rec.id)
    if (!recommendedId || recommendedId === animeId) continue
    await client.query(
      `INSERT INTO anime_recommendations (anime_id, recommended_id, score, source)
       VALUES ($1, $2, $3, 'import')
       ON CONFLICT (anime_id, recommended_id) DO UPDATE SET score = excluded.score`,
      [animeId, recommendedId, Math.max(0, Number(node.rating ?? 0))]
    )
    counts.recommendations++
  }

  return counts
}

/**
 * Drive the deep enrichment.
 *
 * `onlyMissing` (the default) skips anything that already has a cast, so an
 * interrupted run resumes where it stopped instead of starting over. That
 * matters more here than in the fast pass: at ten media per request and a
 * two-second pause, a full catalogue is hours of work.
 */
export async function enrichDeepFromAniList (
  opts: { limit?: number, onlyMissing?: boolean, onProgress?: (done: number, total: number, counts: DeepCounts) => void } = {}
): Promise<{ processed: number, failed: number, rowFailures: number } & DeepCounts> {
  const onlyMissing = opts.onlyMissing ?? true
  const { rows } = await pool.query<{ anime_id: string, anilist_id: number }>(
    `SELECT m.anime_id, m.anilist_id
       FROM anime_mappings m
       JOIN anime a ON a.id = m.anime_id
      WHERE m.anilist_id IS NOT NULL
        ${onlyMissing ? 'AND NOT EXISTS (SELECT 1 FROM anime_characters ac WHERE ac.anime_id = m.anime_id)' : ''}
      ORDER BY a.popularity DESC NULLS LAST
      ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ''}`
  )

  const byAnilist = new Map(rows.map(r => [r.anilist_id, r.anime_id]))
  const ids = rows.map(r => r.anilist_id)
  const total = ids.length
  const counts: DeepCounts = { characters: 0, voices: 0, staff: 0, relations: 0, recommendations: 0 }
  let processed = 0
  let failed = 0
  let rowFailures = 0

  for (let i = 0; i < ids.length; i += DEEP_BATCH) {
    const batch = ids.slice(i, i + DEEP_BATCH)
    try {
      const media = await fetchDeepBatch(batch)
      await transaction(async client => {
        for (const m of media) {
          const animeId = byAnilist.get(m.id)
          if (!animeId) continue
          // Per-row savepoint, the same reason as the fast pass: one show with
          // an unexpected shape must not discard the nine imported beside it.
          await client.query('SAVEPOINT deep_row')
          try {
            const got = await upsertDeep(client, m, animeId)
            for (const key of Object.keys(counts) as Array<keyof DeepCounts>) counts[key] += got[key]
            await client.query('RELEASE SAVEPOINT deep_row')
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT deep_row')
            rowFailures++
            console.error(`  anilist_id ${m.id}: ${(err as Error).message}`)
          }
        }
      })
    } catch (err) {
      failed += batch.length
      console.error(`deep batch ${Math.floor(i / DEEP_BATCH) + 1} failed:`, (err as Error).message)
    }
    processed += batch.length
    opts.onProgress?.(processed, total, counts)
    if (i + DEEP_BATCH < ids.length) await sleep(DELAY_MS)
  }

  return { processed, failed, rowFailures, ...counts }
}
