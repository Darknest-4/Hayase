# 11 — Böngésző- és eszköztesztelés

**A legfontosabb sor ebben a fájlban:** ezen a gépen nincs valódi telefon és
nincs valódi Safari. Ami emulált, az emulált, és alább annak van jelölve.

## Motorok

| Motor | Verzió | Állapot | Mit fed le |
|---|---|---|---|
| Chromium | 153.0.8010.12 | **Tesztelve** | Chrome, Edge, Android Chrome, Opera, Brave |
| WebKit | 26.6 | **Tesztelve** | Safari és iOS Safari *motorja* |
| Firefox | 155.0 | **Tesztelve** | Firefox asztali és Android |

## Amit ez nem jelent

**Edge: nem külön tesztelve.** Az Edge Chromiumra épül, ugyanazzal a
renderelővel. A saját felülete (kollekciók, függőleges lapok) nem érinti az
oldalt. *Részben tesztelve, a motor szintjén.*

**iOS Safari: nem tesztelve.** A WebKit 26.6 a motorja, de az iOS Safari
ezen felül hoz olyasmit, amit emuláció nem ad: valódi érintés a kompozitorban,
a címsáv mozgása görgetés közben, a Home indicator, a rugalmas túlgörgetés, a
`-webkit-` sajátosságok a videólejátszásban. **Itt a legnagyobb a
bizonytalanság**, és a felhasználó eddig innen jelentett hibát.

**Android Chrome: nem tesztelve.** A Chromium a motorja; egy Pixel 7 profillal
mértem, ami viewportot és érintés-jelzőt állít, eszközt nem.

**Valódi eszköz: egy sem.**

## Viewportok — mérve

19 méret, mind **tesztelve** Chromiumban, 361 oldalnézet:

```
mobil     320×568  360×640  375×667  390×844  393×852  412×915  430×932
tablet    600×800  768×1024  820×1180  834×1194  1024×1366
asztali   1280×720  1366×768  1440×900  1536×864  1920×1080  2560×1440
ultrawide 3440×1440
```

WebKitben és Firefoxban 375×667, 768×1024 és 1440×900 — 19 útvonal
mindegyikén.

**Fekvő tájolás: nem külön tesztelve.** A szélesebb viewportok (pl. 1024×1366)
gyakorlatilag lefedik a fekvő tablet arányait, de a tájolásváltás *eseménye*
— ami például egy nyitott modálnál számít — nem lett kipróbálva.

## Mit mér a szonda oldalanként

Vízszintes túlcsordulás (és a kilógó elem neve), a **valódi görgető** mozgása,
célpontméretek a 24px-es padló alatt, levágott szöveg, törött képek, hiányzó
`alt`, `<h1>` darabszám, kihagyott címszint, névtelen mezők és gombok,
JS-hibák, 4xx/5xx kérések.

## Eredmény

```
első mérés     536 nyers észrevétel
javítások után   0     (361 oldalnézet, Chromium)
                 0     (57 oldalnézet, WebKit + Firefox)
```

## Ami állandó teszt lett

`tests/e2e/cross-browser.test.mjs` mindhárom motort futtatja plusz egy
iPhone 13 profilt, és **szándékos elrontásra megbukik** — `touch-action: none`
a `.page`-re ejtve minden útvonalon jelent, nem csendben átmegy. A meglévő
`npm run test:e2e` felveszi.
