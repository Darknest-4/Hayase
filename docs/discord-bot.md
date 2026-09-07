# Yume Discord bot — design v2 (gateway)

> **Status: cancelled design.** No code was ever written, and the work was
> called off before any began — this is kept as a record of the decision and
> the costing, not as a plan anybody is executing. Nothing in the repository
> implements it, and nothing depends on it.
>
> It supersedes an earlier HTTP-interactions design: the request was for
> everything that transport could *not* do, so this committed to a full
> gateway bot, with the real costs stated in §11 rather than buried.

**What changed and why.** The previous design recommended an HTTP interactions
endpoint — no dependencies, no resident process. You asked for the features
that approach explicitly cannot deliver: reacting to messages, reactions,
member joins, presence and voice state. Those require a live gateway
connection, so this design commits to one. That is your call and this document
follows it, with the real costs stated in §11 rather than buried.

---

## 1. Where it lives

```
Hayase/
├── server/     API + worker      (Fastify, no new deps)
├── web/        client            (framework-free)
├── db/         migrations
├── bot/        ← NEW: the Discord bot, its own service
└── docs/
```

**Directory name: `bot/`.** The repo's convention is short, lowercase,
role-named directories — `server`, `web`, `db`, `docs`, `scripts`. `bot` sits
in that set naturally; `yume-dc-bot` repeats the project name inside its own
repo and abbreviates where nothing else does. If a second bot ever appears
(Telegram, Matrix), this becomes `bot/discord/` with no rename of anything
else.

```
bot/
├── package.json          own dependency tree — discord.js never touches server/
├── Dockerfile
├── src/
│   ├── index.ts          client bootstrap, intents, login, graceful shutdown
│   ├── config.ts         env validation, fail-fast (mirrors server/src/config.ts)
│   ├── yume.ts           the API client: service auth, act-as-user, retries
│   ├── events/           gateway event handlers (one file per event)
│   ├── commands/         one file per slash command
│   ├── components/       buttons, select menus, modals
│   ├── features/         cross-cutting: linking, roles, threads, w2g, moderation
│   ├── lib/              embeds, pagination, spoilers, nsfw gating, rate limits
│   └── deploy-commands.ts   registers the command tree with Discord
└── test/                 node:test, same runner as server/
```

**The bot is a separate npm package.** `discord.js` and its dependency tree
live only in `bot/package.json` — the API server's dependencies stay exactly
as they are today. That isolation is the reason a heavy library is acceptable
here: it cannot affect the API's install size, boot time or CVE surface.

### Why `discord.js` after arguing against it

The earlier design avoided it because an interactions endpoint needs ~15 lines
of `node:crypto`. A gateway bot is a different problem: identify/heartbeat/
resume, session invalidation, zombie-connection detection, intent
negotiation, per-route REST rate-limit buckets, sharding, and a cache with
bounded memory. Hand-writing that is weeks of subtle work and a permanent
maintenance burden. Here the dependency is **necessary**, not incidental —
which is exactly the distinction your rule draws.

---

## 2. How the bot talks to Yume

This is the most important decision in the document.

```
┌─────────┐   gateway WS    ┌──────────┐   REST + short-lived JWT   ┌────────────┐
│ Discord │ ◄─────────────► │   bot    │ ─────────────────────────► │ Yume API   │
└─────────┘   REST          └──────────┘                            │  (app)     │
                                  ▲                                 └────────────┘
                                  │ HMAC-signed webhooks                   │
                                  └────────────────────────────────────────┘
                                        (existing webhook system)
```

**The bot never touches Postgres directly.** It could — `DATABASE_URL` is
right there — and that would be a mistake. Writing `library_entries` straight
from the bot bypasses validation, RBAC, visibility rules, rate limiting and
the metadata lock layer, and duplicates business logic that would then drift.
Everything goes through the API the web client already uses.

### Authenticating without a second auth system

The bot holds a **service credential** (`YUME_SERVICE_TOKEN`, env only). One
new endpoint mints a short-lived, ordinary access token for a linked user:

```
POST /v1/integrations/discord/token      (service credential required)
     { discordUserId }
  →  { accessToken }   // normal JWT, 5-minute TTL, existing signing key
```

After that the bot is just another API client: the same JWT plugin, the same
`requirePermission`, the same rate limits, the same audit trail. **No parallel
permission model, no second token format, no bot-only privileges.**

Hard rules for that endpoint:

- Refuses unless `oauth_identities` has a `discord` row for that id.
- Refuses for suspended/banned accounts — the check the login path already does.
- 5-minute TTL, no refresh token. A leaked bot token cannot mint long-lived sessions.
- Every mint is audited with the Discord user id and the command that caused it.
- The service credential is env-only: never in the admin UI, never in a log, never in an embed.

### Yume → bot events

The existing outbound webhook system already has retries, delivery logging,
per-event subscription and auto-disable after 20 failures. The bot exposes a
tiny HTTP listener (one route, HMAC-verified with the shared secret already
supported for `generic` format webhooks) and subscribes to the events it
cares about. **Nothing new is built for delivery guarantees** — that machinery
exists and is in production use.

The `/ws` gateway stays available as a later latency optimisation for the
watch-party sync, where sub-second matters.

---

## 3. Account linking

The schema already permits it: `oauth_identities.provider` accepts
`'discord'`, unique on `(provider, provider_uid)`.

```
/link ──► bot DMs an ephemeral one-time URL (10 min, single use, bound to the Discord id)
      ──► user signs in to Yume with the login that already exists
      ──► Discord OAuth2 consent, `identify` scope only
      ──► row written to oauth_identities
      ──► bot assigns the "Linked" role, posts a confirmation, syncs roles (§5.4)
```

The bot never sees a password and never creates a session. **Only the Discord
user id is stored.** The `identify` scope also returns username, avatar and
email — Yume needs none of them, so none are kept. No Discord OAuth tokens are
stored either: after linking there is nothing to call on the user's behalf, so
holding a token would be pure liability.

`/unlink` removes the identity row, every subscription tied to it, and every
Discord role the link granted — in that order, so a failure part-way never
leaves someone with a role they no longer qualify for.

---

## 4. Intents — read this before promising features

Two of the intents this design needs are **privileged**. Discord grants them
freely under 100 servers; past that they require verification and a written
justification, and are periodically re-reviewed.

| Intent | Privileged | Needed for |
|---|---|---|
| `Guilds` | no | everything |
| `GuildMessages` | no | knowing a message happened |
| **`MessageContent`** | **yes** | link unfurling, spoiler help — anything reading text |
| **`GuildMembers`** | **yes** | welcome flow, role sync, member cache |
| `GuildMessageReactions` | no | reaction roles |
| `GuildVoiceStates` | no | voice ↔ watch-party binding |
| `DirectMessages` | no | DM notifications |

Every feature below is tagged with the intent it needs, so nothing is promised
that a permission screen can quietly take away. Features are individually
switchable: if `MessageContent` is refused, link unfurling turns off and
everything else keeps working.

---

## 5. Features

### 5.1 Slash commands — catalogue (no account needed)

| Command | Notes |
|---|---|
| `/anime <title>` | Detail embed, **autocomplete on the title** |
| `/search <query> [genre] [year] [season] [format] [status] [sort]` | Paginated with buttons |
| `/airing [day]` | Weekly schedule |
| `/random [genre] [format]` | One random public entry |
| `/season [year] [season]` | Season overview |
| `/top [genre] [format]` | Highest rated |
| `/trending` | Current trending rail |
| `/compare <a> <b>` | Two entries side by side |
| `/where <title>` | Which registered sources offer it |

**Autocomplete lands on `/v1/anime/suggest` unchanged.** Discord sends an
interaction per keystroke and expects choices within 3 seconds; that endpoint
answers in single-digit milliseconds with tiered ranking, and its response
maps directly onto Discord's 25-choice limit. The Search 2.0 work pays for
itself here.

### 5.2 Slash commands — personal (requires linking)

| Command | Notes |
|---|---|
| `/list [status] [sort]` | Your library, paginated, **ephemeral by default** |
| `/progress <title> <episode>` | Writes through the library API |
| `/watching` | Currently watching, with progress bars |
| `/plan` · `/completed` · `/dropped` | Status shortcuts |
| `/score <title> <0-10>` | Rate an entry |
| `/stats [user]` | XP, level, minutes watched, genre breakdown — from `profile_stats` |
| `/achievements` | Unlocked and next-up, from `achievements` |
| `/recommend` | Recommendations based on your library |
| `/profile [user]` | Public profile card |
| `/link` · `/unlink` | §3 |

`/stats` and `/achievements` are real integrations, not decoration:
`profile_stats`, `xp_events`, `achievements` and `profile_achievements` all
exist in the schema already.

### 5.3 Announcements and discussion — *gateway*

| Feature | Intent |
|---|---|
| `/notify add\|remove\|list <title>` — channel gets a message when an episode airs | — |
| `/notify me <title>` — DM instead | `DirectMessages` |
| **Auto episode-discussion thread** on air, auto-archived after N days | `Guilds` |
| **Forum-channel posts** where the server uses a forum instead of threads | `Guilds` |
| **Seasonal digest** — a "new season starts" post with the lineup | — |
| **Discord Scheduled Events** created for watch parties | `Guilds` |

**One new backend piece is required: nothing currently detects that an episode
aired.** `episodes.air_date` exists and the schedule endpoint reads it, but no
job fires when the time passes. A recurring worker job scans for episodes
whose `air_date` crossed since the last run and emits a new `episode.aired`
webhook event. That event is worth having independently — in-app notifications
will need exactly the same signal.

### 5.4 Roles and membership — *gateway, `GuildMembers`*

| Feature | Behaviour |
|---|---|
| **Welcome flow** | New member gets a DM explaining `/link`, plus an optional greeting post |
| **Verified role** | Granted on successful link, removed on unlink |
| **Staff role mirror** | Yume `admin` / `moderator` / `developer` roles map to Discord roles |
| **Level roles** | Yume XP level thresholds map to Discord roles, refreshed on level-up |
| **Achievement roles** | Selected achievements grant a cosmetic role |
| **Reaction roles** | React to pick genre-notification roles |
| **Self-service role menu** | Select menu, the modern alternative to reaction roles |

Direction matters: **Yume is the source of truth.** A Discord role never
grants a Yume permission. Someone who hands themselves a Discord "admin" role
gains nothing on the site.

### 5.5 Message-driven — *gateway, `MessageContent`*

| Feature | Behaviour |
|---|---|
| **Link unfurling** | Someone pastes a Yume or AniList link → the bot replies with a rich embed |
| **Inline lookup** | `[[Title]]` in a message expands to a compact card — the convention Discord anime communities already use |
| **Context-menu commands** | Right-click a message → "Search on Yume" / "Report to staff" |
| **Spoiler helper** | Detects an untagged episode number for an unaired episode and offers to re-post it spoiler-tagged, by request — it never deletes a message on its own |

Automatic deletion is deliberately excluded. A false positive that deletes
someone's message is worse than the spoiler it was guarding against, and
moderation belongs to the server's own moderators.

### 5.6 Watch Together ↔ voice — *gateway, `GuildVoiceStates`*

Yume already has watch-together rooms (`watch_together_rooms`, `/v1/w2g`,
the `/ws` channel). Binding them to a Discord voice channel is the strongest
gateway-only feature in this design:

| Feature | Behaviour |
|---|---|
| `/watchparty create <title> [episode]` | Opens a W2G room, posts a join button, optionally creates a Discord Scheduled Event |
| **Voice binding** | Everyone joining the bound voice channel gets the room link DM'd |
| **Live status** | The bot's message updates with what is playing and who is watching |
| **Presence** | Bot status shows the active party |
| `/watchparty end` | Closes the room and tidies the message |

**The bot does not stream or play audio.** Everyone plays locally in their own
browser — the site already synchronises playback. Audio streaming would need
`@discordjs/voice`, native opus and ffmpeg, and would serve no purpose here.
Voice *state* is used; voice *transport* is not.

### 5.7 Moderation bridge — *gateway*

| Feature | Behaviour |
|---|---|
| **Report inbox** | A Yume report opens a staff-channel thread with Approve / Reject / Escalate buttons; pressing one calls the moderation API as the pressing moderator |
| **Action mirror** | A Yume ban optionally applies a Discord timeout, per-guild opt-in |
| **Audit feed** | Moderation actions posted to a staff channel |
| `/yume reports` · `/yume hide <title>` · `/yume status` | Ephemeral staff commands |

Every button resolves the presser's Discord id to their Yume account and runs
the same `requirePermission` check the admin UI does. A moderator without the
permission gets the same refusal, and no action is taken on the strength of a
Discord role alone.

`/yume status` returns the green/amber/red readiness summary from the public
`/v1/health/ready` endpoint — never hostnames, IPs, disk paths, queue
internals or env values, matching the `safeDetail()` rule `probes.ts` already
enforces.

### 5.8 Notification bridge

Yume notifications (replies, follows, airing, achievements) can be mirrored to
a DM, per user, per category, opt-in via `/notifications`. The `notifications`
table stays the source of truth; Discord is one more delivery channel next to
the in-app inbox and the WebSocket push.

---

## 6. Data model

Everything except these five tables is reused.

```sql
discord_guilds          -- per-server config: channels, locale, nsfw policy,
                        -- spoiler policy, which features are enabled
discord_link_codes      -- pending /link codes: single-use, short TTL,
                        -- bound to the requesting Discord user id
discord_subscriptions   -- (guild, channel) or (discord_user) → anime_id
discord_role_map        -- guild → which Discord role mirrors which Yume
                        -- role / level / achievement
discord_deliveries      -- outbound log, monthly partitions, 3-month retention
```

`discord_deliveries` joins the `PARTITIONED` array in `maintenance.ts`, so
partition creation and retention come free from machinery already running.

**Reused unchanged:** `oauth_identities` (linking), `users` / `user_roles` /
`role_permissions` (authorization), `jobs` (fan-out and retries),
`notifications`, `feature_flags` (kill switch), `site_settings`,
`watch_together_rooms`, `profile_stats` / `xp_events` / `achievements`
(gamification), and the whole catalogue.

**New permissions:** `integrations.discord.manage` for configuring the bot.
Command actions reuse existing slugs. Per the audit rule already applied in
this project, a permission is marked `active` only once a route actually
enforces it.

---

## 7. Docker

The bot becomes a first-class compose service, as you asked — everything
starts through Docker.

```yaml
  bot:
    build: ./bot
    restart: on-failure          # a clean "not configured" exit must not loop
    depends_on:
      app:
        condition: service_started
    environment:
      DISCORD_BOT_TOKEN:  ${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN in .env}
      DISCORD_APP_ID:     ${DISCORD_APP_ID:?set DISCORD_APP_ID in .env}
      DISCORD_CLIENT_SECRET: ${DISCORD_CLIENT_SECRET:-}
      YUME_API_URL:       http://app:4000
      YUME_SERVICE_TOKEN: ${YUME_SERVICE_TOKEN:?generate with: openssl rand -base64 48}
      YUME_WEBHOOK_SECRET: ${YUME_WEBHOOK_SECRET:-}
      NODE_ENV: production
```

Plus a one-shot for registering the command tree, in the style of the existing
`seed` and `enrich` profiles:

```bash
docker compose --profile discord-deploy run --rm discord-deploy
```

`bot/Dockerfile` is its own image — `node:22-alpine`, `npm ci --omit=dev`,
`USER node` — mirroring the root Dockerfile's shape. It does **not** reuse the
root image, because that one installs the server's dependencies and copies
`web/` and `db/`, none of which the bot needs.

Design points that matter operationally:

- **No published ports.** The bot's webhook listener is reachable only on the
  compose network, as `http://bot:4100`. It is never exposed to the internet.
- **Unconfigured means a clean exit**, with a log line saying which variable is
  missing — not a crash loop. `restart: on-failure` then leaves it stopped.
- **Graceful shutdown** on SIGTERM: stop accepting interactions, finish
  in-flight ones, destroy the client. Compose restarts and deploys stay clean.
- **`depends_on: app`** only orders startup; the bot must survive the API being
  briefly unavailable anyway (§9).

---

## 8. Security and privacy

- **The bot token is a full account credential.** Env only. Never logged,
  never in an embed, never in an error response, never in the admin UI. If it
  leaks, it is rotated in the Discord developer portal — treat it like
  `JWT_SECRET`.
- **Discord roles grant nothing on Yume.** Every privileged action resolves to
  a linked Yume account and goes through the existing RBAC.
- **Ephemeral by default for anything personal** — `/list`, `/stats`, `/link`,
  every staff command. A private library must not land in a public channel
  because someone mistyped a command.
- **NSFW gating.** Adult results only in channels Discord marks NSFW, never in
  DMs the bot initiates. When the channel flag is unavailable, filter — default
  safe, never permissive.
- **Spoiler safety.** Synopses go inside `||spoiler||`. Episode titles are
  spoilers for ongoing shows far more often than people expect, so they are
  hidden by default and configurable per guild.
- **Minimal data.** Discord user id, guild/channel ids, subscriptions. No
  usernames, no avatars, no emails, no message content is ever persisted —
  `MessageContent` is read in memory to build an embed and dropped.
- **Kill switches.** `feature.discord_bot` disables everything without a
  deploy; each feature group has its own per-guild toggle.
- **Input is hostile.** Command arguments are user input from strangers on the
  internet: JSON-schema validated at the API boundary exactly like web
  requests, with no string interpolation into SQL — the same rules already
  applied in `search.ts`.
- **Cost control.** Command handling is rate-limited per Discord user and per
  guild inside the bot, so one person cannot spend the API's budget for an
  entire server.

---

## 9. Reliability

A gateway bot has failure modes an HTTP endpoint does not, and each needs an
answer up front:

| Failure | Response |
|---|---|
| Gateway disconnect | discord.js resumes automatically; log, and alert only on repeated failure |
| Zombie connection (socket open, no heartbeat ack) | discord.js detects and reconnects — surfaced in health |
| API down or restarting | Commands answer "temporarily unavailable" instead of throwing; announcements retry through the job queue and are never lost |
| Discord 429 | Honour `retry_after`; announcement fan-out is paced through the queue rather than bursting |
| Command handler throws | Caught per interaction; the user gets an ephemeral error, the bot stays up |
| Memory growth | Bounded caches — no full member cache, no message cache beyond what unfurling needs |
| Bot down | The site is entirely unaffected: the bot is a client, not a dependency |

**Health and monitoring** hook into what already exists: the bot exposes
`/health` on its internal port with gateway state, ping and uptime, and the
existing capability-aware probe system picks it up as another optional service
— reporting `not_configured` when no bot is deployed, exactly as it does for
Redis today. No false alarms for people who never wanted a Discord bot.

---

## 10. Build order

Each phase is independently shippable and independently useful.

| Phase | Scope |
|---:|---|
| **1** | `bot/` skeleton, Docker service, config fail-fast, gateway connect, `/ping`, health endpoint, command deploy script |
| **2** | Catalogue commands + autocomplete + pagination buttons (§5.1) — read-only, no account, no privileged intents |
| **3** | Linking (§3) + the token-mint endpoint + personal commands (§5.2) |
| **4** | `episode.aired` event + airing detector + `/notify` + discussion threads (§5.3) |
| **5** | Roles, welcome flow, reaction roles (§5.4) — first privileged intent |
| **6** | Watch-party ↔ voice binding (§5.6) |
| **7** | Message features (§5.5) — second privileged intent, most likely to be refused, so last among the user-facing work |
| **8** | Moderation bridge (§5.7) — highest privilege, built on a linking flow already in real use |

Every phase ships with `node:test` unit tests for the pure parts — embed
rendering, spoiler and NSFW gating, permission resolution, pagination, rate
limiting — matching the 96 tests already in the suite. No new test framework.

---

## 11. What this costs, stated plainly

You chose the gateway, so the trade-offs are real and worth naming:

- **A third resident process** on the VPS. Roughly 80–150 MB RSS with bounded
  caches, plus a permanent WebSocket. The monitoring already in place will
  show it.
- **A large dependency.** `discord.js` and its tree, with its own release
  cadence and security advisories. Contained to `bot/`, but it is real.
- **Privileged intents.** Link unfurling and the welcome flow depend on
  Discord approving them past 100 servers. Both features are switchable, so a
  refusal degrades rather than breaks.
- **A new secret to protect.** The bot token and the service credential join
  `JWT_SECRET` on the list of things that must never leak.
- **More surface to operate.** Reconnects, rate limits, command registration
  drift, and Discord API deprecations become part of routine maintenance.

None of it is a reason not to build it — you asked for the features that
require it. It is a reason to build it in the order above, so the highest-risk
pieces land on foundations that are already working.

## 12. Still deliberately excluded

- **Voice transport** (playing audio). No use case here — everyone plays
  locally — and it drags in native opus and ffmpeg.
- **Generic bot features**: music, generic levelling unrelated to Yume XP,
  server-management utilities. Not what this site is for, and each is a
  permanent support burden.
- **A second authentication system.** Discord identifies; Yume authenticates.
- **Direct database access from the bot.** All writes go through the API.
- **Automatic message deletion.** The bot offers, moderators decide.
- **Sharding.** Not needed under 2,500 guilds; the client is written so it can
  be added without restructuring.
