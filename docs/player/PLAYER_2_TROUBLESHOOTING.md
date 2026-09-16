# Player 2.0 — hibakeresés

## Először: melyik lejátszó fut?

```js
// a böngésző konzoljában, a nézőoldalon
document.querySelector('.yp')          // → van elem: Player 2.0
document.querySelector('.player-shell') // → van elem: a régi
```

Ha a rosszat kaptad, a kapcsoló a hibás — lásd az
[áttérést](PLAYER_2_MIGRATION.md).

## A lejátszó belseje futás közben

A nézőoldal a `this._player2` alatt tartja a felszerelt lejátszót. A
legtöbbet mondó egyetlen parancs:

```js
// a lejátszó teljes állapota
__yp?.player.state.get()        // a böngészős tesztben
```

Éles lapon a lejátszóra nincs globális hivatkozás (szándékosan). Amit kívülről
meg lehet nézni:

```js
const shell = document.querySelector('.yp')
shell.className                                   // yp-playing, yp-fullscreen, yp-idle…
shell.querySelector('.yp-loader-phase').textContent  // hol tart a betöltés
shell.querySelector('.yp-error-text')?.textContent   // mi a hiba
```

## Tünetek

### A betöltőképernyő nem tűnik el

**Ez volt a legsúlyosabb hiba a fejlesztés alatt**, és pontosan így nézett ki:
a logó felállt, végigfutott rajta a szín, és ott maradt — a videó közben ment
alatta, láthatatlanul.

Az ok az volt, hogy a fázist **senki nem állította** `READY`-re. A
`playback/loading-phase.js` azóta a videóelem saját eseményeiből vezeti:
`loadstart` → `LOADING_SOURCE`, `loadedmetadata` → `LOADING_METADATA`,
`canplay`/`loadeddata`/`playing` → `READY`.

Ha mégis előfordul, nézd meg, **megérkezik-e valamelyik készültségi esemény**:

```js
const v = document.querySelector('.yp video')
;['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'error']
  .forEach(t => v.addEventListener(t, () => console.log(t, v.readyState)))
```

Ha csak `loadstart` jön és semmi más: a forrás nem válaszol. Ha
`loadedmetadata` jön, de `canplay` nem, a videó fejléce megvan, az adat nem —
általában hálózat vagy tartományközi (CORS) korlátozás.

### „Ezt a részt egyik elérhető forrásból sem sikerült lejátszani"

A forráskezelő **minden jelöltet kétszer** próbált. A hálózati fülön nézd meg,
mi történt az egyes címekkel:

| amit látsz | mi ez |
|---|---|
| 403 / 401 | a forrás nem engedi innen a lejátszást |
| CORS-hiba | ugyanez, csak a böngésző mondja meg |
| időtúllépés 12 mp-nél | a forrás nem válaszolt — ez a `ATTACH_TIMEOUT_MS` |
| 200, de nem indul | a formátumot a böngésző nem tudja lejátszani |

Az **Újra** gomb a teljes sort újrapróbálja, nulláról.

### Mobilon nem indul el

A mobil böngészők **hang mellett nem engedik** az automatikus lejátszást, és
sokszor csak a metaadatig töltenek. A lejátszó ezért fogadja el a
`loadeddata`-t is készültségnek, és `preload="metadata"`-val indul.

Ha mégis áll: a néző koppintása indítja el. Ez nem hiba, hanem a platform
szabálya.

### A vezérlők eltűnnek, amikor nem kellene

A láthatóság állapotgépe (`ui/controls-visibility.js`) négy tényből dönt:
tétlenség, rögzítés (nyitott menü vagy fogott csúszka), szünet, érintés.

- **szünetben mindig látszanak** — nincs mit takarniuk;
- **nyitott menü mellett sem tűnnek el** — különben a menü a semmi fölött
  lebegne;
- **érintésen hosszabb a türelmi idő** (4 mp a 3 helyett), mert ott nincs
  „egeret elmozdítok" gesztus a visszahozásra.

Ha ez elromlik, a feltétel iránya a gyanús. Egyszer már fordítva volt, és a
vezérlők pont akkor tűntek el, amikor látszaniuk kellett volna.

### A billentyűparancsok nem működnek

A leggyakoribb ok, hogy **a fókusz beviteli mezőben van** — és ez így helyes.
A `isTypingTarget()` kiszűri az `<input>`, `<textarea>`, `<select>`,
`contenteditable` és `role="textbox"` elemeket. A közös nézés csevegőmezőjébe
beírt „f" egy betű, nem teljes képernyő.

A módosítóval nyomott billentyű is kimarad: a Ctrl+F a böngészőé.

A parancsok a **héjra** vannak kötve, nem a dokumentumra. Ha a fókusz sehol
nincs a lejátszón belül, kattints rá egyszer.

### A felirat nem jelenik meg

Három külön ok lehet, és jól elkülöníthetők:

1. **nincs sáv** — a `subtitles.tracks` üres, és a gomb tiltott. A menü ki is
   írja: „Ehhez a részhez nincs feltöltött felirat";
2. **a sáv ott van, de nem látszik** — a `<track>` `default` nélkül
   **letiltva** töltődik be. Ez a régi lejátszó valódi hibája volt. Ellenőrzés:
   `document.querySelector('.yp video').textTracks[0].mode` — `showing`-nak
   kell lennie, nem `disabled`-nek;
3. **`.srt` fájl** — a böngésző `<track>`-je **csak WebVTT-t ért**, és egy
   `.srt`-re mutató `src` némán semmit nem csinál. A
   `subtitles/subtitle-loader.js` ezért letölti, átalakítja, és `blob:` címen
   adja oda. Ha ez elhasal, a felirat kimarad, **de a kép megy tovább** — egy
   hiányzó felirat nem ok arra, hogy a rész ne induljon el.

### Rossz minőség megy

A menü megmondja, miért: az „Automatikus" mellett zárójelben ott van, mi megy
éppen. Ha alacsonyabb a vártnál:

- **adattakarékos mód** — 480p-re szorít, és **semmi nem írja felül**;
- **mobilhálózat** — `player.quality.mobile`, alapból 720p;
- **nincs jobb forrás** — a menü **csak azt sorolja fel, ami tényleg van**.

A **kézi választás erősebb** a hálózati korlátnál. Aki 1080p-t választ, azt
megkapja, ha elérhető.

### A közös nézés összeakad

Két klasszikus tünet:

- **oda-vissza szüneteltetés** — visszhang. A modul számlálóval némít az
  alkalmazás idejére; ha ez elromlik, a `party.applying` ragad igazon;
- **ugrálás** — elsodródás-kezelés. Másfél másodperc alatt nem nyúlunk hozzá,
  harminc fölött újraszinkronizálunk. Ha ugrál, a helyzetjelentés túl sűrű
  vagy a tűréshatár túl szűk.

**Csak a házigazda vezethet**, és ezt a **szerver** dönti el. Egy vendég
üzenetére a válasz: `only the host controls playback`. Ez nem hiba.

## Naplózás

A lejátszó a `logger`-en keresztül ír, és **a fejlesztői részlet sosem jut a
képernyőre**: a `PlayerError.detail` hívásvermet és belső címet is
tartalmazhat, ezért a `toUser()` kizárólag a taxonómia szövegét adja vissza.

A konzolban a `[player]` előtag alatt jelenik meg a kód és a részlet.

## Hibakódok

| kód | újrapróbálható | mit jelent |
|---|---|---|
| `NO_SOURCE` | nem | ehhez a részhez még nincs forrás |
| `SOURCE_TIMEOUT` | **igen** | a forrás nem válaszolt |
| `SOURCE_UNSUPPORTED` | nem | a böngésző nem tudja lejátszani ezt a formátumot |
| `NETWORK_ERROR` | **igen** | megszakadt a kapcsolat |
| `MEDIA_ERROR` | nem | a videó sérült vagy olvashatatlan |
| `CORS_ERROR` | nem | a forrás nem engedi innen a lejátszást |
| `DRM_ERROR` | nem | másolásvédett tartalom |
| `SUBTITLE_ERROR` | **igen** | a feliratot nem sikerült betölteni |
| `QUALITY_ERROR` | **igen** | ez a minőség nem érhető el |
| `ABORTED` | nem | szándékos megszakítás — a néző nem lát semmit |
| `UNKNOWN` | **igen** | minden más |

Az `újrapróbálható` oszlop **vezeti a visszaesést**: ami nem az, annál a
következő jelölt jön azonnal, mert ugyanazzal a forrással nincs értelme még
egyszer próbálkozni.
