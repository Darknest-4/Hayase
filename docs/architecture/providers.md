# Forrásszolgáltatók — a YUME providerrétege

**Állapot:** az első mérföldkő kész és élesben fut. Egy beépített adapter
(`yume-local`), teljes lánc, egészségfigyelés, gyorsítótár és
adminfelület-végpontok.

---

## Mi ez, és mi nem

A réteg **forrás-agnosztikus**: azt tudja, hogyan kell egy epizódhoz
lejátszható címet keresni több szolgáltatónál, sorrendben, hibatűrően — de
semmit nem tud arról, hogy azok a szolgáltatók mik.

Ez nem stílus. A cél az volt, hogy

> ha egy szolgáltató holnap megszűnik, az eltávolítása egy kapcsoló legyen, és
> ne érintse a lejátszót, az API-t vagy az anime/epizód adatmodellt.

Ez ma teljesül: a `PATCH /v1/admin/providers/<slug>` `{"enabled": false}`
kikapcsolja, a lánc átlép rajta, és a lejátszó nem tud róla. Élesben
kipróbálva.

### Amit szándékosan NEM tartalmaz

Nincs benne adapter engedély nélküli streaming-oldalakhoz, és nem készült
felmérés arról, melyikből lehet ma streamet kinyerni. A réteg viszont nem
feltételezi ezek hiányát sem: bármilyen adapter, amit beteszel, ugyanazt a
szerződést kapja.

---

## A rétegek

```
    /v1/anime/episodes/:id/sources
                 │
                 ▼
         resolve.ts ──── gyorsítótár (a forrás saját lejáratához igazítva)
                 │
                 ├──── registry.ts ──── providers tábla (kapcsoló, sorrend)
                 │
                 ├──── health.ts ────── körkörös megszakító + provider_events
                 │
                 ▼
         AnimeProvider (types.ts)
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
  adapters/local.ts     (a te adaptered)
```

### `types.ts` — a határ

Innen kifelé a YUME a **saját** fogalmait használja. Egy külső válasz alakja
az adapter dolga, és nem szivárog át: nincs `server`, nincs „sub/dub"
sztringként szétszórva, nincs idegen azonosítóformátum.

| fogalom | mit rögzít |
|---|---|
| `SourceKind` | `hls` \| `dash` \| `mp4` — ez dönti el, melyik motort indítja a lejátszó |
| `SourceVariant` | `sub` \| `dub` \| `raw` |
| `ProviderSource` | cím, minőség, **hang** nyelve, változat, `headers`, `expiresAt` |
| `ProviderSubtitle` | nyelv, szerep, formátum (`vtt`/`ass`/`srt`), cím |
| `EpisodeRef` | ami egy szolgáltatónak segít: AniList-azonosító, cím, szinonimák, év, rész |

A `headers` nem díszítés: sok kiszolgáló csak a saját fejléceivel ad
szegmenst. Ha ezek nem jutnak el a lejátszóig, a lejátszólista betöltődik és a
videó néma marad — olyan hiba, ami a naplóban **sikernek** látszik.

### A szerződés

Három metódus: `search`, `episodes`, `resolve`. Mind dobhat kivételt — a hívó
fel van készülve rá.

**Amit nem szabad: hibára csendben üres tömböt adni.** Az üres tömb azt
jelenti, hogy „megkérdeztem, és nincs"; a kivétel azt, hogy „nem tudtam
megkérdezni". A kettő különbsége dönti el, hogy a megszakító kinyisson-e — és
egy adapter, ami ezt összemossa, örökre a lánc elején marad halottan.

### `registry.ts` — a kapcsoló

Két forrásból áll, és ez szándékos:

* a **kód** mondja meg, mit *tud* egy szolgáltató;
* a **tábla** mondja meg, *használjuk-e*, és milyen sorrendben.

Ezért nem lehet szolgáltatót „regisztrálni" az adatbázisból (kód nélkül nincs
mit hívni), és ezért nem lehet kikapcsolni a kódból (az üzemeltető döntése nem
telepítés kérdése).

A tábla sorának **hiánya nem kikapcsolás**: egy frissen telepített adapter
működik anélkül, hogy valaki kézzel felvenné. A kikapcsolás a kifejezett
döntés.

### `health.ts` — a megszakító

Három állapot: *zárt* → *nyitott* (3 egymás utáni hiba után) → *félig nyitott*
(egy próbakérés). A türelmi idő 30 másodperctől indul és nyitásonként
duplázódik, 10 percig.

**Az üres válasz nem hiba.** Ha az is büntetne, egy ritka cím kizárná az egész
szolgáltatót.

Az állapot memóriában él (egy telepítés után tiszta lappal indulni helyes), de
minden **állapotváltozás** a `provider_events` táblába kerül — mert a „mióta
romlik?" kérdésre egy processzen belüli számláló nem válasz.

### `resolve.ts` — a lánc

Sorban halad, nem párhuzamosan. Párhuzamosan gyorsabb lenne, de minden
lejátszásindítás minden szolgáltatót megterhelne akkor is, amikor az első
azonnal válaszol.

Minden lépés a válaszba kerül (`attempts`): ki, mit, mennyi idő alatt. Egy
„nincs forrás" válaszra a kérdés az, hogy **miért** — és arra egy üres tömb
nem felelet.

A gyorsítótár kulcsa tartalmazza a **változatot** is, különben egy szinkronos
kérés a feliratos válaszát kapná, és a hiba csak a lejátszóban derülne ki,
rossz hangsávként. A lejáratot a **legkorábbi** forrás szabja meg, nem a
legkésőbbi. **A hiányt nem tároljuk**: különben egy helyreállt szolgáltató öt
percig láthatatlan maradna.

---

## Adminfelület

| végpont | mit csinál |
|---|---|
| `GET /v1/admin/providers` | mind, a **kikapcsoltak is**, egészséggel |
| `GET /v1/admin/providers/:slug/events` | idővonal: mióta romlik |
| `PATCH /v1/admin/providers/:slug` | `enabled`, `priority`, `label` |

Jogosultság: `video_source.view` / `video_source.edit`, `hide: true`-val —
az adminfelület minden végpontja letagadja magát annak, aki nem léphet be.
Minden kapcsolás naplózott (`provider.update`), előtte/utána értékekkel: egy
kikapcsolt szolgáltató első tünete az, hogy „eltűntek a források", és ilyenkor
az első kérdés, hogy ki és mikor kapcsolta ki.

---

## Egy új adapter bekötése

1. `apps/api/src/modules/providers/adapters/<nev>.ts` — az `AnimeProvider`
   szerződés megvalósítása.
2. Felvétel a `BUILT_IN` listába (`providers/index.ts`).
3. Kész. A `providers` tábla sora magától létrejön az első kapcsoláskor; addig
   az adapter `defaultPriority`-je és a bekapcsolt alapértelmezés érvényes.

A `test/provider-core.test.ts` a **szerződést** méri, nem egy konkrét
adaptert — hamis adapterekkel, hálózat nélkül. Amit egy új adapternek
teljesítenie kell, az ott olvasható.

---

## Mit nem old meg ez a réteg

* **Nem párosít.** Az `EpisodeRef` AniList-azonosítót visz; ha egy szolgáltató
  nem ismeri, az adapter dolga megtalálni a címet. A megbízható párosítás a
  nehezebbik fele a feladatnak, és adapterenként más.
* **Nem proxyz.** A `headers` eljut a lejátszóig, de a szegmenseket a böngésző
  kéri. Ha egy forrás CORS miatt nem játszható, azon a réteg nem segít.
* **Nem tárol.** Ami a saját tárolónkba kerül, az a `yume-local` adapteren át
  jön vissza — a feltöltés külön munka (`scripts/upload-video.ts`).
