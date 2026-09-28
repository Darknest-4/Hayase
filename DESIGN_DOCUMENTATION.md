# Yume — designdokumentáció

A Yume vizuális nyelvének teljes leírása, **ahogy 2026-09-15-én ténylegesen
létezik**. Nem terv és nem szándéknyilatkozat: minden szám mérésből származik,
és minden megkötést teszt őrzi.

> **2026-09-23: frontend-újratervezés.** A keret, a tokenek, a komponensek és a
> legtöbb képernyő átdolgozva — a tényleges állapot leírása:
> [13 — Frontend-újratervezés, 2026. szeptember](docs/design/13-redesign-2026-09.md).
> Ahol az alábbi 01–12 mást mond, a 13-as az irányadó.

## Egy mondatban

Fekete alap, közel fehér szöveg, egyetlen rózsaszín kiemelés — a borítók
színesek, a felület nem. Keretrendszer nélküli ES-modulok, három rétegű CSS,
17 primitív.

## Belépési pontok

| Ha ezt keresed | Olvasd |
|---|---|
| Mi ez és hogy épül fel | [01 — Áttekintés](docs/design/01-design-overview.md) |
| Milyen oldalak vannak | [02 — Oldalleltár](docs/design/02-page-inventory.md) |
| Milyen szabályok szerint | [03 — Designrendszer](docs/design/03-design-system.md) |
| Milyen színek, hol | [04 — Színrendszer](docs/design/04-color-system.md) |
| Betűk, méretek, szerepek | [05 — Tipográfia](docs/design/05-typography.md) |
| Milyen komponensek vannak | [06 — Komponenskönyvtár](docs/design/06-component-library.md) |
| Hogy viselkedik telefonon | [07 — Reszponzív](docs/design/07-responsive-design.md) |
| Mit tart be és mit nem | [08 — Hozzáférhetőség](docs/design/08-accessibility.md) |
| Mit talált az audit | [09 — UX audit](docs/design/09-ux-audit.md) |
| Mi lett javítva | [10 — Javítások](docs/design/10-bug-fixes.md) |
| Min futott és min nem | [11 — Böngészők](docs/design/11-browser-device-testing.md) |
| Hogyan dolgozz tovább | [12 — Irányelvek](docs/design/12-design-guidelines.md) |
| **Mi változott 2026-09-ben** | [13 — Újratervezés](docs/design/13-redesign-2026-09.md) |

## A rendszer számokban (2026-09-28)

```
156   design token (sötét)     20   kliens útvonal
  5   töréspont: 480 / 768 / 1024 / 1280 / 1536
  8   rétegszint (z-index)      3   vezérlőméret + 44px érintés
  6   sarokméret                4   időtartam, 1 görbe
  3   render-blokkoló CSS       36 KB a keret style.css-e (korábban 149 KB)
 16   képernyő-stíluslap        8   közös modul-stíluslap (csak ahol kell)
 20   modul a keretben (korábban 28, előtte 47); minden képernyő lusta modul
```

**Minden oldal csak azt tölti be, ami kell neki** — a képernyő a saját
moduljával és stíluslapjával jön, a ritkán megjelenő rész (ablak, fül, panel) a
megjelenésekor, a magyar szótár csak magyar olvasónak, a két lejátszó közül csak
az induló. Mérés útvonalanként: [13 — 4. fejezet](docs/design/13-redesign-2026-09.md#4-teljesítmény).

## Amit teszt tart be, nem konvenció

- a responsive blokk minden stíluslap végén marad (`css-order.test.mjs`)
- minden útvonal pontosan azt a CSS-t tölti be, amit használ (`route-styles.test.mjs`)
- minden hivatkozott token létezik, mindkét stíluslapban (ugyanott)
- a modulrétegek iránya, és hogy nincs használatlan komponens (`layering.test.mjs`)
- a generált tokencsomag nem csúszik el a forrástól (`design-tokens.test.mjs`)
- minden útvonal renderel, **görög** és nem lóg ki — Chromiumban, WebKitben és
  Firefoxban (`cross-browser.test.mjs`)

## Az audit állapota

```
536  →  208  →  57  →  0     nyers észrevétel, 361 oldalnézeten
```

Tizenegy hiba javítva, mind hozzáférhetőség vagy célpontméret. Nulla
vízszintes túlcsordulás, nulla fehér oldal, nulla JS-hiba — már az első
mérésben is.

**Amit nem mértem:** kontrasztarányok, valódi képernyőolvasó, valódi iOS
eszköz. A 11-es dokumentum tételesen felsorolja, mi emulált és mi nem.
