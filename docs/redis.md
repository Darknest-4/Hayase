# Redis — why it is not adopted yet

`docker-compose.yml` carries a Redis service under the `infra` profile, and
`config.ts` reads `REDIS_URL`. **No code uses it.** That is a decision, not an
oversight, and this page records it so nobody has to re-derive it.

The same standard was applied to OpenSearch (`docs/search.md`): infrastructure
earns its place by solving a problem that exists now.

## The two jobs waiting for it

**1. Caching the permission lookup.** `requirePermission` runs a three-table
join on every privileged request, with no cache — the plugin's comment claims a
per-request memo that was never implemented. On one instance this is a local
problem with a local fix: an in-process TTL cache removes the query without any
new infrastructure. Redis only becomes the right answer when several instances
must share and invalidate the same cache.

**2. Backing the WebSocket hub.** `lib/ws.ts` keeps subscriptions in an
in-process `Map`. Two app instances would not error — they would quietly
half-work: notifications reaching only one instance's clients, watch-together
rooms splitting in two, half of a chat's messages vanishing. `publish()` is a
single deliberate seam, so a Redis pub/sub adapter drops in there without
touching any call site.

## Why not now

Yume runs on one VPS with one app instance. In that shape Redis adds a resident
service, a cache-invalidation bug class, and a second thing that can be down —
in exchange for nothing measurable. The in-process `Map` is *correct* for one
instance; it is only wrong for two.

## When to adopt it

Adopt Redis at the point a second app instance is actually being started —
because at that moment the WebSocket hub silently breaks, and silent breakage
is the worst kind. That is the trigger. Not sooner.

Order of work when it comes:

1. Redis pub/sub behind `publish()` in `lib/ws.ts` — the correctness fix.
2. Shared permission cache in `plugins/auth.ts` — the performance fix, once
   an in-process cache is no longer enough.

Until then, `REDIS_URL` being set does exactly one thing: it turns on the
health probe in `lib/probes.ts`. Unset, that probe reports `not_configured`
rather than raising a false alarm.
