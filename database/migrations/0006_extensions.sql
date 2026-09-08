-- ============================================================================
-- 0006 — Extension platform: store, versions, permissions, installs, reviews
-- ============================================================================
-- Design notes:
--  * Evolves the Hayase extension model (torrent/nzb/http/subtitle workers)
--    into a store: extensions have owners, signed versioned packages in
--    object storage, a declared permission manifest, and a review pipeline.
--  * Clients keep running extensions inside sandboxed workers; the declared
--    permissions here are enforced by the runtime (network allowlist, query
--    field access) — see docs/extensions.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- extension_developers — publisher profile on top of a user account
-- ----------------------------------------------------------------------------
CREATE TABLE extension_developers (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  website      text,
  verified     boolean NOT NULL DEFAULT false, -- verified publisher checkmark
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE extension_developers IS 'Publisher identity for the store; verification is a manual admin action.';

-- ----------------------------------------------------------------------------
-- extensions — store listing (one row per extension, versions separate)
-- ----------------------------------------------------------------------------
CREATE TABLE extensions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,64}$'),
  owner_id      uuid NOT NULL REFERENCES extension_developers(user_id) ON DELETE CASCADE,
  name          text NOT NULL,
  summary       text NOT NULL CHECK (length(summary) <= 200),
  description   text,                          -- markdown store page
  type          text NOT NULL CHECK (type IN ('torrent', 'nzb', 'http', 'subtitle', 'metadata', 'theme')),
  icon_key      text,
  accuracy      text NOT NULL DEFAULT 'medium' CHECK (accuracy IN ('high', 'medium', 'low')),
  media_kind    text NOT NULL DEFAULT 'both' CHECK (media_kind IN ('sub', 'dub', 'both')),
  languages     text[] NOT NULL DEFAULT '{}',  -- ISO country codes served
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'suspended', 'deprecated')),
  install_count integer NOT NULL DEFAULT 0,    -- denormalised
  rating_avg    numeric(3,2),                  -- denormalised from extension_reviews
  rating_count  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE extensions IS 'Store listings. Runtime code lives in versioned packages; this row is discovery + trust metadata.';
CREATE INDEX extensions_store_idx ON extensions (type, install_count DESC) WHERE status = 'published';
CREATE INDEX extensions_owner_idx ON extensions (owner_id);
CREATE TRIGGER extensions_updated BEFORE UPDATE ON extensions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- now that extensions exists, wire up the FK left pending in 0003
ALTER TABLE video_sources
  ADD CONSTRAINT video_sources_extension_fk
  FOREIGN KEY (extension_id) REFERENCES extensions(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- extension_versions — immutable released packages
-- ----------------------------------------------------------------------------
CREATE TABLE extension_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id  uuid NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version       text NOT NULL,                 -- semver, validated at the app layer
  package_key   text NOT NULL,                 -- object-storage key of the signed .tgz
  package_hash  text NOT NULL,                 -- sha256 clients verify before loading
  package_size  integer NOT NULL,
  manifest      jsonb NOT NULL,                -- full manifest snapshot (entry, options schema, min app version)
  changelog     text,
  min_app_version text,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  review_notes  text,
  published_at  timestamptz,                   -- null until approved & released
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extension_id, version)
);
COMMENT ON TABLE extension_versions IS 'Immutable signed releases. Clients auto-update to the latest published version compatible with their app.';
CREATE INDEX extension_versions_latest_idx ON extension_versions (extension_id, published_at DESC) WHERE published_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- extension_permissions — declared capability manifest per version
-- ----------------------------------------------------------------------------
CREATE TABLE extension_permissions (
  version_id  uuid NOT NULL REFERENCES extension_versions(id) ON DELETE CASCADE,
  permission  text NOT NULL CHECK (permission IN (
    'net:fetch',            -- outbound fetch to declared hosts
    'query:ids',            -- read external ids (anilist/anidb/tvdb…) from queries
    'query:titles',         -- read title strings (lowers accuracy cap)
    'query:media',          -- read the full media object (lowers accuracy cap)
    'storage:local',        -- persistent key/value storage in the sandbox
    'player:subtitles'      -- inject subtitle tracks into the player
  )),
  hosts       text[] NOT NULL DEFAULT '{}',    -- for net:fetch — allowlisted hostnames
  PRIMARY KEY (version_id, permission)
);
COMMENT ON TABLE extension_permissions IS 'Declared permissions shown at install time and enforced by the client sandbox (network allowlist, query proxy).';

-- ----------------------------------------------------------------------------
-- extension_installs — who runs what (drives update fan-out + counts)
-- ----------------------------------------------------------------------------
CREATE TABLE extension_installs (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id uuid NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version_id   uuid NOT NULL REFERENCES extension_versions(id) ON DELETE RESTRICT,
  enabled      boolean NOT NULL DEFAULT true,
  auto_update  boolean NOT NULL DEFAULT true,
  options      jsonb NOT NULL DEFAULT '{}',    -- user-set option values (validated against manifest schema)
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, extension_id)
);
COMMENT ON TABLE extension_installs IS 'Per-user installs, pinned to a version. Auto-update workers advance version_id when a new release publishes.';
CREATE INDEX extension_installs_ext_idx ON extension_installs (extension_id, version_id);
CREATE TRIGGER extension_installs_updated BEFORE UPDATE ON extension_installs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- extension_reviews — store ratings
-- ----------------------------------------------------------------------------
CREATE TABLE extension_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id uuid NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         text CHECK (length(body) <= 5000),
  version_id   uuid REFERENCES extension_versions(id) ON DELETE SET NULL, -- which version was reviewed
  hidden_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extension_id, user_id)
);
CREATE INDEX extension_reviews_ext_idx ON extension_reviews (extension_id, created_at DESC) WHERE hidden_at IS NULL;

-- ----------------------------------------------------------------------------
-- extension_events — downloads/updates/errors telemetry (aggregated hourly)
-- ----------------------------------------------------------------------------
CREATE TABLE extension_events (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  extension_id uuid NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version_id   uuid REFERENCES extension_versions(id) ON DELETE SET NULL,
  event        text NOT NULL CHECK (event IN ('install', 'uninstall', 'update', 'error', 'load_failure')),
  detail       jsonb NOT NULL DEFAULT '{}',    -- error message class, app version, platform (no PII)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE extension_events IS 'Anonymous extension telemetry for the developer portal dashboards. Monthly partitions, 90-day retention.';
CREATE INDEX extension_events_ext_idx ON extension_events (extension_id, event, created_at DESC);
CREATE TABLE extension_events_2026_07 PARTITION OF extension_events FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE extension_events_2026_08 PARTITION OF extension_events FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
