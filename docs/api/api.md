# Yume — API reference

What the API actually does, as of the code in this repository. Two companions:

- **[endpoints.md](endpoints.md)** — every route the server registers, generated
  from the running app. A test fails when it falls out of date, so it is the
  authoritative list.
- The route's own source file — each handler carries its validation schema and
  a comment on who may call it and why.

There is **no OpenAPI document**. The route schemas exist (Fastify validates
every body and query against them) but nothing generates a published spec from
them yet.

One service, two protocols over the same rules:

- **REST** under `/v1/*` — what the web client uses.
- **GraphQL** at `/graphql` — the same visibility rules and the same library
  services as REST (see below). GraphiQL is served only outside production, and
  introspection is disabled in production.

## Conventions

- **Auth.** `Authorization: Bearer <access JWT>` — 15 minutes, bound to the
  session it was minted under. The refresh token lives **only** in the
  HttpOnly cookie `yume_refresh` (path `/v1/auth`, `SameSite=Strict`); it is
  not in any response body. `POST /v1/auth/refresh` rotates it: the old
  session is retired in the same statement that claims it. Presenting a token
  whose session was rotated a moment ago (another tab) answers 401 with
  `code: "refresh_rotated"` and leaves the cookie alone — retry once;
  presenting it long after (`REFRESH_REUSE_GRACE_MS`, 30 s) is treated as a
  stolen copy and ends every session of the account.
- **Revocation.** Sign-out, sign-out-everywhere, a password change, a ban and
  a deleted account take effect on the next request on REST, GraphQL and open
  WebSockets (sockets are re-checked every minute).
- **Profiles.** User-scoped data is addressed per profile with
  `X-Profile-Id: <uuid>`, checked to belong to the caller. A header that is
  not one of the caller's profiles — malformed included — is 403.
- **Private instances.** With `require_login` on, every `/v1` and `/graphql`
  request needs a live token except `/v1/health`, `/v1/config`, `/v1/auth/*`,
  `/v1/status`, `/v1/analytics/view` and the Discord OAuth callback. The
  decision is made on the path the router matches, so encoded spellings
  (`/%761/…`) are gated the same way.
- **Read-only mode** refuses writes with 503 + `Retry-After`; auth, the admin
  config/security/backup/maintenance switches stay writable. On GraphQL,
  queries keep working and mutations are refused (`READ_ONLY`).
- **Visibility.** A `hidden` title does not exist anywhere — detail, lists,
  search, relations, schedule, GraphQL — and an id of one answers exactly like
  an unknown id. `unlisted` is reachable by id but never listed.
- **Pagination.** Browse (`/v1/anime`) and the library (`/v1/me/library`) are
  keyset-paginated with an opaque cursor; search takes `limit` + `offset`
  (offset ≤ 1000); GraphQL `animePage` pages by offset up to 10 000.
- **Errors.** RFC 9457 problem+json, with `instance` (the request id) and a
  `code` — see below. A value Postgres cannot read (a malformed uuid, an
  impossible date) is 400, never 500.
- **Rate limits.** Per client address: global 1200/min, sign-in/registration
  10 per 15 min, token refresh 60 per 15 min, community writes 60 per 5 min
  (the admin panel can change these at runtime). `429` + `Retry-After`.
  Members may open 3 forum boards a day; XP is awarded for at most 100
  finished episodes a day.

## Notes per area

### Profiles

The profile picture and the profile banner are chosen from the catalogue. The
`PATCH` body carries `avatarAnimeId` / `bannerAnimeId` — a title's uuid, or
`null` to clear it — and the server resolves the image from `anime_images`,
storing both the resolved URL (`avatar_key`, `banner_key`) and the title it came
from (`avatar_anime_id`, and `avatar_from` on read). A client cannot post an
image address: letting it do so would make every profile an arbitrary remote
request performed by everyone who loads a page with that person's name on it.
A title with no artwork answers 404 rather than storing an empty picture.

`GET /v1/profiles/artwork` answers `{ data, source }`, where `source` is
`library` (the caller's own shelf, the default when they have watched
anything), `search` (a `q` was given) or `popular` (the fallback for an empty
library). Every row has an image, so nothing in the grid can be picked and then
fail to appear.

### Catalogue

- `GET /v1/anime/schedule?from&to` — ISO timestamps, at most 62 days apart
  (400 beyond that).
- `GET /v1/anime/search` — tiered search over canonical, romaji/english/native
  and synonym titles; each row reports its `tier` and `matched_title`. See
  [`../database/search.md`](../database/search.md).
- `GET /v1/anime/:id/{relations,franchise,characters,staff,recommendations}` —
  only listed titles appear in relations and recommendations; a hidden id gets
  an empty list, like an unknown one.
- `POST /v1/anime/resolve` (signed in) — creates a hidden stub for an AniList id
  the catalogue does not have yet, at most `ANIME_STUB_DAILY_MAX` a day per
  account. The metadata importer fills it; an editor publishes it.

### Library and progress

- `PUT /v1/me/library/:animeId` — `{status, progress, score (0–10), notes}`;
  reaching the last episode without a status completes the entry. A hidden
  title is 404.
- `PATCH /v1/me/progress/:episodeId` — `{positionSec, durationSec, completed}`.
  `completed` is the client's measured verdict (accepted from a minute watched,
  or half of the known duration); without it the server completes at 85%.
  Continues or opens the watch-history session (six-hour window) and awards XP
  once per finished session, in one transaction.
- `GET /v1/me/stats` — `profile_stats`, recomputed when older than two minutes.
- `GET /v1/me/achievements` — the catalogue with this profile's progress;
  grants anything newly earned (idempotently).

### Watch-together, chat and the WebSocket

`POST /v1/auth/ws-ticket` (signed in) returns a single-use ticket valid for 30
seconds; connect to `/ws?ticket=…`. The access token itself is never accepted
in the URL. Channels: `user:{userId}` (joined automatically — notifications),
`w2g:{code}` (playback sync and presence; only the host may control playback),
`chat:{chatId}` (members only). Delivery across app instances goes through
Postgres `LISTEN/NOTIFY` — there is no Redis. The socket is closed when the
session it was opened under ends or the account's tokens are revoked.

### Errors

Every failure answers `application/problem+json` and carries two fields
beyond the RFC-9457 basics:

```json
{
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "Request 8b3ded03-… failed — quote this id when reporting it",
  "instance": "8b3ded03-f31f-4960-b9e6-53adf34f2f38",
  "code": "YUME-CATALOGUE-500"
}
```

`code` is derived from the route and the status, not enumerated — a new route
gets a correct code the day it is written and nobody maintains a registry that
can rot. `instance` is the request id, and it is recorded on the error
occurrence, so `GET /v1/admin/errors/by-request/:requestId` finds the failure a
user is quoting (permission `admin.analytics.view`).

One deliberate exception: **a 404 is always `YUME-API-404`**. The admin surface
answers 404 rather than 403 so an account without permission cannot tell a
route it may not open from one that does not exist, and a code naming the
component would hand that back on the very reply meant to hide it.

### Outbound webhooks
Admin-configured endpoints subscribe per-event. Discord URLs receive rich
embeds; generic JSON endpoints receive this envelope:

```json
{
  "id": "8f1c…",                       // stable across retries — deduplicate on it
  "event": "user.registered",
  "at": "2026-09-07T10:00:00.000Z",    // when the event happened
  "sentAt": "2026-09-07T10:00:02.113Z",// when this attempt was made
  "attempt": 1,
  "instance": { "name": "Yume", "environment": "production", "url": "https://…" },
  "webhook": { "id": "…", "name": "Ops channel" },
  "links":  { "site": "https://…", "admin": "https://…/#/admin?s=users" },
  "data":   { "username": "alice", "totalUsers": 42, "promotedToAdmin": false }
}
```

`instance.url` and `links` appear only when `PUBLIC_URL` is set. Headers repeat
what a receiver routes on without parsing the body: `X-Yume-Event`,
`X-Yume-Delivery` (the `id`), `X-Yume-Timestamp`, `X-Yume-Attempt`, and
`X-Yume-Signature: sha256=…` — an HMAC of the whole body with the webhook
secret, so the delivery id is inside what is signed.

Delivery runs through the job queue (retries with backoff); 20 consecutive
failures auto-disable the hook. The delivery log records the envelope that was
actually sent. Events:
`user.registered`, `user.moderated`, `user.deleted`, `user.roles.changed`,
`user.password_reset_requested`, `comment.created`, `report.created`,
`report.resolved`, `w2g.room_created`, `stats.daily`, `stats.trending`,
`catalogue.imported`, `catalogue.changed`, `metadata.synced`, `config.changed`,
`monitor.alert`, `monitor.recovered`, `job.failed`, `webhook.test`.

A password reset token never travels through these webhooks.

### Password reset delivery

Yume sends no email itself. `POST /v1/auth/forgot` answers 204 whether or not
the account exists, in about the same time, and — when it does — hands the
token to the operator's own endpoint (`PASSWORD_RESET_WEBHOOK_URL`), which
sends the mail:

```http
POST <PASSWORD_RESET_WEBHOOK_URL>
Content-Type: application/json
X-Yume-Timestamp: 2026-09-22T10:00:00.000Z
X-Yume-Signature: sha256=<hex HMAC-SHA256(PASSWORD_RESET_WEBHOOK_SECRET, "<timestamp>.<body>")>

{ "type": "password_reset", "email": "…", "username": "…", "token": "…", "expiresAt": "…" }
```

The receiver recomputes the signature, compares it in constant time, and
refuses a timestamp more than a few minutes old. The mail should link to
`<PUBLIC_URL>/#/reset?token=<token>` — the web client's reset page, which also
opens on a private instance. Without the URL, reset
requests are recorded and nothing is delivered; `GET /v1/config` says so in
`site.recoveryAvailable`, and the client tells the visitor to contact the
operator instead of waiting for a mail.

## GraphQL schema

The schema as the server defines it (`apps/api/src/graphql/schema.ts`):

```graphql
enum Format { TV TV_SHORT MOVIE SPECIAL OVA ONA MUSIC }
enum Status { NOT_YET_RELEASED RELEASING FINISHED CANCELLED HIATUS }
enum Season { WINTER SPRING SUMMER FALL }
enum LibraryStatus { WATCHING PLANNING COMPLETED PAUSED DROPPED REWATCHING }
enum AnimeSort { POPULARITY TRENDING SCORE NEWEST TITLE }

type Titles { romaji: String english: String native: String preferred: String }
type Image { key: String blurhash: String color: String }
type ExternalIds { anilist: Int mal: Int anidb: Int kitsu: Int tvdb: Int tmdb: Int imdb: String }
type RankedTag { name: String! rank: Int! }

type Anime {
  id: ID!
  canonicalTitle: String!
  format: Format!
  status: Status!
  season: Season
  seasonYear: Int
  episodeCount: Int
  episodeDuration: Int
  synopsis: String
  averageScore: Float
  popularity: Int!
  trending: Int!
  isAdult: Boolean!
  titles: Titles!
  synonyms: [String!]!
  genres: [String!]!
  tags: [RankedTag!]!
  cover: Image
  mappings: ExternalIds
  episodes: [Episode!]!
  relations: [Relation!]!
  viewerEntry: LibraryEntry
}

type Episode {
  id: ID!
  number: Float!
  title: String
  synopsis: String
  airDate: String
  duration: Int
  isFiller: Boolean!
  isRecap: Boolean!
}

type Relation { relation: String!, node: Anime! }

type AnimePage { data: [Anime!]!, nextCursor: String }

type AiringEpisode { episodeId: ID!, animeId: ID!, episode: Float!, airingAt: String!, anime: Anime! }

type LibraryEntry {
  animeId: ID!
  status: LibraryStatus!
  progress: Int!
  score: Float
  rewatches: Int!
  updatedAt: String!
  anime: Anime!
}

type WatchProgress {
  episodeId: ID!
  animeId: ID!
  positionSec: Float!
  durationSec: Float
  completed: Boolean!
  updatedAt: String!
  anime: Anime!
}

type ProfileStats {
  xpTotal: Int!
  level: Int!
  minutesWatched: Int!
  episodesWatched: Int!
  animeCompleted: Int!
  meanScore: Float
}

type Notification {
  id: ID!
  type: String!
  payload: String!
  readAt: String
  createdAt: String!
}

type Viewer {
  id: ID!
  username: String!
  library(status: LibraryStatus, limit: Int = 500): [LibraryEntry!]!
  continueWatching: [WatchProgress!]!
  notifications(unreadOnly: Boolean = false, limit: Int = 25): [Notification!]!
  stats: ProfileStats
}


type Query {
  anime(id: ID!): Anime
  animePage(season: Season, year: Int, genre: String, format: Format, status: Status, sort: AnimeSort = POPULARITY, limit: Int = 25, cursor: String, nsfw: Boolean = false): AnimePage!
  search(query: String!, limit: Int = 10, nsfw: Boolean = false): [Anime!]!
  schedule(from: String!, to: String!): [AiringEpisode!]!
  me: Viewer
}

type Mutation {
  saveLibraryEntry(animeId: ID!, status: LibraryStatus, progress: Int, score: Float): LibraryEntry!
  deleteLibraryEntry(animeId: ID!): Boolean!
  saveProgress(episodeId: ID!, positionSec: Float!, durationSec: Float): WatchProgress!
  markNotificationsRead(ids: [ID!]!): Int!
}
```

- `anime(id)` answers null for a hidden title or a malformed id; `animePage`,
  `search`, `schedule` and `relations` list only public titles, `episodes` only
  public episodes.
- `schedule` spans at most 62 days (`RANGE_TOO_WIDE`).
- Nested titles are resolved by batched loaders — one statement per field per
  request, not one per row.
- A signed-out or revoked token is anonymous; `me` is then null.
- Mutations validate exactly as REST does (they call the same services) and are
  refused in read-only and maintenance modes (`READ_ONLY`).
- In production an unexpected resolver error is reported as
  `Internal error — quote request <id>`; the database's own message is logged,
  not returned.
