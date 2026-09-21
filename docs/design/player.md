# A YUME lejátszó

Mit tud, hogyan épül fel, és miért úgy, ahogy.

A lejátszó a `#/watch/{animeId}:{epizódszám}` címen él
(`apps/web/src/pages/watch.js`), a folyamválasztás pedig külön rétegben
(`apps/web/src/features/player/stream-engine.js`). A kettő szétválasztása
szándékos: a lejátszó nem tudja, honnan jön a videó, a motor pedig nem tudja,
hogyan néz ki a képernyő.

---

## 1. Mielőtt bármi elindulna

### A kapu

```
hasSomethingToPlay(media, epizód, src)
```

Ha ehhez a részhez nincs miből lejátszani, a lejátszó **el sem épül**: a
látogató visszakerül a részletoldalra egy üzenettel. Korábban felépült az üres
lejátszó, a motor végigpróbálta a nulla jelöltet, és a végén közölte, hogy
nincs forrás — a néző addigra egy fekete négyzetet és egy epizódlistát kapott,
amiből semmi nem indul el.

A kapu **nem tiltja a bizonytalant**: egy sosem importált címnél nincs
epizódsor, amire forrást lehetne akasztani, és ott a „nem tudjuk" nem
ugyanaz, mint a „nincs".

### Mi indítja a lejátszót

```
ha van ?src=   VAGY   hasRegisteredSources(epizód)   → lejátszó
különben                                            → kézi forrásválasztó
```

A `hasRegisteredSources` szándékosan szigorúbb a kapunál: csak akkor mond
igent, ha a katalógus sora **ténylegesen** legalább egy forrást jelent.
„Talán van" alapján lejátszót indítani éppen azt az üres képernyőt adná
vissza, amit a kapu megszüntetett.

---

## 2. A betöltőképernyő

A cím **saját logója** áll a közepén, szürkén és lesötétítve, és egy fénypászma
fut át rajta balról jobbra, 2,4 másodpercenként, amíg a videó be nem töltődik.
Alatta a cím saját színében forgó gyűrű.

Két réteg ugyanarról a képről: az alsó szürke, a felsőt egy mozgó maszk vágja
csíkra. Egy kép, két réteg, nulla plusz letöltés.

**A pászma fény, nem csak szín** — és ez mérésből következik. A katalógus
logóinak jó része eleve fehér-szürke; azokon egy tisztán színbeli átmenet
szürkéből szürkébe megy, vagyis láthatatlan. A cím saját színében derengő fény
minden logón látszik. Mérve egy teljes cikluson: az átlagos képkocka-fényesség
118 → 126 között mozog, ahogy a csík áthalad.

**Tartalék:** a 32 536 címből 4 810-nek van logója, tehát a YUME szóvédjegy a
**gyakoribb** eset, nem a kivétel. Ugyanazzal a mozgással — a betöltő egy
dolog, nem kettő aszerint, hogy milyen kép létezik.

`prefers-reduced-motion` esetén a csík megáll a logó közepén: a márka látszik,
a villogás nem.

---

## 3. A forrásválasztás

### Honnan jönnek a jelöltek

| forrás | honnan | rangsor |
|---|---|---|
| **regisztrált** | a katalógus `video_sources` sorai | előrébb |
| **kézi** | a néző által beillesztett URL (`?src=`) | hátrébb |

A regisztrált forrás előrébb rangsorol, mert azt valaki, aki ezt az oldalt
üzemelteti, kézzel akasztotta ehhez a részhez — ez erősebb állítás arról, hogy
„ez a helyes videó", mint egy egyszer bemásolt szöveg.

### Mit ismer fel a motor

```
magnet:…            → magnet    (asztali kliens kell hozzá)
…m3u8               → hls       (hls.js vagy natív)
…mpd                → dash
http(s)://…         → direct
/valami/…           → direct    (azonos eredetű, saját kiszolgálású fájl)
minden más          → unknown
```

Az azonos eredetű út nem kivétel, hanem a helyes alak a saját videóinkra: így a
katalógusban nem szerepel a tartománynév, és egy költözés nem töri el a
sorokat. A `//host/…` protokoll-relatív alak **szándékosan kimarad** — az más
kiszolgálóra mutat.

### Mikor számít egy forrás működőnek

A motor rákapcsolja a jelöltet a videóelemre, és **12 másodpercet** ad neki.
Sikernek számít a `canplay`, a `loadeddata` **és a `loadedmetadata`**.

A harmadik mobilon elengedhetetlen. A mobil böngészők hangos videónál nem
indítanak automatikus lejátszást, és ilyenkor **megállnak a metaadatnál** —
képkocka-adatot csak felhasználói gesztusra töltenek. A `canplay` és a
`loadeddata` viszont mindkettő tényleges képkockát kíván, tehát telefonon
egyikük sem következett be, és minden forrás „a folyam nem indult el időben"
hibával bukott el. A `loadedmetadata` pontosan azt bizonyítja, amit a kérdés
firtat: a hivatkozás él, a formátum érthető, a hossz ismert. Ha a dekódolás
mégis elhasal, az `error` esemény továbbra is megbuktatja a jelöltet.

### Ha egy forrás elhasal

A motor **magától továbblép** a következő jelöltre, és a néző csak akkor lát
hibát, ha mind elfogyott. Ilyenkor az utolsó kísérlet oka jelenik meg, nem egy
általános üzenet.

---

## 4. Felirat és hangsáv

| | |
|---|---|
| **feliratsávok** | a forrással érkeznek, vagy az epizódhoz tartoznak a katalógusban |
| **formátum** | WebVTT natívan; az SRT-t a motor menet közben alakítja át |
| **kiválasztás** | a `playback.subtitles` beállítás nyelve szerint, pontozással |
| **sub / dub** | a `playback.variant` beállítás; a motor ez alapján rangsorol |

Egy `<track>` `default` nélkül **letiltva** töltődik be — vagyis a forrás által
adott felirat ott volt a DOM-ban és láthatatlan maradt. A néző beállítása dönti
el, melyik látszik.

A sub/dub kapcsoló a lejátszó alatti sávban ül, és **azonnal vált**: a
jelöltlistát a motor újrarangsorolja, nem kér le újra semmit.

---

## 5. Vezérlés

### Gombok

| | |
|---|---|
| lejátszás / szünet | a középső gomb és a vezérlősáv |
| tekerés | húzható csúszka, ponttal a pufferelt részre |
| hangerő | csúszka + némítás |
| sebesség | menüből, 0,5×–2× |
| felirat | menüből, sávonként |
| kép a képben | ahol a böngésző engedi |
| teljes képernyő | gomb és `f` |
| forrás váltása | menüből, ha több jelölt van |

### Billentyűk

| billentyű | |
|---|---|
| `szóköz`, `k` | lejátszás / szünet |
| `←` `→` | 5 másodperc vissza / előre |
| `↑` `↓` | hangerő ±5% |
| `f` | teljes képernyő |
| `m` | némítás |
| `0`–`9` | ugrás a hossz 0–90%-ára |

A billentyűk **nem sülnek el**, ha a fókusz beviteli mezőn van — különben a
szobakód beírása közben a szóköz megállítaná a videót.

### Automatikus elrejtés

A vezérlők 2,8 másodperc mozdulatlanság után eltűnnek, ha megy a videó. Egérmozgásra
vagy érintésre visszajönnek.

---

## 6. Intró és outró átugrása

A `skip_segments` táblából, közösségi beküldés alapján, **szavazat szerint
rangsorolva**: az az intervallum számít, amivel a legtöbben egyetértettek.

* Amikor a lejátszás beleér egy szakaszba, megjelenik az **Intró átugrása**
  gomb.
* Az **automatikus átugrás** külön kapcsoló a menüben; ha be van kapcsolva,
  gomb nélkül ugrik.

---

## 7. Haladás, folytatás, megtekintettség

### A pozíció

A lejátszó **profilonként** jegyzi meg, hol tartottál, és a következő
megnyitáskor onnan folytatja.

### A megtekintett idő — mérve, nem becsülve

A `WatchTime` azt a másodpercmennyiséget méri, amíg a videó **ténylegesen
ment**. Korábban öt képernyő ugyanúgy számolta: a megjelölt epizódok száma
szorozva egy névleges hosszal, 24 perces tartalékkal — vagyis becslés, mérésnek
álcázva.

A megtekintettség akkor kerül be, amikor a mért idő átlép egy küszöböt, nem
attól, hogy a csúszkát a végére húzták.

### Következik

Az epizód vége felé megjelenik a **Következik** kártya, visszaszámlálóval. Az
automatikus továbblépés a beállításokban kapcsolható.

---

## 8. Közös nézés

Szoba kóddal vagy meghívó linkkel. A lejátszás, a szünet és a tekerés
**szinkronban marad** a résztvevők között; a lejátszó jelzi, hányan vannak bent,
és mutat egy eseményfolyamot.

A szobakód a címsorban is átadható (`?w2g=…`), tehát egy link elég a
meghíváshoz.

---

## 9. Epizódlista és navigáció

A lejátszó mellett (asztalon jobbra, telefonon alatta) a teljes epizódlista áll
képpel, címmel és dátummal. Az aktuális rész ki van emelve.

* **Nincs forrás** jelvénnyel azok a részek, amikhez nincs mit lejátszani — és
  azok **nem kattinthatók**.
* A **kitöltő** (filler) epizódok külön jelölve.
* Előző / következő gomb a lejátszó alatt.

---

## 10. Megjelenés

A lejátszó a **nézett cím színeit** viseli: a gyűrű, a csúszka és a
kiemelések a borítóból származó domináns színt használják. A lejátszón azelőtt
nem volt semmilyen egyedi szín — vagyis az a képernyő, amin a legtöbb időt
töltöd, volt az egyetlen, ami nem egyezett a rajta lévő borítóval.

---

## 11. Amit a lejátszó *nem* csinál

Ezek nem hiányosságok, hanem döntések:

* **Nem kutat fel forrásokat.** Azt játssza le, amit kapott.
* **Nem kerüli meg a szolgáltatók hozzáférés-korlátozását.**
* **Nem hazudik a formátumról.** Amit a böngésző nem tud lejátszani, azt
  megmondja, nem megjátssza.
* **Torrentet böngészőben nem játszik.** A `magnet:` hivatkozás asztali klienst
  kíván, és ezt a lejátszó ki is írja.

---

## 12. Mi hol van

| | |
|---|---|
| `apps/web/src/pages/watch.js` | a lejátszóoldal: felület, vezérlők, epizódlista, közös nézés |
| `apps/web/src/features/player/stream-engine.js` | jelöltek, rangsor, rákapcsolás, felirat, sub/dub |
| `apps/web/src/features/player/hls-handler.js` | HLS, ahol a böngésző natívan nem tudja |
| `apps/web/src/features/watch-history/watch-time.js` | a ténylegesen nézett idő mérése |
| `apps/web/css/style.css` | `.player-*` — a lejátszó teljes megjelenése |
| `video_sources` tábla | a katalógus saját forrásai epizódonként |
| `skip_segments` tábla | intró/outró intervallumok, szavazatokkal |
