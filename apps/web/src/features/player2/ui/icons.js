// A lejátszó ikonjai.
//
// Egy helyen, `<path>` adatként, mert az ikonok hivatkozásokként szétszórva
// pont azt veszítik el, ami itt a lényeg: MINDEGYIK ugyanabban a rácsban,
// ugyanazzal a vonalvastagsággal készült. Egy sorban egy fél képponttal
// odébb ülő ikon látszik.

const PATHS = {
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  back10: '<path d="M11 8v8M8 11l3-3"/><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  forward10: '<path d="M13 8v8M16 11l-3-3"/><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  volumeLow: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  subtitles: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 13h4M14 13h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  exitFullscreen: '<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M16 21v-3a2 2 0 0 1 2-2h3M8 21v-3a2 2 0 0 0-2-2H3"/>',
  pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/>',
  cinema: '<rect x="2" y="6" width="20" height="12" rx="2"/>',
  next: '<path d="M5 4l10 8-10 8z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  previous: '<path d="M19 4L9 12l10 8z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  warning: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
}

/**
 * Egy ikon SVG-ként.
 *
 * `aria-hidden`, mert az ikon MELLETT mindig van szöveg vagy `aria-label` —
 * egy felolvasott „svg grafika" nem mond semmit.
 */
export function icon (name, size = 20) {
  const paths = PATHS[name]
  if (!paths) return ''
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true" focusable="false">${paths}</svg>`
}

export const ICON_NAMES = Object.freeze(Object.keys(PATHS))
