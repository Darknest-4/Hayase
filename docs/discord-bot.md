# Discord bot — design

> **Status: design only.** Nothing in this document is implemented yet. It
> exists so the architecture decision can be reviewed before any code is
> written.

The short version: about half of what people mean by "a Discord bot" is
**already built** in Yume's outbound webhook system, and the other half can be
built as a handful of Fastify routes with **no new dependencies at all**. The
expensive option — a gateway bot on `discord.js` — buys almost nothing for
this product and costs a resident process, a large dependency tree and a new
class of failure on a single VPS.

---

## 1. The decision that shapes everything

Discord offers two ways to run a bot.

### A. Gateway bot (`discord.js` and friends)

A process holds a WebSocket to Discord, receives every event in every server
it is in (messages, presence, reactions, joins), and answers over the REST
API. This is what most tutorials show.

It needs: a second always-on process, reconnect/resume/shard handling, an
intent configuration, and `discord.js` (~10 MB installed, its own dependency
tree, its own release cadence and CVEs). On the VPS that is another resident
Node process next to `app` and `worker`, holding a connection that must be
healthy 24/7 or commands silently stop working.

### B. HTTP interactions endpoint ← **recommended**

Discord POSTs each slash command to an HTTPS URL you register. You verify an
Ed25519 signature and reply with JSON. There is no socket, no resident
process, and no library required.

**This is verified, not assumed.** Node 22 can verify Discord's signatures
with only `node:crypto` — Discord hands you a 32-byte public key as hex, which
becomes a usable key by prefixing the 12-byte RFC 8410 SPKI header:

```js
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const key = createPublicKey({
  key: Buffer.concat([SPKI_PREFIX, Buffer.from(DISCORD_PUBLIC_KEY, 'hex')]),
  format: 'der', type: 'spki'
})
const ok = verify(null, Buffer.concat([timestamp, rawBody]), key, signature)
```

Confirmed working on this Node version: a valid signature verifies, a tampered
body fails, a forged signature fails.

### What option B cannot do

Honesty matters more than the recommendation. Without a gateway you **cannot**
react to things that merely happen in a server:

| Wanted | HTTP-only? |
|---|---|
| Slash commands, autocomplete, buttons, modals | ✅ yes |
| Posting messages, embeds, DMs | ✅ yes (REST) |
| Assigning roles, editing nicknames | ✅ yes (REST) |
| Announcements into a channel | ✅ yes (already built — see §2) |
| Reacting to an ordinary user message | ❌ needs gateway |
| Reacting to emoji reactions, joins, presence | ❌ needs gateway |
| Voice | ❌ needs gateway |

Everything an anime site's bot actually needs is a command or an outbound
message. Nothing on the "needs gateway" list is on the feature list below.

**Recommendation: build option B.** If a future feature genuinely needs
gateway events — a welcome flow on member join, say — that can be added later
as a separate small process without redoing any of this, because the command
handling and REST layer stay identical.

---

## 2. Half of it already exists — don't rebuild it

`server/src/lib/webhooks.ts` already renders **Discord embeds** and delivers
them to a Discord webhook URL, with per-event subscriptions, delivery logging,
retries and auto-disable after 20 consecutive failures. The admin UI already
manages these.

So this is already solved, today, with no bot at all:

> "post a message in #staff when a report comes in / an extension is submitted
> / a monitor alert fires / the catalogue changes"

A **webhook** is the right tool when the message goes to one fixed channel and
nobody replies to it. A **bot** is only needed when you need per-user identity,
slash commands, DMs, or role management.

The design therefore splits cleanly:

| Direction | Mechanism | Status |
|---|---|---|
| Yume → a fixed channel (staff alerts, monitor, moderation) | existing webhook system | ✅ built |
| Yume → a subscribed channel (episode aired) | existing webhook system + one new event | small addition |
| Yume → one user (DM: your show aired) | bot REST | new |
| Discord user → Yume (commands) | interactions endpoint | new |

---

## 3. Feature set

Ordered by value per unit of work. Commands are scoped to what the site is
about — no music, no general-purpose moderation, no levelling.

### 3.1 Read-only commands (no account needed)

| Command | Behaviour |
|---|---|
| `/anime <title>` | Detail embed: cover, score, format, episodes, status, genres, synopsis (spoiler-tagged), link to the site. **Autocomplete** on the title. |
| `/search <query> [genre] [year] [format]` | Top 5 results as a compact embed with a "see all" link. |
| `/airing [day]` | This week's schedule, or one day. |
| `/random [genre]` | One random public entry — cheap, and people use it constantly. |

**Autocomplete is the standout here.** Discord sends a separate interaction on
every keystroke and expects choices within 3 seconds. The `/v1/anime/suggest`
endpoint built in Search 2.0 is exactly this shape: tiered ranking, minimal
payload, no telemetry, answers in single-digit milliseconds. It maps to
Discord's 25-choice autocomplete response with no new query work.

### 3.2 Account-linked commands

| Command | Behaviour |
|---|---|
| `/link` | Starts account linking (§5). Ephemeral. |
| `/unlink` | Drops the link and every subscription tied to it. |
| `/list [status]` | Your library, paginated. **Ephemeral by default.** |
| `/progress <title> <episode>` | Sets progress — writes through the same library service the web client uses. |
| `/watching` | Your currently-watching shows with progress bars. |

### 3.3 Announcements

| Command | Behaviour |
|---|---|
| `/notify add <title>` | This channel gets a message when a new episode airs. |
| `/notify remove <title>` · `/notify list` | Manage subscriptions. |
| `/notify me <title>` | DM instead of a channel message. |

This needs one genuinely new piece of backend: **nothing currently detects
that an episode aired.** `episodes.air_date` exists and the schedule endpoint
reads it, but no job fires when the time passes. A recurring worker job scans
for episodes whose `air_date` crossed since the last run and emits a new
`episode.aired` webhook event. That event is useful well beyond Discord — it
is what in-app notifications will need too.

### 3.4 Staff commands

| Command | Behaviour |
|---|---|
| `/yume reports` | Open moderation queue, ephemeral. |
| `/yume hide <title>` | Set an entry to hidden. |
| `/yume status` | Readiness summary (never raw metrics — see §7). |

**Authorization for these comes from Yume's RBAC, never from Discord server
roles.** A Discord server administrator is not a Yume administrator. The
command resolves Discord user → `oauth_identities` → `users` → the existing
`requirePermission` check. Someone with no linked account, or a linked account
without the permission, gets the same ephemeral refusal.

---

## 4. Architecture

```
Discord ──HTTPS POST──> /v1/integrations/discord/interactions   (Fastify)
                              │
                              ├── verify Ed25519 (raw body) ── bad ──> 401
                              ├── PING (type 1) ─────────────────────> PONG
                              ├── autocomplete (type 4) ── suggest() ─> choices  (inline, <50 ms)
                              ├── fast command ── searchAnime() ──────> embed    (inline)
                              └── slow command ── enqueue('discord') ─> DEFERRED (type 5)
                                                        │
                                              worker ───┴──> PATCH …/messages/@original
```

### Files (mirroring the existing layout)

| Path | Responsibility |
|---|---|
| `server/src/lib/discord-verify.ts` | Ed25519 signature check. Pure, unit-testable. |
| `server/src/lib/discord-rest.ts` | Outbound REST: bucket-aware rate limiting, `429 retry_after`, timeouts. |
| `server/src/lib/discord-embeds.ts` | Domain object → embed. Pure. Shares the colour palette already in `webhooks.ts`. |
| `server/src/lib/discord-commands.ts` | Command definitions + the registration script. Single source of truth. |
| `server/src/routes/discord.ts` | The interactions route. |
| `server/src/workers/discord.ts` | Deferred follow-ups, airing announcements. |
| `db/migrations/00xx_discord.sql` | Tables in §6. |

### The raw-body problem

Fastify parses JSON before the handler runs, but the signature covers the
**exact bytes** Discord sent — re-serializing changes them. This needs a
content-type parser scoped to the interactions route only, keeping the raw
`Buffer` alongside the parsed object. Getting this wrong produces a bot that
works in testing and fails every real signature, so it is called out here
rather than discovered later.

### The 3-second rule

Discord drops an interaction with no response within 3 seconds. The interaction
token then stays valid for 15 minutes for follow-up edits.

The rule this design follows: **answer inline; defer only when the command
touches the network.** Search, detail, schedule and library commands are
Postgres queries measured in single-digit milliseconds — deferring them would
add a visible "thinking…" state for no reason. Anything reaching AniList or an
importer defers via the existing job queue, which already has retries, dedupe
and failure handling.

### Rate limits, both directions

*Outbound:* Discord allows ~50 requests/second globally plus per-route
buckets. `discord-rest.ts` honours `X-RateLimit-Remaining` / `Reset-After` and
sleeps on `429 retry_after` rather than hammering. Announcement fan-out goes
through the job queue, so a thousand subscriptions become a thousand paced
jobs, not a burst.

*Inbound:* every request arrives from Discord's IPs, so the existing
`request.ip` rate limiter would treat the entire world as one client. The
interactions route needs its own limit keyed on the **Discord user id from the
verified payload** — verify first (microseconds), then throttle. Signature
verification must stay outside any limit, because Discord probes the endpoint
with deliberately invalid signatures and expects a 401.

---

## 5. Account linking — no second auth system

The schema already anticipated this: `oauth_identities.provider` accepts
`'discord'`, with a unique constraint on `(provider, provider_uid)`.

```
/link  ──> bot: one-time code + URL, ephemeral, 10 min TTL
       ──> user opens it, signs in to Yume normally (existing auth)
       ──> Discord OAuth2 consent, identify scope only
       ──> row in oauth_identities (provider='discord')
```

The bot never sees a password and never issues a Yume session. The web login
that already exists does the authenticating; the bot only learns which Yume
user a Discord id belongs to.

**Store the Discord user id and nothing else.** The `identify` scope also
returns username, avatar and email — none of which Yume needs, so none of
which gets stored. The schema comment says OAuth tokens are "encrypted at the
app layer"; the cheaper and safer answer is not to keep Discord tokens at all,
since after linking there is nothing to call on the user's behalf.

The link code must be single-use, short-lived, and bound to the Discord user
id that requested it — otherwise a leaked code links the wrong account.

---

## 6. Data model

Four small tables. Everything else reuses what exists.

```sql
-- per-server configuration
discord_guilds (
  guild_id text primary key, announce_channel_id text,
  locale text, nsfw_allowed boolean not null default false,
  linked_by uuid references users(id), created_at timestamptz )

-- pending /link codes: single-use, short-lived
discord_link_codes (
  code text primary key, discord_user_id text not null,
  expires_at timestamptz not null, used_at timestamptz )

-- "tell this channel when this show airs"
discord_subscriptions (
  id uuid primary key, guild_id text, channel_id text,
  discord_user_id text,            -- set instead of channel for DMs
  anime_id uuid not null references anime(id) on delete cascade,
  created_by uuid references users(id), created_at timestamptz )

-- outbound delivery log, mirroring webhook_deliveries
discord_deliveries ( … partitioned monthly, 3-month retention )
```

`discord_deliveries` joins the `PARTITIONED` list in `maintenance.ts`, so
partition creation and retention are handled by machinery that already exists.

**Reused as-is:** `oauth_identities` (linking), `users` / `user_roles` /
`role_permissions` (authorization), `jobs` (deferred work and fan-out),
`notifications` (in-app mirror of a DM), `feature_flags` (kill switch),
`site_settings` (per-install config), `anime` and friends (all content).

**New permissions:** `integrations.discord.manage` for configuring the bot.
Command actions reuse existing slugs. Consistent with the audit rule already
applied in this project: a permission is marked `active` only once a route
genuinely enforces it — never before.

---

## 7. Security and privacy

- **Signature verification before anything else.** No parsing, no logging, no
  DB access until the Ed25519 check passes. Invalid → 401, no body.
- **Timestamp freshness.** Reject signatures older than ~5 minutes so a
  captured request cannot be replayed.
- **Discord roles grant nothing.** Server admin ≠ Yume admin. Every privileged
  action goes through the existing RBAC on the linked Yume account.
- **Ephemeral by default for anything personal.** `/list`, `/link`, `/yume
  reports` reply with flag 64 so a private library is not dumped into a public
  channel by a mistyped command.
- **NSFW gating.** Adult results only in channels Discord marks NSFW, and
  never in DMs initiated by the bot. When the channel's flag is not in the
  payload, filter — default to safe, never to permissive.
- **Spoiler safety.** Episode announcements carry the number and the air date.
  Synopses go inside `||spoiler||`, and episode titles are spoilers for
  ongoing shows more often than people expect — so they are hidden by default,
  per-guild configurable.
- **Never expose operational detail.** `/yume status` returns the same
  green/amber/red readiness summary the public `/v1/health/ready` endpoint
  gives. No hostnames, no IPs, no disk paths, no queue internals, no env
  values — the same rule `probes.ts` already follows with `safeDetail()`.
- **Minimal retention.** Discord user id and subscriptions only. Command
  arguments are not logged. `discord_deliveries` keeps 3 months, like every
  other operational table.
- **Kill switch.** `feature.discord_bot` disables commands instantly without a
  deploy, matching the 23 flags already in place.

### Configuration is capability-aware

`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` and
`DISCORD_CLIENT_SECRET` are all **optional**, exactly like `REDIS_URL` and the
other optional services in `config.ts`. Unset means the routes are not
registered and monitoring reports `not_configured` rather than raising a false
alarm — the pattern `probes.ts` already implements. A deployment that does not
want a Discord bot changes nothing and notices nothing.

Secrets live only in the environment. The bot token is a full account
credential: it must never appear in a log line, an embed, an error response or
the admin UI.

---

## 8. Build order

Each phase is independently useful and independently shippable.

| Phase | Scope | Why this order |
|---|---:|---|
| **1** | Interactions route, signature verification, `/anime`, `/search`, `/airing`, `/random`, autocomplete | Proves the whole transport with zero account or state complexity. Read-only, so the blast radius is nil. |
| **2** | `/link`, `/unlink`, `/list`, `/progress`, `/watching` | Adds identity. Depends on nothing from phase 3. |
| **3** | `episode.aired` event + airing detector, `/notify` | The one piece with new backend logic; the event is worth having regardless of Discord. |
| **4** | `/yume` staff commands, optional role sync on link | Highest privilege, so it goes last, on top of a linking flow that has been in real use. |

Each phase ships with unit tests for the pure parts (signature verification,
embed rendering, command parsing, NSFW/spoiler gating) using the existing
`node:test` runner — no new test dependencies, consistent with the 96 tests
already in the suite.

---

## 9. What this design deliberately does not do

- **No `discord.js`.** Signature verification is ~15 lines of `node:crypto`,
  and REST calls are `fetch`. A dependency that large needs to earn its place.
- **No gateway process**, until a feature actually requires one.
- **No second authentication system.** Discord identifies; Yume authenticates.
- **No storing Discord profile data or OAuth tokens.**
- **No general-purpose bot features** — moderation, levelling, music. They are
  not what this site is for, and each one is a support burden.
- **No rebuilding the announcement path** that the webhook system already
  covers.
