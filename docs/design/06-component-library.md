# 06 — Komponenskönyvtár

Két fél, és mindkettő kell: `components.css` mondja meg, **hogy néz ki**,
`primitives.js` mondja meg, **mi az**. Egy osztálynév önmagában konvenció, és
a konvencióból lett 1123 osztályszelektor, 36 jelvény-változat és 11 gombosztály.

## Miért volt szétszórva

Egyik primitív sem volt soha egy helyen. Mindegyik abban az oldalszakaszban
született, amelyiknek először kellett: a `.badge` az anime adatlapon, az
`.icon-btn` a könyvtárban, az `.empty-state` a „misc" alatt. A következő
képernyő, amelyiknek ugyanaz kellett, **nem látta**, és írt magának. Nem
hanyagság: nem volt közös cím.

## A 17 primitív

| Gyár | Változatok | Állapotok |
|---|---|---|
| `P.button` | primary, secondary, ghost, danger, theme, sm | hover, focus, disabled, **loading** |
| `P.iconButton` | sm, lg, media | hover, focus, disabled |
| `P.surface` | lg, flush, interactive | hover |
| `P.dialog` | fej / törzs / láb | Escape, háttérre kattintás |
| `P.dropdown` | start, end igazítás | hover, disabled |
| `P.input` `P.textarea` `P.select` | — | focus, disabled, `aria-invalid` |
| `P.checkbox` `P.switch_` | — | checked, disabled |
| `P.field` | címke + hint + hiba | `aria-invalid` beállítása |
| `P.tabs` | — | `aria-selected`, disabled |
| `P.badge` | theme, outline, ok, danger, info | hover (linkként) |
| `P.avatar` | xs, sm, md, lg, xl | — |
| `P.tooltip` (CSS) | jobb oldali | hover, focus |
| `P.skeleton` `P.skeletonRow` | text, title, block, avatar, row | shimmer, reduced-motion |
| `P.spinner` | sm | — |
| `P.pagination` | — | `aria-current`, disabled |
| `P.table` | stack | hover; 720px alatt kártyákra esik |
| `P.emptyState` `P.errorState` | akcióval | — |

## Három szabály, amit érdemes tudni

**A fókusz nincs komponensenként újramondva.** A `tokens.css` globális
`:focus-visible` gyűrűt ad, és az működik. Egy komponens csak akkor beszél
fókuszról, ha *másra* van szüksége (beágyazott gyűrű egy szélig érő
vezérlőn).

**Az állapotokat attribútum hordozza, nem osztály** — `disabled`,
`aria-selected`, `aria-current`. Így egy képernyő be tud állítani egy
állapotot anélkül, hogy ismerné ezt a fájlt, és az állapot **el is hangzik**,
nem csak látszik.

**A gomb betöltés közben megtartja a feliratát**, és átlátszóra festi.
Így nem tud szélességet váltani kérés közben, és nem csúszik ki az ujj alól.

## Domain-komponensek

Ezek nem primitívek, a `shared/ui/components.js`-ben élnek: `C.card` (borító),
`C.avatar`, `C.spotlight`, `C.section` (vízszintes sor), `C.grid`,
`C.skeletonCard`, `C.footer`, `C.authCard`, hover-előnézet.

A `.card` **ennek a terméknek** a borítókártyája, ezért a generikus felület
neve `.surface` — átnevezni a `.card`-ot minden képernyőt érintene, semmiért.

## Amit a rendszer betartat

A `layering.test.mjs` „minden fájl elérhető a belépési pontból" szabálya miatt
**egy komponenskönyvtár, amit definiálnak és nem használnak, megbukik**. A
`primitives.js` addig bukott, amíg valódi képernyők nem importálták.
