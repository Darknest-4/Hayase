# 03 — A designrendszer

## Térköz

Egyetlen skála, 4px alappal:

```
--space-1  4px     --space-5  24px
--space-2  8px     --space-6  32px
--space-3  12px    --space-7  48px
--space-4  16px    --space-8  64px
```

1076 token-használat a stíluslapokban. Hardcode-olt térköz **hét** maradt, mind
64px fölött: hero-eltolások, amik geometria, nem térköz.

Ez korábban 561 hardcode-olt érték volt ~50 különböző mérettel, köztük
`.05rem`, `.12rem`, `.18rem`, `.28rem`, `.32rem`, `.38rem`, `.42rem`. Ezek nem
döntések voltak, hanem utólagos igazgatások.

## Sarkok

Három méret és egy alak:

```
--radius-sm    4px     chip, mező, kis vezérlő
--radius-md    8px     kártya, panel, gomb
--radius-lg   14px     nagy felület, üres állapot
--radius-full 999px    pill és kör
```

Öt volt. A 8px és a 10px között annyi a különbség, amennyit senki nem lát, de
mindenkinek dönteni kellett róla. A `--radius-full` nem negyedik méret, hanem
**alak**: az érték elég nagy ahhoz, hogy a sarok mindig félkör legyen,
bármekkora a doboz.

## Mozgás

**Egy időzítés, egy görbe:**

```
--dur    150ms
--ease   cubic-bezier(0.22, 1, 0.36, 1)
```

Egyetlen dokumentált kivétel, és az **nem interakció**, hanem tartalom
érkezése:

```
--dur-reveal  350ms    borító, előzetes, töltésjelző, haladássáv
```

Négy használat, mind `opacity` vagy `width`. 150ms-nál egy beúszó kép
villogásnak látszik, nem áttűnésnek.

**Eltávolítva:** `--ease-spring` (`cubic-bezier(.34,1.4,.64,1)`). Túllőtt, és
tizenhét elem pattant túl a nyugalmi helyzetén hover-re. Az játékosnak olvas,
ez a felület filmszerűnek szánja magát.

Az egész stíluslapban **öt** `@keyframes` és öt `animation` van. A
„ne legyen túlanimálva" nem cél, hanem állapot.

## Árnyék

Pontosan három:

```
--shadow-1   0 1px 3px      finom elválasztás
--shadow-2   0 6px 20px     lebegő felület
--shadow-3   0 16px 48px    modál, lebegő navigáció
```

## Üvegeffektus

Tíz szelektor használ `backdrop-filter`-t, és mind olyan, ami **képen vagy
tartalmon lebeg**: a két modál-háttér, három pontszám/epizódszám chip
borítón, és öt lejátszó-vezérlő videón.

A krómról lekerült — az oldalsáv, a mobil alsó sáv, az admin fejléc, a
szűrősor és az adatlap infópanelje tömör felület. Az üveg ott funkció, ahol
kép van mögötte; máshol dekoráció.

## Amit a rendszer nem enged

- **Nincs hardcode-olt szín** a stíluslapokban — se hex, se `rgba()`, se
  kulcsszó. (Négy hex marad a JS-ben, mind `<input type="color">` alapérték,
  ahol a HTML literált követel.)
- **Nincs 12px alatti szöveg.**
- **Nincs 24px alatti célpont**, egy dokumentált kivétellel.
- **Nincs második görbe és nincs második interakciós időzítés.**
- **A responsive blokk a `style.css` végén marad** — teszt őrzi.

## A tervezés mögötti három elv

**A fallback egy helyen van.** A `titleTheme()` nem ad stílust, ha egy címnek
nincs színe — a CSS `var(--custom, var(--accent))` már megmondta, mi legyen
akkor. Két fallback egy kérdésre eggyel több.

**Az állapotot attribútum hordozza, nem osztály.** `disabled`,
`aria-selected`, `aria-current` — így egy képernyő állapotot állít anélkül,
hogy a komponens belső elnevezését ismerné, és az állapot elhangzik, nem csak
látszik.

**A javítás ott ül, ahol az ok van.** A lábléc egy komponens: egy javítás
tizenkét útvonalon hat. A beállítások kártya-helpere maga címkéz: egy új
kártya nem tudja elfelejteni.
