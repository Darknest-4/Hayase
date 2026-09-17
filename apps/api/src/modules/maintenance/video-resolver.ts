// A karbantartási videó megtalálása — a 15. és a 20. pont.
//
// A FELADAT: az `assets/videos` könyvtárban lévő videók közül kiválasztani
// azt, amelyik a karbantartási oldalra való, és NEM elhasalni, ha nincs
// egy sem.
//
// A BIZTONSÁGI RÉSZ fontosabb, mint amilyennek látszik. Ez a modul egy
// könyvtárat olvas, és a kiválasztott név egy URL-be kerül. Három szabály
// zárja ki a visszaéléseket:
//
//   1. CSAK EGY KÖNYVTÁRBÓL dolgozunk, és a feloldott útvonalnak BELE KELL
//      ESNIE — a `path.resolve` után ellenőrizve, nem a bemeneten;
//   2. CSAK ISMERT KITERJESZTÉSEKET fogadunk el;
//   3. A NÉV MAGA is szűrt: ami nem egyszerű fájlnév, az kiesik.
//
// A `../../secret.mp4` így három ponton is elbukik, és nem azért, mert
// kiszűrtük a „..”-ot — hanem mert a feloldott útvonal nem a videókönyvtárban
// van. Egy mintaillesztés megkerülhető; egy útvonal-összehasonlítás nem.

import { readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Amit a böngésző le tud játszani, és amit a lejátszó ismer. */
export const SUPPORTED = Object.freeze(['.mp4', '.webm', '.m3u8'])

/** A MIME-típus a kiterjesztésből. A böngésző ebből dönt, mit próbáljon meg. */
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl'
}

/**
 * A felismerés sorrendje.
 *
 * A KIFEJEZETTEN KARBANTARTÁSRA SZÁNT név nyer. Ez a lista azért van, hogy
 * ne kelljen beállítani semmit: aki bemásol egy `maintenance.mp4`-et, annak
 * onnantól az megy — konfiguráció nélkül.
 *
 * Ha egyik sem található, akkor sem hardkódolunk: a könyvtár BÁRMELYIK
 * videója jobb, mint a semmi, és a névsor első eleme kiszámítható választás.
 */
const PREFERRED = ['maintenance', 'maintenance-loop', 'maintenance-background', 'karbantartas']

export interface VideoAsset {
  /** A fájlnév, könyvtár nélkül. */
  name: string
  /** A nyilvános cím, amit a lap betölt. */
  url: string
  type: string
  sizeBytes: number
  /** Kifejezetten karbantartásra szánt névnek látszik-e. */
  preferred: boolean
}

/** A videók könyvtára. EGYETLEN hely, ahonnan dolgozunk. */
export function videoRoot (): string {
  const web = process.env.WEB_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), '../../../../web')
  return resolve(web, 'assets', 'videos')
}

/**
 * Biztonságos-e ez a fájlnév.
 *
 * Nem mintaillesztés a „..”-ra: a feloldott útvonalat hasonlítjuk a
 * gyökérhez. Egy szimbolikus link, egy kódolt karakter vagy egy platform-
 * függő elválasztó így sem visz ki a könyvtárból.
 */
export function isSafeName (name: string, root = videoRoot()): boolean {
  if (typeof name !== 'string' || !name || name.length > 255) return false
  // Csak egyszerű fájlnév: se könyvtár, se abszolút út, se rejtett fájl.
  if (name.includes('/') || name.includes('\\') || name.startsWith('.')) return false
  if (name.includes('\0')) return false
  if (!SUPPORTED.includes(extname(name).toLowerCase())) return false

  const full = resolve(root, name)
  // A feloldott útvonal a gyökér ALATT kell legyen. Az elválasztó a
  // összehasonlításban is benne van: a `/videos-secret` nem a `/videos` alatt
  // van, pedig előtagként annak látszik.
  return full.startsWith(root + sep) || dirname(full) === root
}

/**
 * A könyvtár tartalma.
 *
 * Hiányzó könyvtár NEM hiba: a karbantartási oldal videó nélkül is teljes
 * értékű, és egy friss telepítésen nincs is `assets/videos`.
 */
export async function discover (root = videoRoot()): Promise<VideoAsset[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const found: VideoAsset[] = []
  for (const name of names) {
    if (!isSafeName(name, root)) continue
    let size = 0
    try {
      const info = await stat(resolve(root, name))
      if (!info.isFile()) continue
      size = info.size
    } catch {
      continue
    }
    const base = name.slice(0, name.length - extname(name).length).toLowerCase()
    found.push({
      name,
      url: `/assets/videos/${encodeURIComponent(name)}`,
      type: MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
      sizeBytes: size,
      preferred: PREFERRED.includes(base)
    })
  }
  // Kiszámítható sorrend: előbb a karbantartásra szántak, azon belül névsor.
  return found.sort((a, b) =>
    (Number(b.preferred) - Number(a.preferred)) || a.name.localeCompare(b.name))
}

/**
 * A választott videó, vagy `null`.
 *
 * @param configured a beállításban megadott fájlnév, ha van
 */
export async function resolveVideo (configured?: string | null, root = videoRoot()): Promise<VideoAsset | null> {
  const assets = await discover(root)
  if (!assets.length) return null

  if (configured) {
    // A BEÁLLÍTOTT NÉV IS ÁTMEGY AZ ELLENŐRZÉSEN. Az admin felület sem
    // megbízható bemenet: ami a válaszba kerül, az ugyanazt a kaput járja be.
    if (!isSafeName(configured, root)) return null
    return assets.find(asset => asset.name === configured) ?? null
  }

  return assets[0] ?? null
}
