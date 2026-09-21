// Motorok: ki tudja lejátszani ezt a forrást, és hogyan.
//
// Egy motor szerződése két függvény:
//
//   canPlay(candidate) → boolean | 'maybe'
//   attach(video, candidate, ctx) → Promise<teardown>
//
// A `video` PARAMÉTER, nem keresés: a motor nem tudja, hol van a DOM-ban, és
// nem is keresi. Ettől tesztelhető egy csonkkal.

import { PlayerError } from '../core/player-errors.js'
import { SOURCE_KIND } from './source-ranking.js'

/**
 * Mi számít bizonyítéknak arra, hogy egy forrás MŰKÖDIK.
 *
 * A `loadedmetadata` MOBILON ELENGEDHETETLEN, és a hiánya valódi hiba volt: a
 * telefonon minden forrás „a folyam nem indult el időben"-nel bukott el,
 * miközben asztalon ugyanaz a fájl azonnal elindult.
 *
 * Az ok a mobil böngészők automatikus lejátszási szabálya. Hangos videónál az
 * autoplay tiltott, és ilyenkor a böngésző MEGÁLL A METAADATNÁL — képkocka-
 * adatot csak felhasználói gesztusra tölt. A `canplay` és a `loadeddata`
 * viszont mindkettő `readyState >= 2`-t kíván, vagyis tényleges képkockát;
 * egyikük sem következett be, és a határidő minden jelöltet megbuktatott.
 *
 * A `loadedmetadata` pontosan azt bizonyítja, amit a kérdés firtat: a
 * hivatkozás él, a formátum érthető, a hossz ismert. A dekódolási hibát az
 * `error` esemény továbbra is elkapja.
 */
export const READY_EVENTS = Object.freeze(['loadedmetadata', 'loadeddata', 'canplay'])

/** Meddig várunk egy forrásra, mielőtt elbukottnak vesszük. */
export const ATTACH_TIMEOUT_MS = 12_000

/** Tud-e a böngésző natívan ilyet. Funkciódetektálás, nem böngészőszimat. */
function canPlayType (mime) {
  try {
    const probe = globalThis.document?.createElement?.('video')
    return Boolean(probe?.canPlayType?.(mime))
  } catch {
    return false
  }
}

/**
 * Közös rákapcsolás: a forrás beállítása után megvárjuk a bizonyítékot.
 *
 * Minden motor ezt használja, mert a „mikor jó egy forrás" kérdés mindenhol
 * ugyanaz — csak a beállítás módja más.
 */
function awaitReady (video, { url, timeoutMs = ATTACH_TIMEOUT_MS, setup, teardown }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      for (const event of READY_EVENTS) video.removeEventListener(event, onReady)
      video.removeEventListener('error', onError)
    }
    const succeed = () => { if (settled) return; settled = true; cleanup(); resolve(teardown ?? (() => {})) }
    const failWith = (error) => {
      if (settled) return
      settled = true
      cleanup()
      try { teardown?.() } catch { /* a lebontás legjobb szándék szerint */ }
      reject(error)
    }

    const onReady = () => succeed()
    const onError = () => failWith(mediaErrorOf(video, url))

    for (const event of READY_EVENTS) video.addEventListener(event, onReady, { once: true })
    video.addEventListener('error', onError)
    const timer = setTimeout(() => failWith(new PlayerError('SOURCE_TIMEOUT', url)), timeoutMs)

    try {
      setup()
    } catch (error) {
      failWith(new PlayerError('UNKNOWN', String(error?.message ?? error), error))
    }
  })
}

function mediaErrorOf (video, url) {
  // Lusta import helyett közvetlen leképezés: a `fromMediaError` a
  // `player-errors`-ban van, és a körkörös import elkerülése végett itt
  // ugyanazt a döntést hozzuk meg.
  const code = video?.error?.code
  if (code === 1) return new PlayerError('ABORTED')
  if (code === 2) return new PlayerError('NETWORK_ERROR', url)
  if (code === 3) return new PlayerError('MEDIA_ERROR', url)
  if (code === 4) return new PlayerError('SOURCE_UNSUPPORTED', url)
  return new PlayerError('UNKNOWN', video?.error?.message ?? url)
}

/** Natív: a böngésző maga játssza le. mp4, webm, és a Safariban a HLS is. */
export const nativeEngine = {
  name: 'native',
  canPlay: (candidate) => candidate.kind === SOURCE_KIND.DIRECT,
  attach: (video, candidate, ctx = {}) => awaitReady(video, {
    url: candidate.url,
    timeoutMs: ctx.timeoutMs,
    setup: () => { video.src = candidate.url; video.load?.() },
    teardown: () => { video.removeAttribute?.('src'); video.load?.() }
  })
}

/**
 * HLS.
 *
 * Előbb a natív út: a Safari és az iOS maga tudja, és ott a `hls.js` nemcsak
 * fölösleges, hanem rosszabb is — a natív lejátszás hardveresen gyorsított.
 * Csak ha nincs natív támogatás, akkor töltjük be a könyvtárat, LUSTÁN: 578 kB,
 * és a katalógus forrásainak túlnyomó része nem HLS.
 */
export const hlsEngine = {
  name: 'hls',
  canPlay: (candidate) => candidate.kind === SOURCE_KIND.HLS,
  attach: async (video, candidate, ctx = {}) => {
    if (canPlayType('application/vnd.apple.mpegurl')) {
      return await nativeEngine.attach(video, candidate, ctx)
    }
    const { default: Hls } = await import('../../player/vendor/hls.min.mjs')
    if (!Hls?.isSupported?.()) {
      throw new PlayerError('SOURCE_UNSUPPORTED', 'a böngésző nem támogatja a HLS-t')
    }
    const hls = new Hls({ enableWorker: true, lowLatencyMode: false })
    return await awaitReady(video, {
      url: candidate.url,
      timeoutMs: ctx.timeoutMs,
      setup: () => { hls.loadSource(candidate.url); hls.attachMedia(video) },
      teardown: () => { try { hls.destroy() } catch { /* a lebontás legjobb szándék szerint */ } }
    })
  }
}

/**
 * DASH — csak natív támogatással, SZÁNDÉKOSAN.
 *
 * A `dash.js` ~400 kB, és a katalógusban jelenleg NULLA DASH-forrás van. A
 * 44. pont („ne használj felesleges dependencyt") szerint ez akkor kerül be,
 * ha lesz mit lejátszani vele. Addig a lejátszó megmondja az igazat, ahelyett
 * hogy megjátszaná.
 */
export const dashEngine = {
  name: 'dash',
  canPlay: (candidate) => candidate.kind === SOURCE_KIND.DASH,
  attach: async (video, candidate, ctx = {}) => {
    if (!canPlayType('application/dash+xml')) {
      throw new PlayerError('SOURCE_UNSUPPORTED', 'a DASH-hoz ez a böngésző nem elég')
    }
    return await nativeEngine.attach(video, candidate, ctx)
  }
}

/** A magnet nem böngészőbe való, és ezt ki is mondjuk. */
export const magnetEngine = {
  name: 'magnet',
  canPlay: (candidate) => candidate.kind === SOURCE_KIND.MAGNET,
  attach: async () => {
    throw new PlayerError('SOURCE_UNSUPPORTED', 'a torrenthez asztali kliens kell')
  }
}

const REGISTRY = [nativeEngine, hlsEngine, dashEngine, magnetEngine]

/** Melyik motor viszi ezt a jelöltet. `null`, ha egyik sem. */
export function engineFor (candidate, registry = REGISTRY) {
  return registry.find(engine => engine.canPlay(candidate)) ?? null
}

export const engines = REGISTRY
