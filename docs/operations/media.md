# Média az R2-ben — képek, videók, CORS

A YUME két Cloudflare R2 vödröt használ, és a szétválasztásuk **biztonsági
döntés**, nem rendrakás:

| vödör | mi van benne | ki éri el |
|---|---|---|
| `yume-backups` | az adatbázis teljes mentése | senki kívülről; csak a mentőfeladat |
| `yume-media` | tükrözött borítók, bannerek, videók | bárki, a `media.animehub.hu` címen |

A médiavödröt egy olyan útvonal olvassa, ami a kulcsot a kérés URL-jéből veszi.
Ha a kettő egy vödör lenne, ennek az útvonalnak egyetlen hibája az egész
adatbázist letölthetővé tenné egy jól megtippelt címmel. Így viszont a kód nem
is tud a mentésekre mutatni.

## A nyilvános cím

Egyetlen beállítás dönti el, honnan jönnek a képek:

```
MEDIA_BASE_URL=https://media.animehub.hu
```

Nincs beállítva → `/media/`, vagyis a saját kiszolgálónk. Beállítva → a kép
közvetlenül az R2-ből megy a látogatóhoz, a hozzá legközelebbi Cloudflare
él-szerverről, **nulla kimenő díjjal**, és a mi gépünket el sem éri.

A cím **elgépelése nem okoz katasztrófát**: ami nem felismerhetően https-cím
vagy saját útvonal, arra az alapértelmezés marad. Ide tartozik a `//idegen/`
alakú, séma nélküli cím is — az abszolút útvonalnak *látszik*, a böngésző
viszont idegen gazdának olvasná, és onnan töltene minden képet.

Induláskor az app **megpróbálja** a beállított címet, és ha nem válaszol,
hangosan naplóz. Erre azért van szükség, mert ilyenkor NÁLUNK semmi nem
hibázik: az API helyes választ ad, a lap felépül, csak minden kép törött — a
hiba a látogató böngészőjében történik.

Kézi ellenőrzés: `scripts/cloudflare/check-media.sh`

## CORS — miért kell, és mikor

Egy `<img>` alapból bármit betölt, origótól függetlenül. A CORS akkor lép be,
amikor a **JavaScript is látni akarja a képpontokat**. A lejátszó környezeti
fénye pont ezt teszi: a posztert vászonra rajzolja és megméri a színét, ezért
`crossOrigin = 'anonymous'`-szal tölti be.

Ilyenkor a szabály szigorú: ha a válaszban nincs `access-control-allow-origin`,
a kép **be sem töltődik** — nem „szennyezett vászon" lesz belőle, hanem
betöltési hiba.

Ez élesben elő is fordult: miután a képek átkerültek a tükörre, a vödrön nem
volt CORS-szabály, és a környezeti fény csendben elmaradt.

```bash
# megnézni
node --experimental-strip-types scripts/media-cors.ts --show

# beállítani (az origók a PUBLIC_URL-ből jönnek, ha nem adsz meg mást)
node --experimental-strip-types scripts/media-cors.ts --set \
  --origin https://animehub.hu \
  --origin https://www.animehub.hu \
  --origin https://yumee.duckdns.org
```

A szabály **csak olvasó**: `GET` és `HEAD`, csak a felsorolt origókról. A `*`
itt nem kényelem, hanem azt jelentené, hogy bármelyik weboldal beolvashatja a
vödör tartalmát a látogatói böngészőjén keresztül.

Ellenőrzés kívülről:

```bash
curl -sI -H 'Origin: https://animehub.hu' https://media.animehub.hu/<kulcs>
```

> **A Cloudflare gyorsítótára miatt a hatás késik.** A szabály előtt elmentett
> válaszokban nincs `vary: Origin`, tehát azokat a CORS-kérés is fejléc nélkül
> kapja meg. A `cache-control: max-age=14400` miatt ez legfeljebb négy óra;
> gyorsabb megoldáshoz zóna-ürítés kellene, ahhoz pedig Cloudflare API-token.

## Videó feltöltése

```
node --experimental-strip-types scripts/upload-video.ts <fájl> [opciók]
```

| kapcsoló | mire jó |
|---|---|
| `--episode <uuid>` | a forrás bejegyzése az epizódhoz (`video_sources`) |
| `--title`, `--provider`, `--resolution`, `--language`, `--variant`, `--priority` | a bejegyzés mezői |
| `--key <kulcs>` | kézzel adott tárhelykulcs a tartalomból származó helyett |
| `--part-mb`, `--concurrency` | darabméret és párhuzamosság |
| `--dry-run` | mindent kiszámol, de nem tölt fel és nem ír |

**Miért szkript, és nem adminfelület.** A feltöltésnek a kiszolgálón kell
történnie, nem a kiszolgálón *keresztül*: a Cloudflare ingyenes csomagja a
kérés törzsét 100 MB-ban maximálja, egy epizód pedig ennek a sokszorosa. Egy
böngészőből induló feltöltés nem lassú lenne, hanem 413-mal elhasalna. Az
adminfelület azt regisztrálja, ami már fent van.

**A kulcs a tartalomból származik** (`video/<két jegy>/<sha256>.<kiterjesztés>`),
mint a képtükörnél. Ebből két dolog következik:

* ugyanaz a fájl mindig ugyanoda megy, tehát egy **megismételt futás nem tölt
  fel újra semmit** — egy megszakadt feltöltés egyszerűen újraindítható;
* a kulcs mögött sosem változik a tartalom, tehát a hosszú gyorsítótárazás
  ígérete áll.

**Többrészes feltöltés.** Egyetlen `PUT` 5 GB-ig megy, és a Node-ban egy
`Buffer` jóval előbb elfogy — egy 1,4 GB-os epizód a teljes memóriát kérné,
mielőtt egy bájt is elindulna. A feltöltő ezért darabokban küld, egyszerre
néhány darabbal, és a szolgáltató rakja össze. A darabméret alapból 64 MiB
(10 000 darabbal 640 GB a plafon), és **az utolsó darabon kívül minden darab
pontosan egyforma** — az R2 ezt megköveteli, az AWS nem.

Ha egy darab elhasal, a feltöltő újrapróbálja (1 s, 2 s, 4 s). Ha végleg nem
megy, **eldobja a félkész feltöltést**: a már feltöltött darabok addig helyet
foglalnak és pénzbe kerülnek, amíg vagy le nem zárják, vagy el nem dobják őket.

Feltöltés után a méretet visszaolvassuk. A többrészes lezárás akkor is 200-at
adhat, ha az összefűzés hibás volt, és az eredmény egy csendben sérült videó.

## A karbantartási oldal háttérvideója

A karbantartási oldal **pont akkor megy ki, amikor a kiszolgáló bajban van** —
túlterhelés, telepítés, adatbázishiba. Egy 35 MB-os videó minden látogatónak, a
saját sávszélességünkről, a lehető legrosszabb pillanatban érkezne.

```
MAINTENANCE_VIDEO_BASE=https://media.animehub.hu/video/maintenance
```

A **könyvtár marad a katalógus**: a neveket, a méreteket és a választást
továbbra is az `apps/web/assets/videos` adja. Ez a beállítás csak azt mondja
meg, honnan tölti le a böngésző ugyanazt a nevet — a vödörben tehát ugyanazon a
néven kell lennie:

```bash
node --experimental-strip-types scripts/upload-video.ts \
  /opt/yume/apps/web/assets/videos/amv-counting-stars.mp4 \
  --key video/maintenance/amv-counting-stars.mp4
```

Induláskor ezt is ellenőrizzük, és ha nem szolgál ki, naplózzuk. Visszavonás:
vedd ki a sort, `docker compose up -d app` — a videó azonnal a helyi fájlra esik
vissza.

## Objektum eltávolítása

```
node --experimental-strip-types scripts/media-remove.ts <kulcs> [--dry-run] [--force]
```

A vödörben két fajta tartalom van: amire az oldal **mutat** (a tükrözött
borítók `mirror_key`-e, a lejátszási források `ref`-je), és ami ottfelejtett. A
kettő ránézésre ugyanolyan, és a különbség csak az adatbázisból derül ki. A
szkript ezért alapból visszautasít mindent, amire hivatkozás van, és
adatbázis-hiba esetén **sem** töröl — az ellenőrzés hiánya nem ugyanaz, mint
hogy „semmi nem hivatkozik rá".

## Költség

Az R2 kimenő forgalma a Cloudflare-en át **ingyenes**; a tárolás nem az
(nagyságrendileg 0,015 USD / GB / hó). Ez a képeknél elhanyagolható, videónál
nem: a `video_sources` ma 364 064 bejegyzett forrást tart nyilván, összesen
12 TB méretben. **Ezek referenciák, nem fájlok** — a platform sosem tárolt
médiát. Ha mindet feltöltenénk, az havi több száz dollár lenne. Az R2 tehát
válogatott tartalomra való, nem a teljes katalógusra.
