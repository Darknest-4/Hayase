# Streaming engine

The layer between "the catalogue has a reference" and "the player has a video".

```
Source → Resolver → StreamResult → Player
```

Candidates are what the deployment registered for the episode (`video_sources`,
best priority first) plus any URL the viewer pasted. The player does not know
or care which: everything becomes one `StreamResult` shape, gets ranked, and is
tried in order — if a stream fails to start the engine moves to the next
candidate instead of showing the user a dead end.

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
| `source` | `{ slug, name, accuracy, health }` — the provider's name as the viewer sees it |
| `playable` / `reason` | whether this runtime can play it, and why not |
| `metadata` | `title`, `seeders`, `size` |

Every field is coerced and bounded during normalisation, and a result without a
URL is dropped. The records come from the catalogue and from what a viewer
typed, and neither is a reason to trust a shape.

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

A source the operator registered ranks as `high` accuracy: somebody who runs
the deployment attached that link to that episode by hand, which is a stronger
claim than a string typed into a box once.

## Automatic fallback

```js
const { results } = await StreamEngine.candidates(media, episode, { sources, prefs })
const { candidate } = await StreamEngine.play(video, results, {
  onFallback: (failed, reason) => toast(`${failed.source.name} failed — trying the next`)
})
```

A candidate counts as working once the browser reports it can play. An error
event, an expired link, or silence past `START_TIMEOUT_MS` (12s) moves on to the
next one. Only when every candidate is exhausted does `play()` throw — with the
full `attempts` trail so the UI can explain what happened.

A failure is logged to the console. There is no health column on
`video_sources` yet, so a source that stops working does not sink in the
ranking on its own — an operator disables it, which is what the `enabled` flag
is for.

## In the player

`web/js/pages/watch.js` builds the candidate list from:

* the episode's registered sources, best priority first, and
* the `?src=` parameter — **one URL per line**, so fallback works for a pasted
  source too.

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
* **An episode with no registered source is not offered**: the episode list
  dims it and removes the link rather than opening a player that has nothing to
  play.
* **No source health**: a dead link stays in the rotation until somebody
  disables it.
