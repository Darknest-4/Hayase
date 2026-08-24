/* global Store, U, document, getComputedStyle, window, T */
// Theme Engine — pick a base (dark/light), choose an accent from curated
// presets or a fully custom colour, and optionally tint surfaces toward the
// accent. Applied live via CSS custom-property overrides (Store.applyTheme).

const PageThemes = {
  /**
   * Ask theme extensions what they offer, and draw them under their own
   * heading.
   *
   * Asynchronous and best-effort: the built-in themes are already on screen by
   * the time this runs, so a slow or broken extension delays nothing and
   * removes nothing. A theme is cosmetic — it is never worth an error state.
   */
  async _appendExtensionThemes (pad, currentAccent, currentBase, swatch) {
    const host = window.ExtensionHost
    if (!host?.collect) return

    let results = []
    try {
      ({ results } = await host.collect('theme', undefined, { types: ['theme'] }))
    } catch (e) {
      return
    }

    const themes = (results ?? []).filter(row =>
      row?.kind === 'theme' &&
      typeof row.accent === 'string' &&
      // Only the two bases the engine implements. Anything else would set a
      // data-theme the stylesheet has no rules for and render an unstyled page.
      (row.base === 'dark' || row.base === 'light')
    )
    if (!themes.length) return

    pad.append(U.el('h2', { class: 'settings-group-title', text: T('From extensions') }))
    const grid = U.el('div', { class: 'theme-swatch-grid' })
    for (const theme of themes) {
      grid.append(swatch({
        name: theme.name || theme.slug || 'Theme',
        base: theme.base,
        accent: theme.accent
      }, theme._source))
    }
    pad.append(grid)
  },

  PRESETS: [
    { slug: 'rose', name: 'Rose', base: 'dark', accent: 'hsl(346.6 79% 51%)' },
    { slug: 'sakura', name: 'Sakura', base: 'light', accent: 'hsl(340 82% 62%)' },
    { slug: 'ocean', name: 'Ocean', base: 'dark', accent: 'hsl(200 90% 55%)' },
    { slug: 'aurora', name: 'Aurora', base: 'dark', accent: 'hsl(160 70% 48%)' },
    { slug: 'grape', name: 'Grape', base: 'dark', accent: 'hsl(265 80% 66%)' },
    { slug: 'ember', name: 'Ember', base: 'dark', accent: 'hsl(18 90% 56%)' },
    { slug: 'gold', name: 'Gold', base: 'dark', accent: 'hsl(42 90% 55%)' },
    { slug: 'mono', name: 'Mono', base: 'dark', accent: 'hsl(0 0% 82%)' },
    { slug: 'daylight', name: 'Daylight', base: 'light', accent: 'hsl(215 90% 55%)' }
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
    const swatch = (preset, from) => {
      const active = currentAccent === preset.accent && currentBase === preset.base
      return U.el('button', {
        class: 'theme-swatch-card' + (active ? ' active' : ''),
        title: from ? `${preset.name} · ${from}` : preset.name,
        onclick: () => { Store.setTheme({ base: preset.base, accent: preset.accent }); window.App.navigate() }
      }, [
        U.el('span', { class: 'theme-swatch', style: `background:${preset.accent};` }),
        U.el('span', { class: 'theme-swatch-name', text: preset.name }),
        U.el('span', { class: 'theme-swatch-base', text: preset.base })
      ])
    }

    for (const p of this.PRESETS) grid.append(swatch(p))
    pad.append(grid)

    // Themes contributed by `theme` extensions.
    //
    // The type has been valid in the manifest validator since the store
    // existed and nothing ever consumed it, so a theme pack could be published
    // and installed and would then do nothing at all. This is the consumer.
    //
    // Appended after the built-ins rather than merged into them: a viewer
    // should be able to tell which themes came from where, and an extension
    // should not be able to shadow a built-in by reusing its slug.
    this._appendExtensionThemes(pad, currentAccent, currentBase, swatch)

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

  // best-effort conversion of an accent value to a #rrggbb for the picker
  _toHex (value) {
    if (!value) return null
    if (value.startsWith('#')) return value
    try {
      const probe = document.createElement('span')
      probe.style.color = value
      document.body.append(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      const m = rgb.match(/\d+/g)
      if (!m) return null
      return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')
    } catch (e) {
      return null
    }
  }
}

window.PageThemes = PageThemes
