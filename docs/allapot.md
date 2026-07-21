# Yume — Projekt állapot & referencia

> Részletes, naprakész leírás arról, **mi van kész**, **mi van hátra**,
> **milyen táblák**, **milyen funkciók**, és **miket használunk**.
> Frissítve: 2026‑07‑21.

A magas szintű, elrendezés‑központú áttekintés a [`attekintes.md`](./attekintes.md)‑ben van;
ez a dokumentum a **műszaki állapotot** és a **teljes leltárt** tartja számon.

---

## 1. Egy mondatban

A **Yume** egy adatbázis‑vezérelt anime‑streaming platform (a Hayase kliensből
kinőve): keretrendszer nélküli web‑kliens + Fastify/TypeScript API +
PostgreSQL 16, saját fiók‑, közösségi‑, moderációs‑, statisztika‑ és
bővítmény‑rendszerrel.

### Mit használunk (tech stack)

| Réteg | Technológia |
|-------|-------------|
| **Web kliens** | Keretrendszer nélküli HTML/CSS/JS SPA (`web/`), saját hash‑router (`app.js`), `U.el()` DOM‑helper, design tokenek (`web/css/tokens.css`) — fekete háttér, rózsa akcent, Nunito, keskeny ikon‑sidebar |
| **API** | Fastify + TypeScript, Node 22 `--experimental-strip-types` (natív TS, build nélkül), JSON‑Schema validáció |
| **Auth** | `@fastify/jwt` access token (15 perc) + forgó refresh token (30 nap), RBAC `fastify.requirePermission(slug)` |
| **GraphQL** | `mercurius` (a REST mellett) |
| **Realtime** | `@fastify/websocket` — értesítés, chat, watch‑together |
| **Adatbázis** | PostgreSQL 16, `pg` pool, saját migrációs futtató (`server/src/lib/migrate.ts`), havi particionált log‑táblák |
| **Háttérmunka** | Job queue + worker‑ök (statisztika, import, review, webhook‑kézbesítés) |
| **Katalógus‑adat** | Böngészéskor AniList/Jikan/ani.zip közvetlenül (localStorage cache); a saját DB 25 672 animével + 388 611 epizóddal seedelve |

**Adatmennyiség most:** 25 672 anime · 388 611 epizód · 14 felhasználó ·
387 jogosultság · 6 szerepkör · 23 feature‑flag · **107 tábla**.

---

## 2. Mi van kész ✅

### Alap platform
- [x] **Fiókrendszer** — regisztráció, bejelentkezés, JWT + forgó refresh, eszköz/sesszió‑kezelés, OAuth identitások táblái
- [x] **Katalógus‑böngészés** — home, kereső (full‑text + trigram, elgépelés‑tűrő), szezon/év/műfaj szűrők, ütemterv (schedule), anime‑details, kapcsolatok/ajánlások
- [x] **Lejátszó** — Netflix‑szerű chrome az oldal akcentjével, közép ±10s, Yume‑loader indításkor/bufferelésnél, automatikus **AniSkip** (opening/ending auto‑skip)
- [x] **Könyvtár** — listák/haladás modellje a DB‑ben (`library_entries`, `watch_progress`, `watch_history_*`)
- [x] **Közösség** — kommentek (like, spoiler, thread), közösségi feed
- [x] **Watch Together** — szobák, chat, szinkron lejátszás (WebSocket)
- [x] **Bővítmény‑store** — extension‑ök, verziók, review, telepítés, fejlesztői portál
- [x] **Profilok** — „ki nézi" váltó, per‑profil statisztika, achievement/badge modell
- [x] **Analitika/Dashboard** — platform‑áttekintés, trending, hibacsoportok, napi rollup

### Admin & üzemeltetés
- [x] **Admin oldal újratervezve** — kétoszlopos shell: dedikált másodlagos bal sidebar (Overview / Users / Reports / **Catalogue** / Roles / Webhooks / Site Config) + jobb oldali tartalom, in‑place szekcióváltással
- [x] **Felhasználó‑kezelés** — keresés, felfüggesztés/tiltás
- [x] **Moderáció** — jelentés‑sor, feloldás
- [x] **Webhook‑ok** — kimenő integrációk, Discord‑embed render, kézbesítési napló, teszt‑tüzelés

### #6 — Finomhangolt jogosultsági rendszer (RBAC)
- [x] **387 jogosultság** 14 csoportban (`resource.action` minta)
- [x] **6 szerepkör** értelmes kiosztással: `admin` (387), `moderator` (100), `editor` (96), `developer` (48), `analyst` (23), `user` (1)
- [x] **Roles admin UI** — szerepkör‑sín + csoportosított jogosultság‑katalógus, per‑jogosultság kapcsoló, „Grant/Revoke all" csoportonként, szűrő; az `admin` szerep védett (mindig mindent birtokol)

### Adatbázis‑vezérelt site‑konfiguráció / feature‑flag rendszer
- [x] **Oldalanként és funkciónként ki/be kapcsolható** minden a DB‑ből (`feature_flags`)
- [x] **Hozzáférési szint flagenként**: `public` / `auth` (bejelentkezés) / `permission` (adott jogosultság)
- [x] **Az egész oldal bejelentkezéshez köthető** (`site_settings.require_login`), a Settings mindig elérhető marad
- [x] **Admin Site Config UI** — globális kapcsolók (require_login, registration_open), szövegek (site_name, tagline), per‑oldal/funkció flag‑sorok access‑dropdownnal + kapcsolóval
- [x] **Kliens‑oldali gate** — `App._gateCheck()` letiltott/zárolt oldalnál gate‑képernyőt mutat és elrejti a nav‑elemet

### Katalógus‑kezelés + láthatóság (legutóbb elkészült)
- [x] **Anime lista/keresés** az adminban (a rejtett bejegyzéseket is látja)
- [x] **Anime hozzáadás / szerkesztés / törlés** teljes metaadat‑szerkesztővel
- [x] **Láthatóság (`visibility`)**: `public` (mindenhol) · `unlisted` (csak direkt linkkel) · `hidden` (**sehol**, a detail végpont is 404)
- [x] **Epizód hozzáadás / szerkesztés / törlés** (szám, cím, dátum, hossz, filler/recap, synopsis)
- [x] A publikus `/v1/anime` végpontok (browse, search, schedule, detail, episodes) mind **szűrnek** a láthatóságra

---

## 3. Mi van hátra / tervben 🔜

A felhasználó által kért sorrend (a #6 kész, ezek jönnek „folytasd"‑ra):

1. **#1 — DB library‑sync**: a kliens könyvtár/haladás/folytatás szinkronizálása a DB‑be bejelentkezéskor (a táblák [`library_entries`, `watch_progress`] már megvannak, a kliens‑kötés hiányzik)
2. **#2 — Reviews** (értékelések): a `reviews`, `review_votes` táblák megvannak, UI+API hátra
3. **#3 — Custom lists / Collections**: `custom_lists`, `custom_list_items`, `collections`, `collection_lists` táblák megvannak
4. **#4 — Follows/Friendships + Forums/Clubs**: `follows`, `friendships`, `forums`, `clubs`, `topics`, `posts`, `club_members` táblák megvannak
5. **#5 — AI Center / Marketplace / Plugin API**: `ai` jogosultság‑csoport (16) megvan, funkció hátra

> Megjegyzés: sok jövőbeli funkció **sémája már létezik** (a táblák seedeltek/migrálva),
> csak az API‑végpont és a kliens‑UI hiányzik — ezért gyors lesz ráépíteni.

---

## 4. Adatbázis — teljes tábla‑leltár (107 tábla)

Migrációk: `0001`…`0013` (a `db/migrations/`‑ben, filename szerint követve a `schema_migrations`‑ben).

### Fiók & auth (`0001`)
`users`, `user_settings`, `sessions`, `devices`, `oauth_identities`, `api_keys`, `security_logs`

### Katalógus (`0002`, `0013`)
`anime` *(+`visibility` a 0013‑ban)*, `anime_titles`, `anime_synonyms`, `anime_mappings` (AniList/MAL/AniDB/TVDB/TMDB/IMDB id‑k), `genres`, `anime_genres`, `tags`, `anime_tags`, `companies`, `anime_companies`, `people`, `characters`, `anime_characters`, `character_voices`, `anime_staff`, `episodes`, `anime_relations`, `anime_recommendations`, `anime_images`, `anime_videos`

### Streaming / források (`0003`)
`video_sources`, `source_mirrors`, `audio_tracks`, `subtitle_tracks`, `skip_segments` (AniSkip opening/ending), `watch_progress`, `library_entries`

### Közösség (`0004`)
`comments`, `comment_likes`, `reviews`, `review_votes`, `reports`, `moderation_actions`, `follows`, `friendships`, `clubs`, `club_members`, `forums`, `topics`, `posts`, `favorites`, `bookmarks`, `chats`, `chat_members`, `custom_lists`, `custom_list_items`, `collections`, `collection_lists`, `list_likes`

### Profil & gamifikáció (`0005`)
`user_profiles`, `profile_stats`, `profile_achievements`, `achievements`, `badges`, `user_badges`, `xp_events`, `watch_stats_daily`

### Bővítmények (`0006`)
`extensions`, `extension_versions`, `extension_developers`, `extension_reviews`, `extension_installs`, `extension_permissions`

### Analitika (`0007`, particionált)
`error_groups`, valamint **havi particionált** táblák: `page_views_*`, `watch_history_*`, `search_stats_*`, `error_logs_*`, `performance_metrics_*`, `extension_events_*`, `messages_*`, `audit_logs_*` (`2026_07/08/09` particiók)

### Jobok (`0008`)
`jobs` (queue + retry/dead‑letter)

### Webhookok (`0009`)
`webhooks`, `webhook_deliveries`

### Profilok & jogosultságok (`0010`, `0012`)
`roles`, `permissions`, `role_permissions`, `user_roles`, `notifications`, `watch_together_rooms`

### Site‑konfiguráció (`0011`)
`feature_flags` (kulcs, címke, kategória, `enabled`, `access` ∈ public/auth/permission, `required_permission`), `site_settings` (jsonb value)

---

## 5. API‑végpontok (prefixek)

| Prefix | Fájl | Tartalom |
|--------|------|----------|
| `/v1/auth` | `auth.ts` | regisztráció, login, refresh, logout, permissions |
| `/v1/anime` | `anime.ts` | browse, schedule, search, by‑anilist, resolve, detail, episodes, relations *(láthatóságra szűr)* |
| `/v1/me` | `library.ts` | könyvtár, haladás |
| `/v1/profiles` | `profiles.ts` | profilok |
| `/v1/extensions` | `extensions.ts` | store |
| `/v1/comments` | `comments.ts` | kommentek |
| `/v1/w2g` | `w2g.ts` | watch‑together |
| `/v1/reports` | `reports.ts` | jelentés |
| `/v1/config` | `config.ts` (`publicConfig`) | effektív site‑config a kliensnek |
| `/v1/admin` | `admin.ts` | user‑kezelés, moderáció, analitika |
| `/v1/admin/config` | `config.ts` (`adminConfig`) | flag/setting szerkesztés — `settings.system` |
| `/v1/admin/roles` | `roles.ts` | RBAC — `roles.manage` |
| `/v1/admin/catalogue` | `catalogue.ts` | **anime+epizód CRUD + láthatóság** — `anime.*` / `episode.*` |
| `/v1/admin/webhooks` | `webhooks.ts` | webhook‑ok |
| `/v1/dev` | `dev.ts` | fejlesztői segéd‑végpontok |

### `/v1/admin/catalogue` részletei (új)
- `GET /` — lista/keresés (`q`, `visibility`, `limit`, `offset`), rejtett bejegyzésekkel — `anime.view`
- `GET /:id` — teljes anime szerkesztéshez — `anime.view`
- `POST /` — létrehozás — `anime.create`
- `PATCH /:id` — metaadat + láthatóság módosítás — `anime.edit`
- `DELETE /:id` — törlés (kaszkád epizódok) — `anime.delete`
- `GET /:id/episodes` — epizódlista — `anime.view`
- `POST /:id/episodes` — epizód hozzáadás (duplikált szám → 409) — `episode.create`
- `PATCH /episodes/:eid` — epizód szerkesztés — `episode.edit`
- `DELETE /episodes/:eid` — epizód törlés — `episode.delete`
- Minden mutáció `catalogue.changed` webhook‑eseményt bocsát ki.

---

## 6. Frontend oldalak (`web/js/pages/`)

`home`, `search`, `anime` (details), `schedule`, `list` (könyvtár), `profile`,
`profiles` (váltó), `notifications`, `dashboard`, `community`, `w2g`, `watch`
(lejátszó), `extensions`, `developer`, `admin`, `settings`.

- **Router:** `app.js` — hash `#/route`, async oldal‑handler‑ek (a footer a
  tartalom után kerül be, navigációs‑generációs őrrel), gate‑ellenőrzés
  renderelés előtt, mobil alsó navbar (4 fő fül + „More" bottom‑sheet).
- **Admin shell:** `admin.js` — `SECTIONS` metaadat (kulcs/címke/perm/render/ikon),
  dedikált másodlagos sidebar, in‑place szekcióváltás `history.replaceState`‑tel.

---

## 7. Jogosultsági rendszer (RBAC) — 387 jog, 14 csoport

| Csoport | Jogok | Csoport | Jogok |
|---------|------:|---------|------:|
| catalogue | 73 | community | 56 |
| system | 38 | developer | 39 |
| moderation | 37 | library | 28 |
| users | 26 | analytics | 23 |
| streaming | 23 | gamification | 20 |
| ai | 16 | admin | 4 |
| anime | 2 | extensions | 2 |

**Szerepkörök:** `admin` mindig minden jogot birtokol (a UI‑ban védett, a
grant‑végpont 400‑at ad rá). A többi szerep a `role_permissions` táblából
kapja a jogait, felhasználóhoz a `user_roles` köti.

Feloldás: `users → user_roles → role_permissions → permissions`
(per‑request memo a `auth.ts` pluginban).

---

## 8. Site‑konfiguráció / feature‑flag rendszer

- **`feature_flags`** — soronként egy oldal (`page.home`…`page.watch`) vagy
  funkció (`feature.comments`, `feature.reviews`, `feature.watch_together`,
  `feature.image_search`, `feature.trailers`, `feature.hover_preview`,
  `feature.custom_lists`, `feature.registration`). Mezők: `enabled`,
  `access` (public/auth/permission), `required_permission`.
- **`site_settings`** — `site_name`, `tagline`, `require_login`,
  `registration_open` (jsonb value‑val).
- **Kliens:** `App.loadConfig()` betölti a `/v1/config`‑ot; `_gateCheck(route)`
  dönt (letiltott → „turned off" gate; auth kell → login gate; teljes‑oldal
  zár → „Yume is private" gate, Settings kivétel); `featureOn(name)` a
  funkció‑guardokhoz; `applyNavVisibility()` elrejti a tiltott nav‑elemeket.

---

## 9. Láthatóság (`anime.visibility`) — hogyan hat

| Állapot | Browse | Search | Schedule | Detail | Epizódok |
|---------|:------:|:------:|:--------:|:------:|:--------:|
| `public` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `unlisted` | ❌ | ❌ | ❌ | ✅ (direkt link) | ✅ |
| `hidden` | ❌ | ❌ | ❌ | ❌ (404) | ❌ (404) |

Az admin katalógus‑végpontok **figyelmen kívül hagyják** a láthatóságot, hogy
a személyzet a rejtett bejegyzést is megtalálja és visszaállíthassa.

---

## 10. Fejlesztői / üzemeltetői infó

### Indítás (lokálisan)
```bash
# Postgres (socket: /var/tmp/yume-pg, DB: yume, role: dev)
DATABASE_URL="postgres://dev@localhost/yume?host=/var/tmp/yume-pg" \
  node --experimental-strip-types server/src/lib/migrate.ts   # migrációk
DATABASE_URL=… PORT=4000 JWT_SECRET=dev-only-jwt-secret \
  node --experimental-strip-types server/src/index.ts          # API
# web kliens: bármely statikus szerver a web/ könyvtárra
```

### Hasznos scriptek (`server/package.json`)
`dev` (watch), `build` (tsc), `start`, `migrate`, `check` (tsc --noEmit), `seed`.

### Teszt‑fiókok
- `tester` / `correct-horse-9` — admin
- `dev<suffix>` — a `/var/tmp/devnow.txt`‑ből

### Konvenciók
- Node 22, natív TS strip (nincs build‑lépés futáshoz).
- JSON‑Schema minden route‑on (validáció + gyors serializáció).
- Hibaformátum: RFC‑7807‑szerű `{ type, title, status, detail }`.
- Minden admin‑mutáció permission‑gate‑elt és (releváns esetben) webhook‑eseményt tüzel.
