# YUME PLAYER 2.0 — záró jelentés

> A 49. pont formátuma szerint. Ahol nem `PASS`, ott ott van, **miért**, **mit
> próbáltam**, **milyen mérés bizonyítja**, és **mi maradt hátra**.

## Összefoglaló

| terület | állapot |
|---|---|
| Architecture | **PASS** |
| Core | **PASS** |
| Streaming | **PARTIAL** |
| Fallback | **PASS** |
| Subtitles | **PARTIAL** |
| Audio | **PARTIAL** |
| Quality | **PASS** |
| Watch progress | **PASS** |
| Skip | **PARTIAL** |
| Cinema | **PASS** |
| Ambient | **PARTIAL** |
| Mini player | **PARTIAL** |
| PiP | **PARTIAL** |
| Gestures | **PARTIAL** |
| Keyboard | **PASS** |
| Preferences | **PASS** |
| Feature flags | **PASS** |
| Watch party | **PARTIAL** |
| Accessibility | **PASS** |
| Security | **PASS** |
| Performance | **PASS** |
| Responsive | **PASS** |
| Tests | **PASS** |

**Egy visszatérő ok a PARTIAL-ok mögött**, és ezt előre kimondom, mert a lista
enélkül súlyosabbnak látszik, mint amilyen: hat terület adatbázistáblája
**üres**. A `subtitle_tracks`, az `audio_tracks` és a `skip_segments` egyetlen
sort sem tartalmaz, a katalógusban nincs HLS/DASH forrás, és nincs élő közös
nézési szoba. Ezek a modulok **megvannak és egységtesztekkel igazoltak** — de
éles adaton nem futottak, és `PASS`-t mérés nélkül nem írok rájuk.

A számokat a kód és a mérések adják: **37 modul, 4 969 sor; 247 egységteszt tíz
készletben; 28 böngészős teszt; 14 commit.**

---

## PASS — bizonyítékkal

### Architecture — PASS

A mag, a motorok és a lejátszásvezérlés **egyetlen sora sem hivatkozik
`document`-re**. A felület az egyetlen DOM-réteg, és ott is külön van minden,
ami DOM nélkül eldönthető. Az összeszerelés egyetlen fájlban van
(`watch/episode-player.js`), és ez az egyetlen, ami mindegyik modult ismeri.

Bizonyíték: a mag, a motorok, a lejátszás, a beállítások, a felirat, a
minőség, az átugrás, a közös nézés és a telemetria készletei **böngésző nélkül
futnak** `node --test`-tel, ezredmásodpercek alatt.

### Core — PASS

Esemény, állapot, hibataxonómia, életciklus. 26 teszt.

Amit a felépítés megold: az állapot **mezőnkénti** változásfigyeléssel
értesít. Mérve: egy semmit nem változtató frissítés **0,6 µs**, egy valódi
**55,0 µs** — ötvenszeres különbség. Enélkül a másodpercenként négyszer érkező
`timeupdate` minden alkalommal újrarajzolná az egész felületet.

A szétbontás fordított sorrendben bont le mindent. Mérve: **25
felépítés–szétbontás kör után 0 maradék elem és 0 el nem bontott erőforrás.**

### Fallback — PASS

A forráskezelő minden jelöltet legfeljebb kétszer próbál, és **mindenki kap
egy esélyt, mielőtt bárki másodikat kapna**. Ezt a szabályt egy teszt
kényszerítette ki: az első változat a hibás jelöltet próbálta újra másodszor
is, mielőtt a másodikhoz ért volna.

Élesben bizonyítva: a böngészős készlet egy nem létező címre mutató forrással
indít, és a lejátszó végigmegy a soron, majd magyar nyelvű hibaüzenetet ír ki
Újra gombbal.

### Quality — PASS

Csak az kerül a menübe, ami **tényleg létezik**. A kézi választás erősebb a
hálózati korlátnál; az adattakarékos módot viszont semmi nem írja felül. Az
„Automatikus" mellett zárójelben ott van, mi megy éppen.

### Watch progress — PASS

A haladásmérő órája **csak a ténylegesen lejátszott idővel halad**, és a két
tick közti két másodpercnél nagyobb szakadékot figyelmen kívül hagyja — egy
háttérbe tett lap nem gyűjt nézési időt. A szétbontás **kikényszeríti** az
utolsó mentést.

### Cinema — PASS

Állapotbeli kapcsoló, CSS-osztály, beállításban megjegyezve, billentyűparancs
(`T`). A lap oldalán az `onCinema` visszahívás szól, hogy a környezet is
elhalványulhasson.

### Keyboard — PASS

16 parancs, a 24. pont kiosztása szerint (`P` = kép a képben, `B` = előző). A
**beviteli mezőben egyetlen parancs sem sül el** — `<input>`, `<textarea>`,
`<select>`, `contenteditable` és `role="textbox"` egyaránt kizárva.

Böngészőben mérve: a lejátszóra küldött `ArrowRight` tekert (30 → 35
másodperc), a lejátszóba tett `<input>`-ba küldött ugyanaz **nem**.

### Preferences — PASS

34 kulcs egyetlen sémában, érvényesítéssel. A tartományon kívüli érték **a
határra szorul, nem az alapértelmezésre esik vissza**.

A séma írása közben derült ki, hogy **négy kulcsot rosszul használtam**, és a
hibás kulcs **némán nem csinál semmit**. Azóta teszt őrzi, hogy a `player2` fa
minden `prefs.get`/`prefs.set` hívása létező kulcsra mutasson — és a tesztet
elrontott kulccsal is lefuttattam, hogy tényleg megfogja.

### Feature flags — PASS

23 lejátszókapcsoló, négylépcsős kiértékeléssel. A **fejlesztői réteg az
egyetlen, ami alapból ki van kapcsolva**: a többinél a hallgatás beleegyezés,
ott nem.

A bevezetés kapcsolója (`feature.player2`) külön történet, és a legfontosabb
javítás az egész munkában: a `featureOn` **nem létező kapcsolóra igazat ad
vissza**, tehát az eredeti bekötésem sor nélkül az **új** lejátszót indította
volna el mindenkinél. A nézőoldal azóta kettőt kérdez, és mind a négy eset
tesztelt.

### Accessibility — PASS

Böngészőben mérve, nem állítva:

- **minden látható vezérlőnek van felolvasható neve** (0 névtelen);
- **minden látható vezérlő fókuszálható**, és a lapon van `:focus-visible`
  körvonalszabály;
- a tekerősáv `role="slider"`, `aria-valuemin/max/now`, és **kimondott
  időt** ad (`1 óra 2 perc 3 másodperc`), nem nyers másodpercet;
- **`prefers-reduced-motion` esetén a pásztázás megáll** (`animationName:
  none`), a logó színesen, egyben áll ott;
- a tiltott gomb **`disabled`**, nem csak halvány;
- **a rejtett vezérlők nem nyelik el a fókuszt**, és visszatérve a
  `tabindex` az eredetire áll vissza — ezt egy teszt kényszerítette ki, mert
  az első változat törölte, és egy `<div role="slider">` e nélkül örökre
  kiesik a Tab sorrendjéből;
- **érintőméret**: 430 képpontig egyetlen gomb sem kisebb 22 képpontnál.

### Security — PASS

- a feliratelemző **kétszer** szűr, mert az entitás-visszafejtés **új
  címkéket hozhat elő**: a `&lt;script&gt;` egy menet után `<script>` lenne;
- a hibák `detail` mezője (hívásverem, belső cím) **sosem jut a képernyőre**;
  a `toUser()` kizárólag a taxonómia szövegét adja;
- a telemetria **fehérlistás**: mérve, egy `{ url, message, code, ms }`
  csomagból `{ ms, code }` megy ki — a tokent tartalmazó cím és a belső utat
  tartalmazó szöveg kiesik;
- a feliratbetöltő **méretkorlátos** (2 MB), és a kimenet a saját
  előállításunk, nem a letöltött szöveg;
- a betöltőképernyő, a menü és a hibakereső **menekíti** a beírt szöveget.

Egy tanulság, amit háromszor kellett megtanulnom: a beszúrás mérésénél **nem
az a kérdés, szerepel-e az „onerror" szó** — menekítve szerepelhet,
ártalmatlan szövegként. Az a kérdés, **keletkezett-e tőle elem**.

### Performance — PASS

| mit | mérve |
|---|---|
| felépítés (12 kör mediánja) | 1,60 ms |
| állapotfrissítés | 55,0 µs |
| állapotfrissítés, ha semmi nem változott | 0,6 µs |
| 25 kör után maradék elem / erőforrás | 0 / 0 |
| képkockaköz lejátszás közben, medián | 16,7 ms |
| képkockaköz, p95 | 18,1 ms |

A **környezeti fény miatt ez egyszer megbukott**, és a javítás története a
[teljesítménydokumentumban](PLAYER_2_PERFORMANCE.md) van. A böngészős készlet
azóta **a mediánra is** határt tart (40 ms), pont ezért a hibaosztályért.

### Responsive — PASS

11 szélesség, 320-tól 2560-ig, mind zöld. A vezérlősáv nem elrendez, hanem
**választ**: 640 alatt a hangerő, a mozi mód és a részváltók mennek, 560 alatt
a kép a képben és a sebesség, 400 alatt a tíz másodperces ugrás és a némítás
is — mindegyik elérhető marad máshol.

320 képponton a gombok **20 képpont szélesre nyomódtak**, mert a rugalmas
doboz összenyomta őket. Ujjal eltalálhatatlan, és semmi nem jelezte.

### Tests — PASS

247 egységteszt tíz készletben, 28 böngészős teszt. A teljes webes készlet
**570 teszt, mind zöld**; a szerveroldali **881 teszt**.

---

## PARTIAL — hat terület, egy közös okkal

### Streaming — PARTIAL

**Miért.** A natív út (`mp4`/`webm`) élesben bizonyított: a böngészős készlet
valódi videót játszik le, és az állapotfa követi a videót (eltérés < 1,5
másodperc). A **HLS és a DASH nem**: a katalógusban ma nincs ilyen forrás.

**Mit próbáltam.** A motorok megvannak: a HLS előbb natívan próbálkozik, és
csak utána tölti le a hls.js-t — lustán, egyszer. A DASH **szándékosan csak
natív**: egy dash.js egy olyan formátumért, amit ma egyetlen forrás sem
használ, felesleges függőség lenne.

**Milyen mérés bizonyítja.** A motorválasztás és a csatolási időtúllépés 26
egységteszttel igazolt. Éles HLS-folyamon **nem futott**.

**Mi maradt hátra.** Az első HLS-forrás felvétele után egy valódi lejátszás.

### Subtitles — PARTIAL

**Miért.** A `subtitle_tracks` tábla **üres**. Egyetlen felirat sincs a
rendszerben.

**Mit próbáltam.** Az elemző SRT-t és VTT-t is ért, a hibás blokkot kihagyja,
a címkéket kétszer szűri. A betöltő letölti, átalakítja és `blob:` címen adja
a `<track>`-nek — mert a böngésző **csak WebVTT-t ért**, és egy `.srt`-re
mutató `src` némán nem csinál semmit. A sávválasztás nyelv szerint rangsorol,
és a teljes sávot elsőbbségben részesíti a kényszerítettel szemben.

Megoldottam közben a régi lejátszó egy valódi hibáját: a `<track>` **`default`
nélkül letiltva** töltődik be, ezért a `mode`-ot explicit állítjuk.

**Milyen mérés bizonyítja.** 29 egységteszt, köztük a beszúrás elleni kétmenetes
szűrés. Éles feliratfájlon **nem futott**.

**Mi maradt hátra.** Egy feltöltött felirat, és egy valódi lejátszás vele.

### Audio — PARTIAL

**Miért.** Az `audio_tracks` tábla **üres**, és a böngészők `audioTracks`
támogatása ma is hiányos.

**Mit próbáltam.** A menü akkor kínálja a hangsávot, ha **legalább kettő van**
— egyetlen sávnál egy választómenü hazugság.

**Milyen mérés bizonyítja.** Egységteszt igazolja, hogy egy sávnál nem jelenik
meg, kettőnél igen. Éles többsávos forráson **nem futott**.

**Mi maradt hátra.** Egy többhangsávos forrás.

### Skip — PARTIAL

**Miért.** A `skip_segments` tábla **üres**.

**Mit próbáltam.** A szakaszok szavazat szerint rangsorolódnak, fajtánként a
legtöbb szavazatot kapott marad. Az automatikus átugrás **egyszer** ugrik, a
visszatekerés visszahozza a gombot, és a legvégén nem villantjuk fel.

**Milyen mérés bizonyítja.** Egységtesztek a normalizálásra, a szavazatokra és
az automatikára. Éles beküldésen **nem futott**.

**Mi maradt hátra.** Az első beküldött intró-intervallum.

### Ambient — PARTIAL

**Miért.** **Az eredeti feladat nem teljesíthető elfogadható áron**, és ezt
mérés mondja ki, nem becslés.

**Mit próbáltam.** Először a videó képkockáit mintáztam egy 32×18-as vászonra,
fél másodpercenként. Ettől a képkockaköz mediánja **16,7 ms-ról 75,2 ms-ra**
romlott. Utána az elmosást próbáltam olcsóbbá tenni (kicsiben elmosni, utána
felnagyítani) — **nem segített**: 79 ms maradt.

**Milyen mérés bizonyítja.** A szétbontott mérés, 150 képkocka mediánja,
kétszer megismételve:

| mit csinált | képkockaköz mediánja |
|---|---|
| nincs fény | 16,7 ms |
| **csak a másolás**, megjelenítés nélkül | **76,0 ms** |
| másolás + kicsi elmosás | 74,8 ms |
| másolás + nagy elmosás | 79,3 ms |

A második sor a döntő: a költség maga a `drawImage(video, …)` — a
visszaolvasás a GPU-ról a dekódolót lassabb úton hagyja, és **az egész
lejátszás** lassul, nem csak a másolás pillanata.

**Mi maradt hátra és mit kaptunk helyette.** A 20. pont „a videó/**poster**
színeiből" kér hátteret. A modul azóta a **borítót** mintázza, egyszer, és a
képkockaköz visszatért 16,7 ms-ra. Ami elveszett: a háttér **nem követi a
jelenetek színét**. Ami megmaradt: a cím színvilága a lejátszó mögött, és egy
lejátszás, ami nem akad. Ha egyszer lesz olyan út, ami nem kényszerít
visszaolvasást (például `requestVideoFrameCallback` egy `OffscreenCanvas`-ra,
mérve), a mérés megismételhető.

### Mini player — PARTIAL

**Miért.** Húzás, átméretezés, bezárás, visszaállítás megvan és tesztelt, de
**valódi eszközön nem próbáltam**, és a fejetlen böngészőben nincs értelmes
egérhúzás-mérés.

**Mit próbáltam.** A legfontosabb szabály, hogy **ne tudjon elveszni**: 80
képpontnyi rész mindig a képernyőn belül marad, az ablak átméretezése
visszahúzza, és a szélesség a képernyőhöz is igazodik. Belépéskor helyőrző
marad a régi helyén, hogy a lap tartalma ne ugorjon fel.

**Milyen mérés bizonyítja.** Egységtesztek a beszorításra (négy irányban), a
helyőrzőre és arra, hogy a szétbontás kilép belőle.

**Mi maradt hátra.** Kézi kipróbálás asztali böngészőben és telefonon.

### PiP — PARTIAL

**Miért.** A kötés megvan (`requestPictureInPicture`, `enterpictureinpicture`
/ `leavepictureinpicture` események, `P` billentyű), de **fejetlen Chromiumban
nincs kép a képben**, amin mérni lehetne.

**Mit próbáltam.** A böngésző eseménye írja az állapotot, nem a saját
kapcsolónk — ugyanaz az elv, mint a teljes képernyőnél, ahol ez élesben
bizonyított (`fullscreenchange` mindkét irányban mérve).

**Mi maradt hátra.** Kézi kipróbálás.

### Gestures — PARTIAL

**Miért.** A felismerés DOM-mentes és tesztelt, de **igazi ujjal nem
próbáltam**.

**Mit próbáltam.** Koppintás, dupla koppintás a széleken, csúsztatás mindkét
tengelyen, hosszú nyomás. A nehéz rész az, mit **nem** szabad annak venni: az
elmozdult ujj görgetés, nem koppintás; a második koppintásnak közel kell
lennie az elsőhöz.

**Milyen mérés bizonyítja.** Egységtesztek. Menet közben találtak egy valódi
hibát: a felismerő **képernyő- és elemkoordinátát hasonlított össze**, így
minden mozdulat „csúsztatás" lett.

**Mi maradt hátra.** Kipróbálás igazi iOS-en és Androidon.

### Watch party — PARTIAL

**Miért.** Két böngészővel egyszerre **nem próbáltam**; a szinkron logikája
egységtesztelt, élő szobában nem futott.

**Mit próbáltam.** A visszhangot **számláló** némítja, nem logikai érték: két
egymásba érő alkalmazás (egy `seek` közben érkező `pause`) az elsőt befejezve
hamisra állítaná, és a második már kiküldené magát. Az elsodródásra külön,
DOM-mentes döntésfüggvény van.

**Milyen mérés bizonyítja.** 17 egységteszt. A régi huzalozás egy logikai
értékkel és 250 ezredmásodperccel némít — az új ezt javítja, de **élesben nem
mértem**.

**Mi maradt hátra.** Két böngésző, egy szoba, egy rész végignézve.

---

## Amit kifejezetten NEM vezettem be

### Media Capabilities (37. pont)

A leírás kikötése: *„Ne implementáld csak azért, mert létezik. Csak mérhető
előnyt hozó esetben használd."*

Megmértem. A `navigator.mediaCapabilities` ezen a gépen `smooth: true`-t mond
az **AV1 2160p**-re is — egy megosztott magú, AV1-gyorsítás nélküli VPS-en.
Ez nem igaz, tehát a `smooth` nem hordoz információt. A `supported` marad, azt
viszont a `video.canPlayType()` szinkronban, ígéret nélkül, olcsóbban megadja
— és a lejátszó már használja is.

**Nincs mérhető előny, tehát nincs bevezetve.** A mérés táblázata a
[teljesítménydokumentumban](PLAYER_2_PERFORMANCE.md) van, hogy egy későbbi
böngészővel megismételhető legyen.

### dash.js

A DASH csak natívan megy. Egy külső könyvtár egy olyan formátumért, amit ma
egyetlen forrás sem használ, a 47. pont szerinti „felesleges dependency".

---

## Amit a munka közben a saját kódomban találtam

Nem szépítem: ezek mind az én hibáim voltak, és mind teszt vagy mérés fogta
meg őket, nem átolvasás.

| hiba | mi fogta meg |
|---|---|
| a **betöltő soha nem tűnt volna el** — a `setPhase` megvolt, senki nem hívta | böngészős teszt |
| a **hiányzó kapcsoló BEkapcsolta volna** az új lejátszót mindenkinél | a `featureOn` forrásának elolvasása |
| a **vezérlők láthatósági feltétele fordítva volt** | egységteszt |
| a **környezeti fény 4,5×-ére rontotta a képkockaközt** | mérés |
| **négy beállításkulcs nem létezett**, némán | a séma kiírása a dokumentumhoz |
| a **tizenegy hibaüzenetnek nem volt magyar fordítása** | a hibakódok kiírása a dokumentumhoz |
| **320 képponton a gombok 20 képpontra nyomódtak** | böngészős teszt |
| a **betöltő a hibaüzenet fölött maradt** | böngészős teszt |
| az elrejtés **törölte a tekerősáv `tabindex`-ét** | egységteszt |
| a gesztusfelismerő **kétféle koordinátát kevert** | egységteszt |
| a visszaesés **ugyanazt a jelöltet próbálta újra** | egységteszt |
| a `ui.skipSegment` **nem volt a kezdőállapotban** | egységteszt |
| a **fejlesztői réteg alapból BE volt kapcsolva** | egységteszt |
| a közös nézés `send`-je **létrehozáskor rögzült**, a szoba később nyílik | egységteszt |
| **kitalált felületek**: `PageW2G.isHost`, `flags.on`, `progress.flush` | a valódi forrás elolvasása |

És három saját **mérési** hiba, mert ezek ugyanennyire számítanak:

- a beszúrás mérésénél **háromszor** néztem azt, szerepel-e az „onerror" szó.
  Menekítve szerepelhet. A helyes mérték: **keletkezett-e tőle elem**;
- a közös nézés készlete **minden állítást teljesített, és nem lépett ki** — a
  házigazda időzítője életben tartotta az eseményhurkot;
- a `pkill`-em **a saját parancssoromra is illett**, és megölte a szerkesztést
  végző héjat, mielőtt az lefutott volna.

---

## Bevezetés

A kapcsoló **ki van kapcsolva**, és a lap mindkettőt megkérdezi
(`flagDeclared && featureOn`). Ellenőrizve élesben: a `/v1/config` kiadja a
sort `enabled: false` értékkel.

A kliens a képbe van sütve, nincs becsatolva — **a változás csak a következő
telepítéssel ér ki**, és akkor sem kapcsol át magától semmit.

A lépések, a kézi ellenőrzőlistával és a visszakapcsolással, a
[migrációs dokumentumban](PLAYER_2_MIGRATION.md) vannak.

---

## Dokumentáció

| lap | miről szól |
|---|---|
| [PLAYER_REWRITE_AUDIT.md](PLAYER_REWRITE_AUDIT.md) | mi volt, mi marad, mi megy |
| [PLAYER_2_ARCHITECTURE.md](PLAYER_2_ARCHITECTURE.md) | a rétegek és a szerződéseik |
| [PLAYER_2_CONFIGURATION.md](PLAYER_2_CONFIGURATION.md) | mit kell átadni a lejátszónak |
| [PLAYER_2_PREFERENCES.md](PLAYER_2_PREFERENCES.md) | a 34 beállítás |
| [PLAYER_2_FEATURE_FLAGS.md](PLAYER_2_FEATURE_FLAGS.md) | a 23 kapcsoló és a bevezetésé |
| [PLAYER_2_TESTING.md](PLAYER_2_TESTING.md) | mit bizonyítanak a tesztek, és mit nem |
| [PLAYER_2_PERFORMANCE.md](PLAYER_2_PERFORMANCE.md) | a mért számok és két elutasított megoldás |
| [PLAYER_2_MIGRATION.md](PLAYER_2_MIGRATION.md) | a bevezetés lépései és a visszaút |
| [PLAYER_2_TROUBLESHOOTING.md](PLAYER_2_TROUBLESHOOTING.md) | tünetek és okok |
