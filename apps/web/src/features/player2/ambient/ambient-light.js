/* global Image */
// Környezeti fény — a cím színei a lejátszó mögött.
//
// A FORRÁS A BORÍTÓ, NEM A VIDEÓ, és ez MÉRÉS EREDMÉNYE, nem ízlés.
//
// Az első változat a videó képkockáit mintázta egy apró vászonra, fél
// másodpercenként. Papíron olcsó: 32×18 képpont, másodpercenként kétszer.
// Böngészőben mérve viszont ez történt (150 képkocka mediánja, kétszer
// megismételve):
//
//   nincs fény                          16,7 ms
//   csak a másolás, vászon nélkül       76,0 ms
//   másolás + kicsi elmosás             74,8 ms
//   másolás + nagy elmosás              79,3 ms
//
// A második sor a döntő: a KÖLTSÉG MAGA A `drawImage(video, …)`, elmosás és
// megjelenítés nélkül is. Egy videó képkockájának vászonra másolása
// visszaolvasást kényszerít a GPU-ról, és a dekódoló utána lassabb úton
// marad — nem a másolás pillanata drágul, hanem az EGÉSZ LEJÁTSZÁS.
//
// A 20. pont a „videó/poster színeiből" kér hátteret. A poszter ugyanolyan
// jó forrás, és egy képet egyszer lemásolni ingyen van: nincs dekódoló, amit
// elronthatnánk, és nincs ismétlődő munka sem.
//
// Ami elveszett vele: a háttér nem követi a jelenetek színét. Ami megmaradt:
// a cím saját színvilága a lejátszó mögött — és egy lejátszás, ami nem akad.

/** A mintavevő vászon mérete. Szándékosan apró: a képet úgyis elmossuk. */
export const SAMPLE_WIDTH = 32
export const SAMPLE_HEIGHT = 18

/**
 * @param {object} player
 * @param {HTMLCanvasElement} canvas a héj ambiens rétege
 * @param {object} options `prefs`, `enabled`, `imageSrc`, `loadImage`
 */
export function createAmbientLight (player, canvas, options = {}) {
  const prefs = options.prefs ?? { get: () => undefined }
  let painted = false
  let failed = false

  canvas.width = SAMPLE_WIDTH
  canvas.height = SAMPLE_HEIGHT

  const intensity = () => {
    const value = Number(prefs.get('player.ui.ambientIntensity'))
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 60
  }

  const wanted = () => prefs.get('player.ui.ambient') !== false && options.enabled !== false

  const apply = () => {
    const on = wanted() && painted && !failed && intensity() > 0
    canvas.parentElement?.classList.toggle('yp-ambient-on', on)
    canvas.style.opacity = on ? String((intensity() / 100) * 0.55) : '0'
    return on
  }

  /**
   * A kép egyszeri lemásolása.
   *
   * `crossOrigin = 'anonymous'`: enélkül egy idegen eredetű borító
   * „beszennyezi" a vásznat, és a rajzolás biztonsági hibát dob. Ha a
   * kiszolgáló nem engedi, a kép be sem töltődik — és akkor a fény
   * elmarad, de a lejátszáshoz ennek semmi köze.
   */
  const paint = (source) => {
    const src = source ?? options.imageSrc
    if (!src || failed) return Promise.resolve(false)
    const load = options.loadImage ?? defaultLoader
    return load(src)
      .then(image => {
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('nincs vászonkörnyezet')
        context.drawImage(image, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        painted = true
        apply()
        return true
      })
      .catch(error => {
        failed = true
        player.logger?.warn?.('[player] a környezeti fény nem elérhető:', error?.message ?? error)
        apply()
        return false
      })
  }

  apply()
  const pending = options.imageSrc ? paint() : Promise.resolve(false)

  return {
    paint,
    refresh: apply,
    /** Teszthez: az első festés ígérete. */
    ready: pending,
    get painted () { return painted },
    get failed () { return failed },
    /**
     * Fut-e bármi folyamatosan.
     *
     * MINDIG HAMIS, és ez a modul lényege: a fény egy egyszeri festés, nem
     * egy időzítő. Nincs mit leállítani, és nincs mit takarítani.
     */
    get running () { return false }
  }
}

function defaultLoader (src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('a kép nem tölthető be'))
    image.src = src
  })
}
