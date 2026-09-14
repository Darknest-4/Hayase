-- ============================================================================
-- 0038 — audit.read, the permission behind the Audit status page
-- ============================================================================
-- The admin panel gained a section that reads docs/audit-2026-09.json and shows
-- what the September audit found: how many findings there are, at what
-- severity, which are open, and where each one lives in the source.
--
-- Its own permission rather than a reuse. `admin.analytics.view` is about how
-- the platform is performing and `admin.users.manage` about what people did;
-- this is a list of the known defects in the software, with file and line for
-- each — a map of where the soft spots are. Somebody who may read the audit
-- log does not automatically need that, and an instance may well want to grant
-- it to an engineer who has no business in the user table.
--
-- The existing `audit.view` is not it: that row belongs to the `moderation`
-- group, it has been `planned` since 0012 and nothing checks it, and it means
-- "read the audit log" — the other audit. Two names for two things, which is
-- the same reason the section key had to move (see YUME-AUDIT-0013).
--
-- Granted to admin only. Nothing else changes: no table is touched, no data is
-- moved, and an instance that applies this and no more behaves exactly as it
-- did except that an administrator can now open one more section.
--
-- Backwards compatible in both directions. An older application binary does
-- not know the slug and never asks for it, so an extra permission row is
-- inert; rolling forward again needs no repair because both statements are
-- idempotent.
-- ============================================================================

INSERT INTO permissions (slug, description, "group", status)
VALUES ('audit.read',
        'Read the code audit report: findings, severities and the files they point at',
        'system', 'active')
ON CONFLICT (slug) DO UPDATE
   SET status = 'active',
       description = EXCLUDED.description,
       "group" = EXCLUDED."group";

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug = 'audit.read'
ON CONFLICT DO NOTHING;
