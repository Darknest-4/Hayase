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

Every page and feature of the web client — the platform features
(accounts, comments, store, admin, developer portal) are captured running
against the live API + PostgreSQL. Full gallery in
[`docs/screenshots/`](docs/screenshots/).

| | |
|---|---|
| **Home** — hero, Continue Watching + curated rails<br>![Home](docs/screenshots/01-home.png) | **Search** — full-text + filters (genre/season/year/format/status/sort)<br>![Search](docs/screenshots/02-search.png) |
| **Hover preview** — trailer + quick actions on card hover<br>![Preview](docs/screenshots/01b-hover-preview.png) | **Anime detail** — banner, stats, list controls, genres<br>![Detail](docs/screenshots/03-anime-detail.png) |
| **Episodes** — Hayase-style rows: thumbs, air dates, filler, watched toggles<br>![Episodes](docs/screenshots/04-episodes.png) | **Watch Together** — rooms with live playback sync<br>![W2G](docs/screenshots/10b-watch-together.png) |
| **Comments** — threaded, spoiler-aware, likes, reports<br>![Comments](docs/screenshots/05-comments.png) | **Watch** — custom player, Skip intro (AniSkip), progress tracking<br>![Watch](docs/screenshots/06-watch-player.png) |
| **Schedule** — weekly airing calendar<br>![Schedule](docs/screenshots/07-schedule.png) | **Library** — statuses, progress controls, favourites<br>![Library](docs/screenshots/08-library.png) |
| **Profile** — XP/level, watch stats, library breakdown<br>![Profile](docs/screenshots/09-profile.png) | **Community** — live discussion feed (Yume API)<br>![Community](docs/screenshots/10-community.png) |
| **Extension Store** — live registry with ratings + verified devs<br>![Store](docs/screenshots/11-extension-store.png) | **Developer Portal** — listings + review status<br>![Dev portal](docs/screenshots/12-developer-portal.png) |
| **Developer analytics** — installs, errors, version pipeline<br>![Dev analytics](docs/screenshots/13-developer-analytics.png) | **Admin overview** — users, watch stats, trending, job health<br>![Admin](docs/screenshots/14-admin-overview.png) |
| **Admin users** — search, suspend/ban/restore<br>![Admin users](docs/screenshots/15-admin-users.png) | **Settings** — profile, theme, server, account, data<br>![Settings](docs/screenshots/16-settings.png) |
| **Quick search** — Ctrl+K palette<br>![Quick search](docs/screenshots/17-quick-search.png) | **Light theme** — same tokens, one attribute flip<br>![Light](docs/screenshots/18-light-theme.png) |
| **Mobile** — bottom navigation layout<br>![Mobile](docs/screenshots/19-mobile-home.png) | |

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
