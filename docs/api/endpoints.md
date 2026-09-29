# Endpoint inventory

> Generated from the routes the API registers — do not edit by hand.
> Regenerate from `apps/api`, with `DATABASE_URL` set:
> `node --experimental-strip-types scripts/list-routes.ts > ../../docs/api/endpoints.md`.
> `test/endpoint-inventory.test.ts`
> fails when this file and the code disagree. What each endpoint does, and
> who may call it, is in [api.md](api.md) and next to the route in the source.


## `/anime`

| Method | Path |
|---|---|
| GET | `/anime/:id` |

## `/dashboard`

| Method | Path |
|---|---|
| GET | `/dashboard` |
| GET | `/dashboard/` |
| GET | `/dashboard/*` |
| GET | `/dashboard/assets/*` |
| GET | `/dashboard/css/*` |

## `/graphql`

| Method | Path |
|---|---|
| GET | `/graphql` |
| POST | `/graphql` |

## `/media`

| Method | Path |
|---|---|
| GET | `/media/*` |

## `/robots.txt`

| Method | Path |
|---|---|
| GET | `/robots.txt` |

## `/sitemap.xml`

| Method | Path |
|---|---|
| GET | `/sitemap.xml` |

## `/v1/admin/analytics`

| Method | Path |
|---|---|
| GET | `/v1/admin/analytics/accounts/:userId` |
| GET | `/v1/admin/analytics/anime` |
| GET | `/v1/admin/analytics/anime/:id` |
| GET | `/v1/admin/analytics/breakdown` |
| GET | `/v1/admin/analytics/dashboard` |
| GET | `/v1/admin/analytics/data-quality` |
| GET | `/v1/admin/analytics/export` |
| GET | `/v1/admin/analytics/overview` |
| GET | `/v1/admin/analytics/performance` |
| GET | `/v1/admin/analytics/providers` |
| GET | `/v1/admin/analytics/realtime` |
| GET | `/v1/admin/analytics/search` |
| GET | `/v1/admin/analytics/summary` |
| GET | `/v1/admin/analytics/system-health` |
| GET | `/v1/admin/analytics/timeseries` |
| GET | `/v1/admin/analytics/users` |
| GET | `/v1/admin/analytics/visitors` |

## `/v1/admin/audit`

| Method | Path |
|---|---|
| GET | `/v1/admin/audit` |
| GET | `/v1/admin/audit/report` |

## `/v1/admin/backups`

| Method | Path |
|---|---|
| GET | `/v1/admin/backups` |
| POST | `/v1/admin/backups` |
| POST | `/v1/admin/backups/restore` |
| PATCH | `/v1/admin/backups/schedule` |
| POST | `/v1/admin/backups/verify` |

## `/v1/admin/badges`

| Method | Path |
|---|---|
| GET | `/v1/admin/badges` |

## `/v1/admin/catalogue`

| Method | Path |
|---|---|
| GET | `/v1/admin/catalogue` |
| POST | `/v1/admin/catalogue` |
| DELETE | `/v1/admin/catalogue/:id` |
| GET | `/v1/admin/catalogue/:id` |
| PATCH | `/v1/admin/catalogue/:id` |
| GET | `/v1/admin/catalogue/:id/episodes` |
| POST | `/v1/admin/catalogue/:id/episodes` |
| POST | `/v1/admin/catalogue/:id/episodes/visibility` |
| POST | `/v1/admin/catalogue/:id/merge` |
| POST | `/v1/admin/catalogue/:id/unlock` |
| GET | `/v1/admin/catalogue/duplicates` |
| DELETE | `/v1/admin/catalogue/episodes/:eid` |
| PATCH | `/v1/admin/catalogue/episodes/:eid` |
| GET | `/v1/admin/catalogue/episodes/:eid/skips` |
| POST | `/v1/admin/catalogue/episodes/:eid/skips` |
| GET | `/v1/admin/catalogue/episodes/:eid/sources` |
| POST | `/v1/admin/catalogue/episodes/:eid/sources` |
| GET | `/v1/admin/catalogue/episodes/:eid/subtitles` |
| POST | `/v1/admin/catalogue/episodes/:eid/subtitles` |
| POST | `/v1/admin/catalogue/episodes/visibility/all` |
| GET | `/v1/admin/catalogue/metadata` |
| GET | `/v1/admin/catalogue/metadata/conflicts` |
| POST | `/v1/admin/catalogue/metadata/conflicts/:id/resolve` |
| POST | `/v1/admin/catalogue/metadata/runs` |
| POST | `/v1/admin/catalogue/metadata/runs/:id/cancel` |
| DELETE | `/v1/admin/catalogue/skips/:sid` |
| DELETE | `/v1/admin/catalogue/sources/:sid` |
| PATCH | `/v1/admin/catalogue/sources/:sid` |
| DELETE | `/v1/admin/catalogue/subtitles/:sid` |

## `/v1/admin/config`

| Method | Path |
|---|---|
| GET | `/v1/admin/config` |
| PATCH | `/v1/admin/config/flags/:key` |
| PATCH | `/v1/admin/config/settings/:key` |

## `/v1/admin/edge`

| Method | Path |
|---|---|
| GET | `/v1/admin/edge` |
| POST | `/v1/admin/edge/bans` |
| DELETE | `/v1/admin/edge/bans/:id` |
| PATCH | `/v1/admin/edge/config` |
| GET | `/v1/admin/edge/defaults` |
| GET | `/v1/admin/edge/ip/:ip` |
| GET | `/v1/admin/edge/rules` |

## `/v1/admin/errors`

| Method | Path |
|---|---|
| GET | `/v1/admin/errors` |
| GET | `/v1/admin/errors/:id` |
| PATCH | `/v1/admin/errors/:id` |
| GET | `/v1/admin/errors/by-request/:requestId` |

## `/v1/admin/maintenance`

| Method | Path |
|---|---|
| GET | `/v1/admin/maintenance` |
| PUT | `/v1/admin/maintenance` |
| POST | `/v1/admin/maintenance/bypass` |
| DELETE | `/v1/admin/maintenance/bypass/:id` |
| POST | `/v1/admin/maintenance/preview` |

## `/v1/admin/monitoring`

| Method | Path |
|---|---|
| GET | `/v1/admin/monitoring/alerts` |
| GET | `/v1/admin/monitoring/components` |
| GET | `/v1/admin/monitoring/current` |
| GET | `/v1/admin/monitoring/diagnostics` |
| POST | `/v1/admin/monitoring/diagnostics` |
| GET | `/v1/admin/monitoring/diagnostics/:id` |
| GET | `/v1/admin/monitoring/history` |
| GET | `/v1/admin/monitoring/queues` |
| GET | `/v1/admin/monitoring/thresholds` |

## `/v1/admin/providers`

| Method | Path |
|---|---|
| GET | `/v1/admin/providers` |
| PATCH | `/v1/admin/providers/:slug` |
| GET | `/v1/admin/providers/:slug/events` |

## `/v1/admin/reports`

| Method | Path |
|---|---|
| GET | `/v1/admin/reports` |
| POST | `/v1/admin/reports/:id/resolve` |

## `/v1/admin/roles`

| Method | Path |
|---|---|
| GET | `/v1/admin/roles` |
| POST | `/v1/admin/roles/:roleId/permissions` |
| GET | `/v1/admin/roles/permissions` |

## `/v1/admin/security`

| Method | Path |
|---|---|
| GET | `/v1/admin/security` |
| POST | `/v1/admin/security/:key` |
| PATCH | `/v1/admin/security/limits` |
| GET | `/v1/admin/security/posture` |
| POST | `/v1/admin/security/revoke-all-sessions` |

## `/v1/admin/themes`

| Method | Path |
|---|---|
| GET | `/v1/admin/themes` |
| POST | `/v1/admin/themes` |
| DELETE | `/v1/admin/themes/:id` |
| PATCH | `/v1/admin/themes/:id` |

## `/v1/admin/translations`

| Method | Path |
|---|---|
| GET | `/v1/admin/translations/anime/:id` |
| DELETE | `/v1/admin/translations/anime/:id/:language` |
| PUT | `/v1/admin/translations/anime/:id/:language` |
| PUT | `/v1/admin/translations/episode/:id/:language` |
| GET | `/v1/admin/translations/progress` |
| GET | `/v1/admin/translations/queue` |

## `/v1/admin/users`

| Method | Path |
|---|---|
| GET | `/v1/admin/users` |
| GET | `/v1/admin/users/:id` |
| POST | `/v1/admin/users/:id/roles` |
| POST | `/v1/admin/users/:id/sessions/revoke` |
| POST | `/v1/admin/users/:id/status` |

## `/v1/admin/webhooks`

| Method | Path |
|---|---|
| GET | `/v1/admin/webhooks` |
| POST | `/v1/admin/webhooks` |
| DELETE | `/v1/admin/webhooks/:id` |
| PATCH | `/v1/admin/webhooks/:id` |
| GET | `/v1/admin/webhooks/:id/deliveries` |
| POST | `/v1/admin/webhooks/:id/test` |
| GET | `/v1/admin/webhooks/events` |

## `/v1/analytics`

| Method | Path |
|---|---|
| POST | `/v1/analytics/event` |
| POST | `/v1/analytics/view` |

## `/v1/anime`

| Method | Path |
|---|---|
| GET | `/v1/anime` |
| GET | `/v1/anime/:id` |
| GET | `/v1/anime/:id/characters` |
| GET | `/v1/anime/:id/episodes` |
| GET | `/v1/anime/:id/franchise` |
| GET | `/v1/anime/:id/recommendations` |
| GET | `/v1/anime/:id/relations` |
| GET | `/v1/anime/:id/staff` |
| GET | `/v1/anime/by-anilist` |
| GET | `/v1/anime/by-anilist/:anilistId` |
| GET | `/v1/anime/episodes/:eid/skips` |
| GET | `/v1/anime/episodes/:eid/sources` |
| GET | `/v1/anime/episodes/:eid/subtitles` |
| POST | `/v1/anime/resolve` |
| GET | `/v1/anime/schedule` |
| GET | `/v1/anime/search` |
| GET | `/v1/anime/suggest` |

## `/v1/announcements`

| Method | Path |
|---|---|
| GET | `/v1/announcements` |
| POST | `/v1/announcements` |
| DELETE | `/v1/announcements/:id` |
| PATCH | `/v1/announcements/:id` |
| POST | `/v1/announcements/:id/dismiss` |
| GET | `/v1/announcements/all` |

## `/v1/auth`

| Method | Path |
|---|---|
| POST | `/v1/auth/forgot` |
| POST | `/v1/auth/login` |
| POST | `/v1/auth/logout` |
| POST | `/v1/auth/logout-all` |
| DELETE | `/v1/auth/me` |
| POST | `/v1/auth/password` |
| GET | `/v1/auth/permissions` |
| POST | `/v1/auth/refresh` |
| POST | `/v1/auth/register` |
| POST | `/v1/auth/reset` |
| POST | `/v1/auth/ws-ticket` |

## `/v1/changelog`

| Method | Path |
|---|---|
| GET | `/v1/changelog` |
| POST | `/v1/changelog` |
| DELETE | `/v1/changelog/:id` |
| PATCH | `/v1/changelog/:id` |
| GET | `/v1/changelog/:version` |
| GET | `/v1/changelog/all` |

## `/v1/chat`

| Method | Path |
|---|---|
| DELETE | `/v1/chat/messages/:id` |
| GET | `/v1/chat/rooms` |
| POST | `/v1/chat/rooms/:slug/join` |
| GET | `/v1/chat/rooms/:slug/messages` |

## `/v1/comments`

| Method | Path |
|---|---|
| GET | `/v1/comments` |
| POST | `/v1/comments` |
| DELETE | `/v1/comments/:id` |
| POST | `/v1/comments/:id/like` |
| GET | `/v1/comments/recent` |

## `/v1/config`

| Method | Path |
|---|---|
| GET | `/v1/config` |

## `/v1/discord`

| Method | Path |
|---|---|
| GET | `/v1/discord/guilds` |
| GET | `/v1/discord/guilds/:guildId/activity` |
| GET | `/v1/discord/guilds/:guildId/audit` |
| GET | `/v1/discord/guilds/:guildId/channels` |
| GET | `/v1/discord/guilds/:guildId/channels/:channelId/diagnose` |
| POST | `/v1/discord/guilds/:guildId/commands/register` |
| GET | `/v1/discord/guilds/:guildId/health` |
| GET | `/v1/discord/guilds/:guildId/message-failures` |
| GET | `/v1/discord/guilds/:guildId/notifications` |
| GET | `/v1/discord/guilds/:guildId/overview` |
| GET | `/v1/discord/guilds/:guildId/persistent-messages` |
| POST | `/v1/discord/guilds/:guildId/persistent-messages` |
| DELETE | `/v1/discord/guilds/:guildId/persistent-messages/:id` |
| PATCH | `/v1/discord/guilds/:guildId/persistent-messages/:id` |
| GET | `/v1/discord/guilds/:guildId/persistent-messages/:id/history` |
| GET | `/v1/discord/guilds/:guildId/persistent-messages/:id/preview` |
| POST | `/v1/discord/guilds/:guildId/persistent-messages/:id/recreate` |
| POST | `/v1/discord/guilds/:guildId/persistent-messages/:id/resync` |
| GET | `/v1/discord/guilds/:guildId/roles` |
| GET | `/v1/discord/guilds/:guildId/setup/audit` |
| GET | `/v1/discord/guilds/:guildId/setup/preview` |
| POST | `/v1/discord/guilds/:guildId/setup/repair` |
| POST | `/v1/discord/guilds/:guildId/setup/reset` |
| POST | `/v1/discord/guilds/:guildId/setup/reset/prepare` |
| POST | `/v1/discord/guilds/:guildId/setup/resync` |
| POST | `/v1/discord/guilds/:guildId/setup/run` |
| GET | `/v1/discord/guilds/:guildId/setup/status` |
| GET | `/v1/discord/guilds/:guildId/welcome` |
| PATCH | `/v1/discord/guilds/:guildId/welcome` |
| GET | `/v1/discord/guilds/:guildId/welcome/log` |
| GET | `/v1/discord/guilds/:guildId/welcome/preview` |
| POST | `/v1/discord/guilds/:guildId/welcome/test` |
| GET | `/v1/discord/oauth/callback` |
| DELETE | `/v1/discord/oauth/link` |
| GET | `/v1/discord/oauth/link` |
| POST | `/v1/discord/oauth/start` |
| GET | `/v1/discord/status` |

## `/v1/forum`

| Method | Path |
|---|---|
| GET | `/v1/forum` |
| POST | `/v1/forum` |
| DELETE | `/v1/forum/:id` |
| PATCH | `/v1/forum/:id` |
| GET | `/v1/forum/:slug` |
| GET | `/v1/forum/:slug/topics` |
| POST | `/v1/forum/:slug/topics` |
| DELETE | `/v1/forum/posts/:id` |
| PATCH | `/v1/forum/posts/:id` |
| DELETE | `/v1/forum/topics/:id` |
| GET | `/v1/forum/topics/:id` |
| PATCH | `/v1/forum/topics/:id` |
| GET | `/v1/forum/topics/:id/posts` |
| POST | `/v1/forum/topics/:id/posts` |

## `/v1/health`

| Method | Path |
|---|---|
| GET | `/v1/health` |
| GET | `/v1/health/ready` |

## `/v1/me/achievements`

| Method | Path |
|---|---|
| GET | `/v1/me/achievements` |

## `/v1/me/continue-watching`

| Method | Path |
|---|---|
| GET | `/v1/me/continue-watching` |

## `/v1/me/favorites`

| Method | Path |
|---|---|
| GET | `/v1/me/favorites` |
| DELETE | `/v1/me/favorites/:animeId` |
| PUT | `/v1/me/favorites/:animeId` |

## `/v1/me/library`

| Method | Path |
|---|---|
| GET | `/v1/me/library` |
| DELETE | `/v1/me/library/:animeId` |
| PUT | `/v1/me/library/:animeId` |

## `/v1/me/notifications`

| Method | Path |
|---|---|
| GET | `/v1/me/notifications` |
| POST | `/v1/me/notifications/read` |

## `/v1/me/progress`

| Method | Path |
|---|---|
| PATCH | `/v1/me/progress/:episodeId` |

## `/v1/me/settings`

| Method | Path |
|---|---|
| DELETE | `/v1/me/settings` |
| GET | `/v1/me/settings` |
| PATCH | `/v1/me/settings` |

## `/v1/me/stats`

| Method | Path |
|---|---|
| GET | `/v1/me/stats` |

## `/v1/profiles`

| Method | Path |
|---|---|
| GET | `/v1/profiles/artwork` |
| GET | `/v1/profiles/me` |
| PATCH | `/v1/profiles/me` |

## `/v1/reports`

| Method | Path |
|---|---|
| POST | `/v1/reports` |

## `/v1/status`

| Method | Path |
|---|---|
| GET | `/v1/status` |

## `/v1/themes`

| Method | Path |
|---|---|
| GET | `/v1/themes` |

## `/v1/w2g`

| Method | Path |
|---|---|
| POST | `/v1/w2g` |
| DELETE | `/v1/w2g/:code` |
| GET | `/v1/w2g/:code` |

## `/ws`

| Method | Path |
|---|---|
| GET | `/ws` |
