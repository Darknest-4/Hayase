# 10 — Javítások

A 2026-09-15-i auditból. Minden tétel: mi volt, mi lett, hogyan lett
ellenőrizve.

| ID | Fájl | Javítás |
|---|---|---|
| Y-01 | `shared/ui/components.js` | Lábléc: rejtett `<h2>` a landmarknak, oszlopok `<h4>` → `<h3>` |
| Y-02 | `css/style.css` | `.footer-col a` → `min-height: 24px` a **globális** szabályban |
| Y-03 | `css/style.css` | `.section-more` → 24px |
| Y-04 | `css/style.css` | `.player-back` → 24px |
| Y-05 | `css/style.css` | `.theme-color-input` → `flex-shrink: 0` |
| Y-06 | `pages/admin.js` | 23 vezérlő `aria-label`-t kap a zászló nevével |
| Y-07 | `pages/settings.js` | `_card()` maga címkézi a benne lévő mezőket |
| Y-07 | `pages/search.js`, `features/themes` | fájlválasztó, színválasztó, árnyalat-kapcsoló |
| Y-08 | `pages/settings.js`, `pages/watch.js` | `h3` → `h2` (kihagyott szint) |
| Y-09 | `css/style.css`, `css/components.css` | mindkét `.switch` 24px-re |
| Y-10 | `shared/ui/components.js` | spoiler-jelölő: név + 24px |
| Y-11 | `css/components.css` | landing fejléc-linkek → 24px |

## A javítások jellege

Egy sem egyedi tapasz. Mindegyik ott ül, ahol az ok van:

- A lábléc **egy** komponens, tehát egy javítás tizenkét útvonalon hatott.
- A settings kártya-helper **maga** címkéz, tehát egy új kártya nem tudja
  elfelejteni.
- A célpont-padló a **globális** szabályba került, nem media querybe — a
  Y-02 eredeti hibája pontosan az volt, hogy csak a mobil blokkban élt.
- Az admin `pick()` helper kapott `label` paramétert, nem három hívási hely
  három `aria-label`-t.

## Ellenőrzés

Javítás után minden körben újramérve, ugyanazzal a szondával:

```
536  →  208  →  57  →  0
```

Majd mindhárom motorban újra, 19 útvonalon: tiszta.

Regresszió: 306 kliens teszt, `standard` lint, `tsc --noEmit`, `docker build`
0-val, és a `cross-browser.test.mjs` négy esete.

## Amit szándékosan nem javítottam

**A `.footer-credits` három linkje 16px marad.** Futó mondat közben állnak,
ahol a WCAG 2.5.8 kivételt ad, és egy 44px-es doboz széttörné a sort.

**A kontrasztarányokat nem mértem**, tehát nem is javítottam. Számítás nem
helyettesíti a mérést; lásd `08-accessibility.md`.
