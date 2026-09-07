-- Remove the extension platform.
--
-- ---------------------------------------------------------------------------
-- What it was, and why it is going
-- ---------------------------------------------------------------------------
-- A store with reviews and ratings, a developer portal, a manifest validator, a
-- content-addressed package store on disk, a sandboxed Web Worker with a host
-- allowlist and a request proxy, a review queue with its own worker, and a
-- permission catalogue of thirty entries for it. All of it so that a handful of
-- features could be delivered as packages instead of as code.
--
-- Every one of those features is now part of the platform: themes are a table,
-- skip intervals and subtitle tracks are catalogue data, cast and staff come
-- from the AniList passes, the library syncs server-side, and video sources are
-- registered by the operator. What is left of the machinery is machinery.
--
-- ---------------------------------------------------------------------------
-- What this deletes
-- ---------------------------------------------------------------------------
-- Extension rows, versions, package metadata, installs, store reviews and the
-- developer accounts. That is the point of the change rather than a side
-- effect: the code that reads them is gone in the same commit, and leaving the
-- tables would be exactly the dead schema this project has spent several
-- migrations discovering the cost of.
--
-- Nothing outside the platform is touched. In particular the catalogue — the
-- anime, episodes, images, mappings and everything hanging off them — is not
-- referenced here at all.

-- Reports and comments could point at an extension or a store review. Those
-- subjects no longer exist, so the rows about them are removed before the
-- tables they name; a moderation queue full of reports about deleted things is
-- worse than an empty one.
DELETE FROM reports  WHERE subject_type IN ('extension', 'extension_review');
DELETE FROM comments WHERE subject_type = 'extension';
DELETE FROM moderation_actions WHERE subject_type IN ('extension', 'extension_review');
DELETE FROM jobs WHERE queue = 'ext-review';

-- Webhook subscriptions to events that will never fire again. The array is
-- rewritten rather than the webhook deleted: an operator who also subscribed to
-- catalogue events should keep those.
UPDATE webhooks
   SET events = ARRAY(SELECT unnest(events) EXCEPT SELECT unnest(ARRAY['extension.submitted', 'extension.reviewed', 'extension.installed']))
 WHERE events && ARRAY['extension.submitted', 'extension.reviewed', 'extension.installed'];

DROP TABLE IF EXISTS extension_events CASCADE;
DROP TABLE IF EXISTS extension_installs CASCADE;
DROP TABLE IF EXISTS extension_reviews CASCADE;
DROP TABLE IF EXISTS extension_permissions CASCADE;
DROP TABLE IF EXISTS extension_versions CASCADE;
DROP TABLE IF EXISTS extensions CASCADE;
DROP TABLE IF EXISTS extension_developers CASCADE;

-- The two pages are gone, so the flags that gated them describe nothing.
DELETE FROM feature_flags WHERE key IN ('page.extensions', 'page.developer');

-- Thirty permissions for a surface that no longer exists. `theme.publish` is
-- deliberately not in this list: it is the one that outlived the platform,
-- because the theme editor took the feature over.
DELETE FROM role_permissions WHERE permission_id IN (
  SELECT id FROM permissions
   WHERE slug LIKE 'extension%' OR slug LIKE 'developer%' OR slug LIKE 'dev.%'
);
DELETE FROM permissions
 WHERE slug LIKE 'extension%' OR slug LIKE 'developer%' OR slug LIKE 'dev.%';
