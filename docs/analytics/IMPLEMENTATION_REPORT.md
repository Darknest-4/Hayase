# Megvalósítási jelentés — 2026-09-15

Három commit, 100 fájl, 18 244 új sor. Ez a dokumentum azt írja le, mi készült
el, mi **nem**, és mit mértünk ténylegesen — szemben azzal, amit
következtettünk.

| commit | mi |
|---|---|
| `27fec917` | terhelésmérés: k6-készlet, mérőverem, erőforrás-mintavétel, jelentésgenerátor, sebességkorlát-kivétel |
| `d1457b32` | látogatottság: migráció, gyűjtő, összesítők, fiókesemények, eszközök, admin API, export |
| `80449882` | felület: a Látogatottság szakasz öt füllel, a fiók tevékenységblokkja, dokumentáció, magyar szövegek |

---

## 1. Amit MÉRTÜNK (nem következtettünk)

### HTTP — vegyes forgalom

Mérés: `docs/analytics/load-reports/20260915T221142Z/`
Környezet: mérőverem, 4 mag / 9 969 MB, az éles adatállományból (32 463 cím,
364 064 epizód). Fokozatonként 30 s felfutás + 3 perc terhelés.

| VU | kérés/mp | p50 | p95 | p99 | hiba | 429 | 5xx | CPU |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1.9 | 3 ms | 36 ms | 115 ms | 0 % | 0 | 0 | 8 % |
| 25 | 5.4 | 3 ms | 39 ms | 205 ms | 0 % | 0 | 0 | 11 % |
| 50 | 11.5 | 3 ms | 44 ms | 225 ms | 0 % | 0 | 0 | 12 % |
| 100 | 23.0 | 3 ms | 43 ms | 196 ms | 0 % | 0 | 0 | 17 % |
| **250** | **59.7** | **3 ms** | **53 ms** | **258 ms** | **0 %** | 0 | 0 | **52 %** |
| 500 | 114.2 | 5 ms | 194 ms | **2,76 s** | 0 % | 0 | 0 | **100 %** |

**A mért kapacitás: 250 egyidejű felhasználó**, 59,7 kérés/mp mellett.

Az 500-as fokozat a p99-es küszöbön (2,5 s) bukott el, **nem hibán**: a
hibaarány ott is 0 %, nulla 5xx-szel. A kiszolgáló nem hasalt el, hanem
lelassult — és a processzor 100 %-on állt, terhelés/mag 2,32.

**Ami elfogyott: a processzor.** Nem a memória (45 %), nem a swap (0 %), nem az
adatbázis-kapcsolatok (26 a 100-ból), nem a zárolás (0 várakozó), nem a
feladatsor (1).

A leglassabb lépések a 250-es fokozaton: `step_search` p95 620 ms és
`step_suggest` p95 343 ms. A keresés a legdrágább út, ahogy vártuk — a többi
lépés p95-je 8 és 149 ms között van.

> 1000 felhasználó ≠ 1000 kérés/mp. Ebben a mérésben egy felhasználó
> **0,23 kérés/mp**-et küldött, mert a kérések között olvas.

### WebSocket

Mérés: `docs/analytics/load-reports/20260915T233055Z/`

| VU | kézfogás p95 | ping–pong p95 | jegy p95 | egészséges |
|---:|---:|---:|---:|---:|
| 100 | 2 ms | 1 ms | 4 ms | 100 % |
| 250 | 3 ms | 1 ms | 7 ms | **96,3 %** |

250 egyidejű socketnél 19 kapcsolat a 519-ből elhasalt. Az ok a naplóban:
`Connection terminated due to connection timeout` — a jegykérés adatbázisba
ír, és a felfutás pillanatában a **processzor 99,8 %-on állt**, így az új
adatbázis-kapcsolatok nem épültek fel az 5 másodperces határidőn belül.

Ez **nem** kapcsolatkészlet-kimerülés: a Postgres oldalán 14 kapcsolat volt
nyitva a 100-ból. A processzor fogyott el.

Fontos fenntartás: a k6 UGYANAZON a négymagos gépen futott. 250 socketnél a
terhelésgenerátor költsége már számottevő, tehát ez a szám inkább alsó
becslés. Egy tiszta WebSocket-kapacitás külön gépről futtatott generátort
igényel.

### Lejátszás

Mérés: `docs/analytics/load-reports/20260915T233418Z/`

| VU | indítás p95 | forrásfeloldás p95 | haladásírás p95 |
|---:|---:|---:|---:|
| 100 | 10 ms | 3 ms | 4 ms |
| 250 | 18 ms | 6 ms | 6 ms |

Mindkét fokozat megfelelt. **De:** ezen a példányon **nulla videóforrás** van,
tehát ez az ALKALMAZÁS lejátszásindítási költsége — a szolgáltatói válaszidő
és a videó sávszélessége nincs benne, mert nincs szolgáltató. A szkript ezt ki
is írja minden futásnál, nem pótolja kitalált számmal.

### Sávszélesség

A 250-es fokozaton a kimenő forgalom csúcsa **23,7 kB/s**. Ez az alkalmazás
JSON-forgalma. A videó nem ezen a gépen megy át.

---

## 2. Tesztek — amik TÉNYLEG lefutottak

| készlet | eset | eredmény |
|---|---:|---|
| API (`npm test`) | **736** | mind átment |
| ebből új: `analytics.test.ts` | 20 | mind átment |
| ebből új: `load-test-gate.test.ts` | 10 | mind átment |
| kliens (`node --test`) | **312** | mind átment |
| böngészős (`test:e2e`, 3 motor) | **40** | mind átment |
| `tsc --noEmit` | — | tiszta |
| `standard` (lint) | — | tiszta |

A munka előtt az API-készlet 706 esetből állt; most 736.

Kézzel, böngészőben ellenőrizve: a Látogatottság szakasz mind a hat füle,
1440 és 390 képpont szélességen — nincs oldalirányú csordulás, nincs
konzolhiba.

Élesben, telepítés után: `/v1/analytics/view` 204-et ad névtelenül, a sor
megérkezik a `page_views` táblába kiszolgálón számolt munkamenetkulccsal, és
`/v1/admin/analytics/visitors` hitelesítés nélkül 401.

---

## 3. Amit a mérés és a tesztek TALÁLTAK

### A mérőkészlet két saját hibája (mindkettő terméki hibának látszott)

1. **„A kiszolgáló elhasal 25 felhasználónál"** — nem hasalt el. A vetett
   hozzáférési token 15 percig él, egy nyolc fokozatos futás fél óránál
   hosszabb, tehát a második fokozattól minden bejelentkezett kérés 401 volt.
   A készlet most frissít, és ha a forgó frissítő token is halott, újra
   bejelentkezik — ahogy egy valódi kliens tenné. A belépés költsége
   (scrypt) így a mérés része, nem kivétel alóla.
2. **„A kiszolgáló bontja a socketeket 10 másodpercnél"** — nem bontotta. A
   k6 socketje Go-oldali objektum; idegen mezőt ráírni kivételt dob, az pedig
   csendben megszakította az iterációt az első szívverésnél. A mérés így
   10 másodperces munkameneteket mutatott 60 másodpercesek helyett, és az
   egészségmutató egyetlen mintát sem vett fel.

Mindkettő azt mutatja, miért kell egy mérőeszközt is hibásnak feltételezni,
amíg az ellenkezője ki nem derül.

### Terméki leletek

| lelet | hol | állapot |
|---|---|---|
| a `watch_history` csak befejezésre írt, indításra nem — így a lemorzsolódási arány kiszámíthatatlan volt | `library/routes.ts` | **javítva** |
| a `devices` tábla és a `sessions.device_id` az első migráció óta létezik, és soha nem írt bele senki | `auth/repository.ts` | **javítva** |
| a `page_views` tábla particionálva, indexelve, üresen állt — az író hiányzott | `analytics/collector.ts` | **javítva** |
| a `/v1/admin/analytics/overview` és `/dashboard` hívása a kliensben létezett, kiszolgálói végpont nélkül | `yume.js` | **megjegyezve** — a régi modul útvonalai megvannak, a kliens hívása holt kód |
| a `kedvencek` és a `hozzászólások` polimorfak (`subject_type`+`subject_id`), nem `anime_id` — négy lekérdezés 500-zal hasalt el | `analytics/admin-routes.ts`, `rollup.ts` | **javítva**, teszt őrzi |
| angol szövegek a magyar panelen: három kérdés, két diagramcímke, három szakaszcím, és élesben az angol mottó | `admin.js`, `site_settings` | **javítva** |

### Saját hiba, amit el kell mondani

A munka közben **felülírtam egy létező modult**: a `modules/analytics/routes.ts`
fájlt, ami a `/badges`, `/analytics/dashboard`, `/analytics/overview`,
`/errors` és `/audit` végpontokat tartja. Ellenőrzés nélkül írtam rá, mert a
könyvtár nevéből arra következtettem, hogy üres. A git verziójából
visszaállítottam, az újat átneveztem (`collect-routes.ts`), és az ütköző
`/overview` útvonalat `/visitors`-re — commitba és élesbe a hibás állapot nem
került.

---

## 4. Amit a kód tartalmaz

### Adatbázis

`0051_analytics_foundations.sql` — hét új tábla, egy sorozat, három
jogosultság aktiválása.

Új adatbázis **nincs**, és nem is kell. A meglévő `page_views`,
`search_stats`, `performance_metrics`, `security_logs`, `watch_history`,
`devices` és `audit_logs` táblákat használjuk, ahogy vannak.

### API

`POST /v1/analytics/view` (nyilvános, írási korlát alatt) és tíz olvasó
végpont `/v1/admin/analytics/*` alatt, három jogosultsághoz kötve.

### Worker

Új `analytics` feladatsor: óránként összesít (ma + tegnap), naponta takarít.

### Felület

`Adminfelület → Betekintés → Látogatottság`, hat fül; a felhasználói panelen
tevékenység, eszközök és munkamenetek külön jogosultsággal.

### Adatvédelem

Nincs süti, nincs kliensoldali azonosító. A látogatói kulcs napi sóval
hashelt, és a só két nap után törlődik. Nyers IP a látogatottsági táblákban
sehol. A nyers keresőkifejezés 30 nap után kiürül, a normalizált marad.
Részletek: [PRIVACY.md](PRIVACY.md), [DATA_RETENTION.md](DATA_RETENTION.md).

---

## 5. Ami NEM készült el

Ezek a kért listáról hiányoznak, és nem azért, mert nem fontosak:

* **WATCH_PAUSE / RESUME / SEEK / BUFFER események.** Szándékosan kimaradtak:
  külön kliensesemények lennének, ingyen hamisíthatók, és a kérdésre („hányan
  indították, hol hagyták abba") az indítás+befejezés is válaszol. Amíg nincs
  videóforrás, nincs is mihez mérni őket.
* **Az élő panel automatikus frissítése.** Az adat élő, de a lap nem frissíti
  magát — újratöltésre jön az új szám.
* **A biztonsági napló megőrzési határideje.** Nincs automatikus ejtés a
  `security_logs`-ra. Ez a legérzékenyebb tábla (IP-t tartalmaz), és a
  dokumentáció inkább kimondja, hogy nincs, mint hogy úgy tegyen, mintha
  lenne.
* **Retenció/anonimizálás tesztje.** A `pruneAnalytics()` megírva és
  beütemezve, de nincs rá teszt, ami időben előreugorva bizonyítaná.
* **A keresésből címnézésbe vezető út** („searches leading to anime views").
  A `search_stats.clicked_id` megvan, a kimutatás nem.
* **Terheléses mérés külön gépről.** A generátor ugyanazon a négymagoson fut,
  amin a mért rendszer — a számok emiatt alsó becslések.
* **Lighthouse, CLS, hosszú feladatok.** A kliens oldali teljesítményt nem
  mértük.

---

## 6. Javasolt következő lépések

1. **Hagyd futni egy hetet, aztán nézd meg a Címek fület.** Ma üres, mert a
   napi összesítő most indult. Egy hét után lesz mihez mérni, és onnantól a
   befejezési arány is beszédes.
2. **A keresés a legdrágább út** (p95 620 ms 250 felhasználónál). Ha a
   forgalom nő, ez lassul először. Mérni kell, mielőtt bármit indexelnénk rá.
3. **A processzor fogy el először, 250 és 500 felhasználó között.** Ha ezt a
   sávot el akarod hagyni, a következő lépés egy nagyobb gép vagy egy második
   app-példány — nem gyorsítótár, nem Redis: a mérés szerint egyik sem ott
   szorít.
4. **Vedd ki a `LOAD_TEST_KEY`-t a `.env`-ből**, ha a mérés lezárult. Amíg
   benne van, a Biztonság képernyő figyelmeztet — helyesen.
5. **A `security_logs` megőrzéséről dönteni kell.** Ez az egyetlen tábla,
   ahol nyers IP korlátlan ideig marad.
6. **A tesztek az éles adatbázison futnak.** A 736 eset ugyanabba az
   adatbázisba ír, amit a látogatók használnak — ez termelte a 34 fiókból a
   30 tesztmaradékot és a hibanapló 500-asait. Külön `yume_test` adatbázis a
   következő nagyobb takarítás.
