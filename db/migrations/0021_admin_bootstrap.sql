-- ============================================================================
-- 0021 — Somebody has to be able to reach the admin panel
-- ============================================================================
-- No migration has ever created a user, and none has ever granted a role. That
-- is the right call — a shipped account with a known password is a back door
-- on every deployment that forgets to change it — but it left a gap at the
-- other end: after a fresh install nobody can open the admin panel, and there
-- was no documented way to become the first administrator. The only route was
-- writing this INSERT by hand.
--
-- Two halves, and they share one rule.
--
--   * Registration promotes an account when the instance has no administrator
--     (see server/src/routes/auth.ts).
--   * This migration does the same for an instance that already has users —
--     which is the case this was written for: the database exists and the
--     operator is already registered.
--
-- The rule is "no administrator exists", not "this is the first user". Those
-- differ exactly where it matters: once anybody holds the role, neither path
-- can hand out another. Re-running this changes nothing, and on an instance
-- that already has an administrator it does nothing at all.
--
-- The oldest account is chosen because on a self-hosted install that is the
-- person who set it up. On an instance where that is not true, an existing
-- administrator already exists and this does nothing.
-- ============================================================================

DO $$
DECLARE
  target uuid;
  target_name text;
BEGIN
  -- Already has an administrator: nothing to do, and nothing to explain.
  IF EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.slug = 'admin'
  ) THEN
    RAISE NOTICE 'admin bootstrap: an administrator already exists, leaving roles alone';
    RETURN;
  END IF;

  SELECT u.id, u.username INTO target, target_name
    FROM users u
   WHERE u.deleted_at IS NULL AND u.status = 'active'
   ORDER BY u.created_at
   LIMIT 1;

  -- No users yet: registration will do it instead, on the first account.
  IF target IS NULL THEN
    RAISE NOTICE 'admin bootstrap: no accounts yet, the first to register becomes administrator';
    RETURN;
  END IF;

  INSERT INTO user_roles (user_id, role_id)
  SELECT target, r.id FROM roles r WHERE r.slug = 'admin'
  ON CONFLICT DO NOTHING;

  -- Becoming an administrator is the most consequential thing that can happen
  -- to an account, and here it happens without anyone approving it. Recorded
  -- where somebody would look for it afterwards.
  INSERT INTO security_logs (user_id, event)
  VALUES (target, 'admin_bootstrap');

  INSERT INTO audit_logs (actor_id, action, subject_type, subject_id, before, after)
  VALUES (
    target, 'user.role.bootstrap', 'user', target, '{}'::jsonb,
    jsonb_build_object('role', 'admin', 'reason', 'oldest account on an instance with no administrator', 'via', 'migration 0021')
  );

  RAISE NOTICE 'admin bootstrap: granted admin to the oldest account (%)', target_name;
END $$;
