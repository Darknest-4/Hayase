# SEO — what a crawler, a link preview and a share sheet see

Yume's client is a hash router. `#/anime/21` is a *fragment*, and a fragment is
never sent to the server. For as long as that was the only spelling of a route,
the only `<head>` anything outside a browser could read was `web/index.html`'s
generic one — so every anime ever shared to Discord, Slack, Twitter or a search
index looked identical:

> **Yume** — Yume — anime tracking and discovery.

That is the whole problem this layer solves, and it is solved without adding
server-side rendering: there is no second frontend here, and the page a browser
receives is the same `index.html` it always was.

---

## 1. Two spellings of one route

| URL | Who uses it | What the server sees |
|---|---|---|
| `#/anime/21` | the app's own links | nothing — the fragment stays in the browser |
| `/anime/21` | the sitemap, shared links, crawlers | the id, so it can answer with real metadata |

`server/src/routes/seo.ts` answers the second with `index.html` and a `<head>`
about *that* anime. `web/js/app.js` understands both (`parseHash()` falls back
to `location.pathname`) and rewrites the path form into the hash form on arrival
(`normalisePath()`), so a human never ends up with two URLs for one page.

Two consequences worth knowing about:

* **`index.html` references its assets from the root** (`/js/app.js`, not
  `js/app.js`). A relative reference resolves against the document, so on
  `/anime/21` the browser asked for `/anime/js/app.js` — and the SPA fallback
  answered every one of those with `index.html`, a `200` of the wrong media
  type. The page loaded with no scripts and no styles at all. `web/test/
  path-routes.test.mjs` fails if a relative reference comes back.
* **The `<!--yume:seo-->` … `<!--/yume:seo-->` markers in `index.html` are
  load-bearing.** The per-page head replaces what is between them. If they are
  removed the replacement silently does nothing and every page gets the generic
  head again — which is exactly the bug this layer exists to fix, so there is a
  test for their presence too.

## 2. What is published

`GET /robots.txt` — generated, not a file, so the `Sitemap:` line carries the
right origin and a private instance can say "none of this" without anyone
remembering to edit a file.

`GET /sitemap.xml` — the static pages plus public, non-adult catalogue entries,
most popular first, `lastmod` from each row's own `updated_at`. Capped by
`SITEMAP_MAX_URLS` (default 10 000; the protocol's own ceiling is 50 000).

`GET /anime/:id` — the app, with `<title>`, description, canonical, Open Graph,
a Twitter card and a `schema.org` JSON-LD block built from the catalogue row.
The id may be an AniList id or a Yume uuid, the same two forms the client
accepts.

## 3. What is **not** published

| Not published | Why |
|---|---|
| `visibility = 'hidden'` entries | `404`, and absent from the sitemap |
| `visibility = 'unlisted'` entries | reachable by direct link — that is what unlisted means — but `noindex`, and absent from the sitemap |
| `is_adult` entries | `noindex` and absent from the sitemap |
| `/admin`, `/settings`, `/dashboard`, `/list`, `/profile`, `/w2g`, `/watch`, `/notifications` | ordinary client routes that the SPA fallback answers with `200` HTML. Without help they are indexable, which puts an instance's admin panel in a search index. Disallowed in `robots.txt` **and** answered with `X-Robots-Tag: noindex`, because a crawler that reads only one of the two exists in both directions |
| `/v1`, `/graphql`, `/graphiql`, `/ws` | same header, same reason |
| everything, on a private instance | when `require_login` is on, `robots.txt` is `Disallow: /`, the sitemap is a `404`, and `/anime/:id` publishes no title — a link preview that leaked one would be a hole straight through the login gate |

## 4. Two things that can go wrong, and what stops them

**Injection.** Titles and synopses come from AniList and MAL — text this
project does not control — and they are interpolated into HTML, into
double-quoted attributes, and into a `<script type="application/ld+json">`
block. Three contexts, three ways to get it wrong, one consequence: a catalogue
row becomes script execution in every visitor's browser. `lib/seo.ts` escapes at
the point of use (`escapeHtml`, `jsonLdScript` — the latter escapes `<`, `>`,
`&` and U+2028/9 to their `\u` forms so `</script` cannot end the block), and
most of `server/test/seo.test.ts` is injection attempts.

**Canonical poisoning.** With no `PUBLIC_URL` the canonical link and the
`Sitemap:` line are built from the `Host` header, which the *client* chooses. A
crawler following a link with a forged `Host` would be told these pages really
live on someone else's domain. So:

* **Set `PUBLIC_URL` on any internet-facing deployment.** The Security Center's
  `public-url` check warns when it is missing in production.
* The fallback validates the header against a hostname shape and otherwise uses
  `SELF_URL` rather than echoing what it was handed.

## 5. Configuration

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | derived from the request | The site's public address. Set it. |
| `SITEMAP_MAX_URLS` | `10000` | How many catalogue entries the sitemap lists |

## 6. Where it lives

| File | Role |
|---|---|
| `server/src/lib/seo.ts` | escaping, origin resolution, the head block, the `index.html` template cache, `noIndexPath` |
| `server/src/routes/seo.ts` | `/robots.txt`, `/sitemap.xml`, `/anime/:id` |
| `server/src/app.ts` | registers the routes; the global `X-Robots-Tag` hook |
| `web/index.html` | the replaceable head block, root-absolute asset references |
| `web/js/app.js` | `parseHash()` path fallback, `normalisePath()`, `setTitle()` |
| `server/test/seo.test.ts` | escaping, what is refused, the origin |
| `web/test/path-routes.test.mjs` | the router's half of the agreement |
