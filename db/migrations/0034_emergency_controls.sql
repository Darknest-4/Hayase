-- ============================================================================
-- 0034 — Emergency controls
-- ============================================================================
-- Four switches an operator can throw when something is going wrong, and one
-- permission that gates them.
--
-- Every one of them has an enforcement point in the server. That is the whole
-- test for whether a control belongs here: the spec this came from also asked
-- for "disable uploads" and "disable AI", and neither is in this migration
-- because this platform has no upload route and no AI surface. A switch for a
-- feature that does not exist is the fake toggle problem again, one migration
-- after removing three of them (0033).
--
--   read_only              refuses every mutating HTTP request. GETs, sign-in
--                          and sign-out keep working, and so does the settings
--                          route itself — an operator has to be able to turn it
--                          back off. Background jobs are unaffected: this is
--                          about what the site accepts from outside, not about
--                          freezing the database.
--
--   external_sync_enabled  stops metadata runs starting and stops a running one
--                          continuing. The lever for "AniList is returning
--                          garbage" or "we are being rate-limited into the
--                          ground".
--
--   webhooks_enabled       stops outbound deliveries being queued at all. The
--                          lever for a receiver that has started paging
--                          somebody every thirty seconds.
--
-- The fourth control is an action rather than a setting — revoking every
-- session — and lives at POST /v1/admin/security/revoke-all-sessions.
--
-- `security.manage` rather than reusing `settings.system`: changing the site's
-- name and putting the whole instance into read-only mode are not the same
-- decision, and an editor who may do the first should not inherit the second.
-- Granted to admin only.
--
-- Defaults are the permissive ones, so applying this migration changes the
-- behaviour of a running instance in no way at all.
-- ============================================================================

INSERT INTO site_settings (key, value)
VALUES ('read_only', 'false'::jsonb),
       ('external_sync_enabled', 'true'::jsonb),
       ('webhooks_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (slug, description, "group", status)
VALUES ('security.manage',
        'Throw the emergency controls: read-only mode, external sync, outbound webhooks, revoking every session',
        'security', 'active')
ON CONFLICT (slug) DO UPDATE SET status = 'active', description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug = 'security.manage'
ON CONFLICT DO NOTHING;
