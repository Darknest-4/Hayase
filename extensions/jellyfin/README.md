# Jellyfin / Emby

Streams episodes from a Jellyfin **or Emby** server you have an account on — and it returns
**the actual video**, not a link to somewhere else. Jellyfin's
`/Videos/{id}/stream` serves the file, so the player gets a real stream with the
audio and subtitle tracks the file carries.

It reaches one host: the one in its manifest. The sandbox enforces that, so it
cannot wander.

## One extension, two servers

Jellyfin forked from Emby and kept its API — the same search, the same episode
walk, the same stream endpoint, and the same `X-Emby-Token` header, which
Jellyfin still calls that. A second near-identical package would double the
surface to keep in step for no behavioural gain, so this one serves both.

## Setting it up

1. Get an API key — Jellyfin: **Dashboard → API Keys → New**. Emby:
   **Advanced → API Keys**. The key grants access to your
   library — treat it like a password.
2. In `manifest.json`, replace `jellyfin.example.com` in
   `permissions."net:fetch".hosts` with **your** server's hostname. The sandbox
   rejects every other host, so this is not optional.
3. Install the extension and fill in `server_url` and `api_key`.

| Option | What it does |
|---|---|
| `server_url` | Your Jellyfin server. Must match the manifest host. |
| `api_key` | From Dashboard → API Keys. |
| `user_id` | Optional. Restricts results to one user's view of the library. |
| `max_height` | Resolution ceiling. Only used when transcoding. |
| `subtitle_format` | `vtt` — browsers render nothing else. Change only if you know why. |
| `allow_transcode` | Off by default. Direct play is what most libraries can serve, and transcoding is expensive. |

## How it finds your episode

**By provider id first.** Jellyfin stores external ids on each series
(`ProviderIds`), so when its metadata agent has filled them in, the match is on
AniList / AniDB / MyAnimeList — exact, and the only thing that justifies
claiming `high` accuracy.

**By title as a fallback**, reported as `medium`. That is not modesty: Jellyfin's
search is fuzzy, "Attack on Titan" matches several series, and seasons are
separate items. A title match is a guess, and the engine ranks it below an
exact one.

If your matches are wrong, the fix is in Jellyfin rather than here — install the
AniList or AniDB metadata plugin so your series carry ids.

### A known limit

Jellyfin numbers episodes **within a season**; the query carries an **absolute**
number. For a one-season show they agree. For split seasons and specials they
can disagree, and this takes `IndexNumber` across the flat episode list, which
is the closest honest reading. That is part of why a title match reports
`medium` — a wrong episode is worse than no episode.

## What comes back

- **The stream**, direct-play by default (`static=true`).
- **One candidate per media source** — the same episode as 1080p and 720p is two
  candidates, and the engine ranks them.
- **Audio language**, normalised from Jellyfin's `jpn`/`hun`/`eng` to `ja`/`hu`/`en`.
  This is what the **sub/dub switch** reads: Japanese audio with subtitles is a
  sub, without is a raw, anything else is a dub.
- **Text subtitle tracks**, converted to vtt by Jellyfin, so the **subtitle
  picker** works and `playback.subtitles` selects by language automatically.
  Image-based tracks (PGS, VOBSUB) are skipped — they cannot render in a
  `track` element, and offering one produces a button that does nothing.

## About the API key in URLs

API calls send the key as an `X-Emby-Token` header. The stream and subtitle URLs
cannot: a `video` element fetches those itself and browsers give no way to
attach headers to it, so Jellyfin's own `api_key` query parameter is the only
option. Those URLs stay in your browser and point at your server — but it is a
credential in a URL, and that is worth knowing rather than discovering. The test
suite asserts both halves so the split stays deliberate.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-jellyfin.test.mjs
```

Runs the module against a fake Jellyfin, and validates `manifest.json` with the
server's own validator — the same module the publish endpoint uses.
