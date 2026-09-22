// /v1/admin/analytics — a kimutatások olvasó oldala.
//
// Egy szabály tartja ezt a modult együtt: **a panel nem olvas nyers
// eseménytáblát.** Minden tartományos lekérdezés a napi összesítőkből megy
// (`analytics_daily`, `analytics_breakdown`, `anime_stats_daily`), amiket a
// worker számol. Az egyetlen kivétel az élő nézet, ami szándékosan az utolsó
// öt percet kérdezi — ott a nyers tábla kicsi, mert az ablak kicsi.
//
// Ez nem stílus. Egy „mi volt 90 napja" kérdés nyersen több millió sor, és a
// panel minden frissítésnél újra kifizetné; összesítőből 90 sor. A
// látogatottság mérése nem lehet az oldal lassulásának az oka.
//
// Két jogosultság, nem egy:
//
//   analytics.view      látogatottság, címek, keresés, teljesítmény — ezt
//                       egy szerkesztőnek is meg lehet mutatni;
//   analytics.accounts  EGY fiók tevékenysége, munkamenetei, eszközei — ez
//                       személyes adat, és más kérdés.

import { audit } from '../audit/audit.ts'
import { query, queryOne } from '../../infrastructure/database/index.ts'
import { accountHistory } from './account-events.ts'
import { LATENCY_BUCKETS, percentileFrom } from '../providers/metrics.ts'

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

/** A választható tartományok. Nyers nap helyett nevesítve: kevesebb hiba. */
const RANGES: Record<string, number> = {
  today: 1, yesterday: 2, '7d': 7, '30d': 30, '90d': 90, '365d': 365
}

/** Hány napra kérdezünk, és melyik naptól. */
function windowOf (request: FastifyRequest): { from: string, to: string, days: number, label: string } {
  const q = request.query as { range?: string, from?: string, to?: string }
  const iso = (d: Date): string => d.toISOString().slice(0, 10)

  // Egyedi tartomány. Megfordítjuk, ha fordítva jött — a felhasználó
  // szándéka egyértelmű, és egy üres válasz csak rejtvény lenne.
  if (q.from && q.to) {
    const [from, to] = q.from <= q.to ? [q.from, q.to] : [q.to, q.from]
    const days = Math.min(731, Math.max(1,
      Math.round((Date.parse(to!) - Date.parse(from!)) / 86_400_000) + 1))
    return { from: from!, to: to!, days, label: `${from} – ${to}` }
  }

  const range = q.range && RANGES[q.range] ? q.range : '7d'
  const days = RANGES[range]!
  const today = new Date()
  if (range === 'yesterday') {
    const d = iso(new Date(today.getTime() - 86_400_000))
    return { from: d, to: d, days: 1, label: 'tegnap' }
  }
  const from = iso(new Date(today.getTime() - (days - 1) * 86_400_000))
  return { from, to: iso(today), days, label: range }
}

const RANGE_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { enum: Object.keys(RANGES) },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    dimension: { type: 'string', maxLength: 20 }
  }
} as const

const routes: FastifyPluginAsync = async fastify => {
  // ---- látogatottság -----------------------------------------------------

  /**
   * A napi sorok a tartományra, plusz az előző, azonos hosszú időszak.
   *
   * `/visitors`, nem `/overview`: az `/overview` ezen az előtagon már létezik,
   * és a platform egészéről szól (felhasználók, hibák, sorok). Ez a
   * látogatottságé. Két különböző kérdés, két különböző név.
   *
   * Az összehasonlítás nem extra: egy „1 234 látogató" önmagában nem
   * mond semmit. Az mond valamit, hogy ez több vagy kevesebb, mint az
   * előző héten volt.
   */
  fastify.get('/visitors', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)

    const [days, totals, previous] = await Promise.all([
      query(
        `SELECT day, sessions, visitors, authed_sessions, anon_sessions, new_visitors, returning_visitors,
                page_views, avg_duration_sec, bounce_sessions, registrations, logins, failed_logins,
                searches, zero_result_searches, episode_starts, episode_completions, watch_seconds, errors
           FROM analytics_daily
          WHERE day BETWEEN $1::date AND $2::date
          ORDER BY day`,
        [w.from, w.to]),
      queryOne(
        `SELECT coalesce(sum(sessions), 0)::int AS sessions,
                coalesce(sum(page_views), 0)::int AS page_views,
                coalesce(sum(registrations), 0)::int AS registrations,
                coalesce(sum(logins), 0)::int AS logins,
                coalesce(sum(failed_logins), 0)::int AS failed_logins,
                coalesce(sum(searches), 0)::int AS searches,
                coalesce(sum(zero_result_searches), 0)::int AS zero_result_searches,
                coalesce(sum(episode_starts), 0)::int AS episode_starts,
                coalesce(sum(episode_completions), 0)::int AS episode_completions,
                coalesce(sum(watch_seconds), 0)::bigint AS watch_seconds,
                coalesce(sum(errors), 0)::int AS errors,
                coalesce(round(avg(nullif(avg_duration_sec, 0)))::int, 0) AS avg_duration_sec,
                -- Az egyedi látogató NEM összeadható napokon át: ugyanaz az
                -- ember két napon két sorban van. A napi só miatt nem is
                -- lehet összefűzni. Ezért ez a szám a napi átlag, és a panel
                -- így is nevezi meg — egy hamis "összesen egyedi" rosszabb,
                -- mint egy őszinte átlag.
                coalesce(round(avg(visitors))::int, 0) AS avg_daily_visitors,
                coalesce(max(visitors), 0)::int AS peak_daily_visitors
           FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date`,
        [w.from, w.to]),
      queryOne(
        // Csak két paraméter: a `to` itt nem szerepel, és egy fel nem használt
        // helyőrző nem „ártalmatlan" — a Postgres nem tudja kitalálni a
        // típusát, és az egész utasítást visszautasítja.
        `SELECT coalesce(sum(sessions), 0)::int AS sessions,
                coalesce(sum(page_views), 0)::int AS page_views,
                coalesce(sum(registrations), 0)::int AS registrations,
                coalesce(round(avg(visitors))::int, 0) AS avg_daily_visitors
           FROM analytics_daily
          WHERE day >= ($1::date - $2::int) AND day < $1::date`,
        [w.from, w.days])
    ])

    return { window: w, days, totals, previous }
  })

  /** Egy dimenzió bontása: eszköz, böngésző, oprendszer, nyelv, hivatkozó… */
  fastify.get('/breakdown', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)
    const q = request.query as { dimension?: string, limit?: number }
    const dimension = q.dimension ?? 'device'
    const data = await query(
      `SELECT value, sum(sessions)::int AS sessions, sum(page_views)::int AS page_views
         FROM analytics_breakdown
        WHERE dimension = $1 AND day BETWEEN $2::date AND $3::date
        GROUP BY value ORDER BY sessions DESC LIMIT $4`,
      [dimension, w.from, w.to, Math.min(200, q.limit ?? 20)])
    return { window: w, dimension, data }
  })

  // ---- élő nézet ---------------------------------------------------------

  /**
   * Most.
   *
   * Az egyetlen hely, ami nyers táblát olvas — öt perces ablakkal, tehát a
   * sorok száma a forgalomtól függ, nem az előzmény hosszától. A
   * `analytics_sessions_live_idx` pont erre a rendezésre van.
   */
  fastify.get('/realtime', {
    onRequest: fastify.requirePermission('analytics.view')
  }, async () => {
    const [live, today, searches, animeTop, security, perf] = await Promise.all([
      queryOne(
        `SELECT count(*)::int AS online,
                count(*) FILTER (WHERE user_id IS NOT NULL)::int AS signed_in,
                coalesce(sum(page_views), 0)::int AS page_views_5m
           FROM analytics_sessions
          WHERE last_seen_at > now() - interval '5 minutes' AND NOT is_bot`),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM account_events
             WHERE created_at >= current_date AND event = 'REG' AND result = 'success') AS registrations,
           (SELECT count(*)::int FROM account_events
             WHERE created_at >= current_date AND event = 'LOGIN' AND result = 'success') AS logins,
           (SELECT count(*)::int FROM account_events
             WHERE created_at >= current_date AND event = 'LOGIN_FAILED') AS failed_logins,
           (SELECT count(*)::int FROM watch_history WHERE started_at >= current_date) AS episode_starts,
           (SELECT count(*)::int FROM watch_history WHERE started_at >= current_date AND finished) AS episode_completions,
           (SELECT count(*)::int FROM favorites WHERE created_at >= current_date) AS favorites,
           (SELECT count(*)::int FROM watch_history
             WHERE started_at > now() - interval '30 minutes' AND ended_at IS NULL) AS watching_now`),
      query(
        `SELECT normalized AS term, count(*)::int AS n, sum((result_count = 0)::int)::int AS zero
           FROM search_stats WHERE created_at > now() - interval '24 hours'
          GROUP BY normalized ORDER BY n DESC LIMIT 10`),
      query(
        `SELECT a.id, a.canonical_title AS title, count(*)::int AS views
           FROM page_views p JOIN anime a ON a.id = p.entity_id
          WHERE p.created_at > now() - interval '24 hours'
          GROUP BY a.id, a.canonical_title ORDER BY views DESC LIMIT 10`),
      query(
        `SELECT event, count(*)::int AS n, max(created_at) AS last_seen
           FROM security_logs WHERE created_at > now() - interval '24 hours'
          GROUP BY event ORDER BY n DESC LIMIT 10`),
      queryOne(
        `SELECT round(avg(value_ms))::int AS avg_ms,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY value_ms))::int AS p95_ms,
                count(*)::int AS samples
           FROM performance_metrics
          WHERE created_at > now() - interval '5 minutes'`)
    ])

    return { live, today, searches, animeTop, security, api: perf }
  })

  // ---- címek -------------------------------------------------------------

  fastify.get('/anime', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)
    const { limit } = request.query as { limit?: number }
    const data = await query(
      `SELECT a.id, a.canonical_title AS title,
              sum(s.views)::int AS views,
              sum(s.unique_viewers)::int AS unique_viewers,
              sum(s.episode_starts)::int AS episode_starts,
              sum(s.episode_completions)::int AS episode_completions,
              sum(s.watch_seconds)::bigint AS watch_seconds,
              sum(s.library_adds)::int AS library_adds,
              sum(s.favorites_added)::int AS favorites,
              CASE WHEN sum(s.episode_starts) > 0
                   THEN round(100.0 * sum(s.episode_completions) / sum(s.episode_starts), 1)
                   END AS completion_pct
         FROM anime_stats_daily s JOIN anime a ON a.id = s.anime_id
        WHERE s.day BETWEEN $1::date AND $2::date
        GROUP BY a.id, a.canonical_title
        ORDER BY views DESC NULLS LAST
        LIMIT $3`,
      [w.from, w.to, Math.min(200, limit ?? 50)])
    return { window: w, data }
  })

  /** Egy cím részletesen, epizódonkénti lemorzsolódással. */
  fastify.get('/anime/:id', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: RANGE_QUERY
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const w = windowOf(request)
    const anime = await queryOne('SELECT id, canonical_title AS title FROM anime WHERE id = $1', [id])
    if (!anime) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const [days, episodes, totals] = await Promise.all([
      query(
        `SELECT day, views, unique_viewers, episode_starts, episode_completions, watch_seconds,
                library_adds, favorites_added
           FROM anime_stats_daily WHERE anime_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day`,
        [id, w.from, w.to]),
      query(
        `SELECT e.number, e.title, sum(s.starts)::int AS starts,
                sum(s.completions)::int AS completions, sum(s.watch_seconds)::bigint AS watch_seconds,
                CASE WHEN sum(s.starts) > 0
                     THEN round(100.0 * sum(s.completions) / sum(s.starts), 1) END AS completion_pct
           FROM episode_stats_daily s JOIN episodes e ON e.id = s.episode_id
          WHERE s.anime_id = $1 AND s.day BETWEEN $2::date AND $3::date
          GROUP BY e.number, e.title ORDER BY e.number
          LIMIT 500`,
        [id, w.from, w.to]),
      queryOne(
        // A kedvencek és a hozzászólások POLIMORFAK: `subject_type` +
        // `subject_id`, nem `anime_id`. Csak a könyvtár és az értékelés
        // hivatkozik közvetlenül a címre.
        `SELECT
           (SELECT count(*)::int FROM favorites WHERE subject_type = 'anime' AND subject_id = $1) AS favorites_total,
           (SELECT count(*)::int FROM library_entries WHERE anime_id = $1) AS library_total,
           (SELECT count(*)::int FROM comments WHERE subject_type = 'anime' AND subject_id = $1) AS comments_total,
           (SELECT count(*)::int FROM reviews WHERE anime_id = $1) AS reviews_total,
           (SELECT count(*)::int FROM search_stats
             WHERE clicked_id = $1 AND created_at > now() - interval '90 days') AS search_clicks`,
        [id])
    ])
    return { anime, window: w, days, episodes, totals }
  })

  // ---- keresés -----------------------------------------------------------

  fastify.get('/search', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)
    const [top, zero, daily] = await Promise.all([
      query(
        `SELECT normalized AS term, count(*)::int AS searches,
                round(avg(result_count))::int AS avg_results,
                count(clicked_id)::int AS clicks
           FROM search_stats WHERE created_at >= $1::date AND created_at < $2::date + 1
          GROUP BY normalized ORDER BY searches DESC LIMIT 50`,
        [w.from, w.to]),
      // Ami nem talál semmit. Ez a leghasznosabb keresési kimutatás: minden
      // sor egy hiányzó cím vagy egy rossz írásmód, amire van kereslet.
      query(
        `SELECT normalized AS term, count(*)::int AS searches
           FROM search_stats
          WHERE result_count = 0 AND created_at >= $1::date AND created_at < $2::date + 1
          GROUP BY normalized ORDER BY searches DESC LIMIT 50`,
        [w.from, w.to]),
      query(
        `SELECT day, searches, zero_result_searches, search_result_opens FROM analytics_daily
          WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
        [w.from, w.to])
    ])

    /*
     * A KERESÉS → MEGNYITÁS ARÁNYA. Ez az egyetlen szám, ami megmondja, hogy
     * a keresés MŰKÖDIK-E: nem az számít, hányan kerestek, hanem hogy hányan
     * találták meg, amit kerestek.
     *
     * NULLA KERESÉSNÉL NINCS ARÁNY, nem nulla százalék. A `null` azt jelenti,
     * hogy nincs mihez mérni — a nulla azt állítaná, hogy senki nem találta
     * meg, amit keresett.
     */
    const keresesek = daily.reduce((n, d) => n + Number((d as { searches: number }).searches), 0)
    const megnyitasok = daily.reduce((n, d) => n + Number((d as { search_result_opens: number }).search_result_opens), 0)

    return {
      window: w,
      top,
      zero,
      daily,
      conversion: {
        searches: keresesek,
        opens: megnyitasok,
        rate: keresesek > 0 ? Math.round((megnyitasok / keresesek) * 1000) / 10 : null,
        // MIÓTA MÉRJÜK. Ez az esemény újabb, mint a keresés maga: egy régi
        // időszakban a nulla nem azt jelenti, hogy senki nem kattintott,
        // hanem hogy akkor még nem mértük.
        since: (await queryOne<{ since: string | null }>(
          "SELECT min(created_at)::date::text AS since FROM analytics_events WHERE event_type = 'search.result.open'"
        ))?.since ?? null
      }
    }
  })

  // ---- teljesítmény ------------------------------------------------------

  fastify.get('/performance', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)
    const [byMetric, worstRoutes] = await Promise.all([
      query(
        `SELECT metric,
                count(*)::int AS samples,
                round(percentile_cont(0.50) WITHIN GROUP (ORDER BY value_ms))::int AS p50,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY value_ms))::int AS p95,
                round(percentile_cont(0.99) WITHIN GROUP (ORDER BY value_ms))::int AS p99,
                round(max(value_ms))::int AS max
           FROM performance_metrics
          WHERE created_at >= $1::date AND created_at < $2::date + 1
          GROUP BY metric ORDER BY p95 DESC LIMIT 50`,
        [w.from, w.to]),
      query(
        `SELECT labels->>'route' AS route,
                count(*)::int AS samples,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY value_ms))::int AS p95
           FROM performance_metrics
          WHERE created_at >= $1::date AND created_at < $2::date + 1 AND labels ? 'route'
          GROUP BY labels->>'route' HAVING count(*) > 5
          ORDER BY p95 DESC LIMIT 25`,
        [w.from, w.to])
    ])
    return { window: w, byMetric, worstRoutes }
  })

  // ---- egy fiók ----------------------------------------------------------

  /**
   * Egy fiók tevékenysége.
   *
   * Külön jogosultság (`analytics.accounts`), mert ez már személyes adat: egy
   * ember tevékenységének az idővonala. Rejtett végpont — aki nem jogosult,
   * annak nem létezik, nem tiltott.
   *
   * IP nincs a válaszban. Az a `security_logs`-ban él, és a biztonsági
   * képernyőé — itt a kérdés az, hogy „mit csinált ez a fiók", nem az, hogy
   * „honnan".
   */
  fastify.get('/accounts/:userId', {
    onRequest: fastify.requirePermission('analytics.accounts', { hide: true }),
    schema: {
      params: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          before: { type: 'string', format: 'date-time' },
          event: { type: 'string', maxLength: 40 }
        }
      }
    }
  }, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const q = request.query as { limit?: number, before?: string, event?: string }

    const user = await queryOne(
      'SELECT id, username, status, created_at, last_login_at FROM users WHERE id = $1', [userId])
    if (!user) return await reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    const [events, sessions, devices, visits, watch] = await Promise.all([
      accountHistory(userId, q),
      query(
        // A `sessions` táblában nincs „utoljára használt" oszlop: a
        // frissítő token forgatásakor ÚJ sor keletkezik és a régi
        // visszavonódik, tehát a létrehozás ideje egyben az utolsó
        // használaté is. Egy nem létező oszlopot kérni azért kerül ide,
        // mert a felület mezőneve („last activity") mást sugall.
        `SELECT s.id, s.created_at, s.expires_at, s.revoked_at,
                d.platform, d.name AS device_name,
                (s.revoked_at IS NULL AND s.expires_at > now()) AS active
           FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
          WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 50`,
        [userId]),
      query(
        `SELECT id, platform, name, created_at, last_seen_at
           FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC LIMIT 50`,
        [userId]),
      query(
        `SELECT started_at, last_seen_at, page_views, device_class, browser, os, entry_route
           FROM analytics_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 30`,
        [userId]),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM watch_history h JOIN user_profiles p ON p.id = h.profile_id
             WHERE p.user_id = $1) AS episodes_started,
           (SELECT count(*)::int FROM watch_history h JOIN user_profiles p ON p.id = h.profile_id
             WHERE p.user_id = $1 AND h.finished) AS episodes_finished,
           (SELECT coalesce(sum(h.watched_sec), 0)::bigint FROM watch_history h
              JOIN user_profiles p ON p.id = h.profile_id WHERE p.user_id = $1) AS watch_seconds,
           (SELECT count(*)::int FROM favorites f JOIN user_profiles p ON p.id = f.profile_id
             WHERE p.user_id = $1 AND f.subject_type = 'anime') AS favorites,
           (SELECT count(*)::int FROM library_entries l JOIN user_profiles p ON p.id = l.profile_id
             WHERE p.user_id = $1) AS library_entries,
           (SELECT count(*)::int FROM comments WHERE author_id = $1) AS comments`,
        [userId])
    ])

    return { user, events, sessions, devices, visits, watch }
  })

  // ---- globális felhasználói kimutatás -----------------------------------

  fastify.get('/users', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)
    const [totals, daily, devices] = await Promise.all([
      queryOne(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE created_at >= $1::date)::int AS new_in_window,
                count(*) FILTER (WHERE last_login_at > now() - interval '30 days')::int AS active_30d,
                count(*) FILTER (WHERE last_login_at > now() - interval '7 days')::int AS active_7d,
                count(*) FILTER (WHERE status <> 'active')::int AS restricted,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
           FROM users`,
        [w.from]),
      query(
        `SELECT day, registrations, logins, failed_logins, authed_sessions
           FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
        [w.from, w.to]),
      query(
        `SELECT dimension, value, sum(sessions)::int AS sessions
           FROM analytics_breakdown
          WHERE dimension IN ('device', 'browser', 'os') AND day BETWEEN $1::date AND $2::date
          GROUP BY dimension, value ORDER BY dimension, sessions DESC`,
        [w.from, w.to])
    ])
    return { window: w, totals, daily, devices }
  })
  // ---- export ------------------------------------------------------------

  /**
   * Kimutatás kivitele CSV-be vagy JSON-ba.
   *
   * Amit ki lehet vinni: **összesítők**. Napi számok, bontások, címenkénti
   * teljesítmény. Amit nem: nyers eseménysorok, fiókok tevékenysége,
   * biztonsági napló, IP. Egy export fájl lesz, a fájl elhagyja a rendszert,
   * és onnantól semmilyen jogosultság nem véd rajta — ezért a nyers
   * személyes adat nem exportálható, jogosultsággal sem.
   *
   * Minden export naplózódik: ki, mit, mikor, milyen tartományra. Egy
   * adatkivitel önmagában is olyan esemény, amiről utólag kérdezni szoktak.
   */
  const DATASETS: Record<string, { sql: string, columns: string[] }> = {
    daily: {
      sql: `SELECT day, sessions, visitors, page_views, avg_duration_sec, registrations, logins,
                   failed_logins, searches, zero_result_searches, episode_starts, episode_completions,
                   watch_seconds, errors
              FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
      columns: ['day', 'sessions', 'visitors', 'page_views', 'avg_duration_sec', 'registrations', 'logins',
        'failed_logins', 'searches', 'zero_result_searches', 'episode_starts', 'episode_completions',
        'watch_seconds', 'errors']
    },
    breakdown: {
      sql: `SELECT day, dimension, value, sessions, page_views FROM analytics_breakdown
             WHERE day BETWEEN $1::date AND $2::date ORDER BY day, dimension, sessions DESC`,
      columns: ['day', 'dimension', 'value', 'sessions', 'page_views']
    },
    anime: {
      sql: `SELECT s.day, a.canonical_title AS title, s.views, s.unique_viewers, s.episode_starts,
                   s.episode_completions, s.watch_seconds, s.library_adds, s.favorites_added
              FROM anime_stats_daily s JOIN anime a ON a.id = s.anime_id
             WHERE s.day BETWEEN $1::date AND $2::date ORDER BY s.day, s.views DESC`,
      columns: ['day', 'title', 'views', 'unique_viewers', 'episode_starts', 'episode_completions',
        'watch_seconds', 'library_adds', 'favorites_added']
    },
    searches: {
      // A NORMALIZÁLT alak megy ki, nem a nyers: a nyers keresőkifejezés
      // személyes adat lehet, és egy exportált fájlból nem lehet visszavenni.
      sql: `SELECT date_trunc('day', created_at)::date AS day, normalized AS term,
                   count(*)::int AS searches, count(clicked_id)::int AS clicks
              FROM search_stats WHERE created_at >= $1::date AND created_at < $2::date + 1
             GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      columns: ['day', 'term', 'searches', 'clicks']
    }
  }

  /** Egy CSV-mező. A pontosvessző és az idézőjel az, ami táblázatot tör. */
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    const text = value instanceof Date ? value.toISOString() : String(value)
    return /[",\n;]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
  }

  // ---- szolgáltatók ------------------------------------------------------

  /**
   * A szolgáltatólánc mérőszámai.
   *
   * KÉT TÁBLÁBÓL, ÉS A KETTŐ MÁST MOND. A `provider_metrics_daily` a
   * KÉRÉSEKET összesíti (hány kísérlet, mennyi hiba, milyen gyorsan); a
   * `provider_events` az ÁLLAPOTVÁLTOZÁSOKAT naplózza („leesett",
   * „visszajött"). A panelen mindkettő kell: a számok megmondják, mennyire
   * rossz, az események azt, hogy mikor romlott el.
   *
   * A HIBAARÁNY SZÁMLÁLÓJÁBAN nincs benne az `empty` és a `skipped`. Az
   * `empty` a lánc szerint SIKER — a szolgáltató felelt, csak nincs nála ez a
   * cím —, a `skipped` pedig azt jelenti, hogy meg sem kérdeztük, mert a
   * megszakító kizárta. Egy ritka címet keresgélő néző nem tehet úgy, mintha
   * a szolgáltató romlana.
   */
  fastify.get('/providers', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)

    const [totals, days, events, buckets] = await Promise.all([
      query(
        `SELECT slug,
                coalesce(sum(attempts), 0)::int AS attempts,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'ok'), 0)::int AS ok,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'empty'), 0)::int AS empty,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'error'), 0)::int AS errors,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'timeout'), 0)::int AS timeouts,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'skipped'), 0)::int AS skipped,
                coalesce(sum(sources), 0)::int AS sources,
                coalesce(max(latency_ms_max), 0)::int AS latency_max,
                -- Az átlag az ÖSSZEGBŐL és a DARABSZÁMBÓL, nem napi átlagok
                -- átlagából: az utóbbi egy forgalmas napot ugyanannyit
                -- számítana, mint egy üreset.
                CASE WHEN sum(attempts) FILTER (WHERE outcome IN ('ok','empty','error','timeout')) > 0
                     THEN round(
                       sum(latency_ms_sum) FILTER (WHERE outcome IN ('ok','empty','error','timeout'))::numeric
                       / sum(attempts) FILTER (WHERE outcome IN ('ok','empty','error','timeout')))::int
                     ELSE 0 END AS latency_avg
           FROM provider_metrics_daily
          WHERE day BETWEEN $1::date AND $2::date
          GROUP BY slug
          ORDER BY attempts DESC, slug`,
        [w.from, w.to]),
      query(
        `SELECT day, slug,
                coalesce(sum(attempts), 0)::int AS attempts,
                coalesce(sum(attempts) FILTER (WHERE outcome = 'ok'), 0)::int AS ok,
                coalesce(sum(attempts) FILTER (WHERE outcome IN ('error','timeout')), 0)::int AS failures
           FROM provider_metrics_daily
          WHERE day BETWEEN $1::date AND $2::date
          GROUP BY day, slug
          ORDER BY day, slug`,
        [w.from, w.to]),
      query(
        // Az esemény `detail` mezője a szolgáltató hibaüzenete. Ez a panel
        // üzemeltetőnek szól, és a mező már a forrásnál meg van tisztítva
        // (lásd `providers/scrub.ts`), de a hosszát itt is korlátozzuk.
        `SELECT slug, event, left(detail, 300) AS detail, latency_ms, sources, at
           FROM provider_events
          WHERE at >= now() - ($1::int || ' days')::interval
          ORDER BY at DESC
          LIMIT 50`,
        [w.days]),
      /*
       * A KÉSLELTETÉS ELOSZLÁSA — ebből lesz a percentilis.
       *
       * Az átlag és a maximum együtt sem mondja meg, milyen egy
       * szolgáltató: száz kérésből kilencvenkilenc 200 ms alatt és egy tíz
       * másodpercben ugyanazt az átlagot adja, mint a mind-300-ms-körül.
       */
      query<{ slug: string, bucket_ms: number, count: string }>(
        `SELECT slug, bucket_ms, sum(count)::bigint AS count
           FROM provider_latency_daily
          WHERE day BETWEEN $1::date AND $2::date
          GROUP BY slug, bucket_ms
          ORDER BY slug, bucket_ms`,
        [w.from, w.to])
    ])

    /*
     * A PERCENTILIS FELSŐ KORLÁT, NEM PONTOS ÉRTÉK — és a válasz ezt ki is
     * mondja (`bucketed: true`). Vödrökből számoljuk, tehát a helyes
     * olvasata: „a kérések 95%-a ennyi alatt volt". Egy pontosnak látszó
     * `487 ms` itt találgatás lenne.
     */
    const eloszlas = new Map<string, Array<{ bucket_ms: number, count: number }>>()
    for (const b of buckets) {
      const lista = eloszlas.get(b.slug) ?? []
      lista.push({ bucket_ms: b.bucket_ms, count: Number(b.count) })
      eloszlas.set(b.slug, lista)
    }

    const percentiles = [...eloszlas.entries()].map(([slug, lista]) => ({
      slug,
      samples: lista.reduce((n, b) => n + b.count, 0),
      p50: percentileFrom(lista, 50),
      p95: percentileFrom(lista, 95),
      p99: percentileFrom(lista, 99),
      bucketed: true,
      buckets: lista
    }))

    return { window: w, totals, days, events, percentiles, latencyBuckets: LATENCY_BUCKETS }
  })

  // ---- összefoglaló ------------------------------------------------------

  /**
   * AZ ÁTTEKINTŐ FÜL — amit egy üzemeltető először akar látni.
   *
   * A NEVE `/summary`, NEM `/overview`, és ezt a modul feje ki is mondja: az
   * `/overview` ezen az előtagon MÁR LÉTEZIK, és a platform egészéről szól
   * (felhasználók, hibák, sorok). Ezt először elrontottam — a Fastify
   * `FST_ERR_DUPLICATED_ROUTE`-tal el sem indult, és a teljes analitikai
   * készlet elhasalt egy olyan hibán, aminek a figyelmeztetése húsz sorral
   * följebb áll ebben a fájlban.
   *
   * Nem új mérés: a meglévő összesítőkből áll össze, egyetlen körben. A
   * külön fülek attól maradnak meg, hogy ott van a részletezés; ide az
   * kerül, amiért az ember egyáltalán megnyitja a panelt.
   *
   * A „MIÓTA MÉRÜNK" NEM DÍSZ. Ez a rendszer 2026 szeptemberében kezdett
   * gyűjteni; egy 365 napos nézet nem azért üres, mert elromlott valami. A
   * `since` és a `days` megmondja, mennyi adat van egyáltalán — enélkül a
   * panel minden hosszú tartományon hibásnak látszik.
   */
  fastify.get('/summary', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: { querystring: RANGE_QUERY }
  }, async request => {
    const w = windowOf(request)

    const [katalogus, idoszak, elozo, meddig, felsoAnime, szolgaltatok, allapot] = await Promise.all([
      queryOne(
        `SELECT (SELECT count(*) FROM anime WHERE visibility = 'public')::int AS anime,
                (SELECT count(*) FROM episodes WHERE visibility = 'public')::int AS episodes,
                (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM users WHERE created_at >= now() - interval '30 days')::int AS new_users`),
      queryOne(
        `SELECT coalesce(sum(sessions), 0)::int AS sessions,
                coalesce(sum(visitors), 0)::int AS visitor_days,
                coalesce(sum(page_views), 0)::int AS page_views,
                coalesce(sum(registrations), 0)::int AS registrations,
                coalesce(sum(searches), 0)::int AS searches,
                coalesce(sum(episode_starts), 0)::int AS episode_starts,
                coalesce(sum(episode_completions), 0)::int AS episode_completions,
                coalesce(sum(errors), 0)::int AS errors,
                count(*)::int AS days_with_data
           FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date`,
        [w.from, w.to]),
      // Az előző, AZONOS HOSSZÚ időszak — enélkül egy szám nem mond semmit.
      queryOne(
        // MINDEN PARAMÉTERT HASZNÁLNI KELL. Egy fel nem használt `$2` esetén
        // a Postgres nem tudja kikövetkeztetni a típusát, és az egész kérés
        // 500-zal áll meg — mérve.
        `SELECT coalesce(sum(sessions), 0)::int AS sessions,
                coalesce(sum(page_views), 0)::int AS page_views,
                coalesce(sum(registrations), 0)::int AS registrations
           FROM analytics_daily
          WHERE day >= ($1::date - ($2::int || ' days')::interval)::date
            AND day <  $1::date`,
        [w.from, w.days]),
      queryOne(
        `SELECT min(day)::text AS since, max(day)::text AS until, count(*)::int AS days
           FROM analytics_daily`),
      query(
        `SELECT a.canonical_title AS title, sum(s.views)::int AS views
           FROM anime_stats_daily s JOIN anime a ON a.id = s.anime_id
          WHERE s.day BETWEEN $1::date AND $2::date AND a.visibility = 'public'
          GROUP BY a.canonical_title HAVING sum(s.views) > 0
          ORDER BY sum(s.views) DESC, a.canonical_title LIMIT 5`,
        [w.from, w.to]),
      queryOne(
        `SELECT coalesce(sum(attempts), 0)::int AS attempts,
                coalesce(sum(attempts) FILTER (WHERE outcome IN ('error','timeout')), 0)::int AS failures,
                count(DISTINCT slug)::int AS providers
           FROM provider_metrics_daily WHERE day BETWEEN $1::date AND $2::date`,
        [w.from, w.to]),
      queryOne(
        `SELECT count(*) FILTER (WHERE status = 'green')::int AS green,
                count(*) FILTER (WHERE status NOT IN ('green', 'not_configured'))::int AS problem,
                count(*) FILTER (WHERE status = 'not_configured')::int AS off,
                max(checked_at) AS checked_at
           FROM service_status`)
    ])

    return {
      window: w,
      catalogue: katalogus,
      period: idoszak,
      previous: elozo,
      coverage: meddig,
      topAnime: felsoAnime,
      providers: szolgaltatok,
      services: allapot
    }
  })

  // ---- idősor ------------------------------------------------------------

  /**
   * EGY MÉRŐSZÁM AZ IDŐBEN — napi, heti vagy havi bontásban.
   *
   * A MÉRŐSZÁM NEVE FEHÉRLISTÁS, és ez nem formaiság: az oszlopnév a
   * lekérdezésbe kerül, ahová paraméter nem tehető. Egy szabad szöveg itt
   * SQL-injekció lenne.
   *
   * A HETI/HAVI BONTÁS AZ `analytics_periods`-ból jön, nem napi sorok
   * összegzéséből — és ott a „látogató" neve `visitor_days`, mert a napi
   * sóval képzett kulcsból heti egyedi látogató nem áll elő. Lásd a 0073-as
   * migráció fejlécét.
   */
  const METRIKAK: Record<string, { napi: string, idoszaki: string | null, label: string }> = {
    sessions: { napi: 'sessions', idoszaki: 'sessions', label: 'Munkamenet' },
    visitors: { napi: 'visitors', idoszaki: 'visitor_days', label: 'Látogató' },
    page_views: { napi: 'page_views', idoszaki: 'page_views', label: 'Oldalletöltés' },
    registrations: { napi: 'registrations', idoszaki: 'registrations', label: 'Regisztráció' },
    logins: { napi: 'logins', idoszaki: 'logins', label: 'Belépés' },
    searches: { napi: 'searches', idoszaki: 'searches', label: 'Keresés' },
    episode_starts: { napi: 'episode_starts', idoszaki: 'episode_starts', label: 'Epizód indítás' },
    episode_completions: { napi: 'episode_completions', idoszaki: 'episode_completions', label: 'Epizód befejezés' },
    watch_seconds: { napi: 'watch_seconds', idoszaki: 'watch_seconds', label: 'Nézett másodperc' },
    errors: { napi: 'errors', idoszaki: null, label: 'Hiba' },
    zero_result_searches: { napi: 'zero_result_searches', idoszaki: null, label: 'Nulla találatú keresés' }
  }

  fastify.get('/timeseries', {
    onRequest: fastify.requirePermission('analytics.view'),
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          range: { enum: Object.keys(RANGES) },
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          metric: { enum: Object.keys(METRIKAK) },
          granularity: { enum: ['day', 'week', 'month'] }
        }
      }
    }
  }, async (request, reply) => {
    const w = windowOf(request)
    const q = request.query as { metric?: string, granularity?: 'day' | 'week' | 'month' }
    const nev = q.metric ?? 'sessions'
    const metrika = METRIKAK[nev]!
    const bontas = q.granularity ?? 'day'

    if (bontas !== 'day' && metrika.idoszaki === null) {
      return await reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: `a(z) ${nev} mérőszám csak napi bontásban létezik`
      })
    }

    const sorok = bontas === 'day'
      ? await query(
        `SELECT day::text AS at, ${metrika.napi}::bigint AS value, true AS complete
           FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date ORDER BY day`,
        [w.from, w.to])
      : await query(
        // A `days_counted` mondja meg, teljes-e az időszak. Egy folyamatban
        // lévő hét nem hasonlítható egy lezárthoz, és enélkül a grafikon
        // utolsó oszlopa mindig „visszaesést" mutatna.
        `SELECT period_start::text AS at, ${metrika.idoszaki!}::bigint AS value,
                days_counted >= $3::int AS complete, days_counted
           FROM analytics_periods
          WHERE period = $4 AND period_start BETWEEN ($1::date - $3::int) AND $2::date
          ORDER BY period_start`,
        [w.from, w.to, bontas === 'week' ? 7 : 28, bontas])

    return { window: w, metric: nev, label: metrika.label, granularity: bontas, data: sorok }
  })

  // ---- adatminőség -------------------------------------------------------

  /**
   * ADATMINŐSÉG — „mit mérünk, mióta, és hol van lyuk".
   *
   * EZ A FÜL A PANEL ŐSZINTESÉGE. Minden más nézet számokat mutat; ez azt
   * mutatja meg, mennyit érnek. Három kérdésre válaszol:
   *
   *   * MIÓTA van adat — egy 365 napos nézet nem azért üres, mert elromlott
   *     valami, hanem mert a rendszer szeptemberben kezdett gyűjteni;
   *   * VAN-E LYUK a napi összesítőben — egy leállt worker nem hiányzó
   *     forgalomként, hanem hiányzó SORKÉNT látszik, és a kettő nem ugyanaz;
   *   * MEDDIG ŐRIZZÜK — a nyers sorok eltűnnek, tehát a régi időszakok
   *     bizonyos számai már nem számolhatók újra.
   *
   * A sorszámlálás pontos (`count(*)`), nem becslés: ezek a táblák ma
   * tízezres nagyságrendűek. Ha egyszer milliósak lesznek, a becslés
   * (`pg_class.reltuples`) a helyes csere — de akkor a válasz mondja is meg,
   * hogy becslés.
   */
  // AZ IDŐOSZLOP NEVE TÁBLÁNKÉNT MÁS, és ezt megmérni kellett, nem
  // kitalálni: a legtöbb `created_at`, a Discord-eseményeké `at`, a nézési
  // előzményé `started_at`. Egy elgépelt oszlopnévtől az egész végpont
  // 500-zal áll meg — pontosan ez történt az első változatával.
  const FORRASOK: Array<{ tabla: string, oszlop: string, cimke: string, megorzes: string | null }> = [
    { tabla: 'analytics_daily', oszlop: 'day', cimke: 'Napi összesítő', megorzes: null },
    { tabla: 'analytics_periods', oszlop: 'period_start', cimke: 'Heti/havi összesítő', megorzes: null },
    { tabla: 'analytics_sessions', oszlop: 'started_at', cimke: 'Munkamenet', megorzes: 'ANALYTICS_SESSION_RETENTION_DAYS' },
    { tabla: 'page_views', oszlop: 'created_at', cimke: 'Oldalletöltés', megorzes: 'ANALYTICS_RAW_RETENTION_DAYS' },
    { tabla: 'search_stats', oszlop: 'created_at', cimke: 'Keresés', megorzes: 'ANALYTICS_SEARCH_RAW_DAYS' },
    { tabla: 'account_events', oszlop: 'created_at', cimke: 'Fiókesemény', megorzes: 'ACCOUNT_EVENT_RETENTION_DAYS' },
    { tabla: 'security_logs', oszlop: 'created_at', cimke: 'Biztonsági napló', megorzes: 'SECURITY_LOG_RETENTION_DAYS' },
    { tabla: 'performance_metrics', oszlop: 'created_at', cimke: 'Teljesítmény', megorzes: null },
    { tabla: 'watch_history', oszlop: 'started_at', cimke: 'Nézési előzmény', megorzes: null },
    { tabla: 'anime_stats_daily', oszlop: 'day', cimke: 'Cím-összesítő', megorzes: null },
    { tabla: 'episode_stats_daily', oszlop: 'day', cimke: 'Epizód-összesítő', megorzes: null },
    { tabla: 'provider_metrics_daily', oszlop: 'day', cimke: 'Szolgáltatói mérés', megorzes: null },
    { tabla: 'provider_latency_daily', oszlop: 'day', cimke: 'Szolgáltatói eloszlás', megorzes: null },
    { tabla: 'audit_logs', oszlop: 'created_at', cimke: 'Adminnapló', megorzes: null },
    { tabla: 'persistent_message_events', oszlop: 'at', cimke: 'Discord-frissítés', megorzes: 'DISCORD_EVENT_RETENTION_DAYS' }
  ]

  fastify.get('/data-quality', {
    onRequest: fastify.requirePermission('analytics.view')
  }, async () => {
    // A táblanevek a kódból jönnek, nem a kérésből — a fenti listából.
    const unios = FORRASOK.map((f, i) =>
      `SELECT ${i} AS sorszam, count(*)::bigint AS rows,
              min(${f.oszlop})::text AS first_at, max(${f.oszlop})::text AS last_at
         FROM ${f.tabla}`).join(' UNION ALL ')
    const meresek = await query<{ sorszam: number, rows: string, first_at: string | null, last_at: string | null }>(unios)

    /*
     * A LYUKAK A NAPI ÖSSZESÍTŐBEN. Az utolsó 30 nap közül melyikre nincs
     * sor. A MAI NAP KIMARAD: az még nem futott le véglegesen, és minden
     * délelőtt „hiányzó napot" jelentene.
     */
    const lyukak = await query<{ day: string }>(
      `SELECT g::date::text AS day
         FROM generate_series(current_date - 30, current_date - 1, interval '1 day') g
        WHERE NOT EXISTS (SELECT 1 FROM analytics_daily d WHERE d.day = g::date)
        ORDER BY g`)

    const utolsoOsszesites = await queryOne<{ at: string | null }>(
      'SELECT max(updated_at)::text AS at FROM analytics_daily')

    return {
      sources: FORRASOK.map((f, i) => {
        const m = meresek.find(x => Number(x.sorszam) === i)
        return {
          table: f.tabla,
          label: f.cimke,
          rows: Number(m?.rows ?? 0),
          firstAt: m?.first_at ?? null,
          lastAt: m?.last_at ?? null,
          // A megőrzés a KÖRNYEZETBŐL, nem beégetve: ami itt látszik, az
          // tényleg az, ami a nyeséskor érvényes.
          retentionDays: f.megorzes ? Number(process.env[f.megorzes] ?? 0) || null : null
        }
      }),
      gaps: lyukak.map(l => l.day),
      lastRollupAt: utolsoOsszesites?.at ?? null,
      // Nem becslés — lásd a fenti megjegyzést.
      exact: true
    }
  })

  // ---- rendszerállapot ---------------------------------------------------

  /**
   * Komponensenkénti állapot, a KISZOLGÁLÓ tényleges ellenőrzéseiből.
   *
   * A `service_status` táblát a `infrastructure/observability` írja; ez a
   * végpont csak olvassa. A panel semmit nem talál ki: ami itt nincs, az
   * `unknown`, nem „healthy".
   *
   * A `not_configured` NEM HIBA, és ezt külön ki kell mondani. Ma négy
   * komponens áll így (redis, rabbitmq, opensearch, minio) — ezek a
   * telepítésben szándékosan nincsenek bekapcsolva. Pirosra festeni őket
   * annyit tenne, hogy a panel folyamatosan hibát jelez egy működő
   * rendszerre, és onnantól senki nem nézi.
   */
  fastify.get('/system-health', {
    onRequest: fastify.requirePermission('analytics.view')
  }, async () => {
    const services = await query(
      `SELECT service, status, latency_ms, left(detail, 200) AS detail, checked_at, since,
              extract(epoch FROM (now() - since))::bigint AS since_seconds
         FROM service_status
        ORDER BY service`)

    const recent = await query(
      `SELECT service, status, checked_at
         FROM service_status
        WHERE checked_at < now() - interval '10 minutes'
        ORDER BY service`)

    return {
      services,
      /*
       * ELAVULT ELLENŐRZÉS. Egy tíz perce nem frissült sor nem „zöld" — azt
       * jelenti, hogy az ellenőrző maga nem fut. A panel ezt külön mutatja,
       * mert különben egy leállt megfigyelő a legjobb állapotnak látszik.
       */
      stale: recent.map(r => r.service),
      checkedAt: new Date().toISOString()
    }
  })

  fastify.get('/export', {
    onRequest: fastify.requirePermission('analytics.export', { hide: true }),
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dataset: { enum: Object.keys(DATASETS) },
          format: { enum: ['csv', 'json'] },
          range: { enum: Object.keys(RANGES) },
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' }
        }
      }
    }
  }, async (request, reply) => {
    const q = request.query as { dataset?: string, format?: string }
    const name = q.dataset ?? 'daily'
    const spec = DATASETS[name]!
    const format = q.format ?? 'csv'
    const w = windowOf(request)

    const rows = await query<Record<string, unknown>>(spec.sql, [w.from, w.to])

    await audit(request.user.sub, 'analytics.export', 'config', `analytics:${name}`, null,
      { dataset: name, format, from: w.from, to: w.to, rows: rows.length })

    const filename = `yume-${name}-${w.from}_${w.to}.${format}`
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)

    if (format === 'json') {
      reply.type('application/json; charset=utf-8')
      return { dataset: name, window: w, rows }
    }

    reply.type('text/csv; charset=utf-8')
    // BOM: enélkül az Excel a magyar ékezeteket elrontja, és az export
    // legelső dolga az, hogy valaki megnyitja Excelben.
    return '\uFEFF' + [spec.columns.join(';'),
      ...rows.map(row => spec.columns.map(c => cell(row[c])).join(';'))].join('\n')
  })
}

export default routes
