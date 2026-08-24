# Yume Library

Plays episodes from a server **you** run — your own uploads, your own Hungarian
subtitles.

This is the piece that makes Yume actually play video. The platform hosts no
content by design; sources are resolved at watch time by sandboxed extensions,
and this is one. It reaches exactly one host: the one you configure in its
options. It does not search the internet, it carries no list of sites, and it
has no fallback anywhere else — if your server does not have the file, it
returns nothing.

The sandbox enforces that: an extension can only reach hosts its `manifest.json`
declares, so pointing it somewhere else means saying so in the manifest and
being reviewed on it.

## Setting it up

1. Edit `manifest.json` and put **your** hostname in
   `permissions."net:fetch".hosts`. The sandbox rejects every other host, so
   this is not optional.
2. Install the extension (developer mode side-loads this directory directly —
   no store round-trip while you are iterating).
3. Set the options:

| Option | What it does |
|---|---|
| `base_url` | Your server. Must match the host in the manifest. |
| `index_path` | A JSON index, below. Leave empty to use the pattern instead. |
| `pattern` | Path template. `{anilistId}` `{malId}` `{episode}` `{episodePadded}` `{title}` `{slug}` |
| `subtitle_pattern` | Where the subtitle file sits. Empty if your files carry embedded subtitles. |
| `subtitle_language` | Language of that subtitle file. |
| `audio_language` | **Set this to `hu` for a dub.** It is what makes the sub/dub switch pick correctly. |
| `quality` | Reported resolution. Ranking only. |
| `verify` | Check the file exists before offering it. Leave on. |

## Two ways to find a file

**An index** — a JSON file on your server. Use this one. It survives irregular
naming, split seasons and specials, all of which break a path pattern.

```json
{
  "16498": {
    "3": {
      "url": "/aot/s1e03-1080p.mkv",
      "quality": "1080",
      "audio": "ja",
      "subtitles": [
        { "url": "/aot/s1e03.hu.vtt", "lang": "hu", "label": "Magyar" }
      ]
    }
  }
}
```

The key is the AniList id (MyAnimeList id also works), then the episode number.
Everything except `url` is optional and falls back to your options. Paths may be
relative to `base_url` or absolute. The index is fetched once and cached for ten
minutes, not per episode.

**A pattern** — no file to maintain, but it only works when your naming is
perfectly regular:

```
/anime/{anilistId}/{episodePadded}.mp4
/anime/{anilistId}/{episodePadded}.hu.vtt
```

If both are configured the index wins.

### One behaviour worth knowing

An index that **cannot be read** (missing, 500, malformed) falls back to the
pattern — you may well have the file. An index that **is** read and has no entry
for an episode offers nothing, because the index is your statement of what you
have, and guessing past it produces a link to a file you never uploaded.

## How it fits the rest

- `audio_language` (or `audio` per index entry) drives the **sub/dub switch**
  under the player. `ja` with subtitles is a sub, `ja` without is a raw,
  anything else is a dub.
- Subtitle tracks come back with the source, so the **subtitle picker** in the
  player has something to pick, and `playback.subtitles` selects the right one
  by language automatically.
- `test()` reports whether *your server* is reachable, so the portal can tell
  you "your server is down" rather than "this extension is broken".

## Tests

`web/test/extension-library.test.mjs` runs the module with `yume` bound to a
fake host, and validates `manifest.json` with the server's own validator — the
same one the publish endpoint uses, so a manifest that would be rejected at
publish time fails the test instead.

```sh
node --experimental-strip-types --test web/test/extension-library.test.mjs
```
