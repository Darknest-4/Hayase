# Player 2.0 — tesztelés

**247 egységteszt** tíz készletben, és **28 böngészős teszt** egy
tizenegyedikben. A kettő különbsége nem méretbeli: **mást tudnak megfogni**.

| készlet | tesztek | mit őriz |
|---|---|---|
| `player2-core.test.mjs` | 26 | esemény, állapot, hibataxonómia, életciklus |
| `player2-engine.test.mjs` | 26 | forrásrangsor, motorválasztás, visszaesés |
| `player2-playback.test.mjs` | 19 | lejátszásvezérlés, haladás, folytatás |
| `player2-preferences.test.mjs` | 28 | séma, érvényesítés, áttérés, kapcsolók |
| `player2-subtitles.test.mjs` | 29 | feliratelemzés, sávválasztás, minőség, átugrás |
| `player2-ui.test.mjs` | 48 | formázás, láthatóság, vezérlők, menü, héj |
| `player2-party.test.mjs` | 17 | közös nézés: visszhang, elsodródás |
| `player2-extras.test.mjs` | 26 | fény, kislejátszó, zárolt képernyő, hibakereső, telemetria |
| `player2-next-settings.test.mjs` | 20 | következő-rész kártya, teljes beállításpanel |
| `player2-rollout.test.mjs` | 8 | a bevezetés kapcsolója |
| `tests/e2e/player2.test.mjs` | 28 | valódi böngésző, valódi videó, 11 szélesség, mérés, akadálymentesség |

Futtatás:

```bash
node --test apps/web/test/player2-*.test.mjs       # egységtesztek, DB nélkül
npm run test:e2e --workspace @yume/api             # böngészős, DATABASE_URL kell
```

## Miért van a magban nulla DOM

A mag, a motorok és a lejátszásvezérlés **egyetlen sora sem hivatkozik
`document`-re**. Ez nem elvi tisztaság: ettől lehet őket `node --test`-tel,
böngésző nélkül, ezredmásodpercek alatt futtatni — és ettől lehet egy
visszaesési szabályt úgy megírni, hogy a hibáját egy teszt fogja meg, ne egy
néző.

A felület az egyetlen DOM-réteg, és ott is külön van minden, ami DOM nélkül
eldönthető: időformázás, a vezérlők láthatósági állapotgépe, a
billentyűparancsok felismerése, a gesztusok.

## Miért nem a közös DOM-csonk

A `test/support/browser.mjs` eseménytípusonként **egyetlen** figyelőt tárol
(`this.listeners[type] = fn`), és a `classList` metódusai üresek. Egy olyan
felület, aminek a lényege a „hány figyelő futott le" és a „melyik osztály van
rajta", azzal a csonkkal **nem mérhető**: minden állítás átmenne.

Ezért van a `test/support/mini-dom.mjs`: több figyelő típusonként, működő
`classList`, `querySelector` osztályra, elemnévre és leszármazottra, és annyi
`innerHTML`-elemzés, amennyivel a lejátszó moduljai maguk is dolgoznak.

A közös csonk **érintetlen maradt** — harminc másik készlet fut rajta, és egy
kényelmi átírás ott mindet kockáztatná.

## Mit fogott meg a tesztelés

Nem elméleti lista. Ezek mind olyan hibák, amiket a saját kódomban találtak,
mielőtt bárki látta volna őket:

**Egységtesztek:**

- a visszaesés **ugyanazt a jelöltet próbálta újra** másodszor is, mielőtt a
  másodikhoz ért volna;
- a vezérlők **láthatósági feltétele fordítva volt** — pont akkor tűntek el,
  amikor látszaniuk kellett volna;
- az elrejtés **törölte a tekerősáv `tabindex`-ét**, és egy
  `<div role="slider">` e nélkül örökre kiesik a Tab sorrendjéből;
- a gesztusfelismerő **képernyő- és elemkoordinátát hasonlított össze**, így
  minden mozdulat „csúsztatás" lett;
- a `ui.skipSegment` **nem volt benne a kezdőállapotban**, így `undefined`
  volt `null` helyett — egy feliratkozó felület nem tudta megkülönböztetni a
  „nincs átugrás"-t attól, hogy „még nem kérdeztük meg";
- **négy beállításkulcs nem létezett**, és az ismeretlen kulcs némán nem
  csinál semmit (lásd a [beállításokat](PLAYER_2_PREFERENCES.md)).

**Böngészős tesztek — ezeket egyetlen egységteszt sem foghatta meg:**

- a **környezeti fény négy és félszeresére rontotta a képkockaközt** (16,7 →
  75,2 ms), mert a videó vászonra másolása visszaolvasást kényszerít a
  GPU-ról. Részletek a [teljesítménynél](PLAYER_2_PERFORMANCE.md);

- a **betöltőképernyő soha nem tűnt volna el**. A `setPhase` megvolt, a
  betöltő olvasta is, de **senki nem hívta**. A logó felállt, végigfutott
  rajta a szín, és ott maradt; a videó ment alatta, láthatatlanul;
- a **betöltő a hibaüzenet fölött maradt**, mert a forráskimerülés az
  állapotba ír hibát, esemény nélkül;
- **320 képponton a gombok 20 képpont szélesre nyomódtak** — ujjal
  eltalálhatatlan, és semmi nem jelezte.

## Két saját mérési hiba, hogy máskor ne ismétlődjön

- a **feliratbeszúrás mérésénél** azt néztem, szerepel-e az `onerror` szó a
  jelölésben. Menekítve szerepelhet, ártalmatlan szövegként — a helyes mérték
  az, hogy **keletkezett-e tőle elem**;
- a **közös nézés készlete minden állítást teljesített, és nem lépett ki**: a
  házigazda helyzetjelentője `setInterval`, és szétbontás nélkül életben
  tartja az eseményhurkot. A tesztfuttató zöldet írt, aztán örökre várt. Azóta
  külön teszt őrzi, hogy a szétbontás után ne maradjon időzítő.

## Amit a tesztek NEM bizonyítanak

Ezt kimondva, mert egy hiányzó sor a listából hamis biztonság:

- **feliratok élesben.** A `subtitle_tracks` tábla **üres**. Az elemző, a
  sávválasztás és a betöltő egységtesztekkel igazolt, éles adaton nem;
- **hangsávok.** Az `audio_tracks` tábla **üres**;
- **intró/outró átugrás élesben.** A `skip_segments` tábla **üres**;
- **valódi mobil eszköz.** A gesztusok logikája tesztelt, a böngészős futás
  fejetlen Chromiumban ment — igazi iOS-en és Androidon nem;
- **zárolt képernyős vezérlés.** A Media Session kötése egységtesztelt
  (beleértve azt is, hogy egy ismeretlen művelet nem viszi magával a
  többit), de fejetlen Chromiumban nincs zárolt képernyő, amin látszana;
- **HLS és DASH élesben.** A motorok megvannak és egységtesztekkel igazoltak,
  de a katalógusban ma nincs ilyen forrás, amin ki lehetne próbálni.
