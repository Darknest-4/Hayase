# 05 — Tipográfia

## Betű

```
--font-sans   'Nunito', 'Segoe UI', system-ui, -apple-system, sans-serif
--font-mono   'Geist Mono', ui-monospace, monospace
```

A Nunito a Google Fontsról jön, `300..800` változó tengellyel. Minden
hivatkozásnak valódi tartaléklánca van.

## Méretskála

Hét lépés, és **csak ez a hét** — a stíluslapokban nincs más abszolút méret.

| Token | rem | px | Használat |
|---|---|---|---|
| `--text-xs` | .75 | 12 | metaadat, chip, jelvény |
| `--text-sm` | .875 | 14 | másodlagos szöveg, gombfelirat |
| `--text-base` | 1 | 16 | törzsszöveg |
| `--text-lg` | 1.185 | 19 | alcím |
| `--text-xl` | 1.42 | 23 | szakaszcím |
| `--text-2xl` | 1.7 | 27 | oldalcím |
| `--text-3xl` | 2.5 | 40 | display |

**12px a padló.** Korábban tíz különböző méret élt alatta, 76 helyen, a
legkisebb 8,5px. Ez nem esztétikai kérdés volt: 8,8px-es szöveget látó ember
sem tud kényelmesen elolvasni.

Három `clamp()` kivétel a kezdőképernyőn, ahol a tipográfia plakát, nem
felület:

```
lp-title      clamp(2.5rem, 11vw, 5.5rem)
lp-display    clamp(1.8rem, 6vw, 3.2rem)
lp-watermark  clamp(6rem, 30vw, 20rem)
```

## Súlyok

```
--weight-normal      400
--weight-medium      600
--weight-semibold    650
--weight-bold        700
--weight-extrabold   780
--weight-black       800
```

A `semibold` és az `extrabold` korábban hiányzott, miközben a stíluslap
hivatkozott rájuk — minden ilyen szabály némán érvénytelen volt, és az elem
azt örökölte, amit talált.

## Sorköz

```
--leading-tight    1.15    címek
--leading-normal   1.5     minden más
```

## Szerepek — ezt használd

A skála nyersanyag. Egy méret, egy súly és egy sorköz **három külön token**,
és minden hívási helyen újra össze kellett rakni őket — innen jött a 43 féle
betűméret. Nem a skáláról volt vita, hanem 43 alkalom arra, hogy az egyiket
kiválaszd és a másik kettőt elfelejtsd.

Hat szerep, mindhárom eldöntve egyszerre, a `font` rövidítéssel költve:

```css
font: var(--type-title);
```

| Szerep | Súly / méret / sorköz |
|---|---|
| `--type-heading` | extrabold / 3xl / tight |
| `--type-title` | bold / 2xl / tight |
| `--type-subtitle` | semibold / lg / normal |
| `--type-body` | normal / base / normal |
| `--type-caption` | normal / sm / normal |
| `--type-metadata` | medium / xs / normal |

Egyik sem vezet be új méretet: mindegyik a fenti skála egy lépésére oldódik
fel.

## Címhierarchia

Minden oldalon pontosan **egy `<h1>`**, és nincs kihagyott szint. A lábléc
saját, képernyőolvasónak szóló `<h2>`-vel kezdődik, az oszlopai `<h3>`-ak —
így a sor `h1 → h2 → h3` akkor is, ha az oldal `h1`-en, és akkor is, ha `h2`-n
végződött. Ezt a 2026-09-15-i audit javította 12 útvonalon.
