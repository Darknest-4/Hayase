# Yume — Teljes áttekintés (oldalak, funkciók, működés, bővítési terv)

Magyar nyelvű áttekintés a platform jelenlegi állapotáról: minden oldal,
elrendezés és funkció, hogyan működik, és mivel lehet tovább bővíteni.

> ## ⚠️ A kiegészítő-platform megszűnt
>
> A store, a fejlesztői portál, a manifest-validátor, a csomagtár és a
> sandbox törölve (`0031_remove_extension_platform`). Ami bennük volt, az
> most a platform része:
>
> | Régen kiegészítő | Most |
> |---|---|
> | témacsomag | `themes` tábla + Admin → Themes |
> | aniskip | `skip_segments` a katalógusból, AniSkip csak tartalék |
> | opensubtitles | `subtitle_tracks` epizódonként, admin szerkesztővel |
> | anilist-meta | a mély AniList-menet tölti a saját tábláinkat |
> | yume-library, jellyfin, plex | **megszűnt** — a videóforrás most `video_sources`, amit az operátor vesz fel bármilyen providerhez |
>
> Az alábbi szöveg jelentős részben azt írja le, ami **volt**. Ahol
> kiegészítőkről beszél, ott a fenti táblázat a mérvadó.

---

---

## 1. Hogyan épül fel a rendszer

```
Böngésző (web/)  ──►  AniList/Jikan/ani.zip  (katalógus-adat, közvetlenül)
      │
      └────────►  Yume API (server/, Fastify)  ──►  PostgreSQL (25k+ anime, users…)
                        │                            │
                        ├── /ws WebSocket  (értesítés, chat, watch-together)
                        └── job queue ──► worker-ök (statisztika, import, review…)
```

- A **web kliens** keretrendszer nélküli HTML/CSS/JS (hash-router SPA), a
  Yume design tokenekre építve (`web/css/tokens.css`) — tiszta fekete
  háttér, rózsa akcent, Nunito, keskeny ikon-sidebar (az eredeti Hayase
  arculata).
- A **katalógus-böngészés** AniList-ről megy (offline-cache-elve
  localStorage-ba), a **platform-funkciók** (fiók, kommentek, store,
  admin, W2G) a saját Yume API-ról.
- A **saját adatbázis** a teljes anime-offline-database-szel van seedelve
  (25 672 anime, 388 ezer epizód, valódi filler-adatokkal) —
  `npm run seed`.

---

## 2. Oldalak és működésük

### Home (`#/home`)
- **Hero**: a trending #1 anime — mögötte némított, loopolt trailer
  (YouTube), fölötte cím, meta-sor, műfaj-chipek, leírás; gombok:
  **Watch now** (a következő epizódodra visz), **+ Add to list**,
  **Trailer** (modal), **Details**.
- **Sorok** (vízszintes görgetés): Continue Watching (helyi progress),
  Sequels You Missed (a befejezettjeid folytatásai), Your List, Popular
  This Season, Trending Now, All Time Popular, műfaj-sorok.
- **Hover-előnézet**: fél másodperc után felugró kártya trailerrel,
  leírással, „▶ Ep N" + „+ Add to list" gyorsgombokkal.

### Search (`#/search`)
- Szöveges keresés (debounce) + szűrők: műfaj, évad, év, formátum,
  státusz, rendezés; lapozás „Load more" gombbal.
- **Képkeresés** (trace.moe): 🖼 gomb, vagy kép beillesztése/behúzása —
  megmondja, melyik anime melyik része a képkocka.
- Gyorskereső bárhonnan: **Ctrl+K** vagy **S**.

### Anime adatlap (`#/anime/{id}`) — az eredeti Hayase elrendezés
- A tartalom a globális banner fölött görgetődik.
- **Hero-sor**: borító (180×256) lent-igazítva; mellette halvány
  másodlagos cím + óriási főcím; **a borító domináns színével festett
  chipek** („9 of 28" nézettség, formátum, státusz, évad) + értékelés
  szerint színezett score-chip; 4 soros leírás (kattintásra kinyílik).
- **Akciósor**: borító-színű, széles **Play** gomb (a következő
  részedre visz) + rácsatolt lista-státusz választó; ikongombok: szív
  (kedvenc), könyvjelző (gyors Planning), megosztás, trailer, AL/MAL.
- **Műfaj + tag chipsor** (a spoiler-tagek elblurolva).
- **Fülek**: Episodes (széles epizód-sorok képpel, dátummal,
  filler-jelzéssel, pipával) | Relations (+ karakterek) | Comments
  (Yume-fiókos, fonalazott) | Recommendations.

### Watch (`#/watch/{id}:{ep}`) — modern, beágyazott lejátszó
- Fejléc: vissza-link + „N. rész / összes".
- **Beágyazott 16:9 lejátszó** (nem egész oldalas): saját vezérlők
  (seek + puffer, hangerő, sebesség, PiP, fullscreen), billentyűk
  (szóköz/K, nyilak, F, M, 0–9), automatikusan elrejtőző kezelőfelület,
  **Skip intro/outro** (AniSkip).
- **Teljesen automatikus mentés** (profilonként):
  - a pontos **másodperc**, ahol tartottál, folyamatosan mentődik → a
    következő megnyitáskor onnan **folytat** („Resumed from 12:34");
  - **előzménybe** kerül, amint elindítod (3 mp után);
  - **85%-nál** automatikusan megnézettre vált (progress + XP);
  - a végén **„Up next" kártya** — a következő rész (auto)lejátszása 5 mp
    visszaszámlálással (a Settings › Content autoplay kapcsolójától függ).
- **Watch Together** gomb a player alatt → **popup**: szoba létrehozás
  vagy csatlakozás kóddal, meghívó-link másolás, élő eseménylista,
  nézőszám; a lejátszás WebSocketen szinkronban megy (play/pause/seek),
  a playeren „● Room …" jelvény jelzi. (A régi `?w2g=kód` deep link
  továbbra is automatikusan csatlakoztat.)
- Forrás nélkül a **forrásválasztó a player-keretben** jelenik meg
  (stream URL + hivatalos streamek).
- Alatta: „Progress saves automatically" jelzés, **számozott epizódrács**
  (aktív rózsa, nézett jelölve), epizód-infó (cím, dátum, leírás), kommentek.

### Schedule (`#/schedule`)
Heti adásnaptár napokra bontva (Today/Tomorrow/napnév), kártyák
adásidővel és epizódszámmal.

### Library (`#/list`)
Státusz-fülek (Watching/Planning/Completed/Paused/Dropped/Rewatching +
Favourites) darabszámmal; sorok borítóval, +/- progress-gombokkal,
törléssel. localStorage-ban él, JSON export/import a Settingsben.

### Community (`#/community`)
Platform-szintű friss kommentek feedje (Yume API); bejelentkezés/
regisztráció kártya, ha nincs fiók.

### Watch Together (`#/w2g`, `#/w2g/{kód}`)
Elsősorban a **Watch oldalról, popupban** érhető el (lásd fent). A `#/w2g`
oldal továbbra is megvan mint önálló lobби/szoba-nézet (kód-alapú
létrehozás/csatlakozás, házigazda, nézőszám, eseménylista). A tényleges
szinkron mindig a lejátszóhoz kötődik.

### Profile (`#/profile`) — hub füles elrendezéssel
Random-anime **spotlight banner** fejléc (a bannert egy random népszerű
anime adja, jobb alul halványan kiírva melyik), alatta fülek:
- **Overview**: avatar/profilnév, **XP és szint** (a backenddel azonos
  képlet), stat-kártyák, library-bontás színezett sávokkal, friss aktivitás.
- **Analytics** (`#/profile?tab=analytics`): személyes „év összegzése"
  grafikonok saját SVG chart-motorral (`web/js/charts.js`) — napi aktivitás,
  műfaj/formátum-fánk, státusz-eloszlás, pontszám-hisztogram, top stúdiók.
- **Achievements** (`#/profile?tab=achievements`): 16 elemű, fokozatos
  (bronze/silver/gold) katalógus haladássávokkal + XP/szint-sáv; a slugek
  megegyeznek a backend `achievements` táblájával.
- **History** (`#/profile?tab=history`): profilonkénti előzmény napokra
  bontva.

A régi `#/analytics`, `#/achievements`, `#/history` linkek automatikusan
átirányítanak a megfelelő fülre.

### Extensions (`#/extensions`) + Developer Portal (`#/developer`)
- **Store**: típus-fülek, kártyák (fejlesztő ✓ verified, telepítések,
  értékelés, verzió) — élőben a Yume API-ról; ha nincs backend, őszinte
  „csatlakozz" állapot.
- **Portál**: fejlesztővé válás, listing létrehozás, verziófeltöltés
  jogosultság-választóval → **review-pipeline** (auto-approve /
  flagged / rejected), verziónkénti analitika.

### Admin (`#/admin`) — csak jogosultsággal jelenik meg
Overview (felhasználó/tartalom/nézési statok, trending, job-queue
egészség, hibacsoportok) | Users (keresés, suspend/ban/restore —
session-visszavonással) | Reports (moderációs sor hide/dismiss
akciókkal) | **Roles** | Webhooks | **Site Config**. Minden akció auditnaplózva.

### Roles & Permissions — finomszemcsés RBAC (387 jogosultság)
Teljes jogosultság-rendszer, adminból kezelve:
- **387 jogosultság** 11 domainben (katalógus, streaming, users, community,
  library, moderation, developer, gamification, analytics, system, ai) —
  `resource.action` sémán (pl. `anime.edit`, `user.ban`, `webhook.test`).
- **6 szerep**: admin (mindent kap), moderator, developer, **editor**
  (katalógus+streaming), **analyst** (analytics), user.
- Az admin **Roles** fülön: bal oldalt a szerepek (felhasználószám +
  jogosultság-számláló), jobbra a katalógus **csoportosítva**, checkbox-os
  **grant/revoke** szerepenként, „Grant/Revoke all" csoportonként, kereső a
  387 elem között. Az admin szerep védett (mindig minden). Backend:
  `/v1/admin/roles` (`roles.manage`), minden változás auditált + webhook.

### Site Config — adatbázis-vezérelt konfiguráció / feature flag-ek
A teljes termék egy **DB-vezérelt vezérlőpultról** állítható, élőben:
- **Feature flag-ek** (`feature_flags` tábla) — minden oldal (`page.*`) és
  fő funkció (`feature.*`) egy sor: **be/ki kapcsolható**, és **hozzáférési
  szintet** kap: `public` / `auth` (bejelentkezés kell) / `permission`
  (adott jogosultság kell).
- **Globális beállítások** (`site_settings`) — **az egész oldal
  bejelentkezés mögé rakható** (`require_login`), regisztráció nyitva/zárva,
  oldalnév, tagline.
- A **publikus `/v1/config`** végpont vetíti a kliensre az effektív
  konfigot. A kliens ez alapján: **elrejti a nav-elemeket**, **gate-eli a
  route-okat** (kikapcsolt → „turned off", auth kell → login-gate,
  permission kell → „no access"), és zárolt oldalnál teljes login-kaput
  mutat (a Settings elérhető marad, hogy a szervert be lehessen állítani).
- A funkció-flagek a megjelenő elemeket is vezérlik: kommentek, hover-
  preview, kép-keresés, Watch Together gomb, trailerek stb.
- Minden változás **auditált** és **webhook-eseményt** (`config.changed`)
  küld. Jogosultság: `settings.system` (admin szerep).

### Dashboard (`#/dashboard`)
Személyes nyitóoldal **testreszabható widgetekkel** (sorrend + ki/be a
„Layout szerkesztése" módban, profilonként mentve): üdvözlés napszak
szerint, folytatás, hamarosan adásba kerülő epizódok, gyors statok,
„majdnem meglévő" achievementek, legutóbbi értesítések, top műfajok.
Minden helyi adatból számol — hálózat nélkül is működik.

> **Megjegyzés:** az Analytics, Achievements és Watch History korábban
> külön oldalak voltak, de mivel gyakorlatilag egy-egy szekcióból álltak,
> beépültek a **Profile** hub füleibe (fent).

### Notifications (`#/notifications`)
Szűrhető **értesítési központ**: adásba kerülő epizódok (könyvtárból),
félbehagyott folytatás, achievement-feloldások. Típusonként ki/be
kapcsolható (Settings › Notifications), olvasott/elvetett állapot
profilonként megmarad, a sidebar harangon olvasatlan-számláló.

### Settings (`#/settings`)
**Kategorizált, füles elrendezés** (Account / Appearance / Content /
Notifications / Data / About):
- **Appearance**: a teljes **Theme Engine** ide épült be — alap (dark/light),
  kurált akcentus-presetek, egyéni színválasztó, felület-árnyalás, élő
  előnézet (CSS-változó felülírásokkal, profilonként mentve), + cím-nyelv.
  A régi `#/themes` link ide irányít át.
- **Account / Content / Notifications / Data / About**: profilnév és
  profilkezelés, Yume-fiók, szerver végpont, NSFW, autoplay, intro-átugrás,
  értesítés-preferenciák, API-cache, adat export/import/törlés.

### Footer
Minden tartalmi oldal alján **lábléc**: yume logó + tagline, linkoszlopok
(Discover / Library / Community / Yume) és adatforrás-kredit (AniList,
Jikan, ani.zip). Az immerzív oldalakon (Watch, Watch Together, profilváltó)
nem jelenik meg.

---

## 3. Backend röviden

- **Fastify + TypeScript** (`server/`): auth (JWT + rotálódó refresh),
  RBAC (szerep→jogosultság), katalógus (browse/keresés/schedule),
  library + progress (85%-nál watch_history + XP), kommentek, reportok,
  admin, dev-portál, extension store; **GraphQL** a `/graphql`-en
  ugyanarra a rétegre.
- **PostgreSQL**: ~100 tábla 8 domain-migrációban, mindenütt kommentekkel
  (lásd `docs/database.md`).
- **WebSocket** (`/ws`): értesítések (komment-válasz azonnal), chat
  (perzisztált), W2G szinkron + jelenlét.
- **Worker-ök** (Postgres-alapú tartós job-queue): statisztika-rollup,
  trending, partíció-karbantartás, katalógus-import, extension-review.

---

## 4. Mivel lehetne bővíteni? (priorizálva)

### Kész modulok (ebben az iterációban elkészültek)
- ✅ **Több profil** (Netflix-stílusú váltó, profilonkénti könyvtár,
  előzmény, kedvencek, beállítások).
- ✅ **Értesítési központ + sidebar-harang** olvasatlan-számlálóval.
- ✅ **Analytics** grafikonokkal (saját SVG chart-motor).
- ✅ **Achievementek/jelvények** a profilra — az XP-rendszerrel.
- ✅ **Theme Engine** (egyéni akcentus, presetek, előnézet).
- ✅ **Testreszabható Dashboard** widgetekkel.
- ✅ **Kategorizált Settings** (füles elrendezés).

### Gyors győzelmek (a backend/séma már kész, csak UI kell)
1. **Egyéni listák + kollekciók** — `custom_lists`/`collections` táblák
   készen: rendezhető, megosztható listák („2026 legjobbjai").
2. **Review-k** csillagos értékeléssel az adatlapra (`reviews` tábla +
   hasznos-szavazás kész) — külön „Reviews" fül.
3. **Telepített extensionök kezelése** a kliensben (ki/be, auto-update).

### Közösségi réteg (séma kész, pár route + UI)
6. **Fórumok** animénként és általános témákban (`forums/topics/posts`).
7. **Barátok/követés** + aktivitás-feed („X befejezte a Frierent”).
8. **Élő chat UI** (DM-lista oldal) — a WS-kézbesítés már működik.
9. **Klubok** saját chattel és fórummal.

### Felfedezés / tartalom
10. **Szezonális oldal** („2026 nyár") — a seedelt adat évadonként
    lekérdezhető; „Véletlen anime" gomb.
11. **Kapcsolati fa vizualizáció** (az eredeti Hayase-ben gráf volt) —
    a 27 ezer relation-él megvan a DB-ben.
12. **Karakter- és stúdióoldalak** (`characters`/`people`/`companies`).
13. **Személyre szabott ajánló** — műfaj/tag-átfedés a library alapján
    („mert nézted X-et”).
14. **Themes fül** (OP/ED zenék) — animethemes.moe API-ból, mint az
    eredetiben.

### Platform-minőség
15. **PWA + offline mód** — service worker, telepíthető app.
16. **Többnyelvűség** (magyar felület!) — egyszerű i18n szótár.
17. **Több profil** váltó (Netflix-módra — a `user_profiles` séma eleve
    így épült).
18. **Statisztika-grafikonok** (heti nézési heatmap, műfaj-torta).
19. **MAL/AniList import** — XML/JSON lista-beolvasás a Settingsbe.
20. **Library szinkron a Yume-fiókkal** — a lokális lista feltöltése a
    szerverre (`library_entries` + a REST/GraphQL végpontok készen).

### Infrastruktúra (élő környezetet igényel)
21. ~~OpenSearch-indexelő worker~~ — **elvetve, szándékosan**: a keresés Postgresen fut (tsvector + pg_trgm, rétegelt rangsor); indoklás: `docs/search.md`.
22. **S3/MinIO média-pipeline** (borítók újrahostolása, blurhash).
23. **Redis-adapterek** (rate-limit, cache, több-példányos WS pub/sub) —
    a seam-ek elő vannak készítve.
24. **AniList OAuth összekötés** — lista-szinkron a meglévő fiókoddal.
