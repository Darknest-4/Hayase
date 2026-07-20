-- ============================================================================
-- 0010 — Profile flags + expanded permission catalog
-- ============================================================================
-- Adds an avatar emoji shortcut to profiles (the client uses emoji avatars
-- before object-storage uploads), and greatly expands the permission
-- catalog toward the fine-grained model the platform needs.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_emoji text;
COMMENT ON COLUMN user_profiles.avatar_emoji IS 'Emoji avatar shortcut; avatar_key (object storage) takes precedence when set.';

-- ----------------------------------------------------------------------------
-- Expanded permission catalog. Grouped for the admin UI; enforced by slug.
-- ----------------------------------------------------------------------------
INSERT INTO permissions (slug, "group", description) VALUES
  -- catalogue
  ('anime.edit',            'catalogue',  'Edit anime metadata'),
  ('anime.delete',          'catalogue',  'Delete anime entries'),
  ('anime.publish',         'catalogue',  'Publish anime to the public catalogue'),
  ('anime.merge',           'catalogue',  'Merge duplicate anime entries'),
  ('episode.edit',          'catalogue',  'Edit episode metadata'),
  ('character.edit',        'catalogue',  'Edit characters and staff'),
  ('mapping.edit',          'catalogue',  'Edit external id mappings'),
  -- community
  ('comment.delete',        'community',  'Delete any comment'),
  ('comment.pin',           'community',  'Pin comments'),
  ('review.delete',         'community',  'Delete any review'),
  ('forum.lock',            'community',  'Lock forum topics'),
  ('forum.pin',             'community',  'Pin forum topics'),
  ('forum.moderate',        'community',  'Moderate forums and clubs'),
  ('club.manage',           'community',  'Manage any club'),
  -- moderation
  ('user.warn',             'moderation', 'Issue user warnings'),
  ('user.mute',             'moderation', 'Temporarily mute users'),
  ('user.suspend',          'moderation', 'Suspend user accounts'),
  ('user.ban',              'moderation', 'Ban user accounts'),
  ('report.resolve',        'moderation', 'Resolve reports'),
  ('appeal.review',         'moderation', 'Review moderation appeals'),
  ('spam.review',           'moderation', 'Review the spam queue'),
  ('audit.view',            'moderation', 'View the audit timeline'),
  -- developer / extensions
  ('developer.publish',     'developer',  'Publish extensions'),
  ('developer.review',      'developer',  'Review submitted extensions'),
  ('extension.install',     'developer',  'Install extensions'),
  ('extension.publish',     'developer',  'Publish extension versions'),
  ('theme.publish',         'developer',  'Publish themes to the marketplace'),
  ('api.create',            'developer',  'Create API keys and OAuth apps'),
  ('api.delete',            'developer',  'Revoke API keys and OAuth apps'),
  ('oauth.manage',          'developer',  'Manage OAuth applications'),
  -- analytics
  ('analytics.view',        'analytics',  'View platform analytics'),
  ('analytics.export',      'analytics',  'Export analytics data'),
  -- system
  ('settings.system',       'system',     'Change system settings'),
  ('settings.security',     'system',     'Change security settings'),
  ('roles.manage',          'system',     'Assign roles and edit permissions'),
  ('webhooks.manage',       'system',     'Manage outbound webhooks')
ON CONFLICT (slug) DO NOTHING;

-- grant the whole catalog to the admin role (admin gets everything)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'admin'
ON CONFLICT DO NOTHING;

-- moderator role picks up the moderation + community-moderation set
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'moderator' AND p."group" IN ('moderation', 'community')
ON CONFLICT DO NOTHING;

-- developer role picks up the developer set
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.slug = 'developer' AND p."group" = 'developer'
ON CONFLICT DO NOTHING;
