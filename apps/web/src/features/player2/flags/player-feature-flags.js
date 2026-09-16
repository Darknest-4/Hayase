// A lejátszó funkciókapcsolói.
//
// NEM ÚJ RENDSZER. A YUME-nak van flag-kezelője (`shared/lib/site-config.js`,
// `featureOn`): szerverből vezérelt, hozzáférési szinttel (`auth`,
// `permission`). A 27. pont pont ezt kéri, és a 45. pont szerint a meglévőt
// kell használni.
//
// Ez a modul a lejátszó-specifikus neveket és a KIÉRTÉKELÉST adja hozzá:
// platformcélzást és felhasználói felülbírálást, amit a `featureOn` nem ismer.
//
// A HIÁNYZÓ FLAG BEKAPCSOLT ÁLLAPOTOT JELENT — ez a `featureOn` meglévő
// szerződése, és nem írom felül: egy friss telepítésen minden működjön, ne
// minden legyen kikapcsolva. Egy „biztonságos alapértelmezés", ami mindent
// letilt, egy üres lejátszót ad az első látogatónak.

/**
 * A kapcsolható funkciók.
 *
 * `core: true` → a lejátszó nem működik nélküle, tehát nem is kapcsolható ki.
 * Ez nem álkapcsoló: kiírva jobb, mint egy flag, ami látszólag létezik, és
 * amitől a lejátszó használhatatlan lesz.
 */
export const PLAYER_FLAGS = Object.freeze({
  'player.v2': { core: false, desc: 'Az új lejátszó. Kikapcsolva a régi út fut.' },
  'player.controls': { core: true, desc: 'Vezérlősáv.' },
  'player.quality': { core: false, desc: 'Minőségválasztó.' },
  'player.subtitles': { core: false, desc: 'Feliratok.' },
  'player.audio': { core: false, desc: 'Hangsávválasztó.' },
  'player.hls': { core: false, desc: 'HLS-folyamok.' },
  'player.dash': { core: false, desc: 'DASH-folyamok (csak natív támogatással).' },
  'player.source_fallback': { core: false, desc: 'Visszaesés a következő forrásra.' },
  'player.skip_intro': { core: false, desc: 'Intró átugrása.' },
  'player.skip_outro': { core: false, desc: 'Outró átugrása.' },
  'player.autoplay_next': { core: false, desc: 'Következő rész automatikusan.' },
  'player.ambient': { core: false, desc: 'Környezeti fény a videó színeiből.' },
  'player.cinema': { core: false, desc: 'Mozi mód.' },
  'player.mini_player': { core: false, desc: 'Lebegő kislejátszó.' },
  'player.pip': { core: false, desc: 'Kép a képben.' },
  'player.mobile_gestures': { core: false, desc: 'Érintéses mozdulatok.' },
  'player.keyboard': { core: false, desc: 'Billentyűparancsok.' },
  'player.preview': { core: false, desc: 'Előnézeti kép a csúszkán.' },
  'player.watch_progress': { core: true, desc: 'Haladás mentése.' },
  'player.watch_time': { core: false, desc: 'Mért nézési idő.' },
  'player.watch_party': { core: false, desc: 'Közös nézés.' },
  'player.media_session': { core: false, desc: 'Zárolt képernyős vezérlés.' },
  /*
   * A FEJLESZTŐI RÉTEG AZ EGYETLEN, AMI ALAPBÓL KI VAN KAPCSOLVA.
   *
   * A többi flag alapértelmezése IGEN, és ez szándékos: egy funkció, amiről a
   * kapcsolótábla még nem tud, inkább működjön. Egy videó fölé írt húsz
   * sornyi belső szám viszont pont fordítva van — azt kimondottan kérni kell,
   * különben minden néző látná az első telepítéskor.
   */
  'player.debug': { core: false, defaultOff: true, desc: 'Fejlesztői réteg.' }
})

/** Amit a kiértékelő tudni akar a környezetről. */
export function detectPlatform (env = globalThis) {
  const ua = String(env.navigator?.userAgent ?? '')
  const touch = Boolean(env.navigator?.maxTouchPoints) || 'ontouchstart' in (env ?? {})
  const coarse = Boolean(env.matchMedia?.('(pointer: coarse)')?.matches)
  return {
    mobile: touch && coarse,
    ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touch),
    safari: /^((?!chrome|android).)*safari/i.test(ua),
    touch
  }
}

/**
 * A kiértékelő.
 *
 * Négy forrás, ebben a sorrendben — az elsőt, ami nemet mond, elfogadjuk:
 *
 *   1. FELHASZNÁLÓI FELÜLBÍRÁLÁS (beállítás) — a néző szava az első. Aki
 *      kikapcsolta a mozdulatokat, annak ne legyenek.
 *   2. KÉPESSÉG — amit a böngésző nem tud, azt nem kínáljuk. A 22. pont
 *      követelménye: ne mutass gombot, ami nem működik.
 *   3. PLATFORM — a mozdulatoknak érintőképernyő kell.
 *   4. SZERVER (`featureOn`) — az üzemeltető szava.
 */
export function createFlagEvaluator ({ featureOn, prefs, capabilities = {}, platform = detectPlatform() } = {}) {
  /** Beállításkulcs egy flaghez, ahol a néző felülbírálhatja. */
  const OVERRIDE_KEY = {
    'player.mobile_gestures': 'player.ui.gestures',
    'player.keyboard': 'player.ui.keyboard',
    'player.ambient': 'player.ui.ambient',
    'player.mini_player': 'player.ui.miniPlayer',
    'player.autoplay_next': 'player.autoplayNext',
    'player.skip_intro': 'player.skip.introAuto',
    'player.skip_outro': 'player.skip.outroAuto'
  }

  /** Képességfüggő flagek. `undefined` = nincs követelmény. */
  const REQUIRES = {
    'player.pip': () => capabilities.pip,
    'player.mini_player': () => capabilities.pip !== false,
    'player.mobile_gestures': () => platform.touch,
    'player.media_session': () => capabilities.mediaSession
  }

  const isOn = (name) => {
    const spec = PLAYER_FLAGS[name]
    if (!spec) return false            // ismeretlen név: nincs ilyen funkció
    if (spec.core) return true         // mag: nem kapcsolható ki

    // A KIFEJEZETTEN KÉRENDŐ funkciók: itt a hallgatás NEM beleegyezés. Csak
    // az kapcsolja be, aki tényleg mondta — se a hiányzó kapcsolótábla, se a
    // hiányzó beállítás.
    if (spec.defaultOff) {
      const key = OVERRIDE_KEY[name]
      const asked = key && prefs ? prefs.get(key) === true : false
      const allowed = typeof featureOn === 'function' ? featureOn(name) === true : false
      return asked || allowed
    }

    // 1. a néző szava
    const overrideKey = OVERRIDE_KEY[name]
    if (overrideKey && prefs) {
      const value = prefs.get(overrideKey)
      if (value === false) return false
    }

    // 2–3. képesség és platform
    const requirement = REQUIRES[name]
    if (requirement && requirement() === false) return false

    // 4. az üzemeltető szava. A rövid név megy át, a `featureOn` teszi elé a
    //    `feature.` előtagot.
    if (typeof featureOn === 'function' && !featureOn(name)) return false
    return true
  }

  return {
    isOn,
    /** Minden flag állapota — a hibakereső réteghez és a beállításképernyőhöz. */
    all: () => Object.fromEntries(Object.keys(PLAYER_FLAGS).map(name => [name, isOn(name)])),
    platform,
    capabilities
  }
}

/**
 * Böngészőképességek, funkciódetektálással.
 *
 * A 35. pont követelménye: ne feltételezzük, hogy minden böngésző mindent tud.
 * A `document` hiánya (teszt, kiszolgálóoldal) nem hiba — minden `false`.
 */
export function detectCapabilities (env = globalThis) {
  const doc = env.document
  const video = (() => { try { return doc?.createElement?.('video') } catch { return null } })()
  return {
    pip: Boolean(doc?.pictureInPictureEnabled && video && 'requestPictureInPicture' in video),
    fullscreen: Boolean(doc?.fullscreenEnabled ?? doc?.webkitFullscreenEnabled),
    mediaSession: Boolean(env.navigator?.mediaSession),
    hlsNative: Boolean(video?.canPlayType?.('application/vnd.apple.mpegurl')),
    dashNative: Boolean(video?.canPlayType?.('application/dash+xml')),
    webShare: Boolean(env.navigator?.share),
    wakeLock: Boolean(env.navigator?.wakeLock)
  }
}
