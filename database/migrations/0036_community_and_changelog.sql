-- The community surface, and the development log.
--
-- Two unrelated things in one migration because both are the same kind of
-- change: tables that exist to be read by a page that did not exist before.
--
-- The forum is not new here. `forums`, `topics` and `posts` have been in the
-- schema since 0004 with nothing behind them — no routes, no page, and zero
-- rows in every deployment. What this adds is the small amount they were
-- missing to be usable, and it flips their permissions from `planned` to
-- `active`, which is what the admin Roles screen reads to say which grants a
-- route actually enforces.

-- ---------------------------------------------------------------------------
-- Forum
-- ---------------------------------------------------------------------------

-- Who made it, so a forum somebody created can be told from one that shipped.
ALTER TABLE forums ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE forums ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
-- A forum nobody may post in any more, without deleting what was written.
ALTER TABLE forums ADD COLUMN IF NOT EXISTS locked_at timestamptz;

COMMENT ON COLUMN forums.min_role IS
  'Lowest role that may open this forum. Left as ''user'' for everything anyone can read.';

CREATE INDEX IF NOT EXISTS forums_position_idx ON forums (position, name);
CREATE INDEX IF NOT EXISTS topics_forum_recent_idx ON topics (forum_id, pinned DESC, last_post_at DESC);
CREATE INDEX IF NOT EXISTS posts_topic_idx ON posts (topic_id, created_at);

-- ---------------------------------------------------------------------------
-- Chat rooms
-- ---------------------------------------------------------------------------
--
-- `chats.kind` allowed 'dm' and 'group' only, both of which mean "you were
-- added to this". A room anybody may walk into is a third thing: it is listed
-- before you are a member, and joining is what makes you one.

ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_kind_check;
ALTER TABLE chats ADD CONSTRAINT chats_kind_check CHECK (kind IN ('dm', 'group', 'room'));

ALTER TABLE chats ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS topic text;
CREATE UNIQUE INDEX IF NOT EXISTS chats_slug_key ON chats (slug) WHERE slug IS NOT NULL;

COMMENT ON COLUMN chats.slug IS 'Stable name for a public room, so a link to it survives a rename.';

-- ---------------------------------------------------------------------------
-- Development log
-- ---------------------------------------------------------------------------
--
-- Deliberately two tables. A release is a heading with a version and a state;
-- the lines under it are what changed. Keeping the lines as rows rather than
-- one markdown blob is what lets the page group them by kind, and what lets
-- something later count them.

CREATE TABLE IF NOT EXISTS releases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version     text        NOT NULL UNIQUE,
  title       text        NOT NULL,
  summary     text,
  -- planned → in_progress → released. A planned release has no date yet, which
  -- is the whole reason the date is nullable.
  status      text        NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'in_progress', 'released')),
  released_on date,
  -- Ordering is explicit rather than derived from the version string: "0.9.10"
  -- sorts before "0.9.9" as text, and parsing semver in SQL to avoid that is a
  -- lot of machinery for a list somebody curates by hand anyway.
  position    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE releases IS 'The development log: one row per version, shipped or planned.';

CREATE INDEX IF NOT EXISTS releases_order_idx ON releases (position DESC, released_on DESC NULLS FIRST);

CREATE TABLE IF NOT EXISTS release_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  -- The keep-a-changelog vocabulary, plus 'security' because it is worth
  -- reading separately from 'fixed'.
  kind       text NOT NULL CHECK (kind IN ('added', 'changed', 'fixed', 'removed', 'security')),
  body       text NOT NULL,
  position   integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS release_entries_release_idx ON release_entries (release_id, position);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

INSERT INTO permissions (slug, description, "group", status) VALUES
  ('changelog.manage', 'Write and publish development log entries', 'admin', 'active')
ON CONFLICT (slug) DO UPDATE SET status = 'active', "group" = EXCLUDED."group";

/*
 * Exactly the permissions a route checks, and no more.
 *
 * `status` is what the admin Roles screen reads to badge a grant LIVE or
 * planned, and permission-status.test.ts holds it to the `requirePermission()`
 * and `holds()` call sites in the source. Marking the reading permissions
 * active would have been the easy mistake: forum.view, topic.view, post.view
 * and a changelog.view all sound like they belong in this list, and nothing
 * checks any of them — reading a board is public. A grant badged LIVE that
 * protects nothing is worse than one badged planned, because an operator
 * granting it believes they changed something.
 *
 * Likewise forum.lock and forum.moderate: locking a board goes through
 * PATCH /v1/forum/:id, which asks for forum.edit. Until something asks for
 * them by name they stay planned.
 */
UPDATE permissions SET status = 'active'
 WHERE slug IN (
   'forum.create', 'forum.edit', 'forum.delete',
   'topic.create', 'topic.pin', 'topic.lock', 'topic.delete',
   'post.create', 'post.edit', 'post.delete', 'post.hide',
   'chat.moderate'
 );

-- Anyone signed in may start a forum and post in it. That is the request, and
-- it is what `community.post` already means for comments; the moderation
-- grants below are the counterweight.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'user'
   AND p.slug IN ('forum.create', 'topic.create', 'post.create', 'post.edit')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'moderator'
   AND p.slug IN ('forum.edit', 'forum.delete',
                  'topic.lock', 'topic.pin', 'topic.delete', 'post.delete', 'post.hide', 'chat.moderate')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.slug = 'editor' AND p.slug = 'changelog.manage'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Feature flags
-- ---------------------------------------------------------------------------

INSERT INTO feature_flags (key, label, description, category, enabled, access)
VALUES
  ('feature.forum', 'Forum', 'Discussion boards anyone can start', 'feature', true, 'public'),
  ('feature.chat', 'Live chat', 'Public chat rooms', 'feature', true, 'public'),
  ('page.changelog', 'Development log', 'What shipped, what is coming', 'page', true, 'public')
ON CONFLICT (key) DO NOTHING;
