# Streaming engine

The layer between "an extension found something" and "the player has a video".

```
Extension → Source → Resolver → StreamResult → Player
```

The player does not know or care which extension produced a stream. Everything
becomes one `StreamResult` shape, gets ranked, and is tried in order — if a
stream fails to start the engine moves to the next candidate instead of showing
the user a dead end.

Lives in `web/js/stream-engine.js` (`window.StreamEngine`).

---

## StreamResult

Every candidate, whatever produced it, is normalised into:

| Field | Meaning |
|---|---|
| `url` | where the stream is |
| `kind` | `direct` · `hls` · `dash` · `magnet` · `unknown` (derived from the URL) |
| `container` | optional MIME hint used for a `canPlayType` check |
| `quality` | resolution, parsed from the source or from the release title |
| `audio` | audio track label, when the source says |
| `subtitles[]` | `{ url, label, lang }` — attached to the player as `<track>` |
| `headers` | recorded, **not applied** in the browser (a `<video>` cannot send custom headers; the desktop client can) |
| `expiresAt` | epoch ms; an expired candidate is skipped without being tried |
| `mode` | `direct` or `proxy` |
| `source` | `{ slug, name, accuracy, health }` — who produced it |
| `playable` / `reason` | whether this runtime can play it, and why not |
| `metadata` | `title`, `seeders`, `size` |

Extensions are untrusted, so every field is coerced and bounded during
normalisation, and a result without a URL is dropped.

## Playability is decided up front

Nothing is "tried and hoped":

* **`magnet:`** → not playable in a browser (`torrent sources need the desktop client`).
* **HLS / DASH** → playable only if the browser reports native support **or** a
  handler is registered (see below).
* **`direct`** → checked against `canPlayType` when a container is known.
* anything else → `unrecognised stream URL`.

Unplayable candidates are ranked last and skipped with their reason, so the
message the user eventually sees is the real one.

### Pluggable format handlers

The engine ships **no media dependency**. To add a format, register an adapter:

```js
StreamEngine.registerHandler('hls', (video, result) => {
  const hls = new Hls(); hls.loadSource(result.url); hls.attachMedia(video)
  return () => hls.destroy()          // teardown, called on fallback
})
```

Registering a handler flips that format's `playable` to true. Until then HLS is
honestly reported as unsupported rather than failing inside the player.

## Ranking

Best candidate first:

1. **playable** before unplayable — never waste an attempt
2. **source health** (🟢 healthy › unknown › unstable › 🔴 broken)
3. **accuracy** of the match (high › medium › low)
4. **quality** (resolution)
5. **seeders**

Source health comes from the extension platform, so a source that has been
failing for other users is tried last automatically.

## Automatic fallback

```js
const { results } = await StreamEngine.candidates(media, episode, { sources, extensions })
const { candidate } = await StreamEngine.play(video, results, {
  onFallback: (failed, reason) => toast(`${failed.source.name} failed — trying the next`)
})
```

A candidate counts as working once the browser reports it can play. An error
event, an expired link, or silence past `START_TIMEOUT_MS` (12s) moves on to the
next one. Only when every candidate is exhausted does `play()` throw — with the
full `attempts` trail so the UI can explain what happened.

Each failure is also reported as extension telemetry, so a source that stops
working degrades its own health and sinks in the ranking for everyone.

## In the player

`web/js/pages/watch.js` builds the candidate list from:

* the `?src=` parameter — **one URL per line**, so fallback works with manual
  sources today, and
* every extension currently loaded in the sandbox.

The old behaviour (a stream error dumped the user straight to the source picker)
is gone: the picker is now only reached after every candidate has been tried.

## Scope

The engine plays what a source hands it. It does not scrape, does not work
around provider access controls, and ships with no sources of its own.

## Known limitations

* **HLS/DASH need a handler** in Chromium-based browsers — none is bundled, to
  avoid a dependency that most deployments would not use.
* **Custom headers are not applied** in the browser; they are carried for the
  desktop client.
* **Torrent/magnet candidates are surfaced but not playable** in the browser.
* **Extension-supplied sources need package delivery**: the sandbox and the
  engine are wired together, but published packages are not yet served as bytes
  (`package_key` points at object storage that is not deployed), so today the
  engine's extension path only works for side-loaded extensions. See
  `docs/extensions.md`.
