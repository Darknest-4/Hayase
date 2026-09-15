# 08 — Hozzáférhetőség

Amit betart, mérve, nem feltételezve — 361 oldalnézeten, három motorban.

## Betartva

**Fókusz.** Globális `:focus-visible` gyűrű (`2px solid var(--accent)`,
2px eltolás), tíz komponens finomítja. Az egész stíluslapban két `outline:
none` van, és mindkettő visszaad gyűrűt.

**Címhierarchia.** Oldalanként pontosan egy `<h1>`, kihagyott szint nélkül.
A lábléc képernyőolvasónak szóló `<h2>`-vel kezdődik, hogy a sor akkor is
folytonos legyen, ha az oldal `h1`-en végződött.

**Célpontméret.** 24px a padló mindenhol, 44px ≤820px-en. Egyetlen kivétel a
lábléc három mondatba ágyazott linkje, ahol a WCAG 2.5.8 kivételt ad.

**Nevek.** Minden `input`, `select` és `textarea` kap nevet — `<label>`,
`aria-label` vagy placeholder. A beállítások oldalon a kártya-helper adja,
tehát egy új kártya nem tudja elfelejteni.

**Csökkentett mozgás.** `prefers-reduced-motion` nullázza a `--dur`-t és a
`--dur-reveal`-t, és megállítja a skeleton csillogását.

**Szín nem hordoz egyedül információt.** A súlyossági jelvényeken és a
könyvtár-állapotokon ott a szó is.

**Ugrás a tartalomra.** `.skip-link` az oldalsáv tucatnyi linkje előtt.

**Billentyűzet.** A modálok Escape-re zárnak; a fülek `aria-selected`-et
használnak; a lapozó `aria-current="page"`-et.

## Nem ellenőrizve

**Kontrasztarányok.** Nem mértem. A `--fg-faint` (`hsl(0 0% 50%)`) feketén
körülbelül 5,3:1 — a normál szöveg 4,5:1-es küszöbe fölött, de a 12px-es
metaadatnál ez a legszűkebb hely a rendszerben, és számítás nem helyettesíti a
mérést.

**Valódi képernyőolvasó.** Nincs VoiceOver, NVDA vagy JAWS ezen a gépen. A
szemantika ellenőrizve (szerepek, nevek, hierarchia), a *hangzás* nem.

**Billentyűzetes végigjárás kézzel.** A fókuszgyűrű léte mérve; hogy a
sorrend értelmes-e minden képernyőn, nem.

## Amit az audit javított

Tizenegy hiba, mind ebben a körben: lásd `09-ux-audit.md`. Ebből három a saját
néhány committal korábbi munkám volt — a landing fejléc-linkjei, a
komponensréteg kapcsolója, és a lábléc célpontjai.
