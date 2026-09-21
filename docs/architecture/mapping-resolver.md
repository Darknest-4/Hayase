# Külső azonosítók feloldása

**Igazságforrás:** a kód — `apps/api/src/modules/providers/mapping/`.

---

## Mire való

Egy szolgáltató azon az azonosítón talál meg egy címet, amit ő ismer: van, aki
AniList szerint katalogizál, van, aki MAL vagy AniDB szerint. A YUME
`anime_mappings` táblája mind a négyet tárolja — **de csak azt, amit valaha
beírtunk.**

Ami hiányzott, azt egy adapternek cím szerint kellett pótolnia, és ott téved a
legnagyobbat. Mérve az `arm.haglund.dev`-en:

| Shingeki no Kyojin | AniList | AniDB | Kitsu |
|---|---|---|---|
| 1. évad | 16498 | 9541 | 7442 |
| 3. évad | 99147 | **13241** | **13569** |

A címük majdnem azonos, az azonosítójuk nem. Ez a réteg azért van, hogy egy
adapternek soha ne kelljen a címre hagyatkoznia.

---

## A folyamat

```
providerRef(episodeId)
      ↓
anime_mappings  ── megvan mind a négy? ──→ kész, NULLA külső hívás
      ↓ nem
van legalább egy azonosító?  ── nincs ──→ kész, nincs mire kérdezni
      ↓ van
gyorsítótár / épp futó kérés  ── találat ──→ kész
      ↓
leképezők, sorban:  arm → malsync
      ↓
összefésülés: A MEGLÉVŐ NYER
      ↓
visszaírás az anime_mappings-be (csak a hiányzók)
      ↓
EpisodeRef → adapter
```

---

## A leképezők

| id | upstream | mit ad | megjegyzés |
|---|---|---|---|
| `arm` | `arm.haglund.dev/api/v2/ids` | mind a négy, egy kérésre | elsődleges; mérve 45–135 ms |
| `malsync` | `api.malsync.moe/mal/anime/<id>` | AniDB — **AniList-et nem** | másodlagos; csak MAL-azonosítóval kérdezhető |

**`api.anify.tv` kimaradt:** a referencia-repó használja, de a mérés szerint
nem érhető el (`fetch failed`, DNS). Nem vettem fel olyan forrást, amiről nem
tudom bizonyítani, hogy él.

A réteg **forrás-agnosztikus**: egy új leképező egy `MappingUpstream`
megvalósítása és egy sor az `UPSTREAMS` tömbben.

### A 4xx nem hiba

Az `arm` ismeretlen vagy tartományon kívüli azonosítóra **400**-at ad
(`FST_ERR_VALIDATION`, mérve), a `malsync` **404**-et. Egyik sem azt jelenti,
hogy „nem tudtam megkérdezni" — azt, hogy „megkérdeztem, és nem ismeri". Ha
hibának vennénk, egy ismeretlen cím kizárná az egész leképezőt.

---

## Gyorsítótár és összevonás

| viselkedés | érték | miért |
|---|---|---|
| teljes eredmény | **6 óra** | egy AniList-azonosító nem változik |
| részleges / üres | **10 perc** | a leképező még nem tud az új címről, de holnap tudhat |
| időkorlát leképezőnként | **6 mp** | egy lassú szolgáltatás ne várakoztassa a lejátszást |

**Húsz kérés helyett egy.** Ha húsz lejátszásindítás ugyanarra a címre fut,
egyetlen közös kérés megy ki, és mind a húsz azt várja meg. Enélkül egy
népszerű cím megjelenése húsz egyforma kérést küldene egy ingyenes, önkéntes
szolgáltatásnak. Teszttel igazolva.

---

## Beírás

```sql
INSERT INTO anime_mappings (...) VALUES (...)
ON CONFLICT (anime_id) DO UPDATE
   SET anilist_id = COALESCE(anime_mappings.anilist_id, EXCLUDED.anilist_id), …
```

A `COALESCE` iránya a lényeg: **ami a sorban már van, az marad.** A leképezés
kiegészít, nem javít — amit a táblánk tud, azt valaki beírta vagy egy
metaadat-futás töltötte fel, és egy külső szolgáltatás tévedése nem írhatja
felül.

### Az egyedi megszorítás

Az `anilist_id`, `mal_id` és `anidb_id` oszlopon **UNIQUE** áll. Ha egy
leképező olyan azonosítót ad, ami már **más** címhez tartozik — téves
leképezés, vagy két YUME-sor ugyanarról a műről —, az írás megsértené a
megszorítást.

Ilyenkor **nem hasalunk el**: a kiegészítés kényelem, nem az a dolga, hogy egy
lejátszásindítást megbuktasson. A hibát naplózzuk, és a memóriában megtudott
azonosítókkal megyünk tovább. Teszttel igazolva.

---

## Amit egy adapter ebből lát

Semmit. Az `EpisodeRef` egyszerűen kitöltöttebb lesz:

```ts
{ episodeId, anilistId, malId, kitsuId, anidbId, title, synonyms, year, number, variant }
```

**Egy adapter ne implementáljon saját leképezést.** Ha egy azonosító `null`,
az azt jelenti, hogy ezt a címet egyik forrás sem ismeri — nem azt, hogy nem
próbáltuk.

---

## Tesztek

| fájl | mit mér | hálózat |
|---|---|---|
| `test/mapping-resolver.test.ts` | a viselkedés: mikor kérdezünk, hibák, gyorsítótár, összevonás, beírás | hamis |
| `test/mapping-live.test.ts` | hogy az endpointok MA is élnek, és az évadok külön azonosítót kapnak | **valódi** |

Az élő teszt `YUME_LIVE=1` nélkül tisztán kihagyódik: külső, ingyenes
szolgáltatásoktól függ, és nem buktathat el egy telepítést.

---

## Mit NEM old meg

* **Nem keres cím szerint.** Horgony (legalább egy azonosító) nélkül nem
  kérdez. Cím szerinti keresés épp az a tévedés, amit el akarunk kerülni.
* **Nem képez le epizódszinten.** Az évadok szétválnak, de hogy egy
  szolgáltató 25. része a mi 25. részünk-e, az az adapter dolga.
* **Nem javít rossz adatot.** Ha a táblában téves azonosító áll, az marad.
