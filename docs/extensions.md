# Yume — Extension platform

Extensions are how Yume finds *sources* (torrents, HTTP streams, NZBs,
subtitles, metadata) — the platform itself hosts no content. The runtime
model is inherited from Hayase (per-extension sandboxed workers, accuracy
capping) and extended with a **store, signed versioned packages, declared
permissions and a review pipeline**.

## Implementation status

The format and permission model described below are **implemented and
enforced**. What is live today:

| Piece | Status |
|---|---|
| Manifest v3 validation | ✅ enforced at publish (`lib/extension-manifest.ts`) |
| Permissions derived from the manifest | ✅ the store never trusts a separate list |
| Permission escalation detection | ✅ reported on every new version |
| Web Worker sandbox | ✅ `web/js/extension-worker.js` + `extension-host.js` |
| `net:fetch` host allowlist | ✅ enforced host-side, credentials omitted |
| `storage:local` isolation | ✅ namespaced and size-capped |
| Package integrity (sha256) | ✅ verified before execution |
| Kill switch + `minAppVersion` | ✅ checked before load |
| Call timeouts + worker teardown | ✅ 10s, wedged workers are replaced |
| Result sanitising + accuracy cap | ✅ enforced in the worker |
| Extension health classification | ✅ from failure telemetry |
| Package upload to object storage | ⏳ the portal still sends a manifest + hash, not bytes |
| Human review queue UI | ⏳ static checks run; the moderator screen is pending |
| `create-yume-extension` scaffold / CLI | ⏳ not built |
| Dev-mode side-loading with hot reload | ⏳ not built |

## Extension types

| Type | Resolves | Entry points |
|---|---|---|
| `torrent` | torrent releases for an episode/batch/movie | `single`, `batch`, `movie` |
| `http` | direct web streams / web seeds | `single`, `batch` |
| `nzb` | Usenet articles | `single`, `batch` |
| `subtitle` | external subtitle tracks | `single` |
| `metadata` | supplemental metadata (episode art, mappings) | `episodes`, `mappings` |
| `theme` | design-token overrides (no code execution) | — |

## Package format

An extension is a signed `.tgz` uploaded through the Developer Portal:

```
my-extension/
├─ manifest.json
├─ index.js          # ESM, default-exports the source implementation
└─ README.md         # rendered on the store page
```

### manifest.json

```json
{
  "manifestVersion": 3,
  "id": "nyaa-search",
  "name": "Nyaa Search",
  "version": "2.1.0",
  "type": "torrent",
  "summary": "Torrent search backed by nyaa.si",
  "icon": "icon.png",
  "accuracy": "medium",
  "media": "both",
  "languages": ["ALL"],
  "minAppVersion": "1.0.0",
  "permissions": {
    "net:fetch": { "hosts": ["nyaa.si", "sukebei.nyaa.si"] },
    "query:ids": {},
    "query:titles": {},
    "storage:local": {}
  },
  "options": {
    "trusted_only": { "type": "boolean", "default": false, "description": "Only trusted uploaders" }
  }
}
```

## Permission model

Declared in the manifest, shown at install time, **enforced by the
runtime** — not trusted:

| Permission | Grants | Enforcement |
|---|---|---|
| `net:fetch` | outbound fetch to `hosts` | the sandbox's `fetch` proxy rejects any other host |
| `query:ids` | external ids (anilist/anidb/tvdb/imdb…) | query object is a recording Proxy |
| `query:titles` | title strings | caps result accuracy at `medium` |
| `query:media` | full media object | caps accuracy at `medium`; flagged in review |
| `storage:local` | namespaced key/value store | isolated per extension id |
| `player:subtitles` | inject subtitle tracks | subtitle type only |

Hayase's accuracy heuristic survives intact: the runtime records which
query fields the code actually touched and computes the maximum accuracy a
result may claim (anidb episode id → `high`; title matching → `medium`);
results are sanitised (hash format, numeric clamps) before leaving the
worker.

## Sandbox

Each installed extension runs in its own **Web Worker** (desktop/mobile:
worker inside the extension host process):

- loaded from the locally cached, hash-verified package
  (`sha256(package) == extension_versions.package_hash`);
- no DOM, no cookies, no credentials; `fetch` is the permission-checked
  proxy; `import()` of remote code is blocked;
- every call has a timeout (10 s) and error isolation — a crashing
  extension surfaces a toast + an `extension_events` report, never takes
  the app down;
- workers are recycled on version updates (old worker released, new one
  spun up, seamless to the user).

### What the sandbox actually enforces

The worker strips every ambient capability before any extension code runs
(`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`,
`Worker`, `SharedWorker`, `indexedDB`, `caches`, `navigator`, `crypto`), so an
extension has no way to reach the network or storage except through the host
bridge. That is defence in depth — **the host re-checks every request** and is
the boundary that actually matters:

| Request | Host-side check |
|---|---|
| `yume.fetch(url)` | `net:fetch` declared; hostname is in the manifest allowlist (exact or subdomain); `http(s)` only; method in GET/POST; `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`; identity headers stripped; 8s timeout; 2 MB response cap (streamed, aborted past the cap); only `content-type` returned |
| `yume.storage.*` | `storage:local` declared; key namespaced `ext:{slug}:{key}`; 64 KB value cap |
| any call | 10s timeout — a hung worker is **terminated and removed**, not left running |
| results | array capped at 200, per-field clamping, unknown keys dropped, torrent hashes format-checked |

**CSP trade-off.** The sandbox worker is a same-origin file (`worker-src 'self'`),
but it imports the hash-verified package as a module from an in-memory blob, so
`script-src` allows `blob:`. This is what makes the executed bytes exactly the
reviewed bytes. It does not grant initial execution — creating a blob already
requires running script — and no remote origin is allowed, so injected code
still cannot be fetched from elsewhere.

## Extension health

The client reports failures (`error`, `load_failure`) and deliberately does not
report successes: one event per extension call would dwarf every other table.
Health is therefore **failures per active install per week**, a rate that stays
comparable as an extension grows:

| Badge | Rate | Meaning |
|---|---|---|
| 🟢 healthy | < 0.1 | under one failure per ten installs per week |
| 🟡 unstable | < 0.5 | under one failure per two installs per week |
| 🔴 broken | ≥ 0.5 | at or above one failure per two installs |
| ⚪ unknown | no installs, no failures | too new to judge |

A brand-new extension reports `unknown` rather than being flattered with a green
badge. Health appears on the store list and detail responses.

## Store & lifecycle

```
draft ──▶ in_review ──▶ published ──▶ (deprecated | suspended)
              ▲                │
              └── new version ─┘
```

1. **Publish**: developer uploads a package via the portal. The
   `ext-review` worker runs static checks (manifest validity, no `eval`,
   no undeclared hosts in string literals, size limits) and queues it for
   human review for first releases / permission escalations.
2. **Review**: `extensions.review` moderators approve or reject with
   notes; approved versions get `published_at` and become installable.
3. **Auto-update**: clients poll `/v1/me/extensions` (or receive a push);
   installs with `auto_update` advance to the newest compatible version.
   Permission escalations always require explicit user confirmation.
4. **Versioning**: semver; `minAppVersion` gates rollout; versions are
   immutable — a bad release is fixed by publishing a new one and
   (optionally) suspending the old.
5. **Kill switch**: `status = suspended` disables the extension remotely
   on every client at next sync (malware/DMCA response path).

## Developer experience

- `npx create-yume-extension` scaffolds a typed project (the
  `AnimeQuery`/`TorrentResult` types ship in the `@yume/extension-kit`
  package generated from the server's types).
- Local dev: the client's Developer Mode side-loads an unpacked directory
  with hot reload — no store round-trip while iterating.
- The portal shows per-version installs, error groups and load-failure
  rates from `extension_events` — developers see breakage before users
  report it.

### Minimal torrent source

```js
export default {
  async test () { return true },

  async single (query, options) {
    // query.anidbEid available because we declared query:ids
    const res = await fetch(`https://nyaa.si/?page=rss&q=${encodeURIComponent(query.titles[0])}+${query.episode}`)
    const items = parseRss(await res.text())
    return items.map(item => ({
      title: item.title,
      link: item.link,
      hash: item.infoHash,
      seeders: item.seeders,
      leechers: item.leechers,
      downloads: item.downloads,
      size: item.size,
      date: new Date(item.pubDate),
      accuracy: 'medium'
    }))
  },

  async batch (query, options) { /* same, batch query */ return [] },
  async movie (query, options) { /* same, movie query */ return [] }
}
```
