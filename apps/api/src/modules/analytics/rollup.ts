// Napi összesítés — a panel soha nem olvas nyers eseménytáblát.
//
// „Hány látogató volt 90 napja" nyersen több millió sor végigolvasása, és a
// panel minden frissítésnél újra kifizetné. Napi összesítőből ugyanez 90 sor.
// Ez a különbség az, ami miatt egy látogatottsági rendszer vagy elfér ugyanazon
// a Postgresen, vagy nem.
//
// Mikor fut: óránként a mai napra (hogy a panel ne legyen egy napot késésben),
// és éjfél után egyszer a tegnapira, véglegesítve.
//
// Idempotens, mindenütt. Egy összesítő újraszámolása ugyanazt adja, mert
// mindegyik `INSERT ... ON CONFLICT DO UPDATE SET` a frissen számolt értékre —
// nem hozzáadás. Egy félbeszakadt futás megismételhető, és egy kétszer lefutott
// nap nem duplázza a számokat. Ez az a hiba, amit összesítőknél a leggyakrabban
// elkövetnek, és utólag nem lehet szétválogatni.

import { query } from '../../infrastructure/database/index.ts'

/** Meddig élnek a nyers sorok. Az összesítők maradnak. */
const RETENTION = {
  pageViews: Number(process.env.ANALYTICS_RAW_RETENTION_DAYS ?? 90),
  sessions: Number(process.env.ANALYTICS_SESSION_RETENTION_DAYS ?? 90),
  // A nyers keresőkifejezés személyes adat lehet (valaki a saját nevére keres).
  // A normalizált marad, a nyers eltűnik.
  searchRaw: Number(process.env.ANALYTICS_SEARCH_RAW_DAYS ?? 30),
  accountEvents: Number(process.env.ACCOUNT_EVENT_RETENTION_DAYS ?? 365),
  salt: 2
}

/** A nap, amire összesítünk. Alapból ma. */
function dayOf (day?: string): string {
  return day ?? new Date().toISOString().slice(0, 10)
}

/**
 * A látogatottság napi sora.
 *
 * Minden szám EGY lekérdezésből jön, nem tizenötből: a munkamenettábla egyszer
 * olvasódik végig a napra, és a `FILTER` záradékok ugyanazon a menetben
 * számolnak. Tizenöt külön count ugyanazt a sorhalmazt olvasná tizenötször.
 */
export async function rollupVisitors (day?: string): Promise<void> {
  const d = dayOf(day)
  await query(
    `INSERT INTO analytics_daily (
        day, sessions, visitors, authed_sessions, anon_sessions,
        page_views, avg_duration_sec, bounce_sessions, updated_at)
     SELECT $1::date,
            count(*),
            count(DISTINCT visitor_key),
            count(*) FILTER (WHERE user_id IS NOT NULL),
            count(*) FILTER (WHERE user_id IS NULL),
            coalesce(sum(page_views), 0),
            -- Csak az egy oldalnál többet néző munkamenetekből: egyetlen
            -- oldalletöltésnek nincs értelmezhető hossza, és nullának venni
            -- nem mérés, hanem az átlag lehúzása.
            coalesce(round(avg(extract(epoch FROM last_seen_at - started_at))
              FILTER (WHERE page_views > 1))::int, 0),
            count(*) FILTER (WHERE page_views = 1),
            now()
       FROM analytics_sessions
      WHERE started_at >= $1::date AND started_at < $1::date + 1
        AND NOT is_bot
     ON CONFLICT (day) DO UPDATE SET
        sessions = EXCLUDED.sessions, visitors = EXCLUDED.visitors,
        authed_sessions = EXCLUDED.authed_sessions, anon_sessions = EXCLUDED.anon_sessions,
        page_views = EXCLUDED.page_views, avg_duration_sec = EXCLUDED.avg_duration_sec,
        bounce_sessions = EXCLUDED.bounce_sessions, updated_at = now()`,
    [d]
  )

  // Új és visszatérő. A napi só miatt ez a látogatókulcsból NEM állapítható
  // meg — holnap ugyanaz az ember más kulcsot kap. Bejelentkezett látogatónál
  // viszont pontos, mert a fiók azonosítója marad. Ezért ez a két szám
  // KIZÁRÓLAG a bejelentkezettekről szól, és a panel is így nevezi meg.
  await query(
    `UPDATE analytics_daily SET
        new_visitors = sub.new_users,
        returning_visitors = sub.returning_users
       FROM (
         SELECT count(*) FILTER (WHERE u.created_at >= $1::date) AS new_users,
                count(*) FILTER (WHERE u.created_at <  $1::date) AS returning_users
           FROM (SELECT DISTINCT user_id FROM analytics_sessions
                  WHERE started_at >= $1::date AND started_at < $1::date + 1
                    AND user_id IS NOT NULL AND NOT is_bot) s
           JOIN users u ON u.id = s.user_id
       ) sub
      WHERE analytics_daily.day = $1::date`,
    [d]
  )

  // A bontások. Egy utasítás dimenziónként, mert a dimenziók oszlopok — és
  // egy `UNION ALL` hat olvasást jelentene ugyanazon a napi halmazon.
  await query(
    `INSERT INTO analytics_breakdown (day, dimension, value, sessions, page_views)
     SELECT $1::date, d.dimension, d.value, count(*), coalesce(sum(s.page_views), 0)
       FROM analytics_sessions s
       CROSS JOIN LATERAL (VALUES
         ('device',      coalesce(s.device_class, 'unknown')),
         ('browser',     coalesce(s.browser, 'ismeretlen')),
         ('os',          coalesce(s.os, 'ismeretlen')),
         ('language',    coalesce(s.language, 'ismeretlen')),
         ('screen',      coalesce(s.screen_class, 'unknown')),
         ('country',     coalesce(s.country, '--')),
         ('referrer',    coalesce(s.referrer_host, '(közvetlen)')),
         ('entry_route', coalesce(s.entry_route, '/')),
         ('exit_route',  coalesce(s.exit_route, '/'))
       ) AS d(dimension, value)
      WHERE s.started_at >= $1::date AND s.started_at < $1::date + 1
        AND NOT s.is_bot
      GROUP BY d.dimension, d.value
     ON CONFLICT (day, dimension, value) DO UPDATE SET
        sessions = EXCLUDED.sessions, page_views = EXCLUDED.page_views`,
    [d]
  )
}

/**
 * A nap többi száma: regisztráció, belépés, keresés, hiba.
 *
 * Ezek nem a látogatottsági táblákból jönnek, hanem onnan, ahol amúgy is
 * keletkeznek — a fiókeseményekből, a keresési statisztikából és a
 * hibanaplóból. Egy második írás ugyanarról az eseményről két igazságot
 * jelentene, és előbb-utóbb el is térnének.
 */
export async function rollupActivity (day?: string): Promise<void> {
  const d = dayOf(day)
  await query(
    `INSERT INTO analytics_daily (day, registrations, logins, failed_logins, updated_at)
     SELECT $1::date,
            count(*) FILTER (WHERE event = 'REG' AND result = 'success'),
            count(*) FILTER (WHERE event = 'LOGIN' AND result = 'success'),
            count(*) FILTER (WHERE event = 'LOGIN_FAILED'),
            now()
       FROM account_events
      WHERE created_at >= $1::date AND created_at < $1::date + 1
     ON CONFLICT (day) DO UPDATE SET
        registrations = EXCLUDED.registrations, logins = EXCLUDED.logins,
        failed_logins = EXCLUDED.failed_logins, updated_at = now()`,
    [d]
  )

  await query(
    `INSERT INTO analytics_daily (day, searches, zero_result_searches, updated_at)
     SELECT $1::date, count(*), count(*) FILTER (WHERE result_count = 0), now()
       FROM search_stats
      WHERE created_at >= $1::date AND created_at < $1::date + 1
     ON CONFLICT (day) DO UPDATE SET
        searches = EXCLUDED.searches, zero_result_searches = EXCLUDED.zero_result_searches, updated_at = now()`,
    [d]
  )

  await query(
    `INSERT INTO analytics_daily (day, errors, updated_at)
     SELECT $1::date, count(*), now()
       FROM error_logs
      WHERE created_at >= $1::date AND created_at < $1::date + 1
     ON CONFLICT (day) DO UPDATE SET errors = EXCLUDED.errors, updated_at = now()`,
    [d]
  )

  await query(
    `INSERT INTO analytics_daily (day, episode_starts, episode_completions, watch_seconds, updated_at)
     SELECT $1::date, count(*), count(*) FILTER (WHERE finished), coalesce(sum(watched_sec), 0), now()
       FROM watch_history
      WHERE started_at >= $1::date AND started_at < $1::date + 1
     ON CONFLICT (day) DO UPDATE SET
        episode_starts = EXCLUDED.episode_starts,
        episode_completions = EXCLUDED.episode_completions,
        watch_seconds = EXCLUDED.watch_seconds, updated_at = now()`,
    [d]
  )
}

/**
 * Címenkénti összesítő.
 *
 * Három forrásból: az oldalletöltésekből (megnézés), a nézési előzményből
 * (indítás, befejezés, idő) és a könyvtár/kedvenc táblákból. Mindhárom
 * ugyanarra a napra és ugyanarra a címre.
 */
export async function rollupAnime (day?: string): Promise<void> {
  const d = dayOf(day)

  await query(
    // `unique_viewers` a LÁTOGATÓK száma, nem a munkameneteké. A
    // munkamenetkulcs alakja `<látogatókulcs>:<ablak>`, tehát aki napközben
    // kétszer tér vissza, annak két munkamenete van és egy kulcsa — a
    // munkameneteket számolva ugyanaz az ember kétszer szerepelne, és az
    // „egyedi néző" nem lenne egyedi.
    `INSERT INTO anime_stats_daily (day, anime_id, views, unique_viewers)
     SELECT $1::date, entity_id, count(*), count(DISTINCT split_part(session_key, ':', 1))
       FROM page_views
      WHERE created_at >= $1::date AND created_at < $1::date + 1
        AND entity_id IS NOT NULL
      GROUP BY entity_id
     ON CONFLICT (day, anime_id) DO UPDATE SET
        views = EXCLUDED.views, unique_viewers = EXCLUDED.unique_viewers`,
    [d]
  )

  await query(
    `INSERT INTO anime_stats_daily (day, anime_id, episode_starts, episode_completions, watch_seconds)
     SELECT $1::date, anime_id, count(*), count(*) FILTER (WHERE finished), coalesce(sum(watched_sec), 0)
       FROM watch_history
      WHERE started_at >= $1::date AND started_at < $1::date + 1
      GROUP BY anime_id
     ON CONFLICT (day, anime_id) DO UPDATE SET
        episode_starts = EXCLUDED.episode_starts,
        episode_completions = EXCLUDED.episode_completions,
        watch_seconds = EXCLUDED.watch_seconds`,
    [d]
  )

  await query(
    `INSERT INTO episode_stats_daily (day, episode_id, anime_id, starts, completions, watch_seconds)
     SELECT $1::date, episode_id, anime_id, count(*), count(*) FILTER (WHERE finished), coalesce(sum(watched_sec), 0)
       FROM watch_history
      WHERE started_at >= $1::date AND started_at < $1::date + 1
      GROUP BY episode_id, anime_id
     ON CONFLICT (day, episode_id) DO UPDATE SET
        starts = EXCLUDED.starts, completions = EXCLUDED.completions,
        watch_seconds = EXCLUDED.watch_seconds`,
    [d]
  )

  await query(
    `INSERT INTO anime_stats_daily (day, anime_id, library_adds, favorites_added)
     SELECT $1::date, x.anime_id,
            count(*) FILTER (WHERE x.kind = 'library'),
            count(*) FILTER (WHERE x.kind = 'favorite')
       FROM (
         SELECT anime_id, 'library' AS kind FROM library_entries
          WHERE created_at >= $1::date AND created_at < $1::date + 1
         UNION ALL
         -- A kedvencek polimorfak (subject_type + subject_id): ugyanaz a
         -- tábla tartja a címeket és mindent mást, amit kedvencnek lehet
         -- jelölni. Szűrés nélkül idegen azonosítók kerülnének az
         -- anime-statisztikába, és az idegen kulcs dobná el a beszúrást.
         SELECT subject_id AS anime_id, 'favorite' FROM favorites
          WHERE subject_type = 'anime'
            AND created_at >= $1::date AND created_at < $1::date + 1
       ) x
      GROUP BY x.anime_id
     ON CONFLICT (day, anime_id) DO UPDATE SET
        library_adds = EXCLUDED.library_adds, favorites_added = EXCLUDED.favorites_added`,
    [d]
  )
}

/**
 * Megőrzés.
 *
 * A nyers sorok elmennek, az összesítők maradnak. Ez a különbség adja meg,
 * hogy „mennyien jártak itt tavaly" megválaszolható marad anélkül, hogy
 * bárkiről tárolnánk bármit egy éve.
 *
 * A keresőkifejezésnél nem törlünk sort, csak a NYERS szöveget ürítjük: a
 * normalizált alak marad, tehát a „mire kerestek" kérdés megmarad, a „ki mit
 * gépelt be szó szerint" pedig elmúlik.
 */
export async function pruneAnalytics (): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const del = async (name: string, sql: string, days: number): Promise<void> => {
    const result = await query<{ n: number }>(sql, [days])
    out[name] = Number((result as unknown as Array<{ n: number }>)[0]?.n ?? 0)
  }

  await del('page_views',
    "WITH d AS (DELETE FROM page_views WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1) SELECT count(*)::int AS n FROM d",
    RETENTION.pageViews)
  await del('analytics_sessions',
    "WITH d AS (DELETE FROM analytics_sessions WHERE started_at < now() - ($1 || ' days')::interval RETURNING 1) SELECT count(*)::int AS n FROM d",
    RETENTION.sessions)
  await del('account_events',
    "WITH d AS (DELETE FROM account_events WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1) SELECT count(*)::int AS n FROM d",
    RETENTION.accountEvents)
  await del('search_query_anonymised',
    `WITH d AS (UPDATE search_stats SET query = '' WHERE query <> '' AND created_at < now() - ($1 || ' days')::interval RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    RETENTION.searchRaw)
  /*
   * A napi só.
   *
   * `$1::int` — a cast nem stílus. A pg a számot ismeretlen típusú
   * paraméterként küldi, a Postgres pedig a `current_date - $1` kifejezésre
   * nem talál operátort, és az egész utasítás elszáll: „operator does not
   * exist: date < integer". A takarítás utolsó lépése volt, tehát az előtte
   * lévők lefutottak, a feladat mégis hibával végződött — és a sorbanálló
   * újrapróbálkozott, ötször, minden nap.
   *
   * Két napig élesben így ment: a takarítás egyszer sem fejeződött be. A
   * tünet nem hiányzó törlés volt, hanem egy elhasalt háttérfeladat, amiről
   * semmi nem szólt.
   */
  await del('analytics_salt',
    "WITH d AS (DELETE FROM analytics_salt WHERE day < current_date - $1::int RETURNING 1) SELECT count(*)::int AS n FROM d",
    RETENTION.salt)

  return out
}

/** Egy teljes összesítő menet. Ezt hívja a worker. */
export async function rollupAll (day?: string): Promise<void> {
  await rollupVisitors(day)
  await rollupActivity(day)
  await rollupAnime(day)
}
