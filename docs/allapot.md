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

### VPS Health & Monitoring (kész) — [`monitoring.md`](./monitoring.md)
- [x] **Liveness / readiness szétválasztva**: `/v1/health` triviális marad (LB/Docker), új `/v1/health/ready` cache‑elt aggregát (HEALTHY/DEGRADED/UNHEALTHY)
- [x] **Capability‑aware service‑próbák**: Postgres kemény függőség; Redis/RabbitMQ/OpenSearch/MinIO **csak ha konfigurálva van** → nincs hamis riasztás
- [x] **Metrika‑gyűjtés a workerben** (60 mp), 22+ mérőszám `/proc`‑ból és `node:os`‑ból, **0 új függőség**
- [x] **Tárolás + retention**: `system_metrics` (havi partíciók, 7 nap), `system_metrics_hourly` (1 év), `service_status`
- [x] **Dokumentált, futásidőben állítható küszöbök** (`site_settings`), zöld/sárga/piros osztályozás
- [x] **Admin dashboard** (Infrastructure szekció): valós értékek, service‑rács, dependency‑map, 24 órás sparkline‑ok
- [x] **P0 hotfix**: a `worker` bekerült a compose‑ba (nélküle a particionált táblák insertjei elhaltak volna)
- [x] **Alerting**: debounce (3 ciklus) → tüzelés, cooldown (30 perc), recovery (2 ciklus); egyetlen kiugrás **soha** nem riaszt; állapot a DB‑ben, webhook‑kimenettel
- [x] **Diagnosztika**: adminról indítható, korlátozott benchmarkok (CPU 700 ms, RAM 128 MB, disk 32 MB + kötelező takarítás), egyszerre csak egy futhat, riport `PASS/WARN/FAIL/SKIP` bontásban

### Security hardening (kész) — [`security.md`](./security.md)
- [x] **Rate limiting**: globális 300/perc, login/register 10/15 perc, refresh 60/15 perc, írás 30/5 perc — health **soha** nem limitált
- [x] **Body limit** (1 MB) → 413, séma‑validáció minden route‑on
- [x] **Security headerek + CSP** (`script-src 'self'`, `frame-ancestors 'none'`) — igazoltan nem töri a klienst
- [x] **JWT‑titok fail‑fast** production‑ben (placeholder/rövid titok → nem indul el), compose is megköveteli
- [x] **CORS**: production‑ben a wildcard same‑origin‑ra esik vissza
- [x] **Login timing‑enumeráció lezárva** (decoy‑hash, 1,5% eltérés)
- [x] **CI helyreállítva**: typecheck + tesztek + migrációk + worker + build, `main` ágon

### Extension 2.0 — sandbox & manifest (kész) — [`extensions.md`](./extensions.md)
- [x] **Manifest v3 validáció** kikényszerítve publikáláskor; a **manifest az egyetlen igazságforrás** (a hívó külön permission‑listája megszűnt)
- [x] **Jogosultság‑eszkaláció detektálás** minden új verziónál (új permission vagy bővített host‑lista)
- [x] **Web Worker sandbox**: minden ambient képesség eltávolítva; a host **újraellenőriz** minden kérést
- [x] **`net:fetch` host‑allowlist**, `credentials: omit`, identitás‑headerek szűrve, 2 MB / 8 s korlát
- [x] **`storage:local` izolálva** (`ext:{slug}:{kulcs}`, 64 KB)
- [x] **Integritás**: sha256 ellenőrzés futtatás előtt · **kill switch** · **minAppVersion** kompatibilitás
- [x] **10 s hívás‑timeout**, beragadt worker leállítva; eredmények szanitálva, accuracy‑plafon a beolvasott mezők alapján
- [x] **Extension health** (🟢🟡🔴⚪) hiba‑telemetriából, dokumentált küszöbökkel
- [x] Igazolva: **17 sandbox‑biztonsági eset** böngészőben, mind átment

### Streaming 2.0 — forrás‑absztrakció (kész) — [`streaming.md`](./streaming.md)
- [x] **Egységes `StreamResult`**: url, típus, minőség, hang, feliratok, headerek, lejárat, forrás, direct/proxy, metaadat — a lejátszó nem tudja, melyik bővítmény adta
- [x] **Automatikus fallback**: hibás forrásnál a motor **magától továbblép** a következőre; a felhasználó csak akkor lát hibát, ha már mind elfogyott
- [x] **Playability előre eldöntve**: magnet → „desktop kliens kell", HLS/DASH → csak natív támogatással vagy regisztrált handlerrel, ismeretlen séma kizárva
- [x] **Rangsor**: játszható → forrás‑health → accuracy → minőség → seederek (a romló források maguktól hátracsúsznak)
- [x] **Bedugható formátum‑handler** (`registerHandler`) — **0 média‑függőség**, hls.js később becsatolható
- [x] **Feliratok** a StreamResultból `<track>`‑ként; **lejárt link** meg sem próbálva; hiba → extension‑telemetria
- [x] A forrás‑választó **több URL‑t** fogad (soronként egyet), így a fallback kézi forrásokkal is működik
- [x] Igazolva: 13 motor‑teszt + 8 valós watch‑oldal teszt (köztük „két halott forráson át a harmadik játszik")

### Metadata engine + Search 2.0 (kész) — [`search.md`](./search.md)
- [x] **Megszűnt a néma felülírás**: az AniList‑importőr eddig `coalesce`‑szal ráírt a kézzel javított címre/leírásra — most **minden automatikus írás a konfliktus‑feloldó rétegen megy át** (`server/src/lib/metadata.ts`)
- [x] **Ember‑zár (`anime.locked_fields`)**: amit az admin a katalógus‑szerkesztőben ment, az **zárolódik**, és automatikus forrás soha nem írja felül; csak ember oldhatja fel („Release" gomb / `POST …/unlock`)
- [x] **Forrás‑rangsor** (`anime.metadata_sources`): `manual` 100 > `anilist` 60 > `mal` 50 > `aod` 30 > `stub` 10 > ismeretlen 0 — alacsonyabb rangú forrás nem írja felül a magasabbat, de **saját mezőjét bármelyik frissítheti**
- [x] **Semmi nem törlődik hiány miatt**: `null`/üres bejövő érték kihagyva; üres tárolt mezőt bárki kitölthet
- [x] **Volatilis statisztika kivétel**: `popularity`/`average_score` mindig a legfrissebb (de az ember‑zár ott is tart)
- [x] **Provenance a felületen**: a szerkesztőben látszik, melyik mezőt melyik forrás mikor írta, és mi van zárolva
- [x] **Duplikátum‑felismerés**: azonos `(év, formátum)` bucketen belüli trigram‑hasonlóság; a már `anime_relations`‑szel összekötött párok kizárva (folytatás nem duplikátum) — **csak javasol**, a merge `anime.merge` joggal és megerősítéssel megy
- [x] **Merge**: címek (a vesztes címei szinonimaként megmaradnak), szinonimák, műfajok, tag‑ek, relációk, külső id‑k és könyvtár‑bejegyzések átkerülnek (két profilnál a **nagyobb haladás** marad), majd a vesztes sor törlődik — visszavonhatatlan
- [x] **Cím‑normalizálás**: ékezet/írásjel/névelő nélkül, évad‑jelölés és római számok egységesítve (`Fate/Zero 2nd Season` ≡ `Fate Zero Season II`)

**Search 2.0:**
- [x] **A keresés eddig nem nézte az `anime_titles`‑t** — a romaji/angol/natív cím láthatatlan volt: az „Attack on Titan" **nem talált semmit**, mert a sor `Shingeki no Kyojin`. Most **minden címforma** keresve van
- [x] **Rétegelt rangsor** (hogyan talált, nem csak mennyire): pontos kanonikus cím 100 → pontos alternatív cím 90 → pontos szinonima 80 → prefix 70 → tartalmazás 60 → full‑text 40 → elgépelés‑tűrő trigram 20; holtversenyben hasonlóság, majd népszerűség
- [x] Ezért ad a `one piece` **One Piece**‑et a *One Piece Film: Red* előtt — a régi egypontszámos rangsor ezt nem garantálta
- [x] **Kombinálható szűrők**: műfaj, év, évad, formátum, státusz, nsfw + `sort` (relevance/popularity/score/newest/title); rejtett és nem listázott sor **soha** nem jön vissza; minden szűrőérték kötött paraméter
- [x] **`/v1/anime/suggest`**: gyorskereső‑doboz (Ctrl+K) — a kliens a katalógust részesíti előnyben, és **AniList‑re esik vissza**, ha nincs backend vagy a találatnak még nincs `anilist_id`‑ja
- [x] **Telemetria**: a `search_stats` végre íródik (eddig üres tábla volt) — a 0 találatos kérés a katalógus‑hiány riport; a suggest **nem** naplóz (billentyűnként futna); csak a szöveg + találatszám tárolódik, IP/user‑agent nem, profil‑id csak valódi UUID esetén, 3 hónap után partícióval törlődik
- [x] **Nincs OpenSearch — szándékosan**: 25 672 sornál a Postgres `pg_trgm`+`tsvector` a 0017 indexekről ezredmásodpercben válaszol; az OpenSearch ~1 GB RAM‑ot és egy külön üzemeltetett JVM‑et kérne mérhető haszon nélkül (indoklás és a felülvizsgálat feltétele: `docs/search.md`)
- [x] Igazolva: **32 új unit‑teszt** (16 metadata + 16 search) + élő végpont‑ellenőrzés + 7 böngésző‑teszt a gyorskeresőre

### #1 — DB library‑sync (kész)
- [x] **Bejelentkezve a lokális könyvtár a fiókhoz szinkronizál** és eszközök közt követi a felhasználót
- [x] **Push (lokál → DB):** minden könyvtár‑írás (`Store.saveEntry`/`setProgress`/`removeEntry`) tükröződik a DB‑be (státusz + epizód‑haladás), debounce‑olva
- [x] **Pull (DB → lokál):** bejelentkezéskor a fiók könyvtára visszatöltődik, „legfrissebb nyer" ütközésfeloldással
- [x] **Resume‑pozíció** (per‑epizód másodperc) best‑effort szinkron a `watch_progress`‑be (epizód‑UUID feloldással, cache‑elve)
- [x] **Id‑hidak:** AniList‑id ↔ Yume‑UUID (`yumeAnimeId`), lokál profil → fiók default `user_profiles` (első bejelentkezéskor létrehozva); státusz‑leképezés `CURRENT↔WATCHING`, `REPEATING↔REWATCHING`
- [x] **Settings › Account** „Library sync" kártya státusszal és „Sync now" gombbal
- [x] Kliens‑modul: `web/js/library-sync.js` (`LibrarySync`)

---

## 3. Mi van hátra / tervben 🔜

A felhasználó által kért sorrend (a #6 és #1 kész, ezek jönnek „folytasd"‑ra):

1. ~~**#1 — DB library‑sync**~~ ✅ **kész** (lásd fent)
   *Az alerting és a diagnosztika is elkészült — lásd a monitoring szakaszt.*
   *A **Metadata engine (#7)** és a **Search 2.0 (#8)** is kész — lásd fent és [`search.md`](./search.md).*
2. **#2 — Reviews** (értékelések): a `reviews`, `review_votes` táblák megvannak, UI+API hátra
3. **#3 — Custom lists / Collections**: `custom_lists`, `custom_list_items`, `collections`, `collection_lists` táblák megvannak
4. **#4 — Follows/Friendships + Forums/Clubs**: `follows`, `friendships`, `forums`, `clubs`, `topics`, `posts`, `club_members` táblák megvannak
5. **#5 — AI Center / Marketplace / Plugin API**: `ai` jogosultság‑csoport (16) megvan, funkció hátra
6. **Discord bot (gateway)** — **terv kész, kód még nincs**: [`discord-bot.md`](./discord-bot.md).
   Saját **`bot/`** mappa, **saját `package.json`** (a `discord.js` így soha nem
   kerül a szerver függőségei közé), saját `Dockerfile` és **külön compose‑service**,
   tehát a Docker indítja a többivel együtt.
   **A bot soha nem nyúl közvetlenül a Postgreshez** — mindent a meglévő API‑n
   keresztül ír, így megmarad a validáció, az RBAC, a láthatóság és a rate limit.
   A fiók‑összekötés az `oauth_identities`‑re ül (`'discord'` provider már engedélyezett),
   és **nem lesz második auth‑rendszer**: egy service‑kredencilállal a bot rövid életű
   (5 perces) sima access tokent kér a linkelt userre, onnantól közönséges API‑kliens.
   A Yume → bot irány a **meglévő webhook‑rendszert** használja (retry, delivery‑log,
   auto‑tiltás már megvan).
   Funkciók: katalógus‑parancsok autocomplete‑tel (a `/v1/anime/suggest`‑re ül),
   személyes könyvtár‑parancsok, XP/achievement (`profile_stats`, `xp_events`),
   adás‑értesítés + automatikus epizód‑topik, rang‑szinkron, üdvözlés, reaction‑role,
   **Watch Together ↔ Discord hangcsatorna összekötés**, link‑unfurling, és
   moderációs híd gombokkal.
   Egy új backend‑darab kell hozzá: **ma semmi nem veszi észre, hogy egy epizód adásba került**
   → új `episode.aired` esemény (ez az in‑app értesítéseknek is kelleni fog).
   ⚠️ Két **privileged intent** (`MessageContent`, `GuildMembers`) 100 szerver fölött
   Discord‑jóváhagyást igényel — az érintett funkciók külön kapcsolhatók.

> Megjegyzés: sok jövőbeli funkció **sémája már létezik** (a táblák seedeltek/migrálva),
> csak az API‑végpont és a kliens‑UI hiányzik — ezért gyors lesz ráépíteni.

---

## 4. Adatbázis — teljes tábla‑leltár (107 tábla)

Migrációk: `0001`…`0017` (a `db/migrations/`‑ben, filename szerint követve a `schema_migrations`‑ben).

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
| `/v1/me` | `library.ts` | könyvtár, haladás, continue‑watching, resume‑pozíció *(a kliens `LibrarySync` ehhez szinkronizál, `X-Profile-Id` fejléccel)* |
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

### Jogosultság‑státusz — `active` vs `planned` (0014)

A katalógus a platform teljes RBAC‑szótára, és **szándékosan a funkciók
előtt jár**. Hogy semmi ne tűnjön „halottnak", minden jog `status` mezőt kap:

- **`active`** — ma egy valós route kikényszeríti (`requirePermission` a kódban)
- **`planned`** — katalogizált és kiosztható, de a funkciója még nincs kész (#2–#5)

A Roles admin UI **LIVE / planned** jelvényt és csoportonkénti „n live" számot mutat.
Jelenleg **18 `active`, 369 `planned`**. Ahogy egy modul beköt egy jogot,
a státusza `active`‑ra vált (a `0014` UPDATE‑listáját bővítve).

**A 18 élő jog:** `anime.view/create/edit/delete`, **`anime.merge`**,
`episode.create/edit/delete`, `admin.analytics.view`, `admin.users.manage`,
`admin.webhooks.manage`, `community.moderate`, `community.post`, `roles.manage`,
`settings.system`, `extensions.publish`, `system.metrics.view`,
`system.diagnostics.run`.

> Egy jog **csak akkor** kap `active` státuszt, ha valóban van route, ami
> kikényszeríti. A `mapping.verify` például szándékosan maradt `planned`:
> a merge‑útvonal az `anime.merge`‑öt ellenőrzi, a `mapping.verify`‑ot semmi —
> így a Roles admin nem állít valótlant.

> Miért nem több? A személyes végpontokat (saját könyvtár, profilok, like,
> jelentés‑küldés) **helytelen** lenne joghoz kötni — ott sima `authenticate`
> a helyes. A többi 372 jog a #2–#5 funkcióival válik élővé.

---

## 7b. Használat‑audit — mi él, mi séma (scaffolding)

> Őszinte leltár: a séma előre ki van építve, hogy a következő modulok gyorsan
> ráüljenek. Semmi sem „felesleges" — mindennek megvan a gazda‑modulja és státusza.

**Táblák:** 90 logikai tábla (107 fizikai a havi particiókkal) — **55 használt
(van rá szerver‑kód), 35 séma‑szintű**.

| Réteg | Élő táblák (használt) | Séma‑szintű (jövőbeli modul) |
|-------|----------------------|------------------------------|
| Fiók/auth | `users`, `sessions` | `oauth_identities`, `api_keys`, `devices`, `user_settings` |
| Katalógus | `anime`, `episodes`, `anime_titles/synonyms/mappings/genres/tags/companies/genres`, `anime_images`, `anime_relations` | `characters`, `people`, `anime_characters/staff`, `character_voices`, `anime_videos`, `anime_recommendations` |
| Streaming | — (külső forrás) | `video_sources`, `source_mirrors`, `subtitle_tracks`, `audio_tracks`, `skip_segments`\* |
| Könyvtár | `library_entries`, `watch_progress`, `watch_history` | `favorites`, `bookmarks`, `custom_lists(+items)`, `collections(+lists)`, `list_likes` |
| Közösség | `comments`, `comment_likes`, `reports`, `moderation_actions` | `reviews`, `review_votes`, `follows`, `friendships`, `clubs(+members)`, `forums`, `topics`, `chats` |
| Gamifikáció | `profile_stats`, `xp_events`, `watch_stats_daily` | `achievements`, `badges`, `user_badges`, `profile_achievements` |
| Bővítmények | `extensions`, `extension_versions/installs/developers/permissions` | `extension_reviews` |
| Rendszer | `roles`, `permissions`, `role_permissions`, `user_roles`, `notifications`, `webhooks`, `jobs`, `feature_flags`, `site_settings`, `watch_together_rooms`, `search_stats`, analitika‑particiók | — |

\* Az AniSkip jelenleg a **külső** AniSkip API‑ból megy, nem a `skip_segments` tábláiból.

**Feature‑flagek:** 23 — **19 él** (15 `page.*` router‑gate + 4 funkció‑guard:
`comments`, `hover_preview`, `image_search`, `watch_together`). 4 flag még a
funkciójára vár: `reviews`/`custom_lists` (#2/#3), `trailers` (a funkció megvan,
guard hátra), `registration` (a `site_settings.registration_open` szabályozza).

**Miért tartjuk meg a séma‑szintű táblákat/jogokat?** Mert a #2–#5 modulok pont
ezekre épülnek — most eldobni, majd újra létrehozni felesleges munka lenne.
Ehelyett minden dokumentálva van (gazda‑modul + státusz), és a
jogok/flagek státusza a UI‑ban is látszik.

---

## 7c. Központi szöveg‑katalógus (fix feliratok egy helyen)

Minden **fix UI‑szöveg** (nav‑feliratok, home‑rail címek pl. „Trending Now",
schedule‑fejlécek, footer, gombok) egyetlen fájlban van: **`web/copy.js`**
(`window.Copy`, kulcs → szöveg fa). Nem kell a kódban keresgélni — itt átírsz
egy értéket, és mindenhol frissül.

- Olvasás a UI‑ban: `T('home.rails.trending')` (dot‑path lekérdezés a
  `window.Copy`‑ból; hiányzó kulcsnál a megadott fallbackre vagy a kulcsra esik
  vissza — a helper a `util.js`‑ben).
- A statikus sidebar‑feliratok is innen jönnek (az `app.init` a `data-route`
  alapján behelyettesíti a `Copy.nav`‑ból).
- Bővítés: új szöveghez adj kulcsot `copy.js`‑be és a hívási helyen `T('…')`.
- Igazolva: a katalógus szerkesztése futásidőben a nav‑feliratot és a
  rail‑fejlécet is mindenhol megváltoztatta (0 JS‑hiba).

> Ez a **build‑idejű / szerkeszthető** szövegréteg. A DB‑ből élőben állítható
> értékek (site‑név, tagline) a `site_settings`‑ben vannak (lásd lentebb).

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

### Docker — az egész app egy konténerben
A repó gyökerében egy **sima, egylépcsős `Dockerfile`** van, ami **egyetlen
konténerben az API‑t ÉS a statikus web klienst is kiszolgálja egy porton**
(Node 22, natív TS `--experimental-strip-types`, nincs build‑lépés). A
kliens `base()` automatikusan same‑origin API‑t használ, ha http(s)‑en
szolgálják ki — így semmit sem kell konfigurálni.
```bash
docker build -t yume .
docker run --rm -p 4000:4000 \
  -e DATABASE_URL=… -e JWT_SECRET=… yume          # migrál, majd indít
# → http://localhost:4000  (web kliens + API ugyanazon a porton)
```
A konténer belépője migrálja a DB‑t, majd elindítja az appot. Az API a
`WEB_ROOT` (alap: `/app/web`) statikus fájljait szolgálja ki, SPA‑fallbackkel.

**Minden Dockeren keresztül — Compose:**
```bash
docker compose up                    # app (web+API) + Postgres, egy paranccsal
docker compose --profile infra up -d # + redis/opensearch/minio/rabbitmq (opcionális)
```
A `docker-compose.yml` `app` service‑e a `Dockerfile`‑ból épül, a `postgres`
service‑re vár (healthcheck), és a `postgres://yume:yume@postgres:5432/yume`
DB‑re csatlakozik.

**Katalógus seed (egyszeri, nem az indulás része):** az indulás mindig csak
migrál (másodpercek). A 25k anime + epizód betöltése külön, **egyszeri**
one‑shot a perzisztens `pgdata` volume‑ba — utána minden `up` azonnali:
```bash
docker compose --profile seed run --rm seed   # letölti a hivatalos dumpot és betölt
```
A `seed` script argumentum nélkül a hivatalos anime‑offline‑database dumpot
tölti le (`SEED_URL`‑lel felülírható, vagy adj meg helyi fájl‑útvonalat).
Lokálisan: `npm run seed [<fájl-vagy-url>]`. A seed maga néhány perc, de
egyszeri és a normál indulást sosem lassítja.

**AniList‑gazdagítás (a legtöbb infó innen jön):** a seed a 25k sort +
`anilist_id` leképezést hozza létre; a **gazdag adat** (leírás, borító+banner,
pontszám, műfajok, tag‑ek ranggal, stúdiók, trailer) az AniList‑ről jön:
```bash
docker compose --profile enrich run --rm enrich   # seed UTÁN
# lokálisan: npm run import:anilist [--all] [--limit N]
```
Az importőr 50‑esével kéri le az AniList GraphQL‑t (`id_in`), rate‑limit‑tudatosan
(429/`retry-after` kezelve, `AL_DELAY_MS` pacing), és az `anilist_id` alapján a
meglévő sorokra írja a mezőket (idempotens). Alapból csak a leírás nélküli
sorokat frissíti; `--all` mindet újra. Modul: `server/src/workers/anilist.ts`
(`enrichFromAniList`, `upsertMedia`), script: `scripts/import-anilist.ts`.
A ~16k leképezett anime a rate‑limit miatt ~15–30 perc, egyszeri.

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
