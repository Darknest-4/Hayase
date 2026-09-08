-- ============================================================================
-- 0032 — Assigning a role, and ending a session, become things a screen can do
-- ============================================================================
-- Two permissions that have been grantable since 0014 and enforced by nothing.
--
-- `role.assign` — the Roles screen edits what a role may *do*, and nothing
-- anywhere said who *holds* one. Promoting a moderator meant an INSERT into
-- user_roles by hand: no record of who did it, no check that the last
-- administrator was not being demoted, and no way for anybody without database
-- access to do it at all.
--
-- `session.revoke` — a shared password or a lost laptop is not misconduct, but
-- the only tool for it was a ban, which is both wrong and visible to the
-- person. Ending the sessions without touching the account status is the
-- proportionate act, and it needed a permission of its own rather than being
-- folded into admin.users.manage.
--
-- Flipping `status` is not decoration: the Roles screen draws an "active" or
-- "planned" badge from this column, so an operator granting a permission can
-- see whether it protects anything yet. test/permission-status.test.ts reads
-- the requirePermission() call sites out of the source and fails if this
-- column disagrees with them, which is what makes the badge trustworthy.
-- ============================================================================

UPDATE permissions SET status = 'active' WHERE slug IN ('role.assign', 'session.revoke');

-- Both belong to whoever already administers accounts. Granting them to the
-- admin role only: `moderator` can suspend and ban, but handing out roles is
-- how an instance changes hands, and that is not a moderation decision.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.slug = 'admin' AND p.slug IN ('role.assign', 'session.revoke')
ON CONFLICT DO NOTHING;
