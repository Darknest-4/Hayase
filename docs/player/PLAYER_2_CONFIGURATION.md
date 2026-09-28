# Player 2.0 — beállítás és felépítés

Ez a lap arról szól, **mit kell odaadni a lejátszónak**, hogy működjön — nem
arról, mit állíthat a néző (az a [beállítások](PLAYER_2_PREFERENCES.md)), és
nem arról, mit enged a telepítés (az a
[kapcsolók](PLAYER_2_FEATURE_FLAGS.md)).

## Egyetlen belépési pont

```js
import { createEpisodePlayer } from '/src/features/player2/watch/episode-player.js'

const mounted = createEpisodePlayer({ video, sources, media, episode, prefs })
container.append(mounted.node)
```

Minden más modul ezen keresztül áll össze. A `watch/episode-player.js` az
**egyetlen** fájl, ami mindegyiket ismeri; a többi nem tud egymásról. Ezért
lehet a magot, a motorokat és a lejátszásvezérlést DOM nélkül tesztelni.

## Amit át kell adni

| mező | kötelező | mi ez |
|---|---|---|
| `video` | **igen** | A `<video>` elem. A lejátszó ennek az egyetlen gazdája. |
| `sources` | | A jelöltek: `{ id, url, quality, label }`. |
| `media` | | A cím: `{ title, logoImage }` — a betöltőképernyőhöz. |
| `episode` | | `{ number }`. |
| `nextEpisode`, `previousEpisode` | | `{ number }` vagy `null`. Ettől függ, hogy a gomb tiltott-e. |
| `subtitles` | | Feliratsávok: `{ id, url, language, label, forced }`. |
| `skipSegments` | | Nyers sorok a `skip_segments` táblából. |
| `prefs` | | Egy `get(key)` / `set(key, value)` objektum. A nézőoldalon a `Prefs`. |
| `store`, `resumeKey` | | A folytatási pozíció tárolója. |
| `party` | | `{ send, canBroadcast }` — közös nézéshez. |
| `featureOn` | | A szerver kapcsolótáblája. |
| `timeoutMs` | | A forráscsatolás türelmi ideje (alap: 12 mp). |

Visszahívások: `onProgress`, `onCompleted`, `onNextEpisode`,
`onPreviousEpisode`, `onCinema`, `onSubtitleStyle`, `onShortcuts`,
`onEpisodeChange`.

## Amit visszakapsz

```js
{
  node,      // a héj — ezt kell a lapra tenni
  player,    // a mag: bus, state, listen, timer, own, destroy
  ui,        // a felület: menu, seekBar, controls, loader, visibility
  party,     // közös nézés (csatlakozás nélkül néma)
  loading,   // a betöltőképernyő fázisvezérlője
  sources,   // a forráskezelő
  skip,      // az átugráskezelő
  prefs, flags,
  destroy()  // MINDENT lebont
}
```

## A `destroy()` nem opcionális

A lejátszó időzítőket, figyelőket és egy `blob:` címet tart életben. A
`destroy()` **fordított sorrendben** bontja le őket, és az utolsó
haladásmentést **kikényszeríti** — a rendes ütemezés eldobná, ha az előző
mentés óta kevés idő telt el, és pont a bezáráskor elveszett utolsó néhány
másodperc az, amit a néző észrevesz.

Ennek az árát megmértük: 25 felépítés–szétbontás kör után **0 maradék elem és
0 el nem bontott erőforrás** (lásd [teljesítmény](PLAYER_2_PERFORMANCE.md)).

## A forrásjelölt alakja

```js
{ id: 'egyedi',  url: 'https://…/ep1.mp4',  quality: 1080,  label: 'yume-local' }
```

- `id` — **kötelező, egyedi**. A minőségváltás ezt keresi.
- `quality` — szám vagy `null`. A menü **csak azt sorolja fel, ami tényleg
  van**: egy 2160p-s sor egy 720p-s forrás mellett hazugság.
- `label` — a betöltőképernyőn és a naplóban jelenik meg.

A formátumot a `classify()` állapítja meg a címből (`.m3u8` → HLS, `.mpd` →
DASH, `magnet:` → torrent, egyébként natív), nem a szerver mondja meg.

## A forrássorrend

A `rank()` pontoz: a regisztrált forrás előrébb, mint a kézzel beírt cím; a
natív formátum előrébb, mint amihez külső motor kell; a kért minőséghez
közelebbi előrébb.

A visszaesés szabálya: **mindenki kap egy esélyt, mielőtt bárki másodikat
kapna**. Ez nem apróság — az első változat a hibás jelöltet próbálta újra
másodszor is, mielőtt a másodikhoz ért volna, és a teszt fogta meg.

## CSS

A `css/player2.css` **a `style.css` után** töltődik. 2026-09 óta nem az
`index.html` kéri minden oldalon, és nem is minden lejátszóoldal: csak ahol a
Player 2.0 ténylegesen indul (`feature.player2`). A lejátszóoldal
(`pages/watch.js`) a render elején a `loadPlayerStyles()`-szal indítja, a lap
felépítése előtt megvárja (különben egy pillanatra stílus nélküli, 300×150-es
videó látszana), és a beállítások Lejátszó füle is betölti, mert a panele
(`.yp-settings*`) ebből rajzol. A lap `<head>`-je csak ezt a hármat kéri:

```html
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/style.css">
<!-- player2.css, admin.css, maintenance.css: lustán, a saját képernyőjük -->
```

A dinamikusan beillesztett lap a `<head>` végére kerül, tehát a sorrend
(tokens → components → style → a képernyő lapjai → player2) változatlan; a
`css-order.test.mjs` minden lapra őrzi.

**A két lejátszó közül csak az egyik töltődik le.** A Player 2.0 moduljai
(≈36) és a régi lejátszó motorja (`stream-engine.js`, `hls-handler.js`) 2026-09
óta dinamikus import a `pages/watch.js`-ben (`_player2Module()` /
`_legacyEngine()`): kikapcsolt kapcsolónál a 2.0-s kód, bekapcsoltnál a régi
motor nem jön le. A beágyazott keret (`embed-frame.js`) mindkettőé. A lejátszó a `tokens.css` értékein
kívül alig függ bármitől — de azoktól teljesen.
