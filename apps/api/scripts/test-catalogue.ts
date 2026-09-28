// A small, deterministic catalogue for a test database.
//
// Most suites need something to point at: a public title to put in a library,
// an episode to report progress on, a cover to choose as a profile picture, a
// relation to walk. A freshly migrated database has none of that, and those
// suites failed on it — not because the code was wrong but because
// `SELECT id FROM anime WHERE visibility = 'public' LIMIT 1` came back empty.
// CI never noticed, because CI was not running them at all (see
// .github/workflows/check.yml).
//
// Sizes and dates are set by the suites that measure against the catalogue:
//
//   * 1,100 titles — more than one 1,000-row library page, and more than one
//     250-row batch of the founder seeder, both of which are asserted;
//   * every title has a cover, every other one a banner, three are not
//     public (two hidden, one unlisted), each has twelve episodes and a
//     mapping, and they are chained into franchises of four;
//   * every row is dated years back, so nothing here is "new" to the Discord
//     episode feed, which announces episodes created in the last two days;
//   * images point at the app's own assets (same origin), so a browser test
//     that routes every request through the test server can load them.
//
// Set-based SQL, so it takes seconds. Idempotent: a database that already has
// the fixture is left alone. It refuses any database whose name does not end
// in `_test`.
//
//   DATABASE_URL=postgres://…/yume_test node --experimental-strip-types scripts/test-catalogue.ts

import { pool } from '../src/infrastructure/database/index.ts'

const FIRST_ANILIST_ID = 9_000_001
const TITLES = 1_100
const EPISODES = 12
const LONG_AGO = '2019-01-01T00:00:00Z'

const GENRES = [
  ['action', 'Action'], ['comedy', 'Comedy'], ['drama', 'Drama'],
  ['fantasy', 'Fantasy'], ['romance', 'Romance'], ['sci-fi', 'Sci-Fi']
] as const

async function main (): Promise<void> {
  const name = new URL(process.env.DATABASE_URL ?? 'postgres://localhost/unknown').pathname.slice(1)
  if (!name.endsWith('_test')) {
    console.error(`test-catalogue: refusing to write to "${name}" — only a *_test database gets fixture data`)
    process.exit(1)
  }

  const present = await pool.query('SELECT 1 FROM anime_mappings WHERE anilist_id = $1', [FIRST_ANILIST_ID])
  if (present.rowCount) {
    console.log('test-catalogue: the fixture is already there, leaving it alone')
    await pool.end()
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // `genres.id` is an identity column, so genres are matched by slug.
    for (const [slug, label] of GENRES) {
      await client.query('INSERT INTO genres (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [slug, label])
    }

    await client.query(
      `CREATE TEMP TABLE fixture ON COMMIT DROP AS
       SELECT n, gen_random_uuid() AS id FROM generate_series(1, $1::int) AS n`, [TITLES])

    await client.query(
      `INSERT INTO anime (id, canonical_title, format, status, season, season_year, start_date,
                          episode_count, episode_duration, is_adult, synopsis, average_score,
                          popularity, trending, visibility, created_at, updated_at)
       SELECT f.id,
              'Fixture Title ' || lpad(f.n::text, 4, '0'),
              (ARRAY['TV','TV','TV','MOVIE','OVA','ONA'])[1 + f.n % 6]::anime_format,
              (ARRAY['FINISHED','FINISHED','RELEASING','NOT_YET_RELEASED'])[1 + f.n % 4]::anime_status,
              (ARRAY['WINTER','SPRING','SUMMER','FALL'])[1 + f.n % 4]::anime_season,
              2010 + f.n % 15,
              make_date(2010 + f.n % 15, 1 + f.n % 12, 1),
              $2::int, 24, false,
              'Synopsis of fixture title ' || f.n || '.',
              50 + f.n % 50,
              100000 - f.n,
              f.n % 7,
              CASE WHEN f.n > $1::int - 2 THEN 'hidden' WHEN f.n = $1::int - 2 THEN 'unlisted' ELSE 'public' END,
              $3::timestamptz, $3::timestamptz
         FROM fixture f`,
      [TITLES, EPISODES, LONG_AGO])

    await client.query(
      `INSERT INTO anime_titles (anime_id, kind, title)
       SELECT f.id, t.kind, CASE t.kind
                 WHEN 'romaji' THEN 'Fikusucha Taitoru ' || f.n
                 WHEN 'english' THEN 'Fixture Title ' || lpad(f.n::text, 4, '0')
                 ELSE 'フィクスチャ ' || f.n END
         FROM fixture f CROSS JOIN (VALUES ('romaji'), ('english'), ('native')) AS t(kind)`)
    await client.query(
      `INSERT INTO anime_synonyms (anime_id, synonym) SELECT id, 'FT' || n FROM fixture`)
    await client.query(
      `INSERT INTO anime_genres (anime_id, genre_id)
       SELECT f.id, g.id FROM fixture f
         JOIN (SELECT id, row_number() OVER (ORDER BY slug) - 1 AS k FROM genres
                WHERE slug IN ('action', 'comedy', 'drama', 'fantasy', 'romance', 'sci-fi')) g
           ON g.k IN (f.n % 6, (f.n + 1) % 6)`)
    await client.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, is_primary, dominant_color)
       SELECT id, 'cover', '/assets/yume.svg?cover=' || n, true, '#e91e63' FROM fixture`)
    await client.query(
      `INSERT INTO anime_images (anime_id, kind, object_key, is_primary)
       SELECT id, 'banner', '/assets/logo.svg?banner=' || n, true FROM fixture WHERE n % 2 = 1`)
    await client.query(
      `INSERT INTO anime_mappings (anime_id, anilist_id, mal_id)
       SELECT id, $1::int + n - 1, 8000000 + n FROM fixture`, [FIRST_ANILIST_ID])
    await client.query(
      `INSERT INTO episodes (anime_id, number, title, air_date, duration, visibility, created_at, updated_at)
       SELECT f.id, e, 'Episode ' || e,
              $2::timestamptz + (f.n % 300) * interval '1 day' + (e - 1) * interval '7 days',
              24, 'public', $2::timestamptz, $2::timestamptz
         FROM fixture f CROSS JOIN generate_series(1, $1::int) AS e`, [EPISODES, LONG_AGO])

    // Franchises of four: 1 → 2 → 3 → 4, 5 → 6 → 7 → 8, …
    await client.query(
      `INSERT INTO anime_relations (anime_id, related_id, relation)
       SELECT a.id, b.id, 'SEQUEL' FROM fixture a JOIN fixture b ON b.n = a.n + 1 WHERE a.n % 4 <> 0
       UNION ALL
       SELECT b.id, a.id, 'PREQUEL' FROM fixture a JOIN fixture b ON b.n = a.n + 1 WHERE a.n % 4 <> 0`)
    await client.query(
      `INSERT INTO anime_recommendations (anime_id, recommended_id, score)
       SELECT a.id, b.id, 10 + a.n % 90 FROM fixture a JOIN fixture b ON b.n = 1 + (a.n + 4) % $1::int`, [TITLES])

    await client.query(
      `INSERT INTO service_status (service, status, latency_ms, detail, checked_at, since)
       VALUES ('postgres', 'green', 1, 'fixture', now(), now()),
              ('redis', 'not_configured', NULL, 'REDIS_URL is not set', now(), now())
       ON CONFLICT (service) DO NOTHING`)

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  console.log(`test-catalogue: ${TITLES} titles, ${TITLES * EPISODES} episodes`)
  await pool.end()
}

await main()
