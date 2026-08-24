# Plex

Streams episodes from a Plex Media Server you have access to, and returns **the
original file** rather than a transcode.

## Why this is its own package, when Jellyfin and Emby share one

Jellyfin forked from Emby and kept its API, so one extension serves both. Plex
is genuinely different:

| | Jellyfin / Emby | Plex |
|---|---|---|
| auth | `X-Emby-Token` | `X-Plex-Token` |
| results | plain JSON | wrapped in `MediaContainer` |
| format | JSON | **XML unless you ask for JSON** |
| the file | `/Videos/{id}/stream` | `{Part.key}` — the file itself |

That last row is the one that matters: Plex hands you a path to the actual file,
so playback is direct by default with no transcode to configure.

## Setting it up

1. Get an `X-Plex-Token` for your account (Plex documents how; it is visible in
   the XML of any item's "Get Info" view).
2. In `manifest.json`, replace `plex.example.com` in
   `permissions."net:fetch".hosts` with **your** server's hostname. The sandbox
   rejects every other host.
3. Install and fill in `server_url` and `token`.

| Option | What it does |
|---|---|
| `server_url` | Your server, port included — usually `:32400`. |
| `token` | `X-Plex-Token`. Treat it like a password. |
| `section` | Optional library section key. Empty searches every show library. |
| `max_height` | Reported resolution when Plex does not say. Labelling only. |

## How it finds your episode

**By external id first.** Plex records ids on a show in two formats, and both
are read:

- the legacy agent guid — `com.plexapp.agents.hama://anidb-1234`, which is what
  **anime libraries carry**, since HAMA is the usual agent for them;
- the modern `Guid` array — `tvdb://`, `tmdb://`, `anidb://`.

An id match reports `high`. **By title** as a fallback, reported as `medium`:
Plex's search is fuzzy and seasons are separate items, so it is a guess.

### A known limit

`allLeaves` returns every episode flat, and the query carries an absolute
number while Plex's `index` is per season. For a single-season show they agree;
for split seasons they can disagree. That is part of why a title match only
claims `medium` — a wrong episode is worse than no episode.

## Subtitles

Only streams with a `key` are offered — an embedded track has no URL of its own
and an image-based one (PGS) cannot render in a `track` element. Either would
produce a subtitle button that does nothing. The format is passed along so the
engine converts SubRip to WebVTT before handing it to the player.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-plex.test.mjs
```
