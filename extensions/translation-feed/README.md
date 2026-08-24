# Translation Feed

Shows Hungarian titles and descriptions from a JSON feed you publish, on the
detail pages where the catalogue has no translation of its own.

## What it does not do

It does not import anything. Extensions run in the viewer's browser, inside a
worker with no database access — nothing here can write to `anime_translations`,
and a translation shown by this extension is gone the moment it is uninstalled.

That is a real limit, not an oversight: importing a translation set is a
server-side job, and an extension that appeared to import would produce text
that vanished on the next reload for everyone but the person who installed it.

What this is good for is the case where the catalogue is not where your text
lives: trying a translation set out before committing it, or serving one a
group maintains in their own repository.

## The feed

Either shape works:

```json
{
  "16498": {
    "title": "A támadó titánok",
    "description": "Több mint száz éve az emberiség…",
    "episodes": { "1": "Neked, kétezer év múlva" }
  }
}
```

```json
{
  "language": "hu",
  "anime": {
    "16498": { "title": "A támadó titánok" }
  }
}
```

Keys are AniList ids — the same id the detail page already has, so no matching
or guessing happens anywhere. A title with no AniList id gets nothing, which is
correct: matching by name would attach one show's synopsis to another.

`language` in the wrapped form wins over the extension's own option, because
the feed knows what it contains and the option is a guess by whoever installed
it.

## Where the text appears

Only where the catalogue has nothing in the language you asked for. Every
localised payload from the server carries `_lang`, saying which language each
field actually resolved to; if the synopsis already came back Hungarian, the
feed's version is ignored. An extension outranking editorial text in the
catalogue would be backwards.

When the feed does supply a synopsis, the "not translated yet" line above it
disappears with it.

## Setting it up

1. Publish the JSON somewhere reachable over HTTPS.
2. Change `net:fetch.hosts` in `manifest.json` from `feed.example.com` to your
   host, and republish the extension. The host allowlist is enforced by the
   platform, not by this code — a feed URL on a host the manifest does not
   declare is refused before the request leaves the browser.
3. Install it and set **Feed URL** in the extension's options.

## Caching, and why it looks the way it does

The parsed feed is held in memory for `refresh_minutes` (60 by default), so a
library-sized feed is fetched once per session rather than once per page.

It is not written to storage: `storage:local` caps a value at 64 KB and a real
feed is much larger. What *is* stored is the single entry each page used, so a
title you looked at yesterday still reads correctly if the feed is down today.

The host caps any single response at 2 MB. A feed larger than that fails to
load — split it, or serve the subset you actually have translations for.

## Testing it

`node --test web/test/extension-translation-feed.test.mjs`
