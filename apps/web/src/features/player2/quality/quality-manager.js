// Minőségválasztás.
//
// KÉT SZABÁLY, mindkettő a 13. pontból, és mindkettő a néző ellen dolgozó
// „okos" viselkedés ellen szól:
//
//   * csak az jelenjen meg, ami TÉNYLEGESEN rendelkezésre áll — egy 2160p
//     bejegyzés egy 720p-s forrás mellett hazugság;
//   * ne állítsuk át agresszíven — aki kézzel választott, annak a választása
//     maradjon, amíg ő mást nem mond.

export const QUALITY_STEPS = Object.freeze([2160, 1440, 1080, 720, 480, 360])

/** Számérték egy beállításból: `'1080'` → 1080, `'auto'` → null. */
export function qualityValue (value) {
  if (value === 'auto' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/**
 * A választható minőségek, csökkenő sorrendben.
 *
 * Egyediesítve: ugyanaz a felbontás két forrásból egy sor a menüben.
 */
export function availableQualities (candidates = []) {
  const set = new Set()
  for (const candidate of candidates) {
    const quality = Number(candidate?.quality)
    if (Number.isFinite(quality) && quality > 0) set.add(quality)
  }
  return [...set].sort((a, b) => b - a)
}

/**
 * A hálózat szerinti felső korlát.
 *
 * Az adattakarékos mód a legerősebb: azt a néző KÉRTE, és nem írhatja fölül
 * sem a wifi, sem az automatika.
 */
export function networkCap (prefs = {}, network = {}) {
  if (prefs['player.quality.dataSaver']) return 480
  if (network.type === 'cellular' || network.saveData) return qualityValue(prefs['player.quality.mobile']) ?? 720
  if (network.type === 'wifi') return qualityValue(prefs['player.quality.wifi']) ?? 1080
  return qualityValue(prefs['player.quality.preferred'])
}

/**
 * A választandó minőség.
 *
 * @returns {{quality: number|null, auto: boolean, reason: string}}
 */
export function chooseQuality ({ available = [], prefs = {}, network = {}, manual = null } = {}) {
  if (!available.length) return { quality: null, auto: true, reason: 'nincs választható minőség' }

  // A KÉZI VÁLASZTÁS NYER, ha egyáltalán elérhető. Aki 1080p-t választott,
  // annak nem vesszük el a hálózat ürügyén — legfeljebb nem tudjuk teljesíteni.
  if (manual !== null) {
    const wanted = qualityValue(manual)
    if (wanted && available.includes(wanted)) {
      return { quality: wanted, auto: false, reason: 'a néző választása' }
    }
  }

  const cap = networkCap(prefs, network)
  if (!cap) {
    return { quality: available[0], auto: true, reason: 'automatikus: a legjobb elérhető' }
  }

  // A korlát ALATTI legjobb; ha minden fölötte van, a legkisebb — mert
  // valamit le kell játszani, és a legkisebb áll a legközelebb a kéréshez.
  const fitting = available.find(q => q <= cap)
  return fitting
    ? { quality: fitting, auto: true, reason: `a ${cap}p-s korlát alatt` }
    : { quality: available.at(-1), auto: true, reason: 'minden forrás a korlát fölött van' }
}
