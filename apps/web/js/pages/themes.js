/* global Store, U, YumeAPI, document, window, T */
// Theme Engine — pick a base (dark/light), choose an accent from curated
// presets or a fully custom colour, and optionally tint surfaces toward the
// accent. Applied live via CSS custom-property overrides (Store.applyTheme).

const PageThemes = {
  /**
   * The themes this deployment offers.
   *
   * They used to come from two places that could not see each other: a
   * hard-coded list in this file, and whatever `theme` extensions returned
   * over the sandbox message channel. So an operator could not add a palette
   * without publishing a package, and the two lists could disagree about a
   * slug with nothing to arbitrate.
   *
   * One table now, ordered by the operator. Asynchronous and best-effort: the
   * fallback list below is already on screen by the time this runs, so a slow
   * or unreachable server delays nothing. A theme is cosmetic — it is never
   * worth an error state.
   */
  async _appendSiteThemes (pad, grid, swatch) {
    let themes
    try {
      themes = await YumeAPI.themes()
    } catch (e) {
      return
    }
    const usable = (themes ?? []).filter(row =>
      // Only the two bases the engine implements. Anything else would set a
      // data-theme the stylesheet has no rules for and render an unstyled page.
      row?.base === 'dark' || row?.base === 'light'
    )
    if (!usable.length) return

    // The server's list replaces the fallback rather than joining it: two
    // grids of near-identical swatches is not a choice, it is a puzzle.
    grid.replaceChildren()
    for (const theme of usable) {
      grid.append(swatch({
        slug: theme.slug,
        name: theme.name || theme.slug,
        base: theme.base,
        accent: theme.accent,
        tint: theme.tint,
        tokens: theme.tokens
      }))
    }
  },

  /**
   * What to draw before the server answers, and if it never does.
   *
   * The same rows the themes table is seeded with, so the two agree; kept here
   * so a fresh page paints a full grid rather than an empty box that fills in.
   */
  PRESETS: [
    { slug: 'rose', name: 'Rose', base: 'dark', accent: 'hsl(346.6 79% 51%)' },
    { slug: 'sakura', name: 'Sakura', base: 'light', accent: 'hsl(340 82% 62%)' },
    { slug: 'ocean', name: 'Ocean', base: 'dark', accent: 'hsl(200 90% 55%)' },
    { slug: 'aurora', name: 'Aurora', base: 'dark', accent: 'hsl(160 70% 48%)' },
    { slug: 'grape', name: 'Grape', base: 'dark', accent: 'hsl(265 80% 66%)' },
    { slug: 'ember', name: 'Ember', base: 'dark', accent: 'hsl(18 90% 56%)' },
    { slug: 'gold', name: 'Gold', base: 'dark', accent: 'hsl(42 90% 55%)' },
    { slug: 'mono', name: 'Mono', base: 'dark', accent: 'hsl(0 0% 82%)' },
    { slug: 'dawn', name: 'Dawn', base: 'light', accent: 'hsl(215 90% 55%)' }
  ],

  render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('h1', { class: 'page-title', text: T('Theme Engine') }))
    pad.append(U.el('p', { class: 'list-row-sub', style: 'margin-top:-.5rem;', text: T('Personalise Yume. Changes apply instantly and are saved for this profile.') }))
    this.body(pad)
  },

  // embeddable body — used standalone and inside Settings › Appearance
  body (pad) {
    const settings = Store.settings()
    const currentBase = settings.themeBase ?? (settings.theme === 'light' ? 'light' : 'dark')
    const currentAccent = settings.themeAccent ?? null

    // ---- base toggle ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: T('Base') }))
    const baseRow = U.el('div', { class: 'theme-base-row' })
    for (const [value, label, icon] of [['dark', 'Dark', '🌙'], ['light', 'Light', '☀️']]) {
      baseRow.append(U.el('button', {
        class: 'theme-base-opt' + (currentBase === value ? ' active' : ''),
        onclick: () => { Store.setTheme({ base: value }); window.App.navigate() }
      }, [U.el('span', { text: icon }), document.createTextNode(label)]))
    }
    pad.append(baseRow)

    // ---- accent presets ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: T('Accent') }))
    const grid = U.el('div', { class: 'theme-grid' })
    const currentSlug = settings.themeSlug ?? null
    const swatch = (preset, from) => {
      // By slug when the theme has one — two themes may legitimately share an
      // accent, and the selected card should be the one that was clicked.
      const active = preset.slug && currentSlug
        ? preset.slug === currentSlug
        : currentAccent === preset.accent && currentBase === preset.base
      return U.el('button', {
        class: 'theme-swatch-card' + (active ? ' active' : ''),
        title: from ? `${preset.name} · ${from}` : preset.name,
        onclick: () => {
          Store.setTheme({
            base: preset.base,
            accent: preset.accent ?? '',
            tokens: preset.tokens ?? {},
            slug: preset.slug ?? ''
          })
          window.App.navigate()
        }
      }, [
        U.el('span', { class: 'theme-swatch', style: `background:${preset.accent ?? 'var(--accent)'};` }),
        U.el('span', { class: 'theme-swatch-name', text: preset.name }),
        U.el('span', { class: 'theme-swatch-base', text: preset.base })
      ])
    }

    for (const p of this.PRESETS) grid.append(swatch(p))
    pad.append(grid)
    this._appendSiteThemes(pad, grid, swatch)

    // ---- custom colour ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: T('Custom accent') }))
    const picker = U.el('input', {
      type: 'color',
      class: 'theme-color-input',
      value: this._toHex(currentAccent) ?? '#f43f6e',
      oninput: e => { Store.setTheme({ accent: e.target.value }) },
      onchange: () => window.App.navigate()
    })
    pad.append(U.el('div', { class: 'theme-custom-row' }, [
      picker,
      U.el('div', {}, [
        U.el('div', { style: 'font-weight:700;font-size:.9rem;', text: T('Pick any colour') }),
        U.el('div', { class: 'list-row-sub', text: T('Drag the picker — the whole UI recolours live.') })
      ]),
      U.el('button', {
        class: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;',
        onclick: () => { Store.setTheme({ accent: '', tint: false }); window.App.navigate() }
      }, [document.createTextNode(T('Reset to default'))])
    ]))

    // ---- surface tint ----
    const tint = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox',
        ...(settings.themeTint ? { checked: '' } : {}),
        onchange: e => Store.setTheme({ tint: e.target.checked })
      }),
      U.el('span', { class: 'slider' })
    ])
    pad.append(U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:1rem;margin-top:1rem;' }, [
      U.el('div', { style: 'flex-grow:1;' }, [
        U.el('h3', { style: 'margin:0;', text: T('Tint surfaces') }),
        U.el('p', { style: 'margin:.2rem 0 0;', text: T('Blend a hint of the accent colour into cards and panels.') })
      ]),
      tint
    ]))

    // ---- live preview ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: T('Preview') }))
    pad.append(U.el('div', { class: 'theme-preview' }, [
      U.el('div', { class: 'theme-preview-card' }, [
        U.el('div', { class: 'theme-preview-title', text: T('Attack on Titan') }),
        U.el('div', { class: 'theme-preview-sub', text: T('TV · Finished · 25 episodes') }),
        U.el('div', { style: 'display:flex;gap:.5rem;margin-top:.75rem;' }, [
          U.el('span', { class: 'btn btn-primary btn-sm', text: T('Play') }),
          U.el('span', { class: 'btn btn-secondary btn-sm', text: T('Add to list') }),
          U.el('span', { class: 'badge badge-outline', text: T('Action') })
        ]),
        U.el('div', { class: 'ach-progress-track', style: 'margin-top:.9rem;' }, [
          U.el('div', { class: 'ach-progress-fill', style: 'width:68%;' })
        ])
      ])
    ]))
  },

  // Shared with the admin theme editor, which needs exactly the same thing.
  _toHex (value) {
    return U.toHex(value)
  }
}

window.PageThemes = PageThemes
