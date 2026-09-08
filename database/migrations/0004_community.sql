-- ============================================================================
-- 0004 — Community: comments, forums, messaging, social graph, moderation
-- ============================================================================
-- Design notes:
--  * Comments are polymorphic over a small closed set of subjects
--    (anime, episode, post, extension, review) via subject_type+subject_id.
--    A closed CHECK beats separate tables: one moderation surface, one API.
--  * Threading is materialised-path (path ltree-like text) — cheap subtree
--    reads, no recursive CTE on the hot path.
--  * Social graph is two tables: follows (directed) and friendships
--    (mutual, single row per pair enforced by ordered pair constraint).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- comments — unified comment system for anime/episodes/posts/extensions
-- ----------------------------------------------------------------------------
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('anime', 'episode', 'post', 'extension', 'review')),
  subject_id   uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES comments(id) ON DELETE CASCADE,
  path         text NOT NULL DEFAULT '',       -- materialised path of ancestor ids: 'a1.b2.c3'
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  spoiler      boolean NOT NULL DEFAULT false,
  like_count   integer NOT NULL DEFAULT 0,     -- denormalised from comment_likes
  reply_count  integer NOT NULL DEFAULT 0,
  edited_at    timestamptz,
  hidden_at    timestamptz,                    -- set by moderation; body kept for appeal
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE comments IS 'One comment system for every commentable subject. Materialised path threading, moderation-aware.';
CREATE INDEX comments_subject_idx ON comments (subject_type, subject_id, created_at DESC) WHERE hidden_at IS NULL;
CREATE INDEX comments_author_idx  ON comments (author_id, created_at DESC);
CREATE INDEX comments_path_idx    ON comments (subject_type, subject_id, path text_pattern_ops);

CREATE TABLE comment_likes (
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- ----------------------------------------------------------------------------
-- forums → topics → posts
-- ----------------------------------------------------------------------------
CREATE TABLE forums (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  position    smallint NOT NULL DEFAULT 0,     -- display order
  anime_id    uuid REFERENCES anime(id) ON DELETE CASCADE, -- per-anime forum, null = general
  min_role    text NOT NULL DEFAULT 'user'     -- minimum role slug to post
);
COMMENT ON TABLE forums IS 'Forum categories; per-anime discussion boards reference the anime directly.';
CREATE UNIQUE INDEX forums_anime_idx ON forums (anime_id) WHERE anime_id IS NOT NULL;

CREATE TABLE topics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forum_id    uuid NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  pinned      boolean NOT NULL DEFAULT false,
  locked      boolean NOT NULL DEFAULT false,
  post_count  integer NOT NULL DEFAULT 0,      -- denormalised
  last_post_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topics_forum_idx ON topics (forum_id, pinned DESC, last_post_at DESC);

CREATE TABLE posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  edited_at   timestamptz,
  hidden_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE posts IS 'Forum posts (first post = topic body). Comments on posts reuse the comments table.';
CREATE INDEX posts_topic_idx ON posts (topic_id, created_at);

-- ----------------------------------------------------------------------------
-- direct messages & group chats
-- ----------------------------------------------------------------------------
CREATE TABLE chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('dm', 'group')),
  name        text,                            -- group name; null for DMs
  icon_key    text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_members (
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  muted_until timestamptz,
  last_read_at timestamptz NOT NULL DEFAULT now(), -- unread counters derive from this
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

CREATE TABLE messages (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  reply_to    bigint,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE messages IS 'Chat messages, range-partitioned monthly. Delivery is WebSocket + Redis pub/sub; this is the durable log.';
CREATE INDEX messages_chat_idx ON messages (chat_id, created_at DESC);
CREATE TABLE messages_2026_07 PARTITION OF messages FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE messages_2026_08 PARTITION OF messages FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- ----------------------------------------------------------------------------
-- clubs — persistent interest groups with membership
-- ----------------------------------------------------------------------------
CREATE TABLE clubs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  icon_key    text,
  banner_key  text,
  is_public   boolean NOT NULL DEFAULT true,
  member_count integer NOT NULL DEFAULT 0,     -- denormalised
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE clubs IS 'Interest groups. Each club gets a forum and a group chat created at the app layer.';

CREATE TABLE club_members (
  club_id   uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'owner')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);
CREATE INDEX club_members_user_idx ON club_members (user_id);

-- ----------------------------------------------------------------------------
-- social graph: follows (directed) + friendships (mutual)
-- ----------------------------------------------------------------------------
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);

CREATE TABLE friendships (
  user_a      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)                      -- ordered pair: one row per relationship
);
COMMENT ON TABLE friendships IS 'Mutual relationships stored once per pair (user_a < user_b). requested_by disambiguates direction.';
CREATE INDEX friendships_b_idx ON friendships (user_b) WHERE status = 'accepted';

-- ----------------------------------------------------------------------------
-- moderation: reports and actions
-- ----------------------------------------------------------------------------
CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('comment', 'post', 'topic', 'review', 'user', 'extension', 'message')),
  subject_id   uuid NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('spam', 'harassment', 'nsfw', 'spoiler', 'illegal', 'other')),
  details      text CHECK (length(details) <= 2000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE reports IS 'User reports across every content type; the moderation queue reads status=open ordered by age.';
CREATE INDEX reports_queue_idx ON reports (status, created_at) WHERE status IN ('open', 'reviewing');
CREATE INDEX reports_subject_idx ON reports (subject_type, subject_id);

CREATE TABLE moderation_actions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  moderator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       text NOT NULL CHECK (action IN ('hide', 'delete', 'warn', 'mute', 'suspend', 'ban', 'restore', 'dismiss_report')),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  report_id    uuid REFERENCES reports(id) ON DELETE SET NULL,
  reason       text NOT NULL,
  duration     interval,                       -- for mute/suspend
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE moderation_actions IS 'Append-only log of every moderation decision, linked back to the triggering report.';
CREATE INDEX moderation_actions_subject_idx ON moderation_actions (subject_type, subject_id, created_at DESC);
