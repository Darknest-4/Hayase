// Yume Theme Pack — extra colour themes for the Theme Engine.
//
// ---------------------------------------------------------------------------
// The smallest useful extension there is
// ---------------------------------------------------------------------------
// A theme is pure data: a base (dark or light), an accent colour, and a name.
// So this declares no permissions at all — no network, no ids, no storage. It
// cannot reach anything, which makes it a good reference for the `theme` type
// and a safe thing to install.
//
// The engine applies an accent by overriding CSS custom properties, deriving
// hover and soft variants from it with color-mix. That is why each theme needs
// only one colour rather than a palette: the rest is computed.
//
// ---------------------------------------------------------------------------
// Choosing the colours
// ---------------------------------------------------------------------------
// Every accent is given in HSL with lightness in the band the interface was
// designed around — bright enough to read as an accent on a near-black ground,
// dark enough to stay legible as text on a light one. A colour outside that
// band still "works" in the sense that nothing errors, and looks wrong.
//
// Light-base themes carry a darker accent than their dark-base counterparts
// for exactly that reason: the same hue at the same lightness that reads well
// on black is washed out on white.

const THEMES = [
  // ---- dark ----
  { slug: 'forest', name: 'Forest', base: 'dark', accent: 'hsl(146 55% 45%)' },
  { slug: 'midnight', name: 'Midnight', base: 'dark', accent: 'hsl(222 85% 62%)' },
  { slug: 'crimson', name: 'Crimson', base: 'dark', accent: 'hsl(352 72% 52%)' },
  { slug: 'teal', name: 'Teal', base: 'dark', accent: 'hsl(180 68% 44%)' },
  { slug: 'magenta', name: 'Magenta', base: 'dark', accent: 'hsl(310 75% 58%)' },
  { slug: 'slate', name: 'Slate', base: 'dark', accent: 'hsl(210 16% 62%)' },
  { slug: 'apricot', name: 'Apricot', base: 'dark', accent: 'hsl(28 88% 60%)' },
  { slug: 'iris', name: 'Iris', base: 'dark', accent: 'hsl(248 72% 68%)' },

  // ---- light ----
  { slug: 'paper', name: 'Paper', base: 'light', accent: 'hsl(222 70% 45%)' },
  { slug: 'moss', name: 'Moss', base: 'light', accent: 'hsl(146 52% 32%)' },
  { slug: 'plum', name: 'Plum', base: 'light', accent: 'hsl(300 55% 40%)' },
  { slug: 'clay', name: 'Clay', base: 'light', accent: 'hsl(18 62% 44%)' }
]

export default {
  /**
   * Always available.
   *
   * There is nothing to reach and nothing to authenticate, so the honest
   * answer is yes. Returning false to mean "no themes configured" would make
   * the portal report a fault where there is none.
   */
  async test () {
    return true
  },

  async theme (query, options) {
    const includeLight = (options ?? {}).include_light !== false
    return THEMES
      .filter(entry => includeLight || entry.base !== 'light')
      .map(entry => ({
        kind: 'theme',
        slug: entry.slug,
        name: entry.name,
        base: entry.base,
        accent: entry.accent
      }))
  }
}
