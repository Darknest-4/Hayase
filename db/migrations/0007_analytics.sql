-- ============================================================================
-- 0007 — Analytics & observability: views, watch/search stats, audit, errors
-- ============================================================================
-- Design notes:
--  * Everything here is append-only and time-partitioned. Raw events have
--    short retention (90 days); hourly/daily rollup tables keep history
--    forever at a fraction of the size.
--  * Raw events are written by queue workers (the API only enqueues), so
--    analytics load never sits on the request path.
--  * PII policy: raw events keep profile ids for 90 days (needed for
--    per-user stats); rollups are fully anonymous.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- page_views — raw navigation events
-- ----------------------------------------------------------------------------
CREATE TABLE page_views (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  profile_id  uuid,                            -- null = anonymous visitor
  session_key text,                            -- anonymous session grouping (rotating)
  route       text NOT NULL,                   -- '/anime/:id' pattern, not the concrete URL
  entity_id   uuid,                            -- concrete anime/extension id when applicable
  referrer    text,
  platform    text,
  country     char(2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE page_views IS 'Raw page-view events (90-day retention). Trending scores and rollups derive from this.';
CREATE INDEX page_views_route_idx  ON page_views (route, created_at DESC);
CREATE INDEX page_views_entity_idx ON page_views (entity_id, created_at DESC) WHERE entity_id IS NOT NULL;
CREATE TABLE page_views_2026_07 PARTITION OF page_views FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE page_views_2026_08 PARTITION OF page_views FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- watch_stats_daily — rollup of watch_history per anime per day
-- ----------------------------------------------------------------------------
CREATE TABLE watch_stats_daily (
  day             date NOT NULL,
  anime_id        uuid NOT NULL REFERENCES anime(id) ON DELETE CASCADE,
  unique_viewers  integer NOT NULL DEFAULT 0,
  minutes_watched bigint NOT NULL DEFAULT 0,
  completions     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, anime_id)
);
COMMENT ON TABLE watch_stats_daily IS 'Daily per-anime viewing rollup computed by the nightly worker; feeds trending and admin analytics.';
CREATE INDEX watch_stats_daily_anime_idx ON watch_stats_daily (anime_id, day DESC);

-- ----------------------------------------------------------------------------
-- search_stats — what people search for (product feedback + autocomplete boost)
-- ----------------------------------------------------------------------------
CREATE TABLE search_stats (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  query       text NOT NULL,
  normalized  text NOT NULL,                   -- lowercased, diacritics stripped
  result_count integer NOT NULL,
  clicked_id  uuid,                            -- which result was chosen (relevance feedback)
  profile_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE search_stats IS 'Search telemetry: zero-result queries surface catalogue gaps; clicks feed ranking boosts in OpenSearch.';
CREATE INDEX search_stats_norm_idx ON search_stats (normalized, created_at DESC);
CREATE TABLE search_stats_2026_07 PARTITION OF search_stats FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE search_stats_2026_08 PARTITION OF search_stats FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- performance_metrics — client + server timing samples (sampled, not full)
-- ----------------------------------------------------------------------------
CREATE TABLE performance_metrics (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  metric      text NOT NULL,                   -- 'api.latency', 'player.start_time', 'web.lcp', 'db.slow_query'
  value_ms    numeric(10,2) NOT NULL,
  labels      jsonb NOT NULL DEFAULT '{}',     -- {route, region, platform…}
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE performance_metrics IS '1%-sampled timing data. Full-fidelity metrics belong in Prometheus; this backs the in-app admin dashboard.';
CREATE INDEX performance_metrics_metric_idx ON performance_metrics (metric, created_at DESC);
CREATE TABLE performance_metrics_2026_07 PARTITION OF performance_metrics FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE performance_metrics_2026_08 PARTITION OF performance_metrics FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- audit_logs — admin/moderator/API mutations (who changed what)
-- ----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  actor_id    uuid,                            -- null = system job
  actor_type  text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'api_key', 'system')),
  action      text NOT NULL,                   -- 'anime.update', 'user.ban', 'extension.approve', …
  subject_type text NOT NULL,
  subject_id  text NOT NULL,
  before      jsonb,                           -- changed fields only
  after       jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE audit_logs IS 'Append-only change log for every privileged mutation. before/after store diffs, not full rows.';
CREATE INDEX audit_logs_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_subject_idx ON audit_logs (subject_type, subject_id, created_at DESC);
CREATE TABLE audit_logs_2026_07 PARTITION OF audit_logs FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_logs_2026_08 PARTITION OF audit_logs FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- error_logs — server + client error reports (grouped by fingerprint)
-- ----------------------------------------------------------------------------
CREATE TABLE error_groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint  text NOT NULL UNIQUE,           -- hash of (type, top frame, route)
  title        text NOT NULL,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  event_count  bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored'))
);
COMMENT ON TABLE error_groups IS 'Deduplicated error buckets (Sentry-style). Individual events below keep limited samples per group.';

CREATE TABLE error_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  group_id    uuid NOT NULL REFERENCES error_groups(id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('api', 'worker', 'web', 'desktop', 'mobile', 'extension')),
  message     text NOT NULL,
  stack       text,
  context     jsonb NOT NULL DEFAULT '{}',     -- route, app version, extension id… (no PII)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX error_logs_group_idx ON error_logs (group_id, created_at DESC);
CREATE TABLE error_logs_2026_07 PARTITION OF error_logs FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE error_logs_2026_08 PARTITION OF error_logs FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
