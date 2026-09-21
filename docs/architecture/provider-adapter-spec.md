# YUME Provider Adapter Implementation Specification

**Verzió:** a `apps/api/src/modules/providers/` jelenlegi állapota.
**Igazságforrás:** a kód. Ahol ez a dokumentum és a kód eltér, a kód a helyes.

Ez a dokumentum azt írja le, hogyan kell egy új forrásszolgáltatót a YUME-ba
integrálni. Nem tervez új architektúrát: a Provider Core kész, és a
`/v1/anime/episodes/:id/sources` végponton keresztül a lejátszót is ez
szolgálja ki.

---

## 0. Amit a szerződés NEM tartalmaz

Ezt előre kimondom, mert több gyakori feltételezés nem igaz a jelenlegi
kódra, és egy adapter, ami ezekre épít, nem fog lefordulni.

| feltételezés | a valóság |
|---|---|
| `resolveSources()` metódus | a metódus neve **`resolve(ref)`** |
| külön `referer` mező | **nincs**. A referer egy fejléc a `headers` között |
| külön `origin` mező | **nincs**. Ugyanígy fejléc, ha kell |
| `ProviderCapabilities` modell | **nem létezik**. Nincs képességdeklaráció |
| `healthCheck()` az adapteren | **nem létezik**. Az egészséget a `resolve()` kimenetele adja |
| `label` a feliratsávon | **nincs**. A feliratnak `language`, `kind`, `format`, `url`, `headers`, `isDefault` mezője van |
| `season` / `special` / `absolute` az `EpisodeRef`-ben | **nincs**. Egyetlen `number` van |
| MAL / Kitsu / AniDB azonosító az `EpisodeRef`-ben | **nincs**. Csak `anilistId`. A többi az `anime_mappings` táblában él, de nem megy át az adapterhez |

**Egy pontosítás a változatokról.** Két különböző `variant` mező van, és a
kettő szabálya ellentétes:

* `ProviderSource.variant` — **kötelező**. Minden forrásnak deklarálnia kell,
  hogy `sub`, `dub` vagy `raw`. Nincs „nem deklarál változatot" állapot.
* `EpisodeRef.variant` — **opcionális**. A hiánya azt jelenti, hogy
  **bármelyik** változat jó, nem azt, hogy `sub`.

---

## 1. Az adapter szerkezete

### A szerződés

```ts
export interface AnimeProvider {
  readonly id: string                 // gépi azonosító, ez megy a naplóba
  readonly label: string              // emberi név az adminfelületre
  readonly defaultPriority?: number   // opcionális; alapértelmezés 100

  search (query: string, hint?: { anilistId?: number | null, year?: number | null }): Promise<ProviderMatch[]>
  episodes (matchId: string): Promise<ProviderEpisode[]>
  resolve (ref: EpisodeRef): Promise<ProviderResult>
}
```

**Mind a három metódus kötelező.** Egyetlen opcionális mező van:
`defaultPriority`.

### Konstruktor és beállítás

Nincs konstruktor: az adapter egy **objektum-literál**, nem osztály. A
`providers` táblában van egy `config jsonb` oszlop, ami a
`RegisteredProvider.config`-ban jelenik meg — de a `resolve()` ezt **nem
kapja meg**. Ha egy adapternek beállítás kell, azt ma a környezetből olvassa.

> **Hiányként jelölve:** a `config` jsonb el van tárolva és lekérdezhető, de a
> feloldási úton nincs átadva. Ez a Core mai állapota; nem változtattam rajta.

**Titok soha nem kerül a `config`-ba** — az adminfelület megjeleníti.

### Életciklus

Nincs `init`, nincs `dispose`. Az adapter modulszinten létezik, a
`registerBuiltInProviders()` beteszi a regiszterbe, és onnantól a `resolve.ts`
hívja. Állapotot modulszintű változóban tarthat (pl. saját gyorsítótár), de a
példány **megosztott**: több párhuzamos kérés ugyanazt az objektumot használja.

### Minimális váz

```ts
import { noResult } from '../types.ts'
import type { AnimeProvider, EpisodeRef, ProviderResult } from '../types.ts'

export const peldaProvider: AnimeProvider = {
  id: 'pelda',
  label: 'Példa szolgáltató',
  defaultPriority: 900,

  async search (query, hint) { return [] },
  async episodes (matchId) { return [] },
  async resolve (ref: EpisodeRef): Promise<ProviderResult> { return noResult() }
}
```

---

## 2. Keresés — `search()`

**Bemenet:** `query: string`, és opcionálisan `hint: { anilistId, year }`.

**Kimenet:** `ProviderMatch[]`

```ts
interface ProviderMatch {
  id: string                    // a SZOLGÁLTATÓ saját azonosítója
  title: string
  anilistId?: number | null
  year?: number | null
  episodeCount?: number | null
}
```

* Az `id` a szolgáltató sajátja. A YUME nem értelmezi, csak visszaadja.
* Ha a `hint.anilistId` megvan, **azon keress**, és a címet ne nézd: két évad
  címe gyakran majdnem azonos.
* **Alternatív címek:** a `search()` egyetlen sztringet kap. A szinonimák a
  `resolve()` `EpisodeRef.synonyms` mezőjében érkeznek — ott érdemes
  végigpróbálni őket.
* **Nincs találat → `[]`.** Ez nem hiba.
* **Nem tudtad megkérdezni → dobj kivételt.**

---

## 3. Párosítás

Az adapter **ezt** kapja, és semmi mást:

```ts
interface EpisodeRef {
  episodeId?: string        // a YUME SAJÁT epizódazonosítója
  anilistId: number | null
  title: string
  synonyms?: string[]
  year?: number | null
  number: number
  variant?: SourceVariant
}
```

| azonosító | elérhető? |
|---|---|
| YUME anime ID | **nem** — csak az epizódé, `episodeId` |
| YUME episode ID | **igen**, `episodeId` |
| AniList | **igen**, `anilistId` (lehet `null`) |
| MAL | **nem megy át** (az `anime_mappings.mal_id` létezik, de nincs átadva) |
| Kitsu | **nem megy át** (`anime_mappings.kitsu_id`) |
| AniDB | **nem megy át** (`anime_mappings.anidb_id`) |
| szolgáltató-specifikus | a te dolgod: a `search()`/`episodes()` adja |

**Az `episodeId` a HÁZON BELÜLI adaptereknek szól.** Külső szolgáltató
figyelmen kívül hagyja — ő a mi uuid-nkkel nem tud mit kezdeni. A
`adapters/local.ts` ezt használja, mert ő maga a katalógus.

**Ajánlott párosítási sorrend:** `anilistId` → `title` → `synonyms`.

> **Hiányként jelölve:** a MAL/Kitsu/AniDB azonosítók megvannak az
> adatbázisban, de a `providerRef` nem viszi át őket. Ha egy adapternek
> kellenének, a Core-t kell bővíteni — ezt most nem tettem meg.

---

## 4. Epizód-feloldás

Az `EpisodeRef.number` **egyetlen szám**. A jelenlegi szerződésben:

* **nincs** `season` mező,
* **nincs** `special` / `OVA` / `movie` jelölés,
* **nincs** abszolút vs. évadon belüli számozás megkülönböztetés.

A YUME adatmodelljében az `episodes.number` `numeric`, tehát a `12.5`-szerű
törtszám (különkiadás) tárolható, és az `EpisodeRef.number` ezt hordozza —
de **nincs típus, ami megmondaná, hogy ez különkiadás**.

**Ha a szolgáltató epizód-azonosítója más, mint a miénk** — és külső
szolgáltatónál ez a normális eset —, akkor:

1. a `resolve()` a `number`-t és a cím-horgonyokat kapja;
2. az adapter a saját katalógusában megkeresi a címet;
3. onnan a saját epizód-azonosítóját;
4. és azzal oldja fel a forrást.

Ez a fordítás **teljesen az adapteren belül** történik. A YUME nem tárolja a
szolgáltató epizód-azonosítóit.

> **Hiányként jelölve:** nincs a Core-ban tartós párosítás-tár (anime ↔
> szolgáltatói azonosító). Minden feloldás újrapárosít, a `resolve.ts`
> gyorsítótárán belül. Egy lassú párosítású szolgáltatónál ez pazarlás.

---

## 5. Forrás-feloldás

Ez a legfontosabb rész.

```
resolveEpisode(ref)                       ← resolve.ts
   │
   ├─ gyorsítótár-találat? → vissza
   ├─ registry.ranked()  → bekapcsolt szolgáltatók, prioritás szerint
   │
   └─ minden szolgáltatóra, sorban:
        ├─ health.usable(id)? nem → 'skipped'
        ├─ provider.resolve(ref)  8 másodperces korláttal
        │    ├─ sources.length > 0 → 'ok'    → NYER, a lánc megáll
        │    ├─ sources.length = 0 → 'empty' → megy tovább (siker!)
        │    └─ kivétel            → 'error' / 'timeout' → megy tovább
        └─ …
```

### `ProviderSource` — minden mező

```ts
interface ProviderSource {
  kind: SourceKind              // KÖTELEZŐ: 'hls' | 'dash' | 'mp4'
  url: string                   // KÖTELEZŐ
  label?: string | null         // a forrás NEVE, amit a néző lát
  quality?: string | null       // '1080p', 'auto' — szabad szöveg
  language?: string | null      // a HANG nyelve (BCP-47), nem a feliraté
  variant: SourceVariant        // KÖTELEZŐ: 'sub' | 'dub' | 'raw'
  headers?: Record<string, string>
  expiresAt?: Date | null
}
```

| mező | jelentés |
|---|---|
| `kind` | melyik motort indítsa a lejátszó |
| `url` | a lejátszható cím |
| `label` | **a forrás neve**, nem a szolgáltatóé. Egy szolgáltató több kiszolgálót kínálhat; a néző ezek közül választ. Ha nincs, a végpont a szolgáltató nevét írja ide |
| `quality` | emberi jelölés; a YUME nem értelmezi |
| `language` | a **hangsáv** nyelve |
| `variant` | `sub` = eredeti hang + felirat, `dub` = szinkron, `raw` = se felirat, se szinkron |
| `headers` | amit a lejátszónak is el kell küldenie |
| `expiresAt` | meddig érvényes ez a cím |

**Nincs `provider` mező a forráson.** A feloldó szolgáltató a `Resolution`
szintjén van (`resolution.provider`), és a végpont `resolved_by` néven adja ki.

### Mi megy ki a végponton

A `/v1/anime/episodes/:id/sources` válasza soronként:

```
id           `<szolgáltató>:<index>`  — szintetikus, nincs adatbázis-sora
kind         a SourceKind
ref          a url
title        mindig null
provider     source.label ?? resolution.provider   ← a NÉV, amit a néző lát
resolved_by  resolution.provider                   ← a lánc adata
resolution   source.quality
language     source.language
variant      source.variant
is_batch     mindig false
size_bytes   mindig null
seeders      mindig null
headers      source.headers, vagy null ha üres
```

És a válasz szintjén: `subtitles`, `provider`, `cached`, `attempts`.

---

## 6. Változatok

| érték | jelentése |
|---|---|
| `'sub'` | eredeti (jellemzően japán) hang, felirattal nézhető |
| `'dub'` | szinkron |
| `'raw'` | se felirat, se szinkron |

`ProviderSource.variant` **kötelező**. Nincs „ismeretlen" érték: ha nem tudod,
`'raw'` a becsületes válasz — az azt mondja, hogy nincs deklarált felirat vagy
szinkron, nem azt, hogy nem tudjuk.

Helyes példák:

```ts
// japán hang, angol felirat külön sávban
{ kind: 'hls', url: '…', language: 'ja', variant: 'sub', label: '1. kiszolgáló' }

// angol szinkron
{ kind: 'hls', url: '…', language: 'en', variant: 'dub', label: 'Szinkron' }

// nyers japán, felirat nélkül
{ kind: 'mp4', url: '…', language: 'ja', variant: 'raw', label: 'Nyers' }
```

A **kérés** oldalán viszont a hiány mindent jelent:

```ts
resolveEpisode({ anilistId: 1, title: '…', number: 1 })                   // MINDEN változat
resolveEpisode({ anilistId: 1, title: '…', number: 1, variant: 'dub' })   // csak szinkron
```

A gyorsítótár kulcsa `anilistId|number|variant ?? 'any'` — a feliratos és a
szinkronos kérés **nem keveredik**.

---

## 7. Feliratok

```ts
interface ProviderSubtitle {
  language: string                    // KÖTELEZŐ, BCP-47
  kind: 'subtitles' | 'captions'      // KÖTELEZŐ
  format: 'vtt' | 'ass' | 'srt'       // KÖTELEZŐ
  url: string                         // KÖTELEZŐ
  headers?: Record<string, string>
  isDefault?: boolean
}
```

**Nincs `label` mező.** Két azonos nyelvű sávot ma semmi nem különböztet meg a
modellben a formátumán és a címén kívül.

**Több angol sáv: MINDEGYIKET tartsd meg.** A szerződés nem dedupliál, és a
szűrés nem az adapter dolga — ha kettőből egyet eldobsz, azt veheted el,
amelyik jobb. Az `isDefault` az, amivel javaslatot tehetsz.

---

## 8. Szállítási formák

A `SourceKind` **három értéke létezik**, és nincs több:

| érték | mikor |
|---|---|
| `'hls'` | `.m3u8` lejátszólista, adaptív sávszélesség |
| `'dash'` | `.mpd` |
| `'mp4'` | közvetlen, progresszív fájl |

A `adapters/local.ts` így dönt a tárolt sorokból: `kind === 'hls'` vagy
`.m3u8` → HLS; `kind === 'dash'` vagy `.mpd` → DASH; `kind === 'http'` vagy
`'mp4'` → MP4; **minden más kimarad** (egy torrent-hivatkozás a böngészőben
nem forrás).

---

## 9. Fejlécek

Egyetlen mező van: `headers?: Record<string, string>`.

```ts
headers: {
  Referer: 'https://pelda.invalid/',
  'User-Agent': 'YUME/1.0'
}
```

Nincs külön `referer` és nincs `origin` mező — mindkettő fejléc.

**A fejlécek eljutnak a böngészőig.** A végpont kiadja őket a válaszban, tehát
**nem titkosak**. Ne tegyél közéjük olyat, amit egy néző nem láthat: API-kulcs,
munkamenet-süti, aláíró titok ide nem való.

**Nincs proxy a Core-ban.** A szegmenseket a böngésző kéri közvetlenül. Ha egy
forrás CORS miatt nem játszható, azon ez a réteg nem segít.

---

## 10. Lejárat

`expiresAt?: Date | null` — `Date` objektum, nem sztring, nem ezredmásodperc.

* **Akkor add meg, ha a cím tényleg lejár** (aláírt URL, token).
* A `resolve.ts` a gyorsítótár élettartamát a **legkorábbi** `expiresAt`-ből
  számolja, a jelen időhöz képest. Ha egyik forrás sem mond lejáratot, az
  alapértelmezés **5 perc** (`CACHE_MS`).
* Múltbeli vagy érvénytelen `expiresAt` kimarad a számításból.
* Lejárat után a bejegyzés törlődik, és a következő kérés **újra feloldat**.

**Nincs automatikus frissítés.** A YUME nem hosszabbít meg egy lejárt címet;
újra megkérdezi a szolgáltatót.

---

## 11. Üres eredmény kontra hiba

Ez a szerződés egyetlen szigorú tiltása.

| helyzet | mit adj vissza | mit jelent a Core-nak |
|---|---|---|
| megkérdeztem, és nincs | `noResult()` / `{ sources: [], subtitles: [] }` | **siker**, `'empty'`, megy tovább a láncon |
| nem tudtam megkérdezni | **dobj kivételt** | **hiba**, `'error'`, a megszakító számolja |

**Helytelen:**

```ts
async resolve (ref) {
  try {
    const res = await fetch(url)
    return this.parse(await res.json())
  } catch {
    return noResult()          // ← A HIBA ELNYELVE
  }
}
```

Ettől a megszakító **sosem nyit ki**: minden kérés sikeresnek látszik, és egy
halott szolgáltató örökre a lánc elején marad, nyolc másodpercet lopva minden
lejátszásindításból.

**Helyes:**

```ts
async resolve (ref) {
  const res = await fetch(url)                       // hálózati hiba → kivétel
  if (!res.ok) throw new Error(`HTTP ${res.status}`) // a szolgáltató hibája
  const adat = await res.json()
  const talalat = this.match(adat, ref)
  if (!talalat) return noResult()                    // nincs nála — nem hiba
  return { sources: this.toSources(talalat), subtitles: [] }
}
```

---

## 12. Egészség

**Nincs `healthCheck()` metódus.** Az egészség a `resolve()` kimeneteléből
következik — nincs külön szonda, amit fenn kellene tartani.

| esemény | hatás |
|---|---|
| `sources.length > 0` | siker; a hibasorozat nullázódik |
| `sources.length === 0` | **siker**; az üres válasz nem hiba |
| kivétel | hiba; a sorozat nő |
| 8 mp-en túl nincs válasz | `'timeout'`, hibának számít |

**A megszakító** (`health.ts`):

* `TRIP_AFTER = 3` — három **egymás utáni** hiba után kizár;
* `BASE_COOLDOWN_MS = 30_000` — az első türelmi idő;
* nyitásonként **duplázódik**, `MAX_COOLDOWN_MS = 10 perc`-ig;
* a türelmi idő után `'half-open'`: **egy** kérés átmegy. Sikerül → zár;
  nem → újranyit, hosszabb idővel.

Állapotok: `'up'` | `'down'` | `'half-open'`. Az állapot memóriában él;
**állapotváltozáskor** a `provider_events` táblába kerül egy sor.

**Be/kikapcsolás:** a `providers` táblában, az adminfelületről. Kikapcsolt
szolgáltatót a lánc **meg sem kérdez** — az `attempts`-ben sem jelenik meg. A
sor **hiánya nem kikapcsolás**: egy új adapter alapból be van kapcsolva.

---

## 13. Hibakategóriák

A Core **négy kimenetelt** ismer (`Attempt.outcome`), és semmi mást:

| kimenetel | mikor |
|---|---|
| `'ok'` | legalább egy forrás |
| `'empty'` | nulla forrás, kivétel nélkül |
| `'error'` | bármilyen kivétel |
| `'timeout'` | 8 mp-en belül nem válaszolt |
| `'skipped'` | a megszakító kizárta, vagy ki van kapcsolva |

Amit a kérdésed felsorolt, és **nincs külön kezelve**: hálózati hiba,
érvénytelen válasz, „nincs anime", „nincs epizód", lejárt forrás, átmeneti
kontra végleges hiba. A Core szemszögéből mind vagy `'error'`, vagy
`'empty'`.

A megkülönböztetés egyetlen helye a kivétel **üzenete**, ami az
`Attempt.detail`-be kerül (200 karakterig), és onnan a `provider_events`
táblába. Írj beszédes üzenetet — ez lesz, amit egy üzemeltető lát.

> **Hiányként jelölve:** nincs „átmeneti kontra végleges hiba"
> megkülönböztetés. Egy 404 és egy 503 ugyanúgy számít a megszakítónál.

---

## 14. Képességek

**`ProviderCapabilities` nem létezik.** Nincs képességdeklaráció, és nem is
kell: a Core kipróbálja az adaptert, és a válaszból tudja meg, mit tud.

Ami közel áll hozzá: a `providers.config jsonb` — de azt a `resolve()` nem
kapja meg (lásd 1. pont).

---

## 15. Regisztráció

```
adapter megírása
   ↓  adapters/<nev>.ts
felvétel a BUILT_IN listába
   ↓  providers/index.ts
registry.register()          ← registerBuiltInProviders(), az app.ts-ből
   ↓
providers tábla              ← a sor az első kapcsolásnál jön létre
   ↓
adminfelület                 ← Katalógus › Forrásszolgáltatók
   ↓
health + resolve             ← automatikusan
```

**Módosítandó fájlok egy új adapterhez — pontosan kettő:**

1. `apps/api/src/modules/providers/adapters/<nev>.ts` — új fájl
2. `apps/api/src/modules/providers/index.ts` — import és a `BUILT_IN` tömb

Semmi más. Nincs migráció, nincs route-módosítás, nincs kliensváltozás. Az
adminfelület magától megmutatja.

**Eltávolítás:** a mindennapi művelet a **kikapcsolás** az adminfelületen. A
kódból kivenni csak akkor kell, ha végleg megszűnt — a `providers` sor
megmaradhat, és a beállítás visszajön, ha az adapter visszakerül.

---

## 16. Tesztelési szerződés

A `test/provider-core.test.ts` 16 állítása a **Core-ra** vonatkozik, hamis
adapterekkel. Egy új adapter akkor kész, ha:

| ellenőrzés | hol |
|---|---|
| a szerződés alakja megvan | saját teszt |
| találat nélkül `[]`, hibára kivétel | saját teszt |
| a láncon át feloldódik | saját teszt |
| minden forrás deklarál `variant`-ot | saját teszt |
| a `kind` a három ismert egyike | saját teszt |
| a feliratok formátuma a három ismert egyike | saját teszt |
| az `expiresAt` átmegy a resolveren | saját teszt |
| a lánc, a megszakító, a gyorsítótár, a kapcsoló | **a Core tesztje fedi** |
| TypeScript | `npx tsc -p apps/api --noEmit` |
| lint | `npm run lint` |

A `test/provider-mock-adapter.test.ts` **pontosan ezt a listát** járja végig a
minta-adapteren — ez a másolható kiindulópont.

> **Hiányként jelölve, nem javítva:** nincs egyetlen „futtasd le minden
> regisztrált adapterre" szerződésteszt. Minden adapter a sajátját hozza. Egy
> ilyen közös futtató hasznos lenne; a Core-hoz most nem nyúltam.

---

## 17. A minta-adapter

`apps/api/src/modules/providers/adapters/mock.ts`

**NINCS a `BUILT_IN` listában**, és ezt egy teszt őrzi: `example.invalid`
címeket ad vissza, tehát éles láncban működő forrásnak látszó,
lejátszhatatlan címeket szolgálna ki.

Bemutatja: keresés (AniList-horgonnyal és cím szerint), epizódlista, feloldás
HLS + MP4 forrással, `sub` és `dub` változat, három feliratsáv (kettő angol),
`expiresAt` egy aláírt címen, fejlécek, és az üres eredmény kontra kivétel
különbsége.

Bekapcsolása fejlesztéshez: vedd fel a `BUILT_IN` listába a
`providers/index.ts`-ben. **Éles telepítésre ne.**

---

## 18. Integrációs ellenőrzőlista

* [ ] Adapter létrehozva (`adapters/<nev>.ts`)
* [ ] `AnimeProvider` implementálva (`id`, `label`, `search`, `episodes`, `resolve`)
* [ ] ~~Capabilities definiálva~~ — **nincs ilyen a jelenlegi Core-ban**
* [ ] Párosítás: `anilistId` → `title` → `synonyms` sorrendben
* [ ] Epizód-párosítás: a szolgáltató saját azonosítójára fordítva
* [ ] Forrás-feloldás: minden forrásnak `kind`, `url`, `variant`, és lehetőleg `label`
* [ ] Feliratok: minden sáv megtartva, `language` + `kind` + `format` + `url`
* [ ] `sub` / `dub` / `raw` helyesen deklarálva
* [ ] `expiresAt` megadva, ha a cím aláírt
* [ ] `headers` megadva, ha a kiszolgáló megköveteli — **titok nélkül**
* [ ] Hibakezelés: `noResult()` a hiányra, **kivétel** a hibára
* [ ] ~~Health check megírva~~ — **a Core a `resolve()`-ból következteti**
* [ ] Felvéve a `BUILT_IN` listába
* [ ] `npx tsc -p apps/api --noEmit`
* [ ] `npm run lint`
* [ ] Saját szerződésteszt zöld
* [ ] Éles feloldás kipróbálva egy valódi epizódon

---

## 19. Sablon

```ts
// <SZOLGÁLTATÓ NEVE> adapter.
//
// Párosítás: <mi alapján találod meg a címet a szolgáltatónál>
// Epizódok:  <hogyan fordítod a részszámot a szolgáltató azonosítójára>
// Források:  <milyen formákat ad: HLS / DASH / MP4>
// Feliratok: <milyen nyelvek, milyen formátum>

import { noResult } from '../types.ts'

import type {
  AnimeProvider, EpisodeRef, ProviderEpisode, ProviderMatch,
  ProviderResult, ProviderSource, ProviderSubtitle
} from '../types.ts'

export const ujProvider: AnimeProvider = {
  id: 'uj-szolgaltato',
  label: 'Új szolgáltató',
  // Magas szám = a lánc VÉGÉN. Hagyd itt, amíg nem bízol benne.
  defaultPriority: 900,

  async search (query, hint): Promise<ProviderMatch[]> {
    // Ha van AniList-azonosító, azon keress — a cím kétértelmű.
    // Nincs találat → [] (nem hiba). Nem tudtad megkérdezni → dobj.
    return []
  },

  async episodes (matchId): Promise<ProviderEpisode[]> {
    // Az `id` a SZOLGÁLTATÓ azonosítója. Ismeretlen `matchId` → kivétel.
    return []
  },

  async resolve (ref: EpisodeRef): Promise<ProviderResult> {
    // 1. párosítás: ref.anilistId → ref.title → ref.synonyms
    //    (az `episodeId` a mi azonosítónk — külső szolgáltatónak nem mond semmit)
    // 2. a szolgáltató epizód-azonosítója a `ref.number`-ből
    // 3. a lejátszható címek lekérése
    //
    // A HÁLÓZATI HIBÁT NE KAPD EL: hadd menjen tovább kivételként.
    // Ami nincs meg → `noResult()`.

    const kert = ref.variant ?? null   // null = MINDEN változat

    const sources: ProviderSource[] = [
      // {
      //   kind: 'hls',                       // 'hls' | 'dash' | 'mp4'
      //   url: '…',
      //   label: 'Név, amit a néző lát',     // a FORRÁSÉ, nem a szolgáltatóé
      //   quality: '1080p',
      //   language: 'ja',                    // a HANG nyelve
      //   variant: 'sub',                    // KÖTELEZŐ
      //   headers: { Referer: '…' },         // titok NEM mehet bele
      //   expiresAt: new Date(Date.now() + 10 * 60_000)
      // }
    ]

    if (!sources.length) return noResult()

    const subtitles: ProviderSubtitle[] = [
      // { language: 'en', kind: 'subtitles', format: 'vtt', url: '…', isDefault: true }
    ]

    return { sources, subtitles }
  }
}
```

**Regisztráció** (`providers/index.ts`):

```ts
import { ujProvider } from './adapters/uj-szolgaltato.ts'

const BUILT_IN = [localProvider, ujProvider]
```
