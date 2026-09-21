# Player 2.0 — beállítások

A lejátszó minden megjegyzett döntése egyetlen sémában van
(`apps/web/src/features/player2/preferences/player-preferences.js`), és a séma
**egyszerre három dolgot ad**: az alapértelmezést, az érvényes tartományt, és
a nevet, amit a kód használhat.

## Miért séma, és nem egy `Prefs.get(bármi)`

Mert a `get` és a `set` **ismeretlen kulcsra `undefined`-ot ad vissza, és nem
csinál semmit**. Ez a helyes viselkedés — egy régi telepítés
beállításfájljában lehetnek olyan kulcsok, amiket már nem ismerünk —, de azt
is jelenti, hogy egy **elírt kulcs némán nem működik**.

Ez nem elméleti. A rendszer összeszerelésekor négy ilyen volt egyszerre, és
mind a négy egy-egy csendben halott funkciót jelentett:

| amit a kód kért | ami tényleg van | mi nem működött |
|---|---|---|
| `player.episode.autoNext` | `player.autoplayNext` | a következő rész sosem indult el magától |
| `player.playback.rate` | `player.rate` | a sebesség megjegyzése nem mentett |
| `player.subtitle.language` | *(hiányzott a sémából)* | a nyelvi választás nem létezett |

Egyik sem dobott hibát, egyik sem hiányzott a naplóból. Azóta **teszt őrzi**,
hogy a `player2` fa minden `prefs.get`/`prefs.set` hívása olyan kulcsra
mutasson, ami a sémában szerepel (`player2-preferences.test.mjs`, „a kód nem
kérhet nem létező beállítást").

## Az érvényesítés nem opcionális

Minden olvasás átmegy a `validate()`-en. Ami kívül esik a tartományon, az
**a határra szorul, nem az alapértelmezésre esik vissza**: aki 500%-os
feliratot állított be, 200%-ot kap, nem 100%-ot — a szándéka irányát
megtartjuk, csak a mértékét nem.

A felsorolt értékű mezőknél más a szabály: ott egy ismeretlen érték az
**alapértelmezésre** esik vissza, mert a „legközelebbi érvényes" fogalma nem
értelmezhető.

## A kulcsok

### Lejátszás

| kulcs | típus | alap | tartomány |
|---|---|---|---|
| `player.autoplay` | logikai | `true` | |
| `player.autoplayNext` | logikai | `true` | |
| `player.rememberPosition` | logikai | `true` | |
| `player.rememberRate` | logikai | `false` | |
| `player.rememberVolume` | logikai | `true` | |
| `player.rate` | szám | `1` | 0.5 / 0.75 / 1 / 1.25 / 1.5 / 1.75 / 2 |
| `player.volume` | szám | `1` | 0–1 |
| `player.muted` | logikai | `false` | |

`player.rememberRate` alapból **hamis**, és ez szándékos: a sebesség egy
epizódra szóló döntés. Aki egyszer 1,5-tel nézett meg egy részt, attól még a
következőt nem akarja gyorsítva — és a „miért beszél ilyen furcsán" a
leggyakoribb kérdés, amire a néző nem tudja, hogy ő okozta. (A vezérlősáv
ezért is emeli ki a nem egyszeres sebességet.)

### Minőség

| kulcs | típus | alap | tartomány |
|---|---|---|---|
| `player.quality.auto` | logikai | `true` | |
| `player.quality.preferred` | szöveg | `auto` | auto / 360 / 480 / 720 / 1080 / 1440 / 2160 |
| `player.quality.mobile` | szöveg | `720` | auto / 360 / 480 / 720 / 1080 |
| `player.quality.wifi` | szöveg | `1080` | auto / 480 / 720 / 1080 / 1440 / 2160 |
| `player.quality.dataSaver` | logikai | `false` | |

Az **adattakarékos mód a legerősebb**: 480p-re szorít, és sem a wifi, sem az
automatika nem írhatja felül. A néző kérte.

A **kézi választás viszont még ennél is erősebb**: aki a menüben 1080p-t
választott, azt megkapja, ha elérhető — a hálózati korlát csak az
automatikára vonatkozik.

### Felirat

| kulcs | típus | alap | tartomány |
|---|---|---|---|
| `player.subtitle.enabled` | logikai | `true` | |
| `player.subtitle.language` | szöveg | `hu` | |
| `player.subtitle.size` | szám | `100` | 50–200 |
| `player.subtitle.weight` | szám | `600` | 400 / 600 / 800 |
| `player.subtitle.color` | szöveg | `#ffffff` | |
| `player.subtitle.background` | szöveg | `#000000` | |
| `player.subtitle.backgroundOpacity` | szám | `0.35` | 0–1 |
| `player.subtitle.outline` | logikai | `true` | |
| `player.subtitle.bottomOffset` | szám | `8` | 0–40 (%) |
| `player.subtitle.delayMs` | szám | `0` | −10000 – 10000 |

A nyelv alapja **magyar**, mert ez egy magyar oldal. Az „alapértelmezés
szerint semmi" azt jelentené, hogy a magyar felirattal rendelkező részeknél is
az angol indul el, ha az van elöl a listában.

Ezek a mezők **CSS-változóvá alakulnak** (`subtitleStyle()`), és a héjra
kerülnek egyszer — nem elemenként. A megjelenítés így a CSS dolga marad.

### Átugrás

| kulcs | típus | alap |
|---|---|---|
| `player.skip.introAuto` | logikai | `false` |
| `player.skip.outroAuto` | logikai | `false` |

Mindkettő **hamis** alapból. Az automatikus átugrás akkor is elugrik, amikor
az intró épp az a rész, amit a néző látni akart — és aki nem kérte, annak ez
adatvesztésnek érződik.

### Felület

| kulcs | típus | alap | tartomány |
|---|---|---|---|
| `player.ui.autoHide` | logikai | `true` | |
| `player.ui.autoHideMs` | szám | `2800` | 1000–10000 |
| `player.ui.cinema` | logikai | `false` | |
| `player.ui.ambient` | logikai | `true` | |
| `player.ui.ambientIntensity` | szám | `60` | 0–100 |
| `player.ui.miniPlayer` | logikai | `true` | |
| `player.ui.gestures` | logikai | `true` | |
| `player.ui.keyboard` | logikai | `true` | |
| `player.ui.nextCountdownSec` | szám | `5` | 0–30 |

### Verzió

| kulcs | típus | alap |
|---|---|---|
| `player.schemaVersion` | szám | `1` |

## Áttérés régi beállításokról

A `migrate()` a régi kulcsokat átnevezi az újakra, és **a fel nem ismert
kulcsokat békén hagyja**. Nem törli őket: egy ismeretlen kulcs tartozhat egy
kiterjesztéshez, egy régebbi verzióhoz vagy egy funkcióhoz, ami még nincs itt
— és egy takarítás, ami mások adatát dobja el, rosszabb, mint egy kósza
mező.

## Hol tárolódik

A séma nem tárol semmit: a hívó ad egy `prefs` objektumot `get`/`set`
metódusokkal, és a `createPlayerPreferences` azon keresztül dolgozik. A
nézőoldalon ez a `Prefs` modul. A **helyi másolat** viszont a lejátszóban van:
egy elszálló tároló (privát ablak, letiltott sütik) nem áll meg a lejátszást,
csak nem őriz meg semmit a következő alkalomra.
