-- A használatlan séma eltávolítása: 16 tábla és 319 jogosultság.
--
-- A TÁBLÁK egy korábbi, nagyobb tervből maradtak (klubok, saját listák,
-- barátságok, értékelés-szavazatok, API-kulcsok, OAuth-azonosítók…): létrejöttek,
-- de egyetlen sor kód sem olvassa vagy írja őket. 2026-09-28-án élesben mind a 16
-- ÜRES volt, és kívülről egyetlen idegen kulcs sem mutatott rájuk (csak egymásra).
--
-- A JOGOSULTSÁGOK közül 319-et a kód soha nem ellenőriz (369-ből 50-et igen). A
-- szerepkör-szerkesztőben viszont ott álltak, nem létező funkciók nevével
-- („piactér", „AI-adatkészlet"…) — mintha lennének. A hozzárendeléseik az idegen
-- kulcs ON DELETE CASCADE-jével mennek. A funkciókapcsolók egyetlen kötelező
-- jogosultsága (analytics.view) használatban van, nincs a listán.
--
-- ADATOT SOHA NEM DOB EL CSENDBEN: ha a 16 tábla közül bármelyikben van sor (egy
-- másik telepítésen előfordulhat), egyiket sem dobja el, csak figyelmeztet. A
-- migrációs futtató tranzakcióban futtatja; egy hiba mindent visszavon.

DO $$
DECLARE
  names text[] := ARRAY['api_keys', 'audio_tracks', 'bookmarks', 'club_members', 'clubs', 'collection_lists', 'custom_list_items', 'custom_lists', 'friendships', 'list_likes', 'oauth_identities', 'profile_merge_dropped', 'review_votes', 'source_mirrors', 'translation_runs', 'user_badges'];
  name text;
  filled text[] := '{}';
  has_rows boolean;
BEGIN
  FOREACH name IN ARRAY names LOOP
    IF to_regclass(name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', name) INTO has_rows;
      IF has_rows THEN filled := filled || name; END IF;
    END IF;
  END LOOP;
  IF array_length(filled, 1) > 0 THEN
    RAISE NOTICE 'a használatlan táblák közül ezekben adat van, ezért egyik sem lett eldobva: %', filled;
  ELSE
    DROP TABLE IF EXISTS api_keys, audio_tracks, bookmarks, club_members, clubs, collection_lists, custom_list_items, custom_lists, friendships, list_likes, oauth_identities, profile_merge_dropped, review_votes, source_mirrors, translation_runs, user_badges;
  END IF;
END $$;

DELETE FROM permissions WHERE slug IN (
  'achievement.create', 'achievement.delete', 'achievement.edit', 'achievement.grant',
  'achievement.revoke', 'achievement.view', 'admin.roles.manage', 'ai_dataset.create',
  'ai_dataset.delete', 'ai_dataset.edit', 'ai_dataset.export', 'ai_dataset.view',
  'ai_model.configure', 'ai_model.deploy', 'ai_model.disable', 'ai_model.view',
  'ai_moderation.configure', 'ai_moderation.review', 'ai_moderation.run', 'ai_moderation.view',
  'ai_recommendation.configure', 'ai_recommendation.run', 'ai_recommendation.view', 'analytics.configure',
  'anime.bulk_edit', 'anime.export', 'anime.feature', 'anime.import',
  'anime.publish', 'anime.restore', 'anime.unpublish', 'api.create',
  'api.delete', 'api_key.create', 'api_key.revoke', 'api_key.view',
  'appeal.approve', 'appeal.reject', 'appeal.review', 'appeal.view',
  'audio_track.create', 'audio_track.delete', 'audio_track.edit', 'audio_track.view',
  'audit.view', 'audit_log.export', 'audit_log.view', 'backup.create',
  'backup.download', 'backup.restore', 'backup.view', 'badge.create',
  'badge.delete', 'badge.edit', 'badge.grant', 'badge.revoke',
  'badge.view', 'ban.issue', 'ban.revoke', 'ban.view',
  'bookmark.create', 'bookmark.delete', 'bookmark.view', 'cache.purge',
  'cache.view', 'character.create', 'character.delete', 'character.edit',
  'character.merge', 'character.view', 'chat.view', 'club.create',
  'club.delete', 'club.edit', 'club.feature', 'club.manage',
  'club.view', 'club_member.add', 'club_member.promote', 'club_member.remove',
  'club_member.view', 'collection.create', 'collection.delete', 'collection.edit',
  'collection.share', 'collection.view', 'comment.create', 'comment.delete',
  'comment.edit', 'comment.hide', 'comment.pin', 'comment.view',
  'custom_list.create', 'custom_list.delete', 'custom_list.edit', 'custom_list.feature',
  'custom_list.share', 'custom_list.view', 'device.revoke', 'device.view',
  'episode.bulk_edit', 'episode.import', 'episode.publish', 'episode.view',
  'error_group.ignore', 'error_group.resolve', 'error_group.view', 'error_log.export',
  'error_log.purge', 'error_log.resolve', 'error_log.view', 'favorite.create',
  'favorite.delete', 'favorite.view', 'feature_flag.create', 'feature_flag.delete',
  'feature_flag.edit', 'feature_flag.view', 'follow.remove', 'follow.view',
  'forum.lock', 'forum.moderate', 'forum.pin', 'forum.view',
  'franchise.create', 'franchise.delete', 'franchise.edit', 'franchise.view',
  'friendship.remove', 'friendship.view', 'genre.create', 'genre.delete',
  'genre.edit', 'genre.view', 'image.delete', 'image.edit',
  'image.set_primary', 'image.upload', 'image.view', 'job.cancel',
  'job.purge', 'job.retry', 'job.view', 'leaderboard.configure',
  'leaderboard.view', 'library_entry.create', 'library_entry.delete', 'library_entry.edit',
  'library_entry.export', 'library_entry.view', 'mapping.delete', 'mapping.edit',
  'mapping.verify', 'mapping.view', 'marketplace_listing.create', 'marketplace_listing.delete',
  'marketplace_listing.edit', 'marketplace_listing.feature', 'marketplace_listing.set_price', 'marketplace_listing.view',
  'message.delete', 'message.moderate', 'message.view', 'migration.run',
  'migration.view', 'moderation_action.create', 'moderation_action.revoke', 'moderation_action.view',
  'mute.issue', 'mute.revoke', 'mute.view', 'notification.delete',
  'notification.send', 'notification.view', 'oauth.manage', 'oauth_app.approve',
  'oauth_app.create', 'oauth_app.delete', 'oauth_app.edit', 'oauth_app.view',
  'page_view.export', 'page_view.purge', 'page_view.view', 'performance_metric.export',
  'performance_metric.purge', 'performance_metric.view', 'permission.grant', 'permission.revoke',
  'permission.view', 'person.create', 'person.delete', 'person.edit',
  'person.merge', 'person.view', 'post.view', 'profile.delete',
  'profile.edit', 'profile.transfer', 'profile.view', 'profile_stats.recalculate',
  'profile_stats.view', 'recommendation.create', 'recommendation.delete', 'recommendation.view',
  'relation.create', 'relation.delete', 'relation.view', 'report.assign',
  'report.dismiss', 'report.escalate', 'report.resolve', 'report.view',
  'review.create', 'review.delete', 'review.edit', 'review.feature',
  'review.hide', 'review.moderate', 'review.view', 'review_vote.delete',
  'review_vote.view', 'role.create', 'role.delete', 'role.edit',
  'role.view', 'search_stat.export', 'search_stat.purge', 'search_stat.view',
  'security_log.export', 'security_log.view', 'session.view', 'setting.edit',
  'setting.view', 'settings.security', 'skip_segment.create', 'skip_segment.delete',
  'skip_segment.edit', 'skip_segment.view', 'skip_segment.vote', 'source_mirror.create',
  'source_mirror.delete', 'source_mirror.edit', 'source_mirror.view', 'spam.review',
  'spam_queue.purge', 'spam_queue.review', 'spam_queue.view', 'staff.assign',
  'staff.delete', 'staff.edit', 'staff.view', 'stats_daily.recompute',
  'stats_daily.view', 'studio.create', 'studio.delete', 'studio.edit',
  'studio.merge', 'studio.view', 'subtitle_track.create', 'subtitle_track.delete',
  'subtitle_track.edit', 'subtitle_track.view', 'suspension.issue', 'suspension.revoke',
  'suspension.view', 'synonym.create', 'synonym.delete', 'synonym.view',
  'tag.create', 'tag.delete', 'tag.edit', 'tag.merge',
  'tag.view', 'title.edit', 'title.view', 'topic.edit',
  'topic.move', 'topic.view', 'translation.run', 'trending.recompute',
  'trending.view', 'user.ban', 'user.create', 'user.delete',
  'user.edit', 'user.export', 'user.impersonate', 'user.list',
  'user.mute', 'user.reset_password', 'user.restore', 'user.suspend',
  'user.verify_email', 'user.view', 'user.warn', 'video.add',
  'video.delete', 'video.edit', 'video.view', 'video_source.create',
  'video_source.delete', 'video_source.report', 'video_source.verify', 'warning.issue',
  'warning.revoke', 'warning.view', 'watch_history.delete', 'watch_history.export',
  'watch_history.view', 'watch_progress.edit', 'watch_progress.reset', 'watch_progress.view',
  'webhook.edit', 'webhook.view', 'webhooks.manage', 'xp.grant',
  'xp.recalculate', 'xp.revoke', 'xp.view'
);
