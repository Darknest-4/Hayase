-- ============================================================================
-- 0015 — VPS health & monitoring: host metrics, rollups, service status
-- ============================================================================
-- Design notes:
--  * system_metrics mirrors the performance_metrics design (append-only,
--    monthly RANGE partitions) so the existing maintenance worker handles
--    partition creation and retention with one extra table entry.
--  * Raw samples are collected every 60s by the monitor worker. Fine-grained
--    retention (default 7 days) is enforced row-wise by that worker; the
--    monthly partition drop (1 month) is the backstop.
--  * system_metrics_hourly keeps long-range history at ~1/60th the size so
--    dashboards can show weeks/months without keeping raw samples forever.
--  * service_status holds one current row per dependency (upserted each
--    cycle) — cheap reads for the dashboard and a stable `since` timestamp
--    that alerting builds on later.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- system_metrics — raw host/service gauges sampled by the monitor worker
-- ----------------------------------------------------------------------------
CREATE TABLE system_metrics (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  metric     text NOT NULL,                    -- 'cpu.usage_pct', 'mem.used_bytes', 'net.rx_bps', …
  value      numeric(20,4) NOT NULL,
  unit       text NOT NULL DEFAULT '',         -- 'pct' | 'bytes' | 'ms' | 'bps' | 'count' | ''
  labels     jsonb NOT NULL DEFAULT '{}',      -- {device}, {interface}, {service} …
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE system_metrics IS 'Raw VPS/service gauges at 60s resolution. Short retention (see monitor worker); long-range history lives in system_metrics_hourly.';
CREATE INDEX system_metrics_metric_idx ON system_metrics (metric, created_at DESC);

-- current month + the two ahead, so a stalled maintenance worker never blocks
-- inserts. The maintenance worker keeps rolling this forward.
DO $$
DECLARE start_month date; i int;
BEGIN
  FOR i IN 0..2 LOOP
    start_month := date_trunc('month', now())::date + make_interval(months => i);
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS system_metrics_%s PARTITION OF system_metrics FOR VALUES FROM (%L) TO (%L)',
      to_char(start_month, 'YYYY_MM'), start_month, start_month + interval '1 month'
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- system_metrics_hourly — rollup kept for a year (pruned by the monitor worker)
-- ----------------------------------------------------------------------------
CREATE TABLE system_metrics_hourly (
  hour      timestamptz NOT NULL,
  metric    text NOT NULL,
  avg_value numeric(20,4) NOT NULL,
  min_value numeric(20,4) NOT NULL,
  max_value numeric(20,4) NOT NULL,
  samples   integer NOT NULL,
  PRIMARY KEY (hour, metric)
);
COMMENT ON TABLE system_metrics_hourly IS 'Hourly avg/min/max rollup of system_metrics. Retained ~1 year; powers long-range dashboard charts.';
CREATE INDEX system_metrics_hourly_metric_idx ON system_metrics_hourly (metric, hour DESC);

-- ----------------------------------------------------------------------------
-- service_status — current state of each monitored dependency
-- ----------------------------------------------------------------------------
CREATE TABLE service_status (
  service    text PRIMARY KEY,                 -- 'postgres' | 'redis' | 'rabbitmq' | 'opensearch' | 'minio' | 'api' | 'worker'
  status     text NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'not_configured')),
  latency_ms numeric(10,2),
  detail     text,                             -- short, non-sensitive reason ("connection refused")
  checked_at timestamptz NOT NULL DEFAULT now(),
  since      timestamptz NOT NULL DEFAULT now() -- when the CURRENT status began (drives alert debounce)
);
COMMENT ON TABLE service_status IS 'One row per monitored dependency, upserted every collection cycle. `since` tracks how long the current status has held.';
COMMENT ON COLUMN service_status.detail IS 'Short human reason. Never store credentials, connection strings or env values here.';

-- ----------------------------------------------------------------------------
-- permissions — monitoring is admin-only; both are enforced by real routes
-- ----------------------------------------------------------------------------
INSERT INTO permissions (slug, "group", description, status) VALUES
  ('system.metrics.view',    'system', 'View VPS health metrics and infrastructure status', 'active'),
  ('system.diagnostics.run', 'system', 'Run controlled VPS diagnostic benchmarks',          'active')
ON CONFLICT (slug) DO UPDATE SET status = 'active', description = excluded.description;

-- the admin role holds every permission (roles.ts enforces this invariant)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin' AND p.slug IN ('system.metrics.view', 'system.diagnostics.run')
ON CONFLICT DO NOTHING;

-- allow the monitoring thresholds to be tuned at runtime through the existing
-- site_settings mechanism (PATCH /v1/admin/config/settings/monitor_thresholds).
-- An empty object means "use the documented defaults in lib/thresholds.ts".
INSERT INTO site_settings (key, value) VALUES ('monitor_thresholds', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
