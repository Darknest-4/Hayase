# 12 — Irányelvek új munkához

## Mielőtt CSS-t írsz

1. **Van rá primitív?** `P.button`, `P.badge`, `P.field`, `P.dialog`,
   `P.table`, `P.emptyState`, `P.errorState`… A 36 jelvény-változat és a 11
   gombosztály abból lett, hogy a következő képernyő nem látta az előzőt.
2. **Van rá token?** Szín, méret, térköz, sarok, árnyék, időzítés — mind van.
3. **Melyik fájlba?** (2026-09 óta minden oldal csak azt tölti be, ami kell neki.)
   - `components.css` — a tervrendszer komponense, amit több képernyő használ.
   - `style.css` — **csak a keret** (oldalsáv, alsó sáv, gyorskereső, fiókmenü,
     lábléc, kapuk, toastok) és a valóban közös alap (`.page-pad`,
     `.setting-card`). Ez minden oldalon letöltődik, tehát ide képernyő ne kerüljön.
   - `css/pages/<útvonal>.css` — egy képernyő saját szabályai. A router tölti be
     az útvonallal együtt (`ROUTE_STYLES` a `src/app/router.js`-ben).
   - `css/features/<modul>.css` — egy modulé, amit több képernyő használ
     (hozzászólások, belépőűrlap, diagramok…). Vagy a használó útvonalak
     `ROUTE_STYLES`-ába kerül, vagy — ha csak egy művelet/fül nyomán jelenik meg
     (ablak, panel, fül) — a modul maga tölti be közvetlenül a rajzolás előtt:
     `await loadStylesheet('features/x.css')`.
   - Minden lapon **a töréspontok a lap végén** — különben egy később jövő sima
     szabály némán felülírja őket (a `css-order.test.mjs` minden lapra nézi).
   - A `route-styles.test.mjs` minden útvonalra kiszámolja, mit használnak a
     moduljai, és elbukik, ha egy szükséges lap hiányzik, egy felsorolt lapból
     semmi nem kell, vagy a keretbe egyetlen képernyő saját szabálya került.
4. **JS is csak ott, ahol kell.** Minden képernyő lusta modul (`ROUTE_MODULES`).
   Ami csak egy fülön vagy egy műveletnél kell (a beállítások témaválasztója, a
   lejátszó, egy szerkesztőablak), azt ott importáld dinamikusan. `shared/`-ből
   és `app/`-ból ne importálj statikusan nehéz funkciót: az minden oldal első
   betöltése lesz.

## Kemény szabályok

- Ne írj színliterált. Sem hexet, sem `rgba()`-t, sem `white`-ot.
- Ne menj 12px alá szöveggel.
- Ne menj 24px alá kattintható elemmel. Ha mondatba ágyazott link, az kivétel
  — írd le, miért.
- Ne vezess be új időzítést vagy görbét.
- Ne állítsd `outline: none`-ra a fókuszt anélkül, hogy visszaadnál valamit.
- Ne tegyél `min-height`-ot media querybe, ha a probléma minden szélességen
  fennáll. A Y-02 hiba pontosan ez volt.

## Amikor mérsz

**A dokumentum nem görög.** A görgető a `.page`. Aki `window.scrollTo`-t hív,
sikert jelent anélkül, hogy megnézett volna bármit.

**A `scroll-behavior: smooth` animál.** Kérj `behavior: 'instant'`-ot, és adj
neki időt.

**A szintetikus `TouchEvent` semmit nem görget**, egyik motorban sem.

**A küszöböt a valós maximumhoz mérd**, ne fix számhoz. Egy 90px görgetési
tartományú oldal nem törött.

**Ellenőrizd a mérőeszközt is.** Írj negatív tesztet: rontsd el szándékosan
azt, amit mérsz, és nézd meg, hogy fog-e. A `cross-browser.test.mjs` ezért
tartalmaz ilyet.

## Amikor képernyőt építesz

**A mobil nem kicsinyített asztali.** A táblázat kártyákra esik
(`.table-stack`), nem oldalra görög. A lebegő navigáció a hüvelykujjnál van,
nem a szem magasságában.

**Minden listának három állapota van:** betöltés, üres, hiba. A skeleton a
tartalom *alakját* kövesse — a `P.skeletonRow()` azért van, mert egy szürke
doboz nem mond semmit.

**A fokozatos feltárás bekezdésen indokolt, rövid listán nem.** Nyolc sorból
négyet elrejteni többe kerül, mint amennyit ér.

**Ne másold le a következetlenséget.** Ha egy referencia két helyen máshogy
csinálja ugyanazt, az nem két minta, hanem egy döntés kétszer.
