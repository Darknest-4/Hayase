# YUME Player 2.0 — architektúra

**2. fázis.** Az 1. fázis auditja (`PLAYER_REWRITE_AUDIT.md`) a kiindulás.

---

## A vezérelv

Egyetlen mondat, amiből minden más következik:

> **A logika nem tud a DOM-ról. Az UI nem tud a videóelemről.**

A mai `watch.js`-ben a hangerő-csúszka közvetlenül írja a `video.volume`-ot, a
lejátszási állapot a `shell.classList`-ben él, és a közös nézés a DOM-ot
manipulálja. Ezért nem lehet sem tesztelni, sem bővíteni.

A 2.0-ban a `core`, az `engine` és a `playback` réteg **egyetlen DOM-hívást sem
tartalmaz**. Ez nem esztétika: ettől lesz `node --test`-tel, böngésző nélkül,
ezredmásodpercek alatt futtatható az, ami eddig csak kézzel volt kipróbálható.

---

## A rétegek

```
                         ┌──────────────┐
                         │   watch.js   │   az oldal: elrendezés, epizódlista
                         │  (vékony)    │   — csak összerakja a lejátszót
                         └──────┬───────┘
                                │ createPlayer({ video, sources, … })
                ┌───────────────▼────────────────┐
                │            CORE                │   ⟵ DOM-mentes
                │  state · events · errors ·     │
                │  lifecycle                     │
                └───┬────────────┬───────────┬───┘
                    │            │           │
        ┌───────────▼──┐  ┌──────▼──────┐  ┌─▼─────────────┐
        │   ENGINE     │  │  PLAYBACK   │  │      UI       │
        │  ⟵ DOM-mentes│  │ ⟵ DOM-mentes│  │ ⟵ CSAK itt DOM│
        │              │  │             │  │               │
        │ source-mgr   │  │ play/pause  │  │ control-bar   │
        │ ranking      │  │ seek        │  │ progress      │
        │ health       │  │ rate/volume │  │ menus         │
        │ fallback     │  │ resume      │  │ loading       │
        │ engines:     │  │ progress    │  │ error         │
        │  native/hls  │  │             │  │ overlays      │
        └──────────────┘  └─────────────┘  └───────────────┘
                    │            │           │
                    └────────────┼───────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
       PREFERENCES           FLAGS            TELEMETRY
       (meglévő Prefs)   (meglévő featureOn)  (meglévő analytics)
```

**A `watch.js` marad**, de vékony lesz: az oldal elrendezése, az epizódlista és
a lejátszó példányosítása. A 316 soros `mountPlayer` eltűnik.

---

## Adatáramlás

Egyirányú, és ez a lényeg:

```
  felhasználói szándék          állapotváltozás           újrarajzolás
  ───────────────────           ───────────────           ────────────
  kattintás a Play-re
        │
        ▼
  playback.togglePlay()  ──▶  state.set({playback:{playing:true}})
        │                            │
        ▼                            ▼
  video.play()                 emit(PLAY) ──▶ a feliratkozott UI-elemek
                                                újrarajzolják magukat
```

Az UI **sosem** olvassa a `video` elemet, és **sosem** ír bele. Szándékot
jelez, állapotot olvas. Ettől lesz a közös nézés, a billentyűzet, a
mozdulatok és a távoli vezérlés ugyanannak az útnak a különböző bemenetei —
nem három párhuzamos implementáció.

---

## Modulok

### `core/`

| modul | felelősség | DOM |
|---|---|---|
| `player-events.js` | eseménynevek + busz (`on`/`off`/`emit`) | nincs |
| `player-state.js` | az egyetlen állapotfa, `get`/`patch`/`subscribe` | nincs |
| `player-errors.js` | hibataxonómia, `PlayerError`, felhasználói szöveg | nincs |
| `player.js` | életciklus: `createPlayer` → `destroy`, takarítás | nincs |

### `engine/`

| modul | felelősség | DOM |
|---|---|---|
| `source-manager.js` | jelöltek, állapotgép, visszaesés, újrapróbálás | nincs |
| `source-ranking.js` | normalizálás, pontozás, sorrend | nincs |
| `engines.js` | motorregiszter: melyik forrást ki tudja lejátszani | nincs* |

\* az `attach` kap egy videóelemet, de az egy **paraméter**, nem keresés.

### `playback/`

| modul | felelősség |
|---|---|
| `playback-controller.js` | play/pause/seek/rate/volume — a videóelem egyetlen gazdája |
| `resume.js` | folytatási pozíció |
| `progress.js` | haladás és mért nézési idő |

### `ui/`

Itt és **csak itt** van DOM. Minden UI-modul ugyanazt a szerződést követi:

```js
mount(container, player) → { destroy() }
```

Feliratkozik az állapotra, kirajzol, szándékot jelez. A `destroy()` **minden**
figyelőt és időzítőt elbont — a 29. pont szivárgás-tilalma ezen múlik.

### `preferences/`, `flags/`

Nem új rendszerek: **adapterek** a meglévő `Prefs` és `featureOn` fölé, a
lejátszó-specifikus kulcsokkal és alapértékekkel.

---

## Az állapotfa

Egyetlen forrás, névterekre bontva. A brief 4. pontjának alakja, azzal a
különbséggel, hogy a `source` a forráskezelő állapotgépét is viseli:

```js
{
  status: 'idle' | 'initializing' | 'loading' | 'ready' | 'playing' | 'error' | 'destroyed',
  playback: { playing, currentTime, duration, buffered, volume, muted, rate, seeking },
  source:   { current, candidates: [{ id, state, failure }], type },
  quality:  { current, available, auto },
  subtitles:{ enabled, current, tracks },
  audio:    { current, tracks },
  episode:  { current, next, previous },
  ui:       { controlsVisible, fullscreen, pip, cinema, ambient, miniPlayer, loadingPhase },
  network:  { online },
  error:    null | { code, detail }
}
```

**Miért egy fa és nem modulonkénti állapot:** ma a „megy-e a videó" kérdésre
három hely tud válaszolni (`video.paused`, a `shell` osztálya, és a közös nézés
saját nyilvántartása), és eltérhetnek. Egy fánál nem tudnak.

---

## Hibataxonómia

A brief 30. pontja szerint, kóddal és **kétféle szöveggel**:

| kód | mikor | a felhasználó ezt látja |
|---|---|---|
| `NO_SOURCE` | nincs egyetlen jelölt sem | „Ehhez a részhez még nincs forrás." |
| `SOURCE_TIMEOUT` | a folyam nem indult el időben | „A forrás nem válaszolt." |
| `SOURCE_UNSUPPORTED` | a böngésző nem tudja a formátumot | „Ezt a formátumot a böngésződ nem játssza le." |
| `NETWORK_ERROR` | hálózati hiba | „Megszakadt a kapcsolat." |
| `MEDIA_ERROR` | dekódolási hiba | „A videó megsérült vagy nem olvasható." |
| `CORS_ERROR` | eredetközi tiltás | „A forrás nem engedélyezi a lejátszást innen." |
| `ABORTED` | megszakítva | (nincs üzenet — szándékos) |
| `DRM_ERROR` | másolásvédelem | „Ez a tartalom védett." |
| `SUBTITLE_ERROR` | a felirat nem tölthető | „A felirat nem töltődött be." |
| `UNKNOWN` | minden más | „Nem sikerült lejátszani." |

A fejlesztői részlet (`cause`, `detail`) **külön mezőben** utazik, és a
felhasználói felületre soha nem kerül ki. A 43. pont követelménye:
hívásverem, belső URL, token, adatbázis-információ nem jelenhet meg.

---

## Forrás-állapotgép

```
   unknown ──▶ checking ──▶ ready ──▶ playing
                  │                      │
                  ▼                      ▼
               failed ◀──────────────  failed
                  │
                  └──▶ disabled  (elfogyott az újrapróbálás)
```

Minden `failed` **strukturált okot** kap, nem szöveget:

```js
{ code: 'SOURCE_TIMEOUT', attempts: 2, at: 1789… }
```

Ebből lesz a telemetria, a visszaesési döntés és a felhasználói üzenet — három
külön dolog, egy adatból.

**Nincs végtelen újrapróbálás:** jelöltenként legfeljebb `maxAttempts`, és a
lista végigjárása után `NO_SOURCE`.

---

## Motorok

| motor | mikor | mivel |
|---|---|---|
| `native` | `direct`, `.mp4`/`.webm`, azonos eredetű út | `video.src` |
| `hls` | `.m3u8` | natív, ha a böngésző tudja; különben hls.js (lusta betöltés) |
| `dash` | `.mpd` | **csak natív támogatással** |

**A DASH-hoz szándékosan NEM adok könyvtárat.** A `dash.js` ~400 kB, és a
katalógusban jelenleg nulla DASH-forrás van. A 44. pont („ne használj felesleges
dependencyt") és a 45. pont szerint ez akkor kerül be, ha lesz mit lejátszani
vele — addig a lejátszó **megmondja az igazat**: ezt a formátumot ez a böngésző
nem tudja.

A `magnet:` elkülönítve marad: a lejátszó nem nyit torrentet, és ezt kiírja.

---

## Feature flagek

A meglévő `featureOn()` fölé, `player.` előtaggal. A flag **hiánya
bekapcsolt állapotot jelent** — ez a jelenlegi `featureOn` szerződése, és nem
írom felül: egy friss telepítésen minden működjön, ne minden legyen kikapcsolva.

A kapcsolható funkciók a 27. pont listája szerint. A **kikapcsolt funkció nem
jelenik meg a felületen** — nem szürkén, nem tiltva: nem létezik.

---

## Migráció

| | |
|---|---|
| **API** | változatlan — négy végpont, ugyanaz a szerződés |
| **Adatbázis** | változatlan — `video_sources`, `watch_progress`, `skip_segments`, `subtitle_tracks`, `audio_tracks` |
| **Beállítások** | bővül (`player.*`), a régi kulcsok érintetlenül |
| **CSS** | új `.yp-*` névtér a régi `.player-*` mellett |
| **Régi út** | **megmarad**, flag mögött, amíg az új nem bizonyít |

Az új lejátszó a `player.v2` flag mögött indul. A régi kód **nem törlődik**,
amíg az új élesben nem bizonyított — ez a 42. pont visszafelé kompatibilitási
követelménye.

---

## Amit ez az architektúra megold

| mai probléma | hogyan |
|---|---|
| 316 soros `mountPlayer` | funkciónként egy modul, `mount(container, player)` szerződéssel |
| állapot a DOM-ban | egyetlen állapotfa, feliratkozással |
| modulok egymás belsejét hívják | eseménybusz |
| „megy-e a videó" három helyen | egy helyen |
| szöveges hibák | kódolt taxonómia, kétféle szöveggel |
| nem tesztelhető | a logika DOM nélkül fut |
| szivárgó figyelők | minden modul `destroy()`-jal tartozik |
