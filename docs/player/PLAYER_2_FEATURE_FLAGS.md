# Player 2.0 — funkciókapcsolók

Huszonhárom kapcsoló, két rétegben: a **szerver** kapcsolótáblája dönti el,
mit enged a telepítés, a **néző** beállításai pedig azt, mit kér magának. A
kettő közül a szigorúbb nyer.

## A kiértékelés sorrendje

A `createFlagEvaluator()` négy kérdést tesz fel, ebben a sorrendben:

1. **Mag-e?** Ha `core: true`, a kapcsoló mindig be van kapcsolva. Két ilyen
   van, és mindkettő olyan, ami nélkül a lejátszó nem lejátszó:
   `player.controls` és `player.watch_progress`.
2. **A néző kikapcsolta?** Ha van hozzá beállítás, és az hamis, akkor nem.
3. **Tudja a készülék?** Egy `player.pip` kapcsoló egy olyan böngészőben, ami
   nem ismeri a kép a képben módot, hiába igaz.
4. **Engedi a telepítés?** A `featureOn` a szerver kapcsolótábláját kérdezi.

Ami az elsőn fennakad, azt a többi nem nézi meg. Ami bármelyiken elbukik, az
ki van kapcsolva.

## A kapcsolók

| kapcsoló | mag | mit jelent |
|---|---|---|
| `player.v2` | | Az új lejátszó. Kikapcsolva a régi út fut. |
| `player.controls` | **igen** | Vezérlősáv. |
| `player.quality` | | Minőségválasztó. |
| `player.subtitles` | | Feliratok. |
| `player.audio` | | Hangsávválasztó. |
| `player.hls` | | HLS-folyamok. |
| `player.dash` | | DASH-folyamok (csak natív támogatással). |
| `player.source_fallback` | | Visszaesés a következő forrásra. |
| `player.skip_intro` | | Intró átugrása. |
| `player.skip_outro` | | Outró átugrása. |
| `player.autoplay_next` | | Következő rész automatikusan. |
| `player.ambient` | | Környezeti fény a videó színeiből. |
| `player.cinema` | | Mozi mód. |
| `player.mini_player` | | Lebegő kislejátszó. |
| `player.pip` | | Kép a képben. |
| `player.mobile_gestures` | | Érintéses mozdulatok. |
| `player.keyboard` | | Billentyűparancsok. |
| `player.preview` | | Előnézeti kép a csúszkán. |
| `player.watch_progress` | **igen** | Haladás mentése. |
| `player.watch_time` | | Mért nézési idő. |
| `player.watch_party` | | Közös nézés. |
| `player.media_session` | | Zárolt képernyős vezérlés. |
| `player.debug` | | Fejlesztői réteg. |

## A bevezetés kapcsolója: `feature.player2`

Ez **nem** a fenti listából való — ez a **szerveroldali** kapcsoló, ami
eldönti, hogy a nézőoldal melyik lejátszót állítja fel egyáltalán. A 0058-as
áttérés hozza létre, **kikapcsolva**.

### Miért kellett külön sor

A kliens `featureOn` függvénye szándékosan megengedő:

```js
if (!flag || !flag.enabled) return !flag
```

Egy **nem létező** kapcsoló tehát **igazat** ad vissza. Ez a legtöbb
funkciónál helyes — egy új gomb ne tűnjön el a régi telepítéseken —, egy
teljes lejátszócserénél viszont azt jelentené, hogy a hiányzó sor mellett az
**új** lejátszó indul el mindenkinél, az első éles kérésnél, mérés nélkül.

Ezért a nézőoldal **kettőt kérdez**:

```js
if (flagDeclared('feature.player2') && featureOn('player2')) { … }
```

Négy eset, mind tesztelve (`player2-rollout.test.mjs`):

| a kapcsolótábla állapota | melyik lejátszó |
|---|---|
| nincs sor | régi |
| van sor, kikapcsolva | régi |
| van sor, bekapcsolva | **új** |
| bekapcsolva, jogosultsághoz kötve | **új**, de csak akinek van joga |

### Bekapcsolás

Az adminfelület kapcsolótáblájában, vagy:

```sql
UPDATE feature_flags SET enabled = true WHERE key = 'feature.player2';
```

**Fokozatos bevezetéshez** előbb jogosultsághoz kötve, hogy csak az
üzemeltető lássa:

```sql
UPDATE feature_flags
   SET enabled = true, access = 'permission', required_permission = 'admin.settings.manage'
 WHERE key = 'feature.player2';
```

Visszakapcsolás ugyanígy, `enabled = false`-ra. A kliens **nem cache-eli** a
kapcsolót a lap élettartamán túl: a következő betöltés már az új állapotot
látja.

## Képességfelismerés

A `detectCapabilities()` azt méri, mit tud a böngésző: `hls` (natív
`application/vnd.apple.mpegurl`), `dash`, `pip`, `fullscreen`,
`mediaSession`, `touch`. A `detectPlatform()` a készülék fajtáját adja.

Ezek **mérések, nem feltételezések**: nincs böngészőazonosító-szimatolás. Ami
mérhető, azt megkérdezzük a böngészőtől.
