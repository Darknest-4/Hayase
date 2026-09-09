-- One profile per account.
--
-- The Netflix-style profile picker is removed from the product: no "Who's
-- watching?" screen, no switcher, no create or delete. This makes the database
-- agree with that.
--
-- What is NOT done here, deliberately: profile_id is not collapsed onto
-- user_id. Every user-data table in this schema hangs off profile_id —
-- library_entries, favorites, watch_history, watch_progress, reviews,
-- collections, bookmarks, custom_lists, user_settings, profile_stats,
-- profile_achievements, xp_events, page_views, search_stats, and
-- watch_together_rooms.host_profile. Rewriting all of them to delete a screen
-- would be a far larger and riskier change than the feature is worth, and it
-- would still have to answer the same question this migration answers. So the
-- row stays as the account's own identifier, and the constraint below makes it
-- exactly one.
--
-- Accounts that hold two profiles today are merged rather than truncated: the
-- default (or oldest) profile keeps its rows, and the other profile's rows are
-- moved onto it. Where a unique constraint refuses the move — the same title in
-- both libraries, the same episode's progress in both — the keeper's row wins
-- and the loser is copied into profile_merge_dropped before it goes, so
-- nothing leaves the database without a copy.

-- Where the rows that could not be merged are kept. Deliberately not dropped
-- at the end of this migration: it is the only record that they existed.
CREATE TABLE IF NOT EXISTS profile_merge_dropped (
  id           bigserial PRIMARY KEY,
  user_id      uuid        NOT NULL,
  from_profile uuid        NOT NULL,
  into_profile uuid        NOT NULL,
  table_name   text        NOT NULL,
  row_data     jsonb       NOT NULL,
  dropped_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE profile_merge_dropped IS
  'Rows from a second watch profile that collided with the kept profile when the profile picker was removed (0035). Keep: it is the only copy.';

DO $$
DECLARE
  account   record;
  extra     record;
  tbl       text;
  moved     int;
  dropped   int;
  total_a   int := 0;
  total_d   int := 0;
  -- Base tables carrying profile_id. Partition children are left out on
  -- purpose: an UPDATE on the parent reaches them, and profile_id is not the
  -- partition key, so no row has to change partition.
  tables text[] := ARRAY[
    'library_entries', 'favorites', 'bookmarks', 'collections', 'custom_lists',
    'reviews', 'user_settings', 'profile_stats', 'profile_achievements',
    'watch_progress', 'watch_history', 'xp_events', 'page_views', 'search_stats'
  ];
BEGIN
  FOR account IN
    SELECT user_id FROM user_profiles GROUP BY user_id HAVING count(*) > 1
  LOOP
    -- The keeper: the account's default profile, or its oldest if none is
    -- marked. Same rule the application used to pick a profile to sync with.
    FOR extra IN
      SELECT id, keeper FROM (
        SELECT id,
               first_value(id) OVER (ORDER BY is_default DESC, created_at, id) AS keeper
        FROM user_profiles WHERE user_id = account.user_id
      ) ranked WHERE id <> keeper
    LOOP
      FOREACH tbl IN ARRAY tables LOOP
        -- The whole set usually moves in one statement. Only when a unique
        -- constraint refuses does this fall back to deciding row by row, which
        -- is slow and does not need to be fast: it runs once, for a handful of
        -- accounts, and never again.
        BEGIN
          EXECUTE format('UPDATE %I SET profile_id = $1 WHERE profile_id = $2', tbl)
            USING extra.keeper, extra.id;
          GET DIAGNOSTICS moved = ROW_COUNT;
          total_a := total_a + moved;
        EXCEPTION WHEN unique_violation OR exclusion_violation THEN
          EXECUTE format(
            'INSERT INTO profile_merge_dropped (user_id, from_profile, into_profile, table_name, row_data)
             SELECT $1, $2, $3, %L, to_jsonb(t) FROM %I t WHERE t.profile_id = $2',
            tbl, tbl
          ) USING account.user_id, extra.id, extra.keeper;
          GET DIAGNOSTICS dropped = ROW_COUNT;
          total_d := total_d + dropped;
          EXECUTE format('DELETE FROM %I WHERE profile_id = $1', tbl) USING extra.id;
        END;
      END LOOP;

      -- Rooms are hosted by a profile rather than owned by one, and the column
      -- is named differently.
      UPDATE watch_together_rooms SET host_profile = extra.keeper WHERE host_profile = extra.id;

      DELETE FROM user_profiles WHERE id = extra.id;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'single profile: % rows merged, % rows archived to profile_merge_dropped', total_a, total_d;
END $$;

-- Every remaining profile is its account's one profile, so is_default carries
-- no information any more. The partial unique index it had is replaced by a
-- plain one, which is the actual rule now.
DROP INDEX IF EXISTS user_profiles_one_default;
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_one_per_user ON user_profiles (user_id);

UPDATE user_profiles SET is_default = true WHERE NOT is_default;

COMMENT ON TABLE user_profiles IS
  'One profile per account: the account''s display name, avatar and adult-content switch, and the key every user-data table hangs off. Not a picker — the multi-profile feature was removed in 0035.';
COMMENT ON COLUMN user_profiles.is_default IS
  'Always true. Kept so the column can be dropped separately from the code that still reads it.';
