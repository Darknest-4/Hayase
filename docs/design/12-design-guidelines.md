# 12 — Irányelvek új munkához

## Mielőtt CSS-t írsz

1. **Van rá primitív?** `P.button`, `P.badge`, `P.field`, `P.dialog`,
   `P.table`, `P.emptyState`, `P.errorState`… A 36 jelvény-változat és a 11
   gombosztály abból lett, hogy a következő képernyő nem látta az előzőt.
2. **Van rá token?** Szín, méret, térköz, sarok, árnyék, időzítés — mind van.
3. **Melyik fájlba?** `components.css`, ha minden képernyőé. `style.css`, ha
   egy képernyőé — és **a responsive blokk elé**, különben némán meghal.

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
