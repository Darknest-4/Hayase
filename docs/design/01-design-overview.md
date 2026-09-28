# 01 — Áttekintés

**Állapot:** 2026-09-15. Ez a dokumentum azt írja le, ami *van*, nem azt, ami
tervben volt.

## Mi ez

A Yume egy keretrendszer nélküli, ES-modulokból álló webkliens: nincs React,
nincs build-lépés a kliensen, a böngésző natív modulokat tölt be. A szerver
Fastify + PostgreSQL. A kliens 18 útvonalat és 16 admin szekciót szolgál ki.

## A vizuális nyelv egy mondatban

Fekete alap, közel fehér szöveg, egyetlen rózsaszín kiemelés — **a borítók és
a képek a színesek, a felület nem**. Visszafogott, filmszerű, nem játékos.

## Rétegek

A megjelenés rétegekben él, és a **betöltési sorrend a szerződés**:

```
tokens.css        az értékek (156 token)             — minden oldalon
components.css    a tervrendszer komponensei         — minden oldalon
style.css         csak a keret (oldalsáv, alsó sáv,   — minden oldalon
                  gyorskereső, lábléc, kapuk)
css/pages/*.css   egy képernyő saját szabályai (16)   — csak azon a képernyőn
css/features/*.css több képernyő közös modulja (8)    — csak ahol a modul rajzol
admin.css, player2.css, maintenance.css               — csak a saját felületükön
```

2026-09 előtt a `style.css` egyetlen 149 KB-os fájl volt, amit minden oldal
letöltött, és amiből egy oldal 2–17 KB-ot használt. A képernyők lapjait a
router tölti be az útvonallal együtt (`ROUTE_STYLES`), a ritkán megjelenő
részekét (ablak, panel, fül) a modul maga, közvetlenül a rajzolás előtt. Lásd
[13 — Újratervezés, 4. fejezet](13-redesign-2026-09.md#4-teljesítmény).

Azonos fajsúlyú szabályt a fájlsorrend dönt el, ezért egy képernyő felül tud
írni egy primitívet `!important` nélkül és anélkül, hogy a komponensréteghez
hozzányúlna. A lusta lapok egymáshoz képesti sorrendje a látogatás sorrendjétől
függ, ezért két ilyen lap között nem lehet sorrendfüggő átfedés — ezt a
szétválogatás ellenőrizte, és a `css-order.test.mjs` a töréspontokra őrzi.

Kódoldalon ugyanez:

```
shared/ui/primitives.js   17 primitív gyár (P.button, P.dialog, …)
shared/ui/components.js   domain-komponensek (kártya, avatar, spotlight, rail)
pages/ + features/        a képernyők
```

## Amit a rendszer betartat magáról

Nem konvenció, hanem teszt:

- **`css-order.test.mjs`** — a responsive blokk minden stíluslap végén marad
  (egy media query nem ad többlet-fajsúlyt, így egy előtte lévő felülírás
  némán meghal), egyik lap sem lapítja el egy másik töréspontját, és minden
  hivatkozott token létezik, minden stíluslapban.
- **`route-styles.test.mjs`** — minden útvonal pontosan azt a CSS-t tölti be,
  amit a moduljai használnak: se kevesebbet (stílus nélküli elem), se többet
  (fölösleges letöltés), és a keret lapjában nincs egyetlen képernyő saját
  szabálya sem.
- **`layering.test.mjs`** — a modulrétegek iránya: `shared → entities →
  features → pages → app`. Egy komponenskönyvtár, amit senki nem használ,
  megbukik az „minden fájl elérhető a belépési pontból" szabályon.
- **`design-tokens.test.mjs`** — a `packages/design-tokens` generált másolat
  nem csúszhat el a forrástól.
- **`cross-browser.test.mjs`** — Chromium, WebKit és Firefox: minden útvonal
  renderel, **görög**, és nem lóg ki oldalra.

## A token-forrás

`apps/web/css/tokens.css`. A `packages/design-tokens/` ebből **generált**
(`node packages/design-tokens/build.mjs`) azoknak a felületeknek, amelyek nem
tudnak CSS-t olvasni. A generált fájl kézi szerkesztése némán elvész.

## Mit olvass ezután

| Fájl | Miről szól |
|---|---|
| `02-page-inventory.md` | minden útvonal, felépítés, viselkedés |
| `03-design-system.md` | a rendszer szabályai és a döntések indoklása |
| `04-color-system.md` | színek, hol és miért |
| `05-typography.md` | betűk, méretek, szerepek |
| `06-component-library.md` | a 17 primitív, állapotokkal |
| `07-responsive-design.md` | breakpointok, a görgetési architektúra |
| `08-accessibility.md` | mit tart be és mit nem |
| `09-ux-audit.md` | a 2026-09-15-i audit, hibánként |
| `10-bug-fixes.md` | mi lett javítva és hogyan lett ellenőrizve |
| `11-browser-device-testing.md` | mi lett tesztelve — és mi nem |
| `12-design-guidelines.md` | szabályok új munkához |
