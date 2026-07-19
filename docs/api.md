# Yume — API reference

One service, two protocols over the same service layer:

- **REST** under `/v1/*` — canonical, fully specified in OpenAPI
  (generated from route schemas, served at `/v1/docs`).
- **GraphQL** at `/graphql` — for clients that want to compose views
  (the web app's detail pages), schema below.

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
| GET | `/v1/search` | OpenSearch: `?q&mode=fulltext|autocomplete|semantic` |
| PATCH | `/v1/anime/:id` | edit metadata (`anime.edit` permission; audited) |

### Playback & library
| Method | Path | Description |
|---|---|---|
| GET | `/v1/episodes/:id/sources` | resolved sources + mirrors + tracks + skip segments |
| PATCH | `/v1/episodes/:id/progress` | `{positionSec, durationSec}` — write-behind |
| GET | `/v1/me/continue-watching` | in-progress rail (Redis-cached) |
| GET | `/v1/me/history` | watch history (cursor over partitions) |
| GET/PUT/DELETE | `/v1/me/library/:animeId` | list entry (status/progress/score) |
| GET | `/v1/me/library` | `?status=WATCHING…` |
| GET/POST/DELETE | `/v1/me/favorites` | hearts (`?type=anime|character|…`) |
| GET/POST | `/v1/me/lists` + item/collection CRUD | custom lists & collections |
| GET/POST | `/v1/me/bookmarks` | in-episode bookmarks |
| GET | `/v1/me/stats` | profile statistics (profile_stats) |
| GET | `/v1/me/recommendations` | personalised (Redis-cached model output) |

### Community
| Method | Path | Description |
|---|---|---|
| GET/POST | `/v1/comments` | `?subjectType&subjectId`; POST validates `community.post` |
| PATCH/DELETE | `/v1/comments/:id` · POST `/:id/like` | edit window, like toggle |
| GET | `/v1/forums` · `/v1/forums/:id/topics` | forum tree |
| POST | `/v1/topics` · GET `/v1/topics/:id/posts` · POST `/v1/posts` | threads |
| GET/POST | `/v1/chats` · `/v1/chats/:id/messages` | DMs/groups (WS for live) |
| GET/POST | `/v1/clubs` · membership subroutes | clubs |
| POST/DELETE | `/v1/users/:id/follow` · `/v1/friends/:id` | social graph |
| POST | `/v1/reports` | report any subject |
| POST | `/v1/reviews` · votes subroute | long-form reviews |
| POST | `/v1/w2g` · GET `/v1/w2g/:code` | watch-together rooms (sync over WS) |

### Extension store & developer portal
| Method | Path | Description |
|---|---|---|
| GET | `/v1/extensions` | store browse `?type&sort=installs|rating|new` |
| GET | `/v1/extensions/:slug` · `/versions` · `/reviews` | listing detail |
| POST | `/v1/extensions/:slug/install` · DELETE | install/uninstall (records version) |
| GET | `/v1/me/extensions` | installed set + pending updates |
| POST | `/v1/dev/extensions` | create listing (`extensions.publish`) |
| POST | `/v1/dev/extensions/:slug/versions` | upload package → review pipeline |
| GET | `/v1/dev/extensions/:slug/analytics` | installs/errors dashboards |
| POST | `/v1/admin/extensions/:slug/versions/:id/review` | approve/reject (`extensions.review`) |

### Notifications, admin, misc
| Method | Path | Description |
|---|---|---|
| GET | `/v1/notifications` · POST `/read` | inbox; WS pushes live |
| GET | `/v1/admin/users` · POST `/:id/ban` etc. | user management (`admin.users.manage`) |
| GET | `/v1/admin/reports` · POST actions | moderation queue |
| GET | `/v1/admin/analytics/*` | views/watch/search/perf dashboards |
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
