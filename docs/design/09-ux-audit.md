# 09 — UX audit, 2026-09-15

Nem kódolvasás: a futó alkalmazás vizsgálata. **361 oldalnézet** (19 útvonal ×
19 viewport), plusz 57 nézet három motorban.

Minden észrevételt egyenként ellenőriztem, mielőtt hibának neveztem volna.
Ennek oka lentebb olvasható: az első körben **öt hibaosztály álpozitív volt**,
és mind az öt magabiztosan nézett ki.

## Eredmény

```
első mérés     536 nyers észrevétel
javítás után   208
javítás után    57
javítás után     0
```

Nulla vízszintes túlcsordulás, nulla fehér oldal, nulla JS-hiba, nulla törött
kép és nulla hibás kérés **már az első mérésben is** — a korábbi munka tartotta
magát. Amit az audit talált, az kivétel nélkül hozzáférhetőség és
célpont-méret volt.

---

## A hibák

### Y-01 · Lábléc: hierarchia-ugrás · HIGH · Accessibility
**Útvonal:** 12 (minden lábléces oldal) · **Komponens:** `C.footer()`
**Viewport:** mind

A lábléc oszlopcímei `<h4>`-ek, az oldalak `h1`-en vagy `h2`-n végződnek, így
minden oldalon kimarad egy szint (`2→4`, `1→4`).

*Miért baj:* egy képernyőolvasó a címhierarchiából építi az oldal vázlatát. Egy
kihagyott szint azt sugallja, hogy van egy szakasz, amit nem talál.

*Reprodukció:* bármely oldal → a lábléc oszlopcímei.

*Megoldás:* a landmarknak saját, csak képernyőolvasónak szóló `<h2>`-je lett
(„Oldaltérkép"), az oszlopok `<h3>`-ra. Így a sor `h1 → h2 → h3` minden
oldalon, függetlenül attól, mi volt fölötte. **Javítva.**

### Y-02 · Lábléc-linkek 21px magasak asztali gépen · HIGH · Accessibility
**Útvonal:** minden · **Komponens:** `.footer-col a`

A `min-height: 44px` szabály **csak a ≤820px-es media queryben** élt. Asztali
nézetben a linkek 21px magasak.

*Miért baj:* a WCAG 2.5.8 padlója 24px. A kivétel mondat közbeni linkekre
vonatkozik — ezek listában állnak, rájuk nincs.

*Külön megjegyzés:* a CSS-ben lévő komment azt állította, hogy ezek „tisztázzák
a WCAG 24px-ét". Nem tisztázták. A komment a `.footer-credits` linkekről szólt
(azok tényleg mondatban ülnek és tényleg kivételesek), és átcsúszott a
szomszédos szabályra.

*Megoldás:* `min-height: 24px` a globális szabályban, nem media queryben.
**Javítva.**

### Y-03 · `.section-more` 18px · MEDIUM · Accessibility
**Útvonal:** home · A sor egyetlen kifelé mutató linkje („Továbbiak").
`min-height: 24px`. **Javítva.**

### Y-04 · `.player-back` 21px · MEDIUM · Accessibility
**Útvonal:** watch · A lejátszó képernyő egyetlen navigációja vissza a
sorozathoz; nem lehet a legkisebb célpont rajta. **Javítva.**

### Y-05 · Színválasztó 2px szélesre lapul · HIGH · UI
**Útvonal:** themes · **Komponens:** `.theme-color-input`

Deklarált mérete 48×48, mérve **2×48, 3×48, 12×48**. Az ok: flex-sorban ül,
`flex-shrink: 1`-gyel, és ott a `width` csak javaslat.

*Miért baj:* egy színválasztó, ami néhány pixel széles, megszűnik színválasztó
lenni.

*Megoldás:* `flex-shrink: 0`. **Javítva.**

### Y-06 · 23 címkétlen vezérlő az admin/config oldalon · MEDIUM · Accessibility
**Útvonal:** admin/config · Funkciókapcsolók sorai: a kapcsoló neve a *soron*
van, nem a vezérlőn, így képernyőolvasóval huszonhárom „szerkesztőmező" hallatszik,
megkülönböztethetetlenül. `aria-label` minden vezérlőre, a zászló nevével.
**Javítva.**

### Y-07 · Címkétlen vezérlők: search, settings, themes, admin/users, admin/catalogue · MEDIUM · Accessibility

A beállítások oldalon a javítás **a helperben** történt: a `_card(cím, leírás,
vezérlő)` maga adja a címkét a benne lévő mezőknek. A cím két sorral a mező
fölött *pontosan azt mondja, mit csinál a mező* — csak épp egy cím nem címke.
Így minden mai és jövőbeli kártya kap nevet, és egy új nem tudja elfelejteni.
**Javítva.**

### Y-08 · `settings` és `watch`: `h1 → h3` · MEDIUM · Accessibility
A két oldal saját szerkezete hagyott ki egy szintet. `h3 → h2`. **Javítva.**

### Y-09 · Kapcsolók a 24px-es padló alatt · MEDIUM · Accessibility
Két `.switch` létezik: a régi a `style.css`-ben (42×23px) és **a saját
komponensrétegem** (34×18px). Mindkettő a padló alatt. Mindkettő 24px-re
emelve. Ez a sajátom volt, két committal korábbról.

### Y-10 · Hozzászólás spoiler-jelölő · MEDIUM · Accessibility
Nyers 13×13-as checkbox, név nélkül (a „Spoiler" szó testvér `span`-ban áll a
label*en kívül*). Név és 24px. **Javítva.**

### Y-11 · Landing fejléc-linkek 21px · MEDIUM · Accessibility
Szintén az én kódom, két committal korábbról. Az audit ugyanúgy megtalálta,
ahogy a láblécét. **Javítva.**

---

## Öt álpozitív, és miért érdemes leírni őket

Egyik sem a termék hibája volt. Mind az öt meggyőzően nézett ki.

1. **„Egyetlen oldal sem görgethető."** A dokumentum sosem görög: az
   `.app-shell` `height: 100dvh; overflow: clip`, a görgető a `.page`. Aki
   `window.scrollTo`-t mér, semmit nem mér — és sikert jelent.

2. **„Firefoxban 12, Chromiumban 6, WebKitben 2 útvonal törött."** A `.page`
   `scroll-behavior: smooth`, tehát a `scrollTop` animál. Két képkocka múlva
   visszaolvasva minden motor azt mondja, nem mozdult — motoronként más
   ütemben. Pont úgy néz ki, mint böngészőhiba.

3. **„WebKit egyetlen útvonalon sem görget érintésre."** Szintetikus
   `TouchEvent` egyik motorban sem vált ki natív görgetést, a `mouse.wheel`
   pedig érintéses kontextusban értelmetlen.

4. **„Kilenc oldal nem görgethető."** A küszöböm fix 100px volt. A community
   teljes görgetési tartománya 90px — görög, csak kevesebbet.

5. **„Az alkalmazás nem indul el."** A mérés egy **429-es** hibalapot mért:
   a saját tesztjeim futottak bele a rate limitbe.

A tanulság nem az, hogy óvatosnak kell lenni, hanem hogy **a mérőeszközt
ugyanúgy ellenőrizni kell, mint a mért dolgot** — negatív teszttel. A
`cross-browser.test.mjs` ezért tartalmaz szándékos elrontást is.
