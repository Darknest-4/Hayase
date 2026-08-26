# Yume — API reference

> **Read this first.** This document was written as a specification, ahead of
> the code, and parts of it still describe endpoints that do not exist. Rows
> marked **⏳** are specified and unimplemented; everything else is live and
> exercised by the integration tests. The authoritative, source-verified
> inventory is `status.html` in the repository root — if the two disagree,
> that one is right.

One service, two protocols over the same service layer:

- **REST** under `/v1/*` — canonical, fully specified in OpenAPI
  (generated from route schemas, served at `/v1/docs`).
- **GraphQL** at `/graphql` — implemented with mercurius; GraphiQL is
  served in development. Child collections resolve through batched
  loaders (one query per field per request). Auth is optional per
  request: a bearer token unlocks `me` and `viewerEntry`, and
  `X-Profile-Id` scopes profile data (ownership verified).

## Conventions

- **Auth**: `Authorization: Bearer <access JWT>` (15 min) obtained via
  `/v1/auth/*`; refresh with the rotating refresh token. Developer API uses
  `X-Api-Key` with scoped keys.
- **Profiles**: user-scoped data is addressed per profile:
  `X-Profile-Id: <uuid>` header (validated to belong to the token's user).
- **Pagination**: cursor-based — `?limit=25&cursor=<opaque>`; responses
  return `{ data, nextCursor }`. No offsets on large sets.
- **Errors**: RFC 9457 problem+json: `{ type, title, status, detail }`.
- **Rate limits**: per-user 300 req/min, per-key configurable, per-IP 60
  unauthenticated; `429` + `Retry-After`.
- **Idempotency**: mutating endpoints accept `Idempotency-Key`.

## REST endpoints

### Auth & account
| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/register` | email+username+password → account (email verify job) |
| POST | `/v1/auth/login` | credentials (+ TOTP if enabled) → access + refresh |
| POST | `/v1/auth/refresh` | rotate refresh token → new pair |
| POST | `/v1/auth/logout` | revoke session |
| GET/POST/DELETE | `/v1/auth/oauth/:provider` | link/unlink AniList, MAL, Discord… |
| GET/PATCH | `/v1/account` | account (email, password, MFA) |
| GET | `/v1/account/sessions` · DELETE `/:id` | active sessions/devices |
| GET/POST | `/v1/account/api-keys` · DELETE `/:id` | developer keys |

### Profiles & settings
| Method | Path | Description |
|---|---|---|
| GET/POST | `/v1/profiles` | list/create watch profiles |
| GET/PATCH/DELETE | `/v1/profiles/:id` | manage profile |
| GET/PUT | `/v1/profiles/:id/settings` | bulk settings (key→jsonb) |

### Catalogue
| Method | Path | Description |
|---|---|---|
| GET | `/v1/anime` | browse: `?season&year&genre&tag&format&status&sort&…` |
| GET | `/v1/anime/trending` · `/popular` · `/schedule` | curated rails; schedule takes `?from&to` |
| GET | `/v1/anime/:id` | full detail (titles, genres, companies, stats) |
| GET | `/v1/anime/:id/episodes` · `/relations` · `/characters` · `/staff` · `/recommendations` · `/reviews` | sub-resources |
| GET | `/v1/anime/search` | tiered search: `?q` plus `&genre&year&season&format&status&sort&limit&offset&nsfw`. Matches canonical, romaji/english/native and synonym titles; each row reports its `tier` and `matched_title`. See [`search.md`](./search.md) |
| GET | `/v1/anime/suggest` | quick-search box: `?q&limit&nsfw`, minimal payload, no telemetry |
| PATCH | `/v1/anime/:id` | edit metadata (`anime.edit` permission; audited) |

### Playback & library
| Method | Path | Description |
|---|---|---|
| ⏳ GET | `/v1/episodes/:id/sources` | resolved sources + mirrors + tracks + skip segments |
| PATCH | `/v1/me/progress/:episodeId` | `{positionSec, durationSec, completed}` — `completed` is the client's measured verdict; without it the server falls back to position ≥ 85% |
| GET | `/v1/me/continue-watching` | in-progress rail, with the AniList id so a client can map it back |
| ⏳ GET | `/v1/me/history` | watch history (cursor over partitions) |
| GET/PUT/DELETE | `/v1/me/library/:animeId` | list entry (status/progress/score) |
| GET | `/v1/me/library` | `?status=WATCHING…` |
| GET/PUT/DELETE | `/v1/me/favorites` · `/favorites/:animeId` | hearts; anime only so far, the table is typed for more |
| ⏳ GET/POST | `/v1/me/lists` + item/collection CRUD | custom lists & collections |
| ⏳ GET/POST | `/v1/me/bookmarks` | in-episode bookmarks |
| GET | `/v1/me/stats` | profile statistics (`profile_stats`), recomputed when older than 2 min |
| GET | `/v1/me/notifications` · POST `/notifications/read` | the account's inbox (the notify worker writes it) |
| GET | `/v1/me/achievements` | catalogue + this profile's progress; grants anything newly earned |
| ⏳ GET | `/v1/me/recommendations` | personalised (Redis-cached model output) |

### Community
| Method | Path | Description |
|---|---|---|
| GET/POST | `/v1/comments` | `?subjectType&subjectId`; POST validates `community.post` |
| PATCH/DELETE | `/v1/comments/:id` · POST `/:id/like` | edit window, like toggle |
| ⏳ GET | `/v1/forums` · `/v1/forums/:id/topics` | forum tree |
| ⏳ POST | `/v1/topics` · GET `/v1/topics/:id/posts` · POST `/v1/posts` | threads |
| ⏳ GET/POST | `/v1/chats` · `/v1/chats/:id/messages` | DMs/groups — the WS channel exists, no REST and no client |
| ⏳ GET/POST | `/v1/clubs` · membership subroutes | clubs |
| ⏳ POST/DELETE | `/v1/users/:id/follow` · `/v1/friends/:id` | social graph |
| POST | `/v1/reports` | report any subject |
| ⏳ POST | `/v1/reviews` · votes subroute | long-form reviews |
| POST | `/v1/w2g` · GET `/v1/w2g/:code` | watch-together rooms (sync over WS) |

### Extension store & developer portal
| Method | Path | Description |
|---|---|---|
| GET | `/v1/extensions` | store browse `?type&sort=installs|rating|new` |
| GET | `/v1/extensions/:slug` | listing detail (`/reviews` ⏳) |
| POST | `/v1/extensions/:slug/install` · PATCH · DELETE | install, configure options, uninstall |
| GET | `/v1/extensions/installed` | installed set + permissions + option schema |
| POST | `/v1/dev/extensions` | create listing (`extensions.publish`) |
| POST | `/v1/dev/extensions/:slug/packages` | upload the raw source; the server hashes it |
| POST | `/v1/dev/repositories/import` | import an external index (`{url, dryRun}`); the server fetches and hashes each package |
| POST | `/v1/dev/extensions/:slug/versions` | publish a version against an uploaded package → review pipeline |
| GET | `/v1/dev/extensions/:slug/analytics` | installs/errors dashboards |
| POST | `/v1/admin/extensions/:slug/versions/:id/review` | approve/reject (`extensions.review`) |

### Notifications, admin, misc
| Method | Path | Description |
|---|---|---|
| GET | `/v1/notifications` · POST `/read` | inbox; WS pushes live |
| GET | `/v1/admin/users` · POST `/:id/ban` etc. | user management (`admin.users.manage`) |
| GET | `/v1/admin/reports` · POST actions | moderation queue |
| GET | `/v1/admin/analytics/*` | views/watch/search/perf dashboards |
| GET/POST/PATCH/DELETE | `/v1/admin/webhooks` | outbound webhooks (`admin.webhooks.manage`) |
| POST | `/v1/admin/webhooks/:id/test` | fire a test event synchronously |
| GET | `/v1/admin/webhooks/events` · `/:id/deliveries` | event catalog + delivery log |
| GET/POST/PATCH/DELETE | `/v1/admin/catalogue` · `/:id` · `/:id/episodes` | catalogue management incl. hidden entries (`anime.*` / `episode.*`) |
| POST | `/v1/admin/catalogue/:id/unlock` | release fields back to the importers (`anime.edit`) |
| GET | `/v1/admin/catalogue/duplicates` | proposed duplicate pairs (`anime.merge`) |
| POST | `/v1/admin/catalogue/:id/merge` | merge another entry into this one — irreversible (`anime.merge`) |

### Outbound webhooks
Admin-configured endpoints subscribe per-event. Discord URLs receive rich
embeds; generic JSON endpoints receive `{event, data, at}` signed with
`X-Yume-Signature: sha256=…` (HMAC of the body using the webhook secret)
and `X-Yume-Event`. Delivery runs through the job queue (retries with
backoff); 20 consecutive failures auto-disable the hook. Events:
`user.registered`, `user.moderated`, `comment.created`, `report.created`,
`report.resolved`, `extension.submitted`, `extension.reviewed`,
`extension.installed`, `w2g.room_created`, `stats.daily`, `stats.trending`,
`catalogue.imported`, `job.failed`, `webhook.test`.
| GET | `/v1/health` · `/v1/version` | liveness, build info |

### WebSocket (`/ws`)
Authenticated socket multiplexing channels: `notifications`,
`chat:{chatId}`, `w2g:{roomId}` (play/pause/seek/position sync),
`presence`. Backed by Redis pub/sub so any API instance can serve any
socket.

## GraphQL schema (core)

```graphql
type Query {
  anime(id: ID!): Anime
  animePage(filter: AnimeFilter, sort: AnimeSort, cursor: String, limit: Int = 25): AnimePage!
  search(query: String!, mode: SearchMode = FULLTEXT): [SearchResult!]!
  schedule(from: DateTime!, to: DateTime!): [AiringEpisode!]!
  me: Viewer
  extension(slug: String!): Extension
  extensionPage(type: ExtensionType, sort: ExtensionSort, cursor: String): ExtensionPage!
}

type Anime {
  id: ID!
  titles: Titles!
  synonyms: [String!]!
  format: Format!  status: Status!  season: Season  seasonYear: Int
  episodes(cursor: String): EpisodePage!
  episodeCount: Int  duration: Int
  synopsis: String
  genres: [Genre!]!  tags: [RankedTag!]!
  studios: [Company!]!  staff: [StaffCredit!]!  characters: [CharacterCredit!]!
  relations: [Relation!]!  recommendations(limit: Int = 12): [Anime!]!
  images: Images!  videos: [Video!]!
  stats: AnimeStats!          # score, popularity, trending
  nextAiring: AiringEpisode
  viewerEntry: LibraryEntry   # null unless authenticated
  mappings: ExternalIds!
}

type Viewer {
  profile: Profile!
  library(status: LibraryStatus): [LibraryEntry!]!
  continueWatching: [WatchProgress!]!
  history(cursor: String): HistoryPage!
  favorites(type: FavoriteType): [Favorite!]!
  lists: [CustomList!]!
  stats: ProfileStats!
  notifications(unreadOnly: Boolean): [Notification!]!
  recommendations: [Anime!]!
  installedExtensions: [ExtensionInstall!]!
}

type Mutation {
  saveLibraryEntry(animeId: ID!, input: LibraryEntryInput!): LibraryEntry!
  deleteLibraryEntry(animeId: ID!): Boolean!
  saveProgress(episodeId: ID!, positionSec: Float!, durationSec: Float): WatchProgress!
  toggleFavorite(type: FavoriteType!, id: ID!): Boolean!
  createComment(subject: SubjectRef!, body: String!, parentId: ID, spoiler: Boolean): Comment!
  toggleCommentLike(id: ID!): Comment!
  createReview(animeId: ID!, input: ReviewInput!): Review!
  installExtension(slug: String!): ExtensionInstall!
  markNotificationsRead(ids: [ID!]!): Int!
}
```

Field resolvers use per-request DataLoaders keyed on the same services the
REST routes call — no N+1s, no duplicate logic.
