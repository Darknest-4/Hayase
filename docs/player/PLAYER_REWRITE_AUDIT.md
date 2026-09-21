# Player 2.0 — 1. fázis: audit

**Dátum:** 2026-09-16 · **Terjedelem:** a jelenlegi lejátszó teljes implementációja, függőségei, API- és adatbázis-szerződései

Ez a dokumentum azt írja le, **ami ma van** — nem azt, aminek lennie kéne. A
tervezés a következő fázis (`PLAYER_2_ARCHITECTURE.md`).

---

## 1. Ami ma a lejátszó

| fájl | sor | bájt | felelősség |
|---|---:|---:|---|
| `pages/watch.js` | **1 323** | 62 420 | **minden**: oldal, lejátszó, vezérlők, epizódlista, közös nézés, menük |
| `features/player/stream-engine.js` | 588 | 24 295 | jelöltek, rangsor, rákapcsolás, felirat, sub/dub |
| `features/player/hls-handler.js` | 123 | 4 583 | HLS, ahol nincs natív támogatás |
| `features/watch-history/watch-time.js` | 254 | 9 193 | a ténylegesen nézett idő mérése |
| `features/watch-together/watch-together.js` | 170 | 7 068 | közös nézés (külön oldal) |
| `features/player/vendor/hls.min.mjs` | — | 592 193 | hls.js, lusta betöltéssel |
| `css/style.css` (`.player-*`) | 67 szabály | — | a lejátszó teljes megjelenése |

**Összesen ~2 460 sor saját kód**, plusz 578 kB vendor.

### A fő probléma: `watch.js`

A 26 funkcióból négy viszi a fájl felét:

| funkció | sor |
|---|---:|
| `mountPlayer` | **316** |
| `render` | **214** |
| `mountVariantBar` | 112 |
| `mountEpisodeList` | 94 |

A `mountPlayer` egyetlen függvényben építi fel a videóelemet, a tizenkét
vezérlőgombot, a csúszkát, a hangerőt, a menüt, a betöltőt, a szobajelvényt, a
billentyűkezelőt, az automatikus elrejtést, a folytatási pozíciót, a
haladásmérést, az „up next" kártyát és a közös nézés bekötését. **Nincs
állapot** — az állapot a DOM-ban és lezárt változókban él.

Ez a rewrite oka. Nem az, hogy rossz, hanem hogy **nem bővíthető**: egy új
funkció csak ennek a 316 sornak a közepébe fér be.

---

## 2. Függőségi térkép

```
                      watch.js  (1 323 sor)
                          │
   ┌──────────┬───────────┼───────────┬──────────┬──────────┐
   │          │           │           │          │          │
StreamEngine WatchTime  Catalogue   Prefs      Store     PageW2G
   │                        │          │          │
 hls-handler          YumeAPI     (séma +    (localStorage:
   │                        │       szerver     folytatás)
 hls.min.mjs           /v1/anime/*     spec)
 (lusta)               /v1/…/sources
                       /v1/…/skips
                       /v1/…/subtitles
```

Közös infrastruktúra, amit a lejátszó használ, de **nem birtokol**:

| modul | mit ad | rewrite-döntés |
|---|---|---|
| `shared/lib/site-config.js` → `featureOn()` | feature flag, szerverből, hozzáférési szinttel | **megtartani** — a 27. pont kérése már létezik |
| `shared/state/preferences.js` → `Prefs` | `DEFAULTS` + `VALUES` sémavalidáció + szerver-spec + profil-szinkron | **megtartani és bővíteni** |
| `shared/state/store.js` → `getResume/setResume` | folytatási pozíció profilonként | **megtartani** |
| `shared/lib/title-theme.js` | a cím domináns színe CSS-változóként | **megtartani** |
| `shared/ui/dom.js` (`U`), `primitives.js` (`P`) | elemépítés, alap-UI | **megtartani** |
| `shared/i18n/i18n.js` (`T`) | fordítás | **megtartani** |

---

## 3. API-szerződés

A lejátszó négy végpontra épül. **Egyiket sem kell megváltoztatni.**

| végpont | mit ad | fogyasztó |
|---|---|---|
| `GET /v1/anime/:id/episodes` | epizódsorok `number`, `source_count`, `is_filler` mezőkkel | epizódlista, kapu |
| `GET /v1/anime/episodes/:eid/sources` | `id, kind, ref, title, provider, resolution, language, variant, is_batch, size_bytes, seeders` | forrásválasztás |
| `GET /v1/anime/episodes/:eid/skips` | intró/outró intervallumok szavazattal | átugrás |
| `GET /v1/anime/episodes/:eid/subtitles` | feliratsávok | felirat |

**A 42. pont követelménye teljesíthető: az API-szerződés változatlan marad.**

---

## 4. Adatbázis-függőségek

| tábla | sorok ma | szerep |
|---|---:|---|
| `video_sources` | **364 064** | epizódonkénti források (`kind`: torrent/http/nzb/embed) |
| `watch_progress` | **364 064** | pozíció és megtekintettség profilonként |
| `skip_segments` | **0** | intró/outró intervallumok szavazattal |
| `subtitle_tracks` | **0** | `episode_id`, `source_id`, `language`, `kind`, `format`, `object_key`/`url` |
| `audio_tracks` | **0** | `source_id`, `language`, `codec`, `channels`, `is_default` |

**Egyik séma sem igényel változtatást a rewrite-hoz.**

A három üres tábla **nem hiányzó funkció, hanem feltöltetlen adat**: a séma
megvan, a végpontok kiszolgálják, a kliens kezeli — csak a katalógusban nincs
még egyetlen felirat, hangsáv vagy intró-jelölés sem. Ez a rewrite-ra két
következménnyel jár:

1. A felirat- és hangsáv-modulokat **meg lehet írni és egységteszttel
   igazolni**, de **élesben nem lehet bizonyítani** — a 49. pont szerint ezek
   `PARTIAL`-ként jelentendők, nem `PASS`-ként.
2. A jelenlegi lejátszó feliratai **a forrással érkeznek** (a
   `StreamResult.subtitles` mezőben), nem ezekből a táblákból. Az új
   feliratkezelőnek **mindkét utat** ismernie kell.

---

## 5. Amit meg kell tartani (üzleti logika)

Ezek helyesek, mértek, vagy valódi hibából származnak — az új architektúrába
**át kell ültetni**, de nem szó szerint másolni:

| logika | hol | miért marad |
|---|---|---|
| **A kapu** (`hasSomethingToPlay`) | watch.js | enélkül üres lejátszó épült fel nulla jelölttel |
| **A szigorú változat** (`hasRegisteredSources`) | watch.js | „talán van" alapján indítva üres képernyő |
| **Azonos eredetű út `direct`-ként** | stream-engine | enélkül a saját videóink lejátszhatatlanok, és abszolút URL a tartománynevet égetné 364 064 sorba |
| **`loadedmetadata` mint bizonyíték** | stream-engine | mobilon a `canplay` sosem tüzel — minden forrás elbukott |
| **`normalise` `\|\|`-lal, nem `??`-val** | stream-engine | az üres sztringet a `??` jelenlévőnek veszi; emiatt minden torrent-találat eldobódott |
| **`<track default>`** | stream-engine | enélkül a felirat betöltődik és láthatatlan marad |
| **Mért nézési idő** | watch-time.js | az epizódszám × névleges hossz becslés volt, mérésnek álcázva |
| **Forrás-visszaesés** | stream-engine | a néző csak akkor lát hibát, ha minden jelölt elfogyott |
| **Kattinthatatlan, forrás nélküli epizód** | watch.js | a lista már tudta; a nagy gomb megkerülte |

---

## 6. Amit el kell dobni

| | miért |
|---|---|
| `mountPlayer` 316 soros felépítése | nincs állapot, nincs határ, nem bővíthető |
| DOM-ban tárolt állapot | `shell.classList` és lezárt változók az igazság forrásai |
| Vezérlők és üzleti logika összefonódása | a hangerő-csúszka közvetlenül írja a `video.volume`-ot |
| Közvetlen modulhívások a modulok közt | a közös nézés a DOM-ot manipulálja |
| Globális `document` billentyűkezelő | a lejátszó életciklusához kötetlen |

---

## 7. Kockázatok

| kockázat | súly | kezelés |
|---|---|---|
| **A `watch.js` az egyetlen belépő a lejátszáshoz** | magas | az új lejátszó mögé kerül, a régi útvonal flag mögött marad, amíg az új nem bizonyít |
| Az e2e tesztek a jelenlegi DOM-ra épülnek | közepes | a `.player-*` osztályneveket meg kell tartani, vagy a teszteket együtt átírni |
| 578 kB `hls.js` | alacsony | ma is lusta; marad |
| A közös nézés szerveroldala WebSocketen megy | közepes | a szerződés nem változik, csak a kliensoldali réteg |
| `skip_segments` üres | alacsony | a modult meg kell írni, de élesben nem bizonyítható adat nélkül |
| Mobil autoplay-szabályok | **magas** | a mostani rewrite egyik fő tanulsága; a 2.0-nak kezdettől ezzel kell számolnia |

---

## 8. Migrációs pontok

| | állapot |
|---|---|
| API-szerződés | **változatlan** |
| `video_sources` | **változatlan** |
| `watch_progress` | **változatlan** — a folytatási pozíció kompatibilis marad |
| `skip_segments` | **változatlan** |
| Közös nézés protokoll | **változatlan** |
| `Prefs` kulcsok | **bővül** (`playback.*` mellé `player.*`), a régiek érintetlenül |
| Feature flagek | **bővül** (`feature.player.*`), a `featureOn()` változatlan |
| CSS | új `.yp-*` névtér; a régi `.player-*` marad, amíg a régi út él |

**Adatvesztés nélkül, visszafelé kompatibilisen.**

---

## 9. Mit mérek majd (kiindulási értékek)

A 29. és 13. fázishoz a jelenlegi lejátszó alapértékei, ugyanazon a gépen:

| | mai érték |
|---|---|
| első képkockáig (asztali, meleg gyorsítótár) | *mérendő a 13. fázisban* |
| a `watch.js` letöltött mérete | 62 420 bájt (tömörítve ~13 kB) |
| a lejátszó JS-modulok száma | 4 saját + 1 vendor |
| az oldal DOM-csomópontjai lejátszás közben | *mérendő* |

Ezeket a 2.0 ellen újra kell mérni — a 49. pont szerint **PASS csak mérésre**.
