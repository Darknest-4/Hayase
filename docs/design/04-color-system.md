# 04 — Színrendszer

A forrás `apps/web/css/tokens.css`. A színek **hsl()**-ben vannak, nem hexben,
egyetlen kivétellel: a `<input type="color">` alapértékei, ahol a HTML literál
hexet követel és a `var()` érvénytelen.

A stíluslapokban **nulla** hardcode-olt színliterál van — sem hex, sem `rgba()`,
sem kulcsszó.

## Alapszínek (primitívek)

| Token | Érték | Mire való |
|---|---|---|
| `--ink-black` | `hsl(0 0% 0%)` | a lap alapja |
| `--ink-900` | `hsl(0 0% 4%)` | kártyák, railek |
| `--ink-800` | `hsl(0 0% 10%)` | keret |
| `--ink-700` | `hsl(0 0% 15%)` | erős keret |
| `--ink-400` | `hsl(0 0% 50%)` | halvány szöveg |
| `--ink-200` | `hsl(0 0% 75%)` | tompított szöveg |
| `--ink-50` | `hsl(0 0% 98%)` | szöveg |
| `--rose-500` | `hsl(346.6 79.1% 51.2%)` | **a kiemelés** |

## Szemantikus réteg — ezt használd, ne a primitívet

| Token | Sötét | Világos | Hol |
|---|---|---|---|
| `--bg` | `hsl(0 0% 0%)` | `hsl(0 0% 100%)` | lap |
| `--bg-raised` | `hsl(0 0% 4%)` | `hsl(0 0% 96%)` | kártya, panel, rail |
| `--bg-overlay` | `hsl(0 0% 4%)` | `hsl(0 0% 100%)` | modál, popover, lebegő nav |
| `--bg-sunken` | `hsl(0 0% 0%)` | `hsl(0 0% 92%)` | mélyedés |
| `--fg` | `hsl(0 0% 98%)` | `hsl(0 0% 4%)` | szöveg |
| `--fg-muted` | `hsl(0 0% 75%)` | `hsl(0 0% 25%)` | másodlagos szöveg |
| `--fg-faint` | `hsl(0 0% 50%)` | `hsl(0 0% 45%)` | metaadat |
| `--border` / `--border-strong` | 10% / 15% | 86% / 74% | elválasztás |
| `--accent` | rózsaszín | ugyanaz | kiemelés |
| `--accent-fg` | `hsl(0 0% 100%)` | ugyanaz | szöveg a kiemelésen |
| `--primary` | `--ink-50` | `hsl(0 0% 8%)` | elsődleges gomb (világos gomb sötét lapon) |
| `--ok` / `--danger` / `--info` / `--live` | zöld / piros / kék / ibolya | ugyanaz | állapot |

## A két szín, ami nem követi a témát

```
--on-media   hsl(0 0% 100%)   szöveg és vezérlő videón vagy borítón
--scrim      hsl(0 0% 0%)     a sötétítés, ami olvashatóvá teszi
```

Fehér egy videókockán **nem** `--fg`: a mögötte lévő felület egy kép, és az
mindkét témában sötét marad. Ez volt korábban 29-szer `#fff`.

## Címenkénti kiemelés

A katalógus tárolja minden borító domináns színét (`anime_images.dominant_color`,
40 349-ből 20 232 sorban van érték). Az adatlap és a lejátszó ebből veszi a
kiemelést:

```css
background: var(--custom, var(--accent));
```

Így az Attack on Titan lapja narancs (`#f1a143`), a Frierené zöld — a gomb, a
chipek, az aktív fül, a lejátszó csúszkája mind követi. Amelyik címnek nincs
színe, az a rózsaszínre esik vissza; a `--custom` ilyenkor **be sem kerül**, és
a CSS fallback intézi.

**A borítót és a bannert ez nem érinti.** A borítóból származik az accent; egy
másik poszterre cserélni annyit tenne, hogy egy oldal máshogy néz ki, cserébe
semmiért.

## Súlyossági és állapotskálák

```
--severity-critical  --red-400      audit-leletek
--severity-high      --amber-400
--severity-medium    --yellow-400
--severity-low       --fg-faint

--status-watching    zöld           könyvtár-állapotok
--status-planning    kék
--status-completed   ibolya
--status-paused      borostyán
--status-dropped     piros
```

A négy súlyosság négy *különböző* árnyalat, nem egy szín négy világossága:
kettő szomszédos szint különbségének nyilvánvalónak kell lennie. A szó minden
jelvényen ott van, tehát színnel semmit nem közlünk egyedül.

## Kategorikus diagramskála

`--chart-1` … `--chart-12`. Ezek korábban hex-tömbként éltek a
`pages/analytics.js`-ben, vagyis a felület egyetlen olyan része, ami csupa
szín, kívül volt a tokenrendszeren és nem tudott témát követni.

Nyitott kérdés, amit ez a dokumentum nem dönt el: tizenkettő a helyes szám-e,
és megkülönböztethetők-e maradnak a gyakori színtévesztéseknél.

## Világos téma

Létezik és átgondolt. A 400-as lépések **irányt váltanak**: sötét alapon
világosabbak a 500-nál (kis szöveget emelni kell), fehéren sötétebbek — egy
világoszöld fehéren alig van ott.
