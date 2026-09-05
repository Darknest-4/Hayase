-- ============================================================================
-- 0028 — Remember which Discord message is which
-- ============================================================================
-- Without this the bot can only ever *post*. Every status refresh becomes a new
-- message, #server-status fills with a thousand near-identical embeds a day,
-- and the rules get re-posted every time anybody edits them.
--
-- What is needed is an identity: "the release board" is one message, and
-- updating it means editing that message. Discord gives no way to look one up
-- by purpose — a message id is the only handle — so the mapping is stored here.
--
-- The content hash is what makes it quiet. A sync that finds the same hash
-- writes nothing at all: no edit, no API call, no `(edited)` marker appearing
-- on a message whose text did not change. That matters more than it sounds,
-- because the boards re-render on a timer and most ticks change nothing.
--
-- Nothing secret lives here. A message id and a channel id are public within
-- the server; the webhook URLs that *are* credentials stay in the environment.
-- ============================================================================

CREATE TABLE discord_messages (
  -- What this message is, not where it is: 'board:status', 'static:rules',
  -- 'release:<anime>:<ep>'. Stable across channel moves and re-provisioning.
  key         text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200),
  guild_id    text NOT NULL,
  channel_id  text NOT NULL,
  message_id  text NOT NULL,
  -- sha256 of the rendered payload. Equal hash means "do nothing".
  content_hash text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- How many times the content actually changed. A board that rewrites itself
  -- every minute is a bug, and this is where it shows up.
  edit_count  integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE discord_messages IS
  'Purpose → Discord message, so an update edits in place instead of posting again. content_hash short-circuits unchanged renders.';
COMMENT ON COLUMN discord_messages.key IS
  'Stable purpose key. The bot owns the namespace: board:*, static:*, release:*.';
COMMENT ON COLUMN discord_messages.edit_count IS
  'Incremented only when the hash changed. A high count on a static message means something is rendering non-deterministically.';

-- "everything this guild owns", for re-provisioning and for cleanup when a
-- channel is deleted.
CREATE INDEX discord_messages_guild_idx ON discord_messages (guild_id, channel_id);
