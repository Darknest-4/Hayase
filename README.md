# Yume (夢)

**Yume** is an anime streaming platform born from the Hayase codebase but
rebuilt as its own product: its own identity, its own design system, a real
backend with a scalable database, and an extension **store** instead of
URL-pasted plugins. Two ideas are inherited and kept sacred:

1. **The platform hosts zero content** — video sources are resolved by
   sandboxed, permission-scoped extensions.
2. **Accuracy is earned, not claimed** — the runtime measures what data an
   extension actually used and caps how confident its results may look.

## Repository layout

```
├─ docs/                  Architecture, database, API and extension docs
│  ├─ architecture.md     Services, caching, queue, search, scaling, ADRs
│  ├─ database.md         Schema guide: domains, ER, indexing, partitioning
│  ├─ api.md              REST + GraphQL reference
│  └─ extensions.md       Extension platform: manifest, permissions, store
├─ db/migrations/         PostgreSQL 16 schema — 7 domain migrations,
│                         ~100 relations, fully commented, verified clean
├─ server/                API gateway — Fastify + TypeScript (Node 22)
│                         auth (JWT + rotating refresh), RBAC, catalogue,
│                         library/progress, extension store endpoints
├─ packages/
│  └─ design-tokens/      Yume design system tokens (CSS + JSON):
│                         colors, type scale, spacing, motion, dark/light
├─ web/                   Web client (framework-free HTML/CSS/JS SPA,
│                         being migrated onto the design tokens + API)
└─ docker-compose.yml     Local infra: Postgres, Redis, OpenSearch,
                          MinIO, RabbitMQ
```


## Screenshots

Every page and feature of the web client, in **desktop and mobile** layouts.
Platform features (accounts, comments, store, admin, developer portal) are
captured running against the live API + PostgreSQL; anime metadata is mocked
for reproducible shots. Click any section below to expand it. Full gallery in
[`docs/screenshots/`](docs/screenshots/).

<details>
<summary><b>🏠 Home</b> — hero, Continue Watching + curated rails</summary>

<br>

![🏠 Home — desktop](docs/screenshots/01-home.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/01-home-mobile.png" alt="🏠 Home — mobile" width="300">

</details>

<details>
<summary><b>🖱️ Hover preview</b> — trailer/banner card with meta chips, genres and quick actions (desktop)</summary>

<br>

![🖱️ Hover preview — desktop](docs/screenshots/26-hover-preview.png)

</details>

<details>
<summary><b>📊 Dashboard</b> — customizable widget landing page (reorder + toggle)</summary>

<br>

![📊 Dashboard — desktop](docs/screenshots/02-dashboard.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/02-dashboard-mobile.png" alt="📊 Dashboard — mobile" width="300">

</details>

<details>
<summary><b>🔍 Search</b> — full-text search with genre / season / year / format / status / sort filters</summary>

<br>

![🔍 Search — desktop](docs/screenshots/03-search.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/03-search-mobile.png" alt="🔍 Search — mobile" width="300">

</details>

<details>
<summary><b>📺 Anime detail</b> — two-column: tabs + info sidebar (facts, airing countdown, where to watch), banner, tinted chips</summary>

<br>

![📺 Anime detail — desktop](docs/screenshots/04-anime-detail.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/04-anime-detail-mobile.png" alt="📺 Anime detail — mobile" width="300">

</details>

<details>
<summary><b>🎬 Episodes</b> — Hayase-style rows: thumbnails, air dates, filler flags, watched toggles</summary>

<br>

![🎬 Episodes — desktop](docs/screenshots/05-episodes.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/05-episodes-mobile.png" alt="🎬 Episodes — mobile" width="300">

</details>

<details>
<summary><b>💬 Comments</b> — threaded, spoiler-aware, likes and reports</summary>

<br>

![💬 Comments — desktop](docs/screenshots/06-comments.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/06-comments-mobile.png" alt="💬 Comments — mobile" width="300">

</details>

<details>
<summary><b>▶️ Watch</b> — two-column: player + episode sidebar (thumbs, titles, watched marks); automatic per-second resume, up-next autoplay, AniSkip</summary>

<br>

![▶️ Watch — desktop](docs/screenshots/07-watch.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/07-watch-mobile.png" alt="▶️ Watch — mobile" width="300">

</details>

<details>
<summary><b>🗓️ Schedule</b> — weekly airing calendar</summary>

<br>

![🗓️ Schedule — desktop](docs/screenshots/08-schedule.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/08-schedule-mobile.png" alt="🗓️ Schedule — mobile" width="300">

</details>

<details>
<summary><b>📚 Library</b> — statuses, progress controls, favourites</summary>

<br>

![📚 Library — desktop](docs/screenshots/09-library.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/09-library-mobile.png" alt="📚 Library — mobile" width="300">

</details>

<details>
<summary><b>👤 Profile</b> — a hub with Overview / Analytics / Achievements / History tabs, over a random-anime spotlight banner</summary>

<br>

![👤 Profile — desktop](docs/screenshots/11-profile.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/11-profile-mobile.png" alt="👤 Profile — mobile" width="300">

</details>

<details>
<summary><b>📈 Analytics</b> — Profile tab — personal viewing charts (activity, genres, formats, studios, scores)</summary>

<br>

![📈 Analytics — desktop](docs/screenshots/13-analytics.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/13-analytics-mobile.png" alt="📈 Analytics — mobile" width="300">

</details>

<details>
<summary><b>🏆 Achievements</b> — Profile tab — tiered catalogue with progress bars and XP / levels</summary>

<br>

![🏆 Achievements — desktop](docs/screenshots/14-achievements.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/14-achievements-mobile.png" alt="🏆 Achievements — mobile" width="300">

</details>

<details>
<summary><b>⏳ Watch History</b> — Profile tab — per-profile log grouped by day</summary>

<br>

![⏳ Watch History — desktop](docs/screenshots/10-history.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/10-history-mobile.png" alt="⏳ Watch History — mobile" width="300">

</details>

<details>
<summary><b>🎭 Profiles</b> — Netflix-style “who’s watching” picker (per-profile data)</summary>

<br>

![🎭 Profiles — desktop](docs/screenshots/12-profiles.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/12-profiles-mobile.png" alt="🎭 Profiles — mobile" width="300">

</details>

<details>
<summary><b>🔔 Notifications</b> — filterable inbox (airing, continue-watching, achievements)</summary>

<br>

![🔔 Notifications — desktop](docs/screenshots/15-notifications.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/15-notifications-mobile.png" alt="🔔 Notifications — mobile" width="300">

</details>

<details>
<summary><b>🗨️ Community</b> — live discussion feed (Yume API + WebSocket)</summary>

<br>

![🗨️ Community — desktop](docs/screenshots/16-community.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/16-community-mobile.png" alt="🗨️ Community — mobile" width="300">

</details>

<details>
<summary><b>👥 Watch Together</b> — a popup under the player: create/join a room, copy invite, live activity, WebSocket play/pause/seek sync</summary>

<br>

![👥 Watch Together — desktop](docs/screenshots/17-watch-together.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/17-watch-together-mobile.png" alt="👥 Watch Together — mobile" width="300">

</details>

<details>
<summary><b>🧩 Extension Store</b> — live registry with ratings and verified developers</summary>

<br>

![🧩 Extension Store — desktop](docs/screenshots/18-extension-store.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/18-extension-store-mobile.png" alt="🧩 Extension Store — mobile" width="300">

</details>

<details>
<summary><b>🛠️ Developer Portal</b> — listings, review status and per-version analytics</summary>

<br>

![🛠️ Developer Portal — desktop](docs/screenshots/19-developer.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/19-developer-mobile.png" alt="🛠️ Developer Portal — mobile" width="300">

</details>

<details>
<summary><b>🛡️ Admin</b> — users, watch stats, trending, job-queue health, reports</summary>

<br>

![🛡️ Admin — desktop](docs/screenshots/20-admin.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/20-admin-mobile.png" alt="🛡️ Admin — mobile" width="300">

</details>

<details>
<summary><b>📚 Catalogue</b> — anime & episode management: add / edit / delete, per-entry visibility (public / unlisted / hidden — hidden 404s everywhere), episode CRUD</summary>

<br>

![📚 Catalogue — list](docs/screenshots/30-catalogue.png)

![📚 Catalogue — editor](docs/screenshots/31-catalogue-editor.png)

</details>

<details>
<summary><b>🎛️ Site Config</b> — DB-driven feature flags: toggle any page/feature, set access (public / login / permission), lock the whole site behind login</summary>

<br>

![🎛️ Site Config — desktop](docs/screenshots/28-site-config.png)

</details>

<details>
<summary><b>🛡️ Roles & Permissions</b> — fine-grained RBAC: 387 permissions across 11 domains, 6 roles, per-role grant/revoke with search</summary>

<br>

![🛡️ Roles & Permissions — desktop](docs/screenshots/29-roles.png)

</details>

<details>
<summary><b>🎨 Theme Engine</b> — in Settings › Appearance — accent presets + custom colour with a live preview</summary>

<br>

![🎨 Theme Engine — desktop](docs/screenshots/21-theme-engine.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/21-theme-engine-mobile.png" alt="🎨 Theme Engine — mobile" width="300">

</details>

<details>
<summary><b>⚙️ Settings</b> — categorized tabs — account, appearance, content, notifications, data</summary>

<br>

![⚙️ Settings — desktop](docs/screenshots/22-settings.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/22-settings-mobile.png" alt="⚙️ Settings — mobile" width="300">

</details>

<details>
<summary><b>⌨️ Quick search</b> — Ctrl+K command palette</summary>

<br>

![⌨️ Quick search — desktop](docs/screenshots/23-quick-search.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/23-quick-search-mobile.png" alt="⌨️ Quick search — mobile" width="300">

</details>

<details>
<summary><b>☀️ Light theme</b> — the same design tokens, one attribute flip</summary>

<br>

![☀️ Light theme — desktop](docs/screenshots/24-light-theme.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/24-light-theme-mobile.png" alt="☀️ Light theme — mobile" width="300">

</details>

<details>
<summary><b>🔗 Site footer</b> — navigation columns and data-source credits on every content page</summary>

<br>

![🔗 Site footer — desktop](docs/screenshots/25-footer.png)

<sub>📱 Mobile</sub>

<img src="docs/screenshots/25-footer-mobile.png" alt="🔗 Site footer — mobile" width="300">

</details>

## Quick start

```sh
docker compose up -d                 # infrastructure
cd server
cp .env.example .env
npm install
npm run migrate                      # applies db/migrations in order
npm run dev                          # API on :4000
```

### Seed a real catalogue

Fill the database with the full anime-offline-database dump — ~25k real
anime with titles, synonyms, external ids (AniList/MAL/AniDB/Kitsu),
covers, genres/tags, the relation graph, per-episode rows generated from
real episode counts with season-anchored air dates, and real
community-sourced filler flags:

```sh
curl -o /tmp/aod.json https://raw.githubusercontent.com/manami-project/anime-offline-database/2022-26/anime-offline-database-minified.json
npm run seed /tmp/aod.json           # ~2 minutes, idempotent
```

Smoke test:

```sh
curl localhost:4000/v1/health
curl -X POST localhost:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","username":"you","password":"correct-horse-9"}'
```

## Status & roadmap

Delivered:
- [x] Multiple profiles per account (Netflix-style): per-profile library,
      history, favourites, continue-watching and settings; profile picker,
      sidebar switcher and manager; backend `/v1/profiles` CRUD; expanded
      permission catalog (45 slugs across catalogue/community/moderation/
      developer/analytics/system)

- [x] Full PostgreSQL schema (identity/RBAC, catalogue, streaming,
      community, profiles/gamification, extension store, analytics) —
      applies cleanly, documented table-by-table in the SQL + docs
- [x] Architecture, API and extension-platform documentation
- [x] API foundation: auth with rotating refresh tokens, RBAC plugin,
      catalogue browse/detail/schedule, library + watch progress,
      extension store browse/install — typechecked, exercised end-to-end
- [x] Design tokens (dark default + light), local infra compose file

Remaining:

- [x] Web client rebuilt on the design system: Yume identity, expanded
      sidebar navigation, Home/Search/Details/Schedule/Library pages
      restyled, new Profile (stats, XP/levels) and Extension Store pages
      (live against the API), dark + light themes, mobile bottom-nav
- [x] Watch page: full custom player (seek/buffered bar, volume, speed,
      PiP, fullscreen, keyboard shortcuts, auto-hide controls), AniSkip
      intro/outro skipping, resume positions and automatic progress
      tracking; plays any direct stream URL, links official streams
- [x] Community: accounts in the client (register/sign-in with rotating
      refresh tokens), threaded spoiler-aware comments with likes on
      anime pages, platform-wide recent-discussion feed; backed by new
      /v1/comments API and an AniList-id → catalogue bridge
- [x] Background workers on a durable Postgres job queue (SKIP LOCKED,
      retries with backoff, dedupe): profile-stats recompute, daily watch
      rollups, trending scores, partition creation + retention pruning,
      and an anime-offline-database catalogue importer (idempotent);
      progress completions now write watch_history + XP automatically
- [ ] OpenSearch indexing and extension review pipeline workers
- [x] GraphQL endpoint (/graphql, GraphiQL in dev) over the same service
      layer: anime/animePage/search/schedule/extensionPage/me queries with
      batched child-field loaders (titles, genres, mappings, episodes,
      relations, viewerEntry — no N+1s), library/progress/notification
      mutations; plus REST /v1/anime/search — both backed by typo-tolerant
      tsvector + trigram search over titles and synonyms
- [x] WebSocket layer (/ws): JWT-authenticated channels — live
      notifications (comment replies push instantly), persisted chat with
      membership checks, watch-together rooms (REST registry + play/seek
      sync + presence)
- [x] Moderation & admin: content reporting (dedup per reporter),
      permission-gated /v1/admin API (user search/suspend/ban with session
      revocation, moderation queue with hide/restore/dismiss, analytics
      overview) — every action logged to moderation_actions + audit_logs —
      and an Admin dashboard in the client (Overview / Users / Reports)
      that appears only for privileged accounts
- [x] Developer portal: enrol as a developer (grants the developer
      role), create extension listings, upload immutable semver versions
      into a review pipeline, per-extension analytics (installs, ratings,
      30-day update/error/load-failure counts, version review status) —
      backend /v1/dev API plus a client Developer Portal page
- [x] Extension review worker: static manifest/permission analysis —
      auto-approves + publishes low-risk versions, flags sensitive
      permissions (net:fetch, query:media) for human review, rejects
      invalid manifests / wildcard hosts, notifies the developer

## License

BUSL-1.1 (inherited from the Hayase interface codebase — see LICENSE).
