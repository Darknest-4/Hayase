# Hayase — HTML/CSS/JS build (`html-web` branch)

This branch is a rebuild of the Hayase interface using **only plain HTML, CSS and JavaScript** — no framework, no build step, no dependencies. Open `index.html` and it works.

The `master`/main branch keeps the original Svelte application untouched.

## Running

No build needed. Either open `index.html` directly, or serve the folder:

```sh
# any static server works
python3 -m http.server 8080
# or: npx serve .
```

## What it does

Everything is fetched live from public APIs, exactly like the original app:

| Source | Used for |
|---|---|
| [AniList GraphQL](https://docs.anilist.co) | search, trending/popular sections, anime details, relations, characters, recommendations, airing schedule |
| [Jikan v4 (MyAnimeList)](https://docs.api.jikan.moe) | episode list fallback via MAL id |
| [ani.zip](https://api.ani.zip) | episode titles, thumbnails, air dates, id mappings |
| filler-scrape | filler episode markers |

Features:

- **Home** — hero banner, Continue Watching, Your List, Popular This Season, Trending, genre rows
- **Search** — full-text + genre/season/year/format/status/sort filters, pagination
- **Anime page** — banner, info, genres, trailer (YouTube), episode list with thumbnails/air dates/filler flags, official streaming links, relations, characters, recommendations
- **Schedule** — weekly airing calendar grouped by day
- **My List** — watching/planning/completed/… statuses, episode progress, favourites; stored in `localStorage`, with JSON export/import
- **Quick search** — `Ctrl+K` or `S`
- **Settings** — themes (dark/light/catppuccin — same palettes as the app), NSFW toggle, cache and data management
- API responses cached in `localStorage` to respect rate limits

## Not included

Torrent playback, watch-together, IRC chat and extensions need the native (desktop) client and its Node backend — a plain static page cannot torrent. Episode "watch" clicks track your progress instead, and official streaming links are shown when AniList has them.
