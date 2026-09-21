// A kliens verziója, és a telepítésenként változó cím.
//
// A PROBLÉMA, MÉRVE. Ez a projekt szándékosan build nélküli: a böngésző
// azokat a fájlneveket tölti le, amik a lemezen vannak. Nincs tehát tartalomból
// származó fájlnév, ami magától frissülne — telepítés után a böngésző
// ugyanarról a címről kérné az ÚJ kódot, és ha a régit gyorsítótárazta, nem
// kéri.
//
// És ez nem elméleti. Egy új útvonal élesítése után egy visszatérő látogató
// telefonján „Page not found" jelent meg, miközben a kiszolgálón minden
// rendben volt: friss `index.html` érkezett, RÉGI `router.js`-szel. Vegyes
// verzió.
//
// A NÉGY ÓRÁT NEM MI ADJUK, és megpróbáltuk alávinni:
//
//   eredet: cache-control: no-cache          → él: max-age=14400
//   eredet: public, max-age=86400 (kép)      → él: max-age=86400
//
// A Cloudflare zónabeállítása („Browser Cache TTL", négy óra) a statikus
// kiterjesztésekre ráerőlteti magát, és az eredet nem tud alámenni — csak
// fölé. Fejlécekkel tehát ez nem oldható meg.
//
// A MEGOLDÁS: VÁLTOZZON A CÍM. Ha a cím telepítésenként más, a négy óra nem
// számít, sőt előnyre fordul: a régi címet senki nem kéri többé, az újat
// pedig egy évre el lehet tárolni, ellenőrzés nélkül.
//
// AMIÉRT EZ EGYETLEN CÍMEN MÚLIK. A kliens modulkészlete RELATÍV importokat
// használ (`../shared/ui/primitives.js`). Egy relatív import a KÉRŐ MODUL
// címéhez képest oldódik fel — tehát ha a belépési pont
// `/b/<verzió>/src/app/main.js`, akkor a teljes gráf magától
// `/b/<verzió>/src/...` alatt jön le. Egy sort sem kell átírni a kliensben.

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Az előtag, ami alatt a bélyegzett kliens elérhető. */
export const STAMP_PREFIX = 'b'

/** Amit bélyegzünk. Az `assets` KIMARAD — lásd `stampAssets`. */
const STAMPED_DIRS = ['src', 'css']

let cached: { root: string, version: string } | null = null

/**
 * A kliens verziója: egy rövid ujjlenyomat a kiszolgált fájlokról.
 *
 * A TARTALMAT NEM OLVASSUK BE. A név, a méret és a módosítás ideje együtt
 * pontosan azt mondja meg, amit tudni akarunk: változott-e bármi a legutóbbi
 * telepítés óta. Egy konténerképben a `COPY` megőrzi a módosítási időt, tehát
 * egy változatlan fájl ujjlenyomata is változatlan — a verzió a TARTALMAT
 * azonosítja, nem az építés pillanatát.
 *
 * Boot után gyorsítótárazva: ez a szám egy folyamat életében nem változik.
 */
export async function clientVersion (webRoot: string): Promise<string> {
  if (cached?.root === webRoot) return cached.version

  const hash = createHash('sha256')
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // hiányzó könyvtár nem hiba: egy telepítésen lehet kevesebb
    }
    // Rendezve, hogy a könyvtárolvasás sorrendje ne mozgassa a verziót.
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const rel = `${relative}/${entry.name}`
      if (entry.isDirectory()) { await walk(full, rel); continue }
      if (!entry.isFile()) continue
      const info = await stat(full)
      hash.update(`${rel}:${info.size}:${Math.round(info.mtimeMs)}\n`)
    }
  }

  for (const dir of STAMPED_DIRS) await walk(join(webRoot, dir), dir)
  try {
    const info = await stat(join(webRoot, 'index.html'))
    hash.update(`index.html:${info.size}:${Math.round(info.mtimeMs)}\n`)
  } catch { /* enélkül is van verzió */ }

  // Tizenkét hexa jegy: 48 bit. Ütközéshez milliárdnyi telepítés kellene, és
  // egy ütközés legrosszabb esetben egy elmaradt gyorsítótár-frissítés.
  const version = hash.digest('hex').slice(0, 12)
  cached = { root: webRoot, version }
  return version
}

/** A gyorsítótár eldobása. Teszthez. */
export function forgetClientVersion (): void { cached = null }

/**
 * Az `index.html` hivatkozásainak bélyegzése.
 *
 * Csak a `/src/` és a `/css/` előtagot írjuk át, és csak akkor, ha idézőjel
 * előzi meg — vagyis attribútum értékeként. Egy szövegben vagy egy
 * kommentben említett útvonal nem hivatkozás.
 *
 * AZ `assets/` SZÁNDÉKOSAN KIMARAD. Képek, betűk, videó: ritkán változnak, és
 * egy elavult kép legrosszabb esetben csúnya — nem törött alkalmazás. Ezzel
 * szemben a bélyegzésük minden telepítésnél újratöltetné őket, ami pont a
 * legnagyobb fájlok fölösleges újraküldése.
 */
export function stampAssets (html: string, version: string): string {
  if (!version) return html
  return html.replace(
    /(["'])\/(src|css)\//g,
    (_match, quote: string, dir: string) => `${quote}/${STAMP_PREFIX}/${version}/${dir}/`)
}

/**
 * Egy bélyegzett cím szétszedése.
 *
 * `/b/<verzió>/css/style.css` → `css/style.css`, vagy `null`, ha nem ilyen.
 *
 * A VERZIÓT NEM ELLENŐRIZZÜK a mostanihoz. Egy telepítés pillanatában a
 * látogató böngészőjében még a régi `index.html` futhat, és annak a régi
 * címeit is ki kell szolgálni — különben pont a telepítés másodpercében
 * törne el az oldal mindenkinél, aki épp nyitva tartja.
 */
export function unstamp (url: string): string | null {
  const path = url.split('?')[0] ?? ''
  const match = new RegExp(`^/${STAMP_PREFIX}/([0-9a-f]{6,64})/(.+)$`).exec(path)
  if (!match) return null
  const rest = match[2]!
  // A `..` semmilyen alakban nem mehet tovább: a kiszolgáló ugyan maga is
  // őrzi a gyökeret, de két zár jobb, mint egy.
  if (rest.split('/').includes('..') || rest.includes('\0')) return null
  const top = rest.split('/')[0]
  if (top === undefined || !STAMPED_DIRS.includes(top)) return null
  return rest
}


/**
 * Az API nyilvános alapcíme, amit a kliens használjon.
 *
 * MIÉRT VAN ERRE SZÜKSÉG. A webkliens ma az azonos origóból indul ki
 * (`window.location.origin`), és ez egyetlen konténeres telepítésen helyes: a
 * lapot és az API-t ugyanaz a folyamat szolgálja ki. Amint az APP külön gépre
 * kerül, ez a feltevés a saját origójára mutatna, ahol nincs API.
 *
 * A LAP MÁR A KISZOLGÁLÓN KÉSZÜL (a hivatkozásokat verzióval bélyegezzük),
 * tehát van hova beírni a címet — nem kell sem építési lépés, sem
 * routercsere. Üres beállításnál a kliens az eddigi viselkedést tartja.
 *
 * Az ELLENŐRZÉS ugyanaz, mint a médiaalapnál: csak `https://` cím vagy saját
 * útvonal fogadható el. A `//idegen/` alakú, séma nélküli cím abszolút
 * útvonalnak LÁTSZIK, a böngésző viszont idegen gazdának olvassa — és ide a
 * hitelesítési kérések mennének.
 */
export function apiBaseUrl (): string | null {
  const raw = (process.env.API_PUBLIC_URL ?? '').trim()
  if (!raw) return null
  const absolute = /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?(\/[a-z0-9._~/-]{0,120})?$/i.test(raw)
  const relative = /^\/(?!\/)[a-z0-9._~/-]{0,120}$/i.test(raw)
  if (!absolute && !relative) return null
  return raw.replace(/\/+$/, '')
}

/**
 * Az API címének beírása a lapba.
 *
 * `<meta name="yume:api-base">` — adat, nem szkript. A lap szándékosan
 * szkriptmentes marad ezen a ponton: a `script-src 'self'` a beágyazott
 * szkriptet megfogná, és ezt egy hibaoldalon már megtanultuk.
 *
 * A jelölő a `<head>` elejére kerül, a stíluslapok elé — a kliens a
 * modulbetöltés után olvassa ki, tehát a sorrend csak annyit számít, hogy
 * legyen ott, mire a JavaScript fut.
 */
export function stampApiBase (html: string, base: string | null): string {
  if (!base) return html
  const tag = `<meta name="yume:api-base" content="${base.replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)}">`
  return html.includes('<head>') ? html.replace('<head>', `<head>\n  ${tag}`) : html
}
