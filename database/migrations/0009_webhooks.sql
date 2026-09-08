-- ============================================================================
-- 0009 — Outbound webhooks
-- ============================================================================
-- Admin-configured webhooks: each subscribes to an individual set of event
-- types (per-event toggles). Discord URLs get rich embeds; generic JSON
-- endpoints get the raw payload with an HMAC signature header.
-- Delivery runs through the job queue (retries with backoff); every attempt
-- is logged to webhook_deliveries.

CREATE TABLE webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  url           text NOT NULL CHECK (url ~ '^https?://'),
  format        text NOT NULL DEFAULT 'json' CHECK (format IN ('discord', 'json')),
  events        text[] NOT NULL DEFAULT '{}',  -- subscribed event types; empty = nothing fires
  enabled       boolean NOT NULL DEFAULT true,
  secret        text,                          -- HMAC-SHA256 signing key for json format
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  failure_count integer NOT NULL DEFAULT 0,    -- consecutive failures; auto-disable at 20
  last_success_at timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE webhooks IS 'Outbound webhook endpoints with per-event subscriptions. Discord format renders embeds; json format signs with HMAC.';
CREATE INDEX webhooks_enabled_idx ON webhooks (enabled) WHERE enabled;
CREATE TRIGGER webhooks_updated BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE webhook_deliveries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status_code integer,                         -- HTTP status; null = network error
  error       text,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE webhook_deliveries IS 'Per-attempt delivery log (kept 30 days, pruned by the maintenance worker).';
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (webhook_id, created_at DESC);

-- permission gate for the admin webhook UI
INSERT INTO permissions (slug, "group", description) VALUES
  ('admin.webhooks.manage', 'admin', 'Create and configure outbound webhooks');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin' AND p.slug = 'admin.webhooks.manage';
