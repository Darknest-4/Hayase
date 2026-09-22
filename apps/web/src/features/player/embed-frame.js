// Idegen lejátszó beágyazása `iframe`-be.
//
// KÖZÖS MODUL, SZÁNDÉKOSAN. Két lejátszó él a kódban — a mai `StreamEngine`
// és a kapcsoló mögötti `player2` —, és a beágyazás mindkettőben ugyanaz a
// feladat. Ha külön írnánk meg, a homokozó-beállítások két helyen élnének, és
// egy szigorítás előbb-utóbb csak az egyikbe kerülne be.
//
// AMIT EZ A MODUL NEM CSINÁL: nem nyúl bele a beágyazott lapba, nem olvassa
// ki belőle a folyam címét, és nem kerüli meg semmilyen védelmét. Az `iframe`
// tartalma számunkra átlátszatlan — pontosan úgy, ahogy a szolgáltató szánta.

/**
 * A HOMOKOZÓ, ÉS MIÉRT PONT EZ A HÁROM.
 *
 * Az `iframe` alapból mindent megenged; a `sandbox` attribútum jelenléte
 * MINDENT ELVESZ, és onnantól a felsorolt jogok kerülnek vissza. Tehát a
 * lista nem engedmény, hanem a szűkítés eredménye.
 *
 *   allow-scripts       — enélkül a lejátszó el sem indul; ez a minimum.
 *   allow-same-origin   — a lejátszónak a SAJÁT eredetén kell tárolnia és
 *                         kérnie. Ez NEM a mi eredetünket adja oda: a
 *                         beágyazott lap a saját origójában marad, ami egy
 *                         idegen tartomány.
 *   allow-presentation  — a teljes képernyő és a második kijelző ezen megy.
 *
 * AMIT KIHAGYUNK, és az sem véletlen:
 *   allow-popups        — egy beágyazott lejátszó reklámablakot nyithatna a
 *                         néző lapja fölé. Nincs rá szükség a lejátszáshoz.
 *   allow-top-navigation — ezzel a beágyazott lap ELVIHETNÉ a YUME-ot egy
 *                         másik címre. Ez a legfontosabb kihagyás.
 *   allow-modals, allow-forms, allow-downloads — egyikhez sincs köze a
 *                         videólejátszásnak.
 */
export const SANDBOX = 'allow-scripts allow-same-origin allow-presentation'

/**
 * Jogosultságok (Permissions Policy). Csak ami a lejátszáshoz kell.
 *
 * A `camera`, `microphone`, `geolocation` és a többi SZÁNDÉKOSAN hiányzik:
 * amit itt nem sorolunk fel, azt a beágyazott lap nem kérheti meg.
 */
export const ALLOW = 'autoplay; fullscreen; picture-in-picture'

/** Meddig várunk a keret betöltésére, mielőtt elbukottnak vesszük. */
export const EMBED_TIMEOUT_MS = 15_000

/** A kapcsoló kulcsa. A `featureOn` a `feature.` előtag nélkül kéri. */
export const UNSANDBOXED_FLAG = 'embed_unsandboxed'

/**
 * Homokozzunk-e ezt a keretet?
 *
 * A KAPCSOLÓNAK LÉTEZNIE ÉS BEKAPCSOLVA KELL LENNIE. A `featureOn` egy nem
 * létező kapcsolóra IGAZAT ad vissza — ez a többi funkciónál helyes (egy új
 * gomb ne tűnjön el a régi telepítéseken), itt viszont azt jelentené, hogy
 * sor nélkül a homokozó MINDENHOL feloldódna. Ezért kell a `flagDeclared` is.
 *
 * A két függvény PARAMÉTER, nem import: így a modul tesztelhető a
 * helyszíni beállítások nélkül, és nem húz be egy egész konfigurációs réteget
 * egy `iframe` kedvéért.
 */
export function sandboxFor ({ flagDeclared, featureOn } = {}) {
  const feloldva = typeof flagDeclared === 'function' &&
    typeof featureOn === 'function' &&
    flagDeclared('feature.' + UNSANDBOXED_FLAG) &&
    featureOn(UNSANDBOXED_FLAG)
  return feloldva ? null : SANDBOX
}

/**
 * Beágyazó keret létrehozása egy már ELLENŐRZÖTT címhez.
 *
 * A CÍMET ITT MÁR NEM ELLENŐRIZZÜK ÚJRA, és ez tudatos: az ellenőrzés a
 * szerveren történt (`embed-url.ts`), ahol az engedélyezett gazdagépek listája
 * él. Egy második, gyengébb ellenőrzés itt csak azt a látszatot keltené, hogy
 * a kliens is kapuőr — miközben a kliensben futó ellenőrzést a néző
 * átírhatja. EGY KAPU VAN, és az a szerveren.
 *
 * Amit viszont itt is megteszünk: a séma ellenőrzése. Nem védelemnek — az a
 * szerveren van —, hanem azért, hogy egy elrontott bekötés NE `javascript:`
 * címet tegyen az attribútumba, hanem hangosan elhasaljon.
 */
export function createEmbedFrame (url, { title = 'Beágyazott lejátszó', document: doc = globalThis.document, sandbox = SANDBOX } = {}) {
  const text = String(url ?? '')
  if (!/^https:\/\//i.test(text)) {
    throw new Error('a beágyazó cím nem https — a keret nem jön létre')
  }

  const frame = doc.createElement('iframe')
  frame.className = 'player-embed'
  frame.setAttribute('src', text)
  /*
   * A HOMOKOZÓ ELHAGYHATÓ — DE CSAK SZÁNDÉKOSAN, ÉS ÁRON.
   *
   * MÉRVE (2026-09-21, valódi Chromiumban): a `megaplay.buzz` lejátszója
   * MINDEN homokozót elutasít. Nem egy hiányzó jogosultságról van szó —
   * mind a tizenegy token megadásával is ezt írja ki:
   *
   *   „Opss! Sandboxed our player is not allowed. Remove sandbox to use it."
   *
   * Homokozó nélkül elindul. Az ár viszont valódi: enélkül a beágyazott lap
   * ELNAVIGÁLHATJA a YUME-ot egy másik címre, és ablakot nyithat a néző
   * fölé. Ezt a döntést az üzemeltető hozza meg, nem ez a modul — ezért van
   * itt paraméter, és ezért a HOMOKOZÓ AZ ALAPÉRTELMEZÉS.
   *
   * Az `allow` és a `referrerpolicy` homokozó nélkül is érvényes marad,
   * tehát a kamera, mikrofon és helyadat így is zárva van.
   */
  if (sandbox) frame.setAttribute('sandbox', sandbox)
  frame.setAttribute('allow', ALLOW)
  // Az `allowfullscreen` a régebbi böngészőknek szól; az `allow` fedi az újakat.
  frame.setAttribute('allowfullscreen', '')
  /*
   * A HIVATKOZÓ CÍMBŐL CSAK AZ EREDET MEGY EL.
   *
   * A teljes cím elárulná, melyik animét és melyik részt nézi valaki egy
   * harmadik félnek. Az eredet (`https://animehub.hu`) elég ahhoz, hogy a
   * beágyazás működjön — ezt megmértük —, a néző szokásai viszont nem
   * tartoznak a másik kiszolgálóra.
   */
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
  frame.setAttribute('title', title)
  frame.setAttribute('loading', 'eager')
  return frame
}

/**
 * A keret beillesztése a videóelem helyére, és megvárása.
 *
 * A VIDEÓELEMET ELREJTJÜK, NEM TÖRÖLJÜK. A lejátszó többi modulja (a
 * billentyűkezelő, a haladásmérő, a vezérlősáv) hivatkozást tart rá, és egy
 * eltávolított elemtől mind elhasalna. Az elrejtés viszont azt is elintézi,
 * hogy a `<video>` ne kezdjen el semmit tölteni a keret mögött.
 *
 * @returns {Promise<Function>} a lebontó függvény, ahogy a motorok várják
 */
export function attachEmbed (video, url, { timeoutMs = EMBED_TIMEOUT_MS, title, sandbox = SANDBOX } = {}) {
  const doc = video?.ownerDocument ?? globalThis.document
  const mount = video?.parentNode
  if (!mount) throw new Error('a beágyazáshoz kell egy szülőelem a videó mellett')

  const frame = createEmbedFrame(url, title
    ? { title, document: doc, sandbox }
    : { document: doc, sandbox })

  /*
   * A `<video>` KIÜRÍTÉSE, mielőtt eltűnik.
   *
   * Ha korábban egy forrás rá volt kötve, a `src` elhagyása nélkül a böngésző
   * a háttérben tovább töltené — sávszélesség egy videóhoz, amit senki nem
   * lát. A `load()` szakítja meg.
   */
  try {
    video.removeAttribute?.('src')
    video.load?.()
  } catch { /* a kiürítés legjobb szándék szerint */ }

  const rejtve = video.style?.display
  if (video.style) video.style.display = 'none'
  mount.appendChild(frame)

  let bontva = false
  const teardown = () => {
    if (bontva) return
    bontva = true
    try { frame.remove?.() } catch { /* lebontás */ }
    if (video.style) video.style.display = rejtve ?? ''
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn() }

    /*
     * A `load` ESEMÉNY A BIZONYÍTÉK, amennyi egyáltalán lehet.
     *
     * A keret tartalma más eredeten van: NEM tudjuk megnézni, elindult-e
     * benne a videó, és nem is próbáljuk — az a lap belsejébe nyúlás lenne.
     * Amit a `load` bizonyít: a cím él, a kiszolgáló válaszolt, a keret
     * megkapta a lapot. Ennél többet őszintén nem állíthatunk.
     */
    frame.addEventListener?.('load', () => done(() => resolve(teardown)), { once: true })
    frame.addEventListener?.('error', () => done(() => {
      teardown()
      reject(new Error('a beágyazott lejátszó nem töltődött be'))
    }), { once: true })

    const timer = setTimeout(() => done(() => {
      teardown()
      reject(new Error('a beágyazott lejátszó nem válaszolt időben'))
    }), timeoutMs)
  })
}
