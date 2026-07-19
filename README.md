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

## Quick start

```sh
docker compose up -d                 # infrastructure
cd server
cp .env.example .env
npm install
npm run migrate                      # applies db/migrations in order
npm run dev                          # API on :4000
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

Next phases:

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
- [ ] Workers: notifications, stats rollups, metadata importers,
      OpenSearch indexing, extension review pipeline
- [ ] GraphQL endpoint over the same service layer
- [ ] WebSocket: notifications, chat, watch-together sync
- [ ] Developer portal + admin dashboard UIs

## License

BUSL-1.1 (inherited from the Hayase interface codebase — see LICENSE).
