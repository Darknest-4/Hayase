// The accent a single title lends to the page it is on.
//
// A cover is mostly one colour, and the interface reads better when the one
// element competing with it — the play button, the active tab — agrees with it
// rather than fighting it in the site's rose. AniList ships that colour with
// every cover and the catalogue stores it as `anime_images.dominant_color`, so
// no analysis is needed at render time: it is already a field.
//
// Half the catalogue has no colour yet (20 232 of 40 349 primary images), so
// every consumer has to work without one. That is why this returns null rather
// than a default: the CSS already spells the fallback as
// `var(--custom, var(--accent))`, and one fallback in one place beats a second
// one invented here.

/**
 * Black or white, whichever can be read on `color`.
 *
 * ITU-R BT.601 luma, which is the same weighting the rest of the client uses
 * for cover chips. Returns an hsl() rather than the keywords `white`/`black`
 * so the value sits in the same notation as every token.
 */
function readableOn (color) {
  const hex = typeof color === 'string' && color.startsWith('#') ? color.slice(1) : null
  if (!hex || hex.length < 6) return 'hsl(0 0% 100%)'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? 'hsl(0 0% 0%)' : 'hsl(0 0% 100%)'
}

/**
 * The inline style that themes a subtree, or '' when the title has no colour.
 *
 *   U.el('div', { class: 'detail-page', style: titleTheme(media) })
 *
 * Spent as a style rather than a class because the value is per title: there
 * is no stylesheet that could hold forty thousand of them.
 */
export function titleTheme (media) {
  const color = media?.coverImage?.color ?? null
  if (!color) return ''
  return `--custom:${color};--custom-fg:${readableOn(color)};`
}

export { readableOn }
