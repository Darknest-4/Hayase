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

A megjelenés három fájlban él, és a **betöltési sorrend a szerződés**:

```
tokens.css      145 egyéni tulajdonság — az értékek
components.css  171 szabály            — a primitívek
style.css       5 002 sor              — elrendezés és képernyők
```

Azonos fajsúlyú szabályt a fájlsorrend dönt el, ezért egy képernyő felül tud
írni egy primitívet `!important` nélkül és anélkül, hogy a komponensréteghez
hozzányúlna.

Kódoldalon ugyanez:

```
shared/ui/primitives.js   17 primitív gyár (P.button, P.dialog, …)
shared/ui/components.js   domain-komponensek (kártya, avatar, spotlight, rail)
pages/ + features/        a képernyők
```

## Amit a rendszer betartat magáról

Nem konvenció, hanem teszt:

- **`css-order.test.mjs`** — a responsive blokk a `style.css` végén marad
  (egy media query nem ad többlet-fajsúlyt, így egy előtte lévő felülírás
  némán meghal), és minden hivatkozott token létezik, mindkét stíluslapban.
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
