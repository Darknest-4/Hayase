/* global document */
// Egy képernyő saját stíluslapja — akkor töltődik be, amikor az a képernyő
// először kirajzolódik.
//
// Az index.html eddig hat stíluslapot kért minden oldalon, köztük az
// adminfelületét (kétezer sor), a lejátszóét és a karbantartási lapét. Egy
// látogató, aki soha nem lép be az adminba, minden betöltéskor letöltötte és
// végigillesztette az admin szabályait. Most a lap csak a hármat kéri, ami
// minden képernyőnek kell (tokens, components, style), a többit az a modul,
// amelyik rajzol belőle.
//
// A cím a MODUL SAJÁT címéből épül (`import.meta.url`). A kiszolgáló a klienst
// verzióbélyeggel szolgálja ki (`/b/<bélyeg>/src/…`), és a stíluslapnak
// ugyanazzal a bélyeggel kell jönnie — különben egy telepítés után a régi,
// örökre gyorsítótárazott változat töltődne be az új kód mellé.

const loaded = new Map()

/**
 * Betölti a `css/<name>` stíluslapot, egyszer.
 *
 * A visszaadott ígéret akkor teljesül, amikor a lap alkalmazva van — vagy
 * amikor a betöltés elhasalt: egy hiányzó stíluslap nem akaszthatja meg a
 * képernyőt, ami kérte. Csúnyább lesz, de működik.
 *
 * @param {string} name  például `admin.css`
 * @returns {Promise<void>}
 */
export function loadStylesheet (name) {
  if (loaded.has(name)) return loaded.get(name)
  const promise = new Promise(resolve => {
    try {
      const href = new URL(`../../../css/${name}`, import.meta.url).href
      const already = [...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === href)
      if (already || !document.head) { resolve(); return }
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.setAttribute('data-sheet', name)
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener('error', () => resolve(), { once: true })
      document.head.append(link)
    } catch {
      // Nem DOM-os környezet (egységteszt), vagy tiltott művelet: a képernyő
      // stílus nélkül is kirajzolható, ezt nem akaszthatja meg.
      resolve()
    }
  })
  loaded.set(name, promise)
  return promise
}
