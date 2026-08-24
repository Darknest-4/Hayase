# OpenSubtitles

Finds subtitle tracks for the episode being watched and hands the **text**
straight to the player, already converted for the browser.

Needs your own API key from the OpenSubtitles consumer dashboard.

## Why it returns text and not a link

Two things break a subtitle link in a browser, and both apply here:

- a `track` element fetches its own `src`, so the file has to be **CORS-readable
  from the page** — most subtitle services are not;
- browsers render **only WebVTT** in a track, while OpenSubtitles serves SubRip.

The extension already has a proxied fetch, so it downloads the file itself and
returns the text. The engine converts SubRip to WebVTT and gives the player a
blob URL. Both problems disappear — and every other subtitle provider written
against this contract gets the same treatment for free.

If the download link lands on a host this extension has not declared, the proxy
blocks it and the link is offered instead. That may not render, which is worse
than text but better than nothing, and it is visible in the picker rather than
silently absent.

## The quota

Downloads count against your account's daily allowance, and this runs on **every
episode**. Two things keep that in check:

- one download **per configured language**, not per result — the most-downloaded
  candidate wins;
- results are cached for a day, so re-opening an episode does not spend quota
  again. An empty result is deliberately *not* cached: that would hide a
  subtitle that appears later.

`test()` checks the key against `/infos/user`, which needs authentication and
spends no download — so it can tell a wrong key from a dead service.

## Options

| Option | What it does |
|---|---|
| `api_key` | From the OpenSubtitles consumer dashboard. |
| `languages` | Comma-separated, best first. One track per language. |
| `trusted_only` | Only uploads marked trusted. Fewer results, fewer mistimed files. |
| `user_agent` | Identifies this client, as their API requires — requests without one are rejected in a way that reads like an auth failure. |

## Accuracy

Reported as `medium`, deliberately. The search key is a title plus an episode
number, and the only quality signal the API offers is download count. That
correlates with a file being correctly timed but does not guarantee it.

## A bug the tests caught

`srtToVtt()` prepends a `WEBVTT` header, so empty input converted to a non-empty
string — an empty subtitle would have been attached as a valid track with no
cues. The check now looks at the source text rather than the converted text.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-opensubtitles.test.mjs
```
