-- ============================================================================
-- 0028 — Remove the Discord bot's message table
-- ============================================================================
-- The Discord integration was reverted. Reverting the commits takes the code
-- and the migration *file* away, but not the table on a database where that
-- migration already ran — the runner records applied filenames and never goes
-- back to undo one. A deployed instance would keep an empty table forever,
-- with nothing in the repository explaining what it was.
--
-- `IF EXISTS` because both cases are normal: an instance that ran the bot has
-- the table, and a fresh one has never heard of it.
--
-- Nothing depended on it. It held only a mapping from a purpose key to a
-- Discord message id — no user data, no foreign keys pointing at it.
-- ============================================================================

DROP TABLE IF EXISTS discord_messages;
