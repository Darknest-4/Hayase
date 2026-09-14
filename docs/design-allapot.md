# Yume — design állapotfelmérés

**Dátum:** 2026-09-14 · **Ág:** `claude/audit-and-audit-status-page`
**Mérve:** `apps/web/css/style.css` (5073 sor), `apps/web/css/tokens.css`,
`apps/web/src/` (200 modul), és a futó példány valódi Chromiumban, bejelentkezve.

Ez a dokumentum a *jelenlegi* állapotot írja le. Nem javaslat és nem terv —
az a következő lépések dolga. Minden szám mérésből származik, a mérés módja
minden szakasznál ott van, hogy megismételhető legyen.

---

## 0. Összefoglalás

A vizuális nyelv nincs elrontva. A tokenrendszer létezik, jól van megtervezve,
és a színek majdnem tiszták. A probléma nem az, hogy rossz a rendszer, hanem
hogy **nincs végigvíve**: a kód 96%-a megkerüli.

| Mérés | Érték | Megjegyzés |
|---|---|---|
| Közös komponens-hívás (`C.*`) | **73** | |
| Kézzel épített DOM (`U.el`) | **1718** | 4% újrahasználat |
| Különböző osztályszelektor | **1123** | 15 oldalra |
| Különböző fontméret | **43** | ebből 36 hardcode |
| Különböző spacing érték | **~50** | 387 token-használat *mellett* |
| 12px alatti szöveg | **76 helyen** | legkisebb 8.5px |
| Oldal, amin van skeleton | **2 / 15** | |
| 375px vízszintes túlcsordulás | **0** | ez rendben van |

A három legnagyobb tétel, súly szerint:

1. **`admin.js` 4211 sor** — az oldalkód 52%-a, 492 saját osztállyal és 915
   kézi DOM-hívással, miközben összesen 8-szor nyúl a közös komponensekhez.
   Ez nem egy oldal, hanem egy párhuzamos alkalmazás saját designnyelvvel.
2. **A spacing kettős élete** — a skála jó és a kód használja is (387 helyen),
   de mellette ~50 egyedi érték fut, köztük `.05rem`, `.12rem`, `.18rem`,
   `.28rem`, `.32rem`, `.38rem`, `.42rem`. Ezek nem döntések, hanem
   igazgatások.
3. **A responsive karantén** — 969 sor (19%) egyetlen blokkban a fájl végén,
   4105. sortól. Minden komponens mobil viselkedése több ezer sorral távol van
   magától a komponenstől.

---

## 1. Előfeltétel: betölt-e a kliens?

**Igen.** Ez volt a feladat kikötése, ezért külön ellenőriztem.

Valódi Chromium, a futó példány ellen (`172.20.0.3:4000`), mind a 14 route:

```
ok  home  search  schedule  list  profile  notifications  dashboard
    community  changelog  settings  admin  anime/1  watch/1  w2g
```

Egyik sem fehér oldal, egyik sem dob kivételt bootkor. Bejelentkezve a
tartalom valódi: a `home` 11 144 karakter, az `anime/1` a Cowboy Bebopot
adatokkal, a `watch/1` a lejátszót.

Kiegészítő ellenőrzések ugyanitt:

- az `index.html` mind a 4 helyi hivatkozása létezik (`yume.svg`,
  `style.css`, `tokens.css`, `main.js`);
- a 200 relatív import közül **0** feloldatlan.

*Egy dolgot nem láttam:* az admin oldalt bejelentkezve, admin joggal. A
teszt-fiók szerepkör-adását a rendszer megtagadta (DB-írás), így az admin
szekciót statikusan mértem. Ez a felmérés egyetlen lyuka.

---

## 2. Border-radius

**Token: 5 érték. A feladat legfeljebb hármat enged.**

| Érték | Token | Előfordulás |
|---|---|---|
| 999px | `--radius-full` | 79 |
| 8px | `--radius-md` | 70 |
| 10px | `--radius-lg` | 53 |
| 4px | `--radius-sm` | 37 |
| 14px | `--radius-xl` | 2 |

Ez a rendszer legegészségesebb része: 245 token-használat mellett mindössze
**6 hardcode** (`999px`×2, `3px`×2, `50%`, plusz négy sarok-kombináció).

A gond nem a szórás, hanem a **felbontás**: a `--radius-md` (8px) és a
`--radius-lg` (10px) között 2px a különbség — ezt senki nem látja, de minden
komponensnél dönteni kell róla. A `--radius-xl` pedig 2 helyen él.

---

## 3. Spacing

**~50 különböző hardcode-olt érték, 387 token-használat mellett.**

A skála maga pontosan az, amit a feladat kér:

```
--space-1: 4px   --space-2: 8px   --space-3: 12px  --space-4: 16px
--space-5: 24px  --space-6: 32px  --space-7: 48px  --space-8: 64px
```

Tehát nem új skála kell, hanem **adoptáció**. A leggyakoribb hardcode-ok:

| Érték | px | Előfordulás | Legközelebbi token |
|---|---|---|---|
| `.6rem` | 9.6 | 66 | `--space-2` (8) |
| `.5rem` | 8 | 66 | `--space-2` (8) ✓ pontosan |
| `.4rem` | 6.4 | 50 | `--space-2` (8) |
| `.35rem` | 5.6 | 39 | `--space-1` (4) |
| `.3rem` | 4.8 | 38 | `--space-1` (4) ✓ közel |
| `.1rem` | 1.6 | 37 | — nincs |
| `.7rem` | 11.2 | 34 | `--space-3` (12) |
| `.75rem` | 12 | 25 | `--space-3` (12) ✓ pontosan |

A `.5rem` és a `.75rem` **pontosan** token-értékek, csak nem tokenként írták
le — ez 91 azonnali, kockázatmentes csere.

A farok viszont valódi munka: `.05rem`, `.12rem`, `.16rem`, `.18rem`,
`.28rem`, `.32rem`, `.38rem`, `.42rem`, `.62rem`, `.65rem`, `.85rem` —
egyenként 1–5 előfordulással. Ezek utólagos igazgatások, és a kerekítésük
látható elmozdulást okozhat; nem sed-elhetők vakon.

Bontás tulajdonságonként: padding 37, gap 20, margin 16 különböző atomi érték.

---

## 4. Tipográfia

**43 különböző fontméret. Ebből 7 token, 36 hardcode.**

A token-skála: `--text-xs` .75rem, `sm` .875, `base` 1, `lg` 1.185,
`xl` 1.42, `2xl` 1.7, `3xl` 2.5.

Az adoptáció felül jó, alul rossz. A `--text-xs` 177-szer, a `--text-sm`
105-ször szerepel — de **alattuk** egy egész árnyékskála él:

```
.72rem 11.5px   .7rem 11.2px    .68rem 10.9px   .66rem 10.6px
.65rem 10.4px   .64rem 10.2px   .62rem  9.9px   .6rem   9.6px
.58rem  9.3px   .55rem  8.8px   8.5px   8.5px   11px
```

**76 előfordulás 12px alatt**, tíz különböző méreten, a legkisebb 8.5px.
Ez a rendszer legrosszabbul álló dimenziója, és nem csak esztétikai kérdés:
8.8px-es szöveget sok látó ember sem tud kényelmesen elolvasni.

Amit a feladat kér (heading / title / subtitle / body / caption / metadata,
mindegyik méret+súly+sorköz hármassal), az ma **nem létezik**. Ma külön van
méret (`--text-*`), külön súly (`--weight-*`) és külön sorköz
(`--leading-tight|normal`), a hármas összerakása minden hívási helyen újra
megtörténik. Innen jön a 43-as szórás.

A súlyskála viszont rendben: 6 lépés, mind definiált. (A `--weight-semibold`
és `--extrabold` korábban hiányzott és minden rájuk hivatkozó szabály néma
módon érvénytelen volt — ez már javítva.)

---

## 5. Színek

**Ez a rendszer legjobb állapotú része. Nem kell hozzányúlni.**

- 29 hardcode-olt hex az egész fájlban, 11 különböző;
- ebből 16 a `#fff`;
- a maradék az érem-színek (`#ffd700`, `#c0c0c0`, `#cd7f32`) és négy
  chart-szín;
- 10 nyers `rgba()`, 0 nyers `hsl()`.

A szemantikus réteg teljes: `--bg` / `--bg-raised` / `--bg-overlay` /
`--bg-sunken`, `--fg` / `--fg-muted` / `--fg-faint`, `--border` /
`--border-strong`, `--accent`, `--ok` / `--danger` / `--info` / `--live`,
plusz külön severity- és library-status-skála. Van működő világos téma, ami
a 400-as lépéseket **irányt váltva** definiálja újra — ez átgondolt munka.

A feladat kikötése („ne vezess be új palettát") tehát magától teljesül:
itt nincs mit bevezetni, csak a 13 maradék literált hazavinni.

---

## 6. Árnyék és mozgás

**Árnyék:** 3 token (`--shadow-1|2|3`), pontosan annyi, amennyit a feladat
enged. 31 `box-shadow` deklarációból 18 tokenre hivatkozik, **13 nem** —
ezek jellemzően fókusz- és glow-gyűrűk.

**Mozgás:** 77 `transition` deklarációból **73 tokenizált** (95%). Ez a
legmagasabb adoptációs arány az egész rendszerben.

A feladat egyetlen időzítést és görbét kér; ma 3 időtartam (`--dur-fast`
120ms, `--dur-base` 200ms, `--dur-slow` 350ms) és 2 görbe (`--ease-out`,
`--ease-spring`) van. A `--ease-spring` (`cubic-bezier(.34,1.4,.64,1)`)
túllövő görbe — ez az, ami „játékos" hatást ad, és a kért „cinematic,
prémium, nem túlanimált" nyelvvel áll szemben.

**Animáció:** mindössze 5 `@keyframes` és 5 `animation` deklaráció. A
„ne legyen túlanimálva" kikötés **már ma teljesül**. Van `prefers-reduced-motion`
kezelés, ami mindhárom időtartamot 0-ra viszi.

---

## 7. A tiltólistás jelenségek

Amit a feladat kifejezetten nem akar, és ami ma ténylegesen jelen van:

| Jelenség | Előfordulás | Ítélet |
|---|---|---|
| `backdrop-filter` (glassmorphism) | **23** | sok; ez a legnagyobb tétel |
| `linear-gradient` | 18 | határeset |
| `radial-gradient` | 2 | rendben |
| `text-shadow` (glow) | 3 | rendben |
| `filter: blur/drop-shadow` | 33 | ellenőrzendő, mennyi ebből a hover-preview |
| neon / telített kiemelés | — | nincs; a paletta visszafogott |

A „neon, gamer-hatás" tehát nem probléma. A **glassmorphism igen**: 23 hely.

---

## 8. Komponensek — mi van és mi nincs

A közös réteg (`shared/ui/components.js`, 802 sor) **domain-komponenseket**
ad: `card`, `avatar`, `spotlight`, `footer`, `section`, `grid`,
`skeletonCard`, `listControls`, hover-preview.

Primitívekből viszont csak a **gomb** van meg rendesen, CSS-ben:
`.btn` + `-primary` / `-secondary` / `-ghost` / `-danger` / `-sm`.

Amit a feladat kér, és ma **nincs** egységesen definiálva:

| Komponens | Állapot |
|---|---|
| Button | ✅ megvan (`.btn` + 4 variáns) — de **11 saját gombosztály** kerüli meg |
| IconButton | ❌ szórtan: `.icon-btn`, `.detail-icon-btn`, `.preview-icon-btn`, `.admin-menu-btn`, `.player-btn`, `.ep-num-btn` |
| Card | ⚠️ 27 `*card*` osztály |
| Modal / Dialog | ⚠️ 7 osztály (`modal`, `sheet`, `drawer`, `popover`) |
| Dropdown | ❌ nincs önálló |
| Input / Select | ⚠️ `.input`, `.select` létezik; Checkbox / Switch nincs |
| Tabs | ❌ oldalanként külön (`.dtab`, admin rail, profil-tabok) |
| Badge | ⚠️ **36** `badge/chip/pill/tag` osztály |
| Avatar | ✅ `C.avatar()` |
| Toast | ⚠️ CSS-ben van, primitívként nincs |
| Tooltip | ❌ a sidebar `title=` attribútummal oldja meg |
| Skeleton | ❌ egyetlen generikus `.skeleton` + admin-specifikus `.aud-skel*` |
| Pagination | ❌ nincs |
| Table | ❌ 2 osztály, az admin sajátjai |
| EmptyState | ⚠️ `.empty-state` létezik, de nem minden oldal használja |
| ErrorState | ❌ nincs |

A 36 badge-osztály és a 27 card-osztály a két legnagyobb duplikációs fészek.

### Fókusz — a feltételezés itt téves

A feladat azt írja: „a focus állapot látható legyen billentyűzetes
navigációnál — ez most valószínűleg hiányzik."

**Nem hiányzik.** A 41. sorban ott a globális szabály:

```css
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

és rajta felül 10 komponens-specifikus `:focus-visible` finomítás. Az egész
fájlban mindössze **két** `outline: none` van:

- `.input, .select` (537) — de az 541. sor visszaadja `border-color` +
  `box-shadow` gyűrűvel, tehát fedett;
- `.search-modal-input-wrap input` (1637) — **ez valódi lyuk**, nem ad vissza
  semmit. A gyakorlatban enyhíti, hogy a Ctrl+K modál megnyitáskor ide
  fókuszál és ez az egyetlen fókuszálható elem benne.

Tehát a fókusz-munka nem nulláról indul: egy lyuk befoltozása és a meglévő
szabály megtartása a feladat, nem rendszerbevezetés.

---

## 9. Oldalankénti saját CSS

A `style.css` 59 szekcióra oszlik, és **oldalanként** van szervezve, nem
komponensenként. A legnagyobbak:

| Sorok | Szekció |
|---|---|
| 618 | *responsive* (karantén, lásd lentebb) |
| 404 | watch page / player |
| 387 | anime detail page |
| 246 | admin: rail, header, drawer |
| 183 | admin: overview dashboard |
| 146 | extension store |
| 128 | admin: audit trail |
| 104 | hover preview panel |
| 104 | anime card |

Kódoldalon ugyanez a kép, élesebben:

| Oldal | Sor | `C.*` | `U.el` | Saját osztály |
|---|---|---|---|---|
| **admin** | **4211** | **8** | **915** | **492** |
| watch | 1136 | 5 | 155 | 102 |
| anime | 686 | 8 | 133 | 85 |
| settings | 345 | 1 | 55 | 17 |
| forum | 326 | 6 | 74 | 39 |
| onboarding | 263 | 1 | 23 | 21 |
| dashboard | 234 | 2 | 49 | 40 |
| search | 217 | 4 | 29 | 16 |
| home | 167 | 7 | 19 | 14 |
| profile | 162 | 3 | 19 | 15 |
| notifications | 156 | 1 | 16 | 13 |
| list | 144 | 5 | 21 | 15 |
| changelog | 107 | 2 | 22 | 20 |
| community | 106 | 5 | 15 | 13 |
| schedule | 80 | 2 | 11 | 9 |

`admin.js` egymaga az oldalkód **52%-a**. 915 kézi DOM-hívás, 492 saját
osztálynév, 52 saját gombosztály — és 8 közös komponens-hívás. Gyakorlatilag
külön alkalmazás, amely csak a tokeneket osztja meg a többivel.

A `home` a másik véglet: 167 sor, 7 közös komponens-hívás, 14 saját osztály.
Ez a helyes arány, és bizonyítja, hogy a közös réteg működik — csak kevesen
használják.

---

## 10. Responsive

### Mit mértem

Valódi Chromium, bejelentkezve, mind a 13 nyilvános route × 8 szélesség
(375 / 390 / 430 / 768 / 1024 / 1280 / 1440 / 1920). Mérés:
`documentElement.scrollWidth > clientWidth`, és ahol igaz, az első négy
kilógó elem.

### Eredmény: minden szélességen tiszta

```
375px  clean     768px  clean     1280px clean
390px  clean    1024px  clean     1440px clean
430px  clean                      1920px clean
```

Ez nem véletlen: a `tests/e2e/responsive.test.mjs` már ma is őrzi, ugyanezen
kilenc szélességen, és a kilógás mellett a 22px-es minimális
érintőfelületet is méri.

**Fontos fenntartás:** a mérés egy **üres könyvtárú** fiókkal futott
(0 elem). A sok adattal járó esetek — több száz elemes könyvtár-rács, 1168
epizódos lista (a ONE PIECE ennyi a katalógusban), hosszú admin-táblák — így
**nem lettek lefedve**. A legutóbbi fehér-oldal hiba pontosan ilyen volt:
adatmennyiségtől függött. A fiók feltöltése rate limitbe futott, ezt a
következő lépésben pótolni kell.

### A szerkezeti gond: a karantén

969 sor (19%) egyetlen `/* ===== responsive ===== */` blokkban a 4105.
sortól. A 27 media query közül 11 itt van, 16 elszórva.

Ez azt jelenti, hogy egy komponens mobil viselkedése több ezer sorral odébb
van a komponens saját definíciójától. Aki a `.detail-hero-row`-t módosítja,
nem látja, hogy 2500 sorral lejjebb van hozzá egy 560px-es felülírás.

### Breakpointok

**7 különböző, egyik sem 1024px fölött:**

```
560px ×6   640px ×3   700px ×1   720px ×5   820px ×7   900px ×2   1000px ×1
```

A `560/640/700/720/820/900/1000` sor nem illeszkedik a kért
`375/390/430/768/1024/1280/1440/1920` készülékskálához. A `700` és a `720`
egyetlen elrendezésen belül 20px-re van egymástól — ez nem két döntés, hanem
egy döntés kétszer. 1000px fölött pedig nincs semmi: a 1280, 1440 és 1920
ugyanazt a szabályt kapja, a `--content-max: 90rem` (1440px) korlátot.

---

## 11. Állapotok (loading / empty / error)

| Oldal | Skeleton | Empty | Error |
|---|---|---|---|
| admin | 7 | 36 | 136 |
| search | 1 | 2 | 5 |
| anime | 0 | 7 | 4 |
| watch | 0 | 3 | 30 |
| list | 0 | 2 | 2 |
| notifications | 0 | 2 | 1 |
| schedule | 0 | 1 | 2 |
| changelog | 0 | 2 | 2 |
| community | 0 | 1 | 2 |
| settings | 0 | 0 | 4 |
| home | 0 | 0 | 1 |
| dashboard | 0 | 2 | **0** |
| profile | 0 | 1 | **0** |
| analytics | 0 | 2 | **0** |
| history | 0 | 1 | **0** |

**Skeleton: 15 oldalból 2.** A `C.section()` ugyan 8 `skeletonCard()`-ot tesz
ki betöltés közben — tehát a vízszintes sorok fedettek —, de ez a
`skeletonCard` két szürke doboz:

```js
U.el('div', { class: 'card-cover skeleton' }),
U.el('div', { class: 'card-title skeleton', style: 'height:1em;border-radius:4px;' })
```

Ez pontosan az, amit a feladat kizár: „ne egy általános szürke doboz legyen".
Az egyetlen hely, ahol a skeleton a tartalom alakját követi, az audit-nézet
(`.aud-skel-row`, `.aud-skel-fact`, `.aud-skel-count`).

**Error: négy oldalon nulla** — dashboard, profile, analytics, history.
Ezek mind hálózatról töltenek. Ha a kérés elhasal, a nézet néma marad.

---

## 12. Amit még nem mértem

Hogy a következő lépés ne induljon hamis teljesség-érzettel:

1. **Admin oldal bejelentkezve, admin joggal** — a szerepkör-adás DB-írását a
   rendszer megtagadta. Az oldalkód 52%-a így csak statikusan van felmérve.
2. **Layout sok adattal** — üres fiókkal mértem. A több száz elemes könyvtár,
   az 1168 epizódos lista és a hosszú admin-táblák kimaradtak.
3. **Levágott szöveg / törött rács** — a kilógást mértem, a `text-overflow`
   általi tartalomvesztést nem.
4. **Világos téma** — létezik és átgondolt, de végig nem néztem.
5. **Kontraszt-arányok** — a 12px alatti szövegeknél ez külön kockázat.

---

## 13. Mit mond ez a következő lépésekről

Röviden, indoklással — a részletes terv a 2–6. lépés dolga:

- **Token-lépés (2):** nem új rendszer kell. A színek készen vannak, a
  spacing-skála helyes, az árnyék pontosan három. A munka: a tipográfiát
  szerepekké összerakni (ma szétesik méret/súly/sorköz hármasra, innen a 43-as
  szórás), a radiust 5-ről 3-ra vinni, és a 12px alatti szövegeket felhozni.
- **Komponens-lépés (3):** a badge (36 osztály) és a card (27) a két
  legnagyobb nyeremény. A gombnál a `.btn` már megvan — ott a 11 megkerülő
  osztály behúzása a feladat, nem új komponens.
- **Oldal-lépés (4):** a sorrend a mérésből adódik — `admin` (4211 sor),
  `watch` (1136), `anime` (686). A `home` már jó, azt nem kell bántani.
- **Responsive (5):** a kilógás rendben van és teszt őrzi. A valódi munka a
  karantén felszámolása és a 7 breakpoint konszolidálása — plusz a sok-adatos
  eset lemérése, ami eddig kimaradt.
- **Állapotok (6):** a skeleton a legnagyobb hiány (13/15 oldal), az error a
  legkockázatosabb (4 oldal némán hal el).

---

## Függelék — a mérések megismételhetők

```bash
# radius
grep -ohE 'border-radius:[^;}]+' apps/web/css/style.css | sort | uniq -c | sort -rn

# fontméretek
grep -ohE 'font-size:[^;}]+' apps/web/css/style.css | sed 's/font-size: *//' | sort -u | wc -l

# spacing-atomok
grep -ohE '(padding|margin|gap)(-[a-z]+)?:[^;}]+' apps/web/css/style.css \
  | sed -E 's/.*: *//' | tr ' ' '\n' | grep -E '^[0-9.]+(rem|px)$' | sort | uniq -c | sort -rn

# komponens-újrahasználat
grep -rohE '\bC\.[a-zA-Z]+' apps/web/src/pages apps/web/src/features | wc -l
grep -rohE '\bU\.el\(' apps/web/src/pages apps/web/src/features | wc -l

# responsive (valódi böngésző, 8 szélesség)
npm run test:e2e
```

A token-forrás **`apps/web/css/tokens.css`**; a `packages/design-tokens/`
ebből **generált** (`node packages/design-tokens/build.mjs`), és az
`apps/web/test/design-tokens.test.mjs` elhasal, ha a kettő elcsúszik.
Ezt az irányt megtartani — a generált fájl kézi szerkesztése némán elvész.
