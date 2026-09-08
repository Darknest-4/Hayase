-- ============================================================================
-- 0014 — Permission lifecycle status (active vs planned)
-- ============================================================================
-- The permission catalogue is the platform's full RBAC vocabulary and is
-- deliberately ahead of the features that consume it (modules #2–#5). To keep
-- it honest — so no permission looks "dead" — every permission carries a
-- status:
--   * active  — enforced by a real route today (requirePermission in code)
--   * planned — catalogued & grantable, but its feature isn't built yet
-- The Roles admin UI surfaces this so operators see what actually bites.
-- When a future module wires a permission, flip its status to 'active'.
-- ============================================================================

ALTER TABLE permissions
  ADD COLUMN status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('active', 'planned'));

COMMENT ON COLUMN permissions.status IS
  'active = enforced by a route today; planned = catalogued for an upcoming module. Keep in sync with requirePermission() call sites.';

-- Mark the permissions actually enforced in server/src today.
UPDATE permissions SET status = 'active' WHERE slug IN (
  'admin.analytics.view',
  'admin.users.manage',
  'admin.webhooks.manage',
  'anime.view', 'anime.create', 'anime.edit', 'anime.delete',
  'episode.create', 'episode.edit', 'episode.delete',
  'community.moderate', 'community.post',
  'extensions.publish',
  'roles.manage',
  'settings.system'
);
