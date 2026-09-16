# Player 2.0 — teljesítmény

Minden szám ezen a gépen mért, valódi Chromiumban, valódi videóval
(`tests/e2e/player2.test.mjs`). Nem becslés és nem összehasonlítás egy másik
termékkel — **ennek a kódnak az ára, ezen a VPS-en**.

## A mért értékek

| mit | érték |
|---|---|
| felépítés (12 kör mediánja) | **1,20 ms** |
| felépítés, legrosszabb | 1,70 ms |
| állapotfrissítés | **76,8 µs** |
| állapotfrissítés, ha semmi nem változott | **0,6 µs** |
| 25 felépítés + szétbontás után maradék elem | **0** |
| 25 kör után el nem bontott erőforrás | **0** |
| képkockaköz lejátszás közben, medián | **16,7 ms** |
| képkockaköz, p95 | 36,9 ms |
| képkockaköz, legrosszabb | 43,1 ms |

## Mit jelentenek

**A második és a harmadik sor együtt** a legfontosabb. Egy olyan frissítés,
ami semmit nem változtat, **ötvenkilencszer olcsóbb** egy valódinál. Ez a
mezőnkénti változásfigyelés bizonyítéka: a `merge()` nem cseréli ki az
állapotfát, hanem összehasonlítja a mezőket, és csak akkor értesít, ha
tényleg más lett.

Enélkül a `timeupdate` — ami **másodpercenként négyszer** jön — minden
alkalommal újrarajzolná az egész felületet. Így viszont a tekerősáv és az
időkijelző frissül, a menü, a gombok és a feliratréteg nem.

**A negyedik és ötödik sor** a részváltás ára. A lejátszó minden résznél
újraépül; egy körönként bennmaradó héj egy sorozatnézés alatt tucatnyi rejtett
videóelemet jelentene, mindegyik a saját pufferével. A `player.own()`
nyilvántartása miatt ez nulla.

**Az utolsó három sor** azt méri, hogy a lejátszó nem fagyasztja-e be a
főszálat. A 16,7 ms-os medián nagyjából 60 kép/másodperc. Fejetlen böngészőben
nincs valódi képernyőfrissítés, tehát ez a szám **nem hasonlítható** egy
asztali gép 60 Hz-éhez — amit megfog, az a blokkolás.

## Ami olcsóvá teszi

- **Nincs építési lépés és nincs keretrendszer.** A lejátszó 30 modul, összesen
  3 895 sor, és a böngésző pontosan azokat tölti le, amiket használ.
- **Nincs külső függőség**, ami mindig betöltődne. A hls.js **csak akkor**
  töltődik le, ha egy HLS-forrás kerül sorra, és a böngésző natívan nem tudja.
  A dash.js egyáltalán nincs — ott csak a natív támogatásra építünk.
- **Az ikonok `<path>` adatok**, nem külön kérések.
- **A pufferelt sáv csak azt a szakaszt rajzolja, amelyikben éppen vagyunk.**
  Több tekerés után a `buffered` több, egymástól független szakaszt ad, és
  mindet kirajzolni fölösleges munka lenne — ráadásul hazugság.
- **A tekerés az elengedéskor történik**, nem húzás közben. Egy másodperc
  húzás különben tucatnyi bájttartomány-kérés lenne.
- **A közös nézés helyzetjelentése négy másodpercenként megy**, nem
  `timeupdate`-re. Az utóbbi egy részen negyvenezer üzenet lenne, semmi
  haszonnal.

## Egy funkció, amit a mérés írt át

A környezeti fény első változata a **videó képkockáit** mintázta egy 32×18-as
vászonra, fél másodpercenként. Papíron elhanyagolható. Böngészőben mérve, 150
képkocka mediánja, kétszer megismételve:

| mit csinált | képkockaköz mediánja |
|---|---|
| nincs fény | **16,7 ms** |
| **csak a másolás**, vászon megjelenítése nélkül | **76,0 ms** |
| másolás + kicsi elmosás, felnagyítva | 74,8 ms |
| másolás + nagy elmosás a teljes felületen | 79,3 ms |

A **második sor** a döntő. A költség nem az elmosás és nem a megjelenítés,
hanem maga a `drawImage(video, …)`: egy videó képkockájának vászonra másolása
visszaolvasást kényszerít a GPU-ról, és a dekódoló utána lassabb úton marad.
Nem a másolás pillanata drágul — **az egész lejátszás**.

Először az elmosást próbáltam olcsóbbá tenni (kicsiben elmosni, utána
nagyítani). Nem segített: 79 ms maradt. Csak a szétbontott mérés mutatta meg,
hogy rossz helyen kerestem.

A 20. pont a „videó/**poster** színeiből" kér hátteret. A poszter ugyanolyan
jó forrás, és egy képet **egyszer** lemásolni ingyen van: nincs dekódoló,
amit elronthatnánk, és nincs ismétlődő munka. A modul azóta a borítót
mintázza, egyszer, és a mért érték visszatért 16,7 ms-ra.

Ami elveszett: a háttér nem követi a jelenetek színét. Ami megmaradt: a cím
saját színvilága a lejátszó mögött — és egy lejátszás, ami nem akad.

A böngészős készlet azóta **a mediánra is** állít határt (40 ms), pont ezért
a hibaosztályért.

## Mit nem mértünk

- **valódi hálózaton, valódi nézővel.** Ez a mérés helyi fájlból játszik le,
  egy gépen. A pufferelés viselkedése valódi hálózaton más;
- **mobil eszközön.** Fejetlen Chromium egy VPS-en nem mond semmit egy
  háromévés Androidról;
- **hosszú távon.** A leghosszabb mérés 25 kör; egy éjszakán át futó
  sorozatnézés nem.

## Ha romlana

A böngészős készlet minden futásnál kiírja a számokat. Ami gyanús:

- **a felépítés mediánja tízszeresére nő** — valószínűleg új szinkron munka
  került a felépítési útba (például egy hálózati kérés, amit meg is várunk);
- **a változás nélküli frissítés drágul** — a mezőnkénti összehasonlítás
  romlott el, és minden `timeupdate` újrarajzol mindent. Erre külön állítás
  van: a nem változó frissítésnek **olcsóbbnak kell lennie** a valódinál;
- **a maradék elemek száma nem nulla** — valami kikerült a `player.own()`
  nyilvántartásából.
