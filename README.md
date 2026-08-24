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
├─ docs/                  Architecture, database, API and operations docs
│  ├─ architecture.md     Services, queue, search, catalogue precedence,
│  │                      publishing workflow, scaling, ADRs
│  ├─ database.md         Schema guide: domains, ER, indexing, partitioning
│  ├─ api.md              REST + GraphQL reference
│  ├─ extensions.md       Extension platform: manifest, permissions, store
│  ├─ security.md         Threat model and the controls that answer it
│  ├─ backup.md           Backup, restore and what has not been rehearsed
│  └─ redis.md            Why Redis is carried but not adopted
├─ db/
│  ├─ migrations/         PostgreSQL 16 schema — 23 migrations, ~100
│  │                      relations, every one commented with its reasoning
│  └─ *.sh               Backup, restore and cron scripts (POSIX sh)
├─ server/                API gateway — Fastify 5 + TypeScript on Node 22
│  ├─ src/                No build step: --experimental-strip-types
│  └─ test/               17 suites, including the adversarial one
├─ packages/
│  └─ design-tokens/      Design tokens shared with native surfaces
├─ web/                   Web client — framework-free HTML/CSS/JS SPA
│  ├─ js/catalogue.js     Which source answers: our database, then AniList
│  ├─ js/i18n.js          One text lookup: copy catalogue + translation
│  ├─ i18n/hu.js          Hungarian dictionary, keyed by the English source
│  └─ test/               Engine, resolver, i18n and DOM-helper tests
├─ .github/workflows/     CI: typecheck, tests, migrations, worker, lint
├─ Caddyfile              TLS termination in front of the app
└─ docker-compose.yml     app · worker · caddy · backup · postgres
```

**Infrastructure is deliberately small.** Four times over, the obvious
component was declined in favour of what Postgres already does:
`LISTEN/NOTIFY` instead of Redis for cross-instance fan-out, full-text search
instead of OpenSearch, a `jobs` table with `FOR UPDATE SKIP LOCKED` instead of
RabbitMQ, and content-addressed files on disk instead of MinIO. Each decision
is written next to the code that implements it. Redis is still read from the
environment for a health probe and nothing else — see `docs/redis.md`.


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
docker compose up -d                 # postgres (app/worker/caddy optional)
cd server
cp .env.example .env                 # JWT_SECRET and POSTGRES_PASSWORD are required
npm install
npm run migrate                      # applies db/migrations in order, idempotent
npm run dev                          # API on :4000, no build step
```

### Tests

```sh
npm test                             # every server suite
npm run test:adversarial             # forgery, injection, SSRF, IDOR, races
node --test ../web/test/*.test.mjs   # engine, catalogue resolver, DOM helper
```

The adversarial suite needs `DATABASE_URL`; without one it skips itself, which
is why CI runs it as its own step **after** the database exists rather than
inside the general unit-test step, where it would report green having checked
nothing.

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

### The first administrator

There is no shipped account and no default password — an account with a known
password is a back door on every deployment that forgets to change it. Instead,
**the first account registered on an instance that has no administrator becomes
one**, and the same rule promotes the oldest existing account when migration
0021 runs on a database that already has users.

The condition is *"no administrator exists"*, not *"this is the first user"*.
Once anybody holds the role the path is dead, so it cannot hand out a second
one later. The promotion is written to `security_logs` and `audit_logs`, and
logged at warn level, because it is the most consequential thing that can
happen to an account and nobody approves it.

Register immediately after deploying. Until you do, whoever registers first
gets the panel.

Smoke test:

```sh
curl localhost:4000/v1/health
curl -X POST localhost:4000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","username":"you","password":"correct-horse-9"}'
```

## Hungarian and English

The site is bilingual on one domain — the language is a setting, not an
address. There is no `/hu/` prefix and no second deployment.

**Four independent axes, not one switch.** A Hungarian viewer typically wants
a Hungarian interface and Hungarian subtitles but *romaji* titles, because
that is how the community refers to shows. One combined "Hungarian" toggle
would take the titles away from them.

| Setting | Controls | State |
|---|---|---|
| `language.ui` | buttons, menus, messages | complete, both languages |
| `language.titles` | romaji / English / Hungarian / native | data exists for romaji |
| `language.content` | synopses and episode text | sparse; falls back to English |
| `playback.variant` | **sub or dub** | ranks the sources a provider offers |
| `playback.subtitles` / `playback.audio` | preferred tracks | applied when a source declares them |

Preferences live in `user_settings`, keyed **per profile** — one household can
have a Hungarian child profile and an English adult profile on one login. The
list of preferences is declared once, in `server/src/lib/preferences.ts`;
`GET /v1/config` publishes it, and both the settings screen and the onboarding
wizard render from it, so adding a preference is one entry and nothing else
changes.

### The first-run wizard

Three steps, pre-answered from the browser's own language, and always
dismissable. It triggers on *"this profile has no language preference"* — not
on *"this account just registered"* — so accounts created before the feature
existed get it too, and a registration finished on another device is not
skipped. Everything is written in one request at the end, so an abandoned
wizard cannot leave a profile half-configured.

### Sub / dub

`playback.variant` is a real ranking input, not a label. The stream engine
classifies each candidate as `sub`, `dub`, `raw` or `unknown` from the audio
language a source declares, the subtitle tracks it carries, and — last and
least trusted — the release title. The viewer's choice outranks source health
and resolution, because a 1080p subbed release is the wrong answer for someone
who asked for a dub.

`unknown` is a real answer and is never guessed into one of the others: a
wrong guess starts the wrong audio. Under the player, a bar switches between
the variants and providers actually on offer, re-ranking candidates already in
hand rather than re-querying every extension.

### Translating the catalogue

The catalogue holds ~25,700 English synopses and Hungarian ones exist only
once somebody writes them. `anime_translations` is a sparse overlay that
starts empty — **not** `anime_titles`, which every re-import rewrites and
which would silently discard hand-written text. Reads are a `LEFT JOIN` with
fallback, so nothing 404s for want of a translation.

Every localised response carries a `_lang` marker saying which language each
field actually resolved to. The client uses it to say *"this description has
not been translated yet"* rather than showing a Hungarian viewer an
unexplained English paragraph, which reads as the site being broken.

Admin → **Translations** lists what is still missing, ordered by popularity:
translating 25,700 entries is not going to happen, translating the few hundred
people actually open is a week of work.

### Interface strings

`T('Start Watching')` — the key *is* the English text, so a missing
translation renders the English sentence rather than an identifier or a blank
button. `T('nav.community')` still resolves through the pre-existing
`web/copy.js` catalogue and is then translated; the two used to be separate
systems and are now one function.

### Text handling

Hungarian needs the database to be UTF-8. Under `SQL_ASCII`, `lower('Á')`
stays `'Á'`, `ILIKE` misses accented matches, and `length()` counts bytes —
and `server/src/lib/search.ts` matches on `lower()` and `ILIKE` in all three of
its tiers. Encoding cannot be changed after `initdb`, so it is pinned in
`docker-compose.yml`, stated explicitly in `db/restore.sh`, and checked at
migration time: `server/src/lib/db-encoding.ts` **refuses to create a schema**
on a non-UTF-8 database and warns loudly on one that already has data —
failing closed while it is free to fix, and never turning a text defect into
an outage.

Migration 0022 adds accent-folding (`tamadas` finds `támadás`), Hungarian
stemming for translated text, and the `hu-HU-x-icu` collation for alphabetical
order — the default sorts `Zebra` before `Álom`.

## Status & roadmap

The catalogue is the source of truth for anime data; AniList, ani.zip and
Jikan are the fallback. Nothing imported is published until somebody publishes
it — this platform serves a Hungarian audience and a Hungarian subtitle
arrives days after an episode does, so both `anime.visibility` and
`episodes.visibility` default to `hidden`. See `docs/architecture.md`.

Delivered:
- [x] **Hungarian/English on one domain** — four independent language axes
      (interface, titles, descriptions, playback), stored per profile in
      `user_settings`; a three-step first-run wizard pre-answered from the
      browser; a live language switch with no reload; a sub/dub and provider
      switcher under the player; `anime_translations` as an import-proof
      overlay with a popularity-ordered editor queue in the admin panel; and
      UTF-8, accent-folding and Hungarian collation pinned in provisioning and
      enforced at migration time

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
- [x] Search over Postgres — typo-tolerant tsvector + trigram over titles and
      synonyms. OpenSearch was declined rather than deferred: it earns its
      place by solving a problem that exists now, and this one does not yet
      (`docs/search.md`)
- [x] Catalogue as the source of truth: the detail and watch pages read our
      database first and fall back to a provider only on a miss; routes accept
      a Yume id or an AniList id, so a title that exists only here is reachable
- [x] Editorial publishing: per-anime and per-episode visibility, bulk range
      publishing, an unfiltered admin list so staff can see what is *not*
      live, and every change written to the audit trail
- [x] Account recovery: password change and reset, session-bound access tokens
      (signing out kills this device's token immediately and leaves the others
      alone), and a separate sign-out-everywhere. Reset delivery is the
      operator's — the token goes to one configured endpoint, never through
      the admin-managed webhook fan-out
- [x] Error triage and audit views in the admin panel — list, open a group for
      its stack, resolve it; read who changed what and when
- [ ] Restore rehearsal: the backup scripts are written and CI syntax-checks
      them, but **no restore has been performed**. A backup that has never
      been restored is a belief, not a backup
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
