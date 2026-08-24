# AniSkip

Supplies opening and ending intervals for an episode, which the player turns
into the **Skip intro** button and the auto-skip setting.

## Why it is an extension now

The client used to call `api.aniskip.com` directly from the watch page with a
raw `fetch`, hardcoded. That worked — and it also meant the feature could not be
turned off, could not be replaced by another provider, bypassed the sandbox's
host allowlist and request proxy, and its failures were invisible to the
developer portal.

As a `metadata` extension it is ordinary: declared host, proxied requests,
reported errors, and someone can ship a different skip provider without touching
the client.

## What it returns

Flat metadata records, the only shape that crosses the sandbox:

```js
{ kind: 'skip', skipType: 'op' | 'ed', start: 12.5, end: 102.3 }
```

## Options

| Option | What it does |
|---|---|
| `types` | Fetch openings and endings, or only one of them. |
| `min_length` | Ignore intervals shorter than this many seconds. |

`min_length` is not fussiness: a one-second "opening" is a bad submission, and a
skip button that jumps nowhere is worse than no button. Intervals that end
before they start are dropped outright — the button seeks to `end`, so a
backwards interval would move the viewer backwards without being asked.

## Limits

AniSkip is keyed on **MyAnimeList ids** and nothing else. A title without one
gets no skip data, and that is the honest answer: guessing an id from a title
would produce intervals from a different show.

`episodeLength=0` is sent deliberately — passing a wrong runtime makes AniSkip
return nothing at all, and the player knows the real duration anyway.

## The built-in fallback

The client asks metadata extensions first and falls back to its own AniSkip call
when none answers. Removing the built-in path entirely would have read more
cleanly and behaved worse: the skip button would silently disappear for everyone
who has not installed an extension, which is a regression dressed as a refactor.

## Tests

```sh
node --experimental-strip-types --test web/test/extension-aniskip.test.mjs
```
