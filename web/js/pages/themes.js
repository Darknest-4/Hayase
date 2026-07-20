/* global window, document, U, Store */
// Theme Engine — pick a base (dark/light), choose an accent from curated
// presets or a fully custom colour, and optionally tint surfaces toward the
// accent. Applied live via CSS custom-property overrides (Store.applyTheme).

const PageThemes = {
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
    pad.append(U.el('h1', { class: 'page-title', text: 'Theme Engine' }))
    pad.append(U.el('p', { class: 'list-row-sub', style: 'margin-top:-.5rem;', text: 'Personalise Yume. Changes apply instantly and are saved for this profile.' }))
    this.body(pad)
  },

  // embeddable body — used standalone and inside Settings › Appearance
  body (pad) {
    const settings = Store.settings()
    const currentBase = settings.themeBase ?? (settings.theme === 'light' ? 'light' : 'dark')
    const currentAccent = settings.themeAccent ?? null

    // ---- base toggle ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: 'Base' }))
    const baseRow = U.el('div', { class: 'theme-base-row' })
    for (const [value, label, icon] of [['dark', 'Dark', '🌙'], ['light', 'Light', '☀️']]) {
      baseRow.append(U.el('button', {
        class: 'theme-base-opt' + (currentBase === value ? ' active' : ''),
        onclick: () => { Store.setTheme({ base: value }); window.App.navigate() }
      }, [U.el('span', { text: icon }), document.createTextNode(label)]))
    }
    pad.append(baseRow)

    // ---- accent presets ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: 'Accent' }))
    const grid = U.el('div', { class: 'theme-grid' })
    for (const p of this.PRESETS) {
      const active = currentAccent === p.accent && currentBase === p.base
      grid.append(U.el('button', {
        class: 'theme-swatch-card' + (active ? ' active' : ''),
        onclick: () => { Store.setTheme({ base: p.base, accent: p.accent }); window.App.navigate() }
      }, [
        U.el('span', { class: 'theme-swatch', style: `background:${p.accent};` }),
        U.el('span', { class: 'theme-swatch-name', text: p.name }),
        U.el('span', { class: 'theme-swatch-base', text: p.base })
      ]))
    }
    pad.append(grid)

    // ---- custom colour ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: 'Custom accent' }))
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
        U.el('div', { style: 'font-weight:700;font-size:.9rem;', text: 'Pick any colour' }),
        U.el('div', { class: 'list-row-sub', text: 'Drag the picker — the whole UI recolours live.' })
      ]),
      U.el('button', {
        class: 'btn btn-secondary btn-sm', style: 'margin-left:auto;',
        onclick: () => { Store.setTheme({ accent: '', tint: false }); window.App.navigate() }
      }, [document.createTextNode('Reset to default')])
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
        U.el('h3', { style: 'margin:0;', text: 'Tint surfaces' }),
        U.el('p', { style: 'margin:.2rem 0 0;', text: 'Blend a hint of the accent colour into cards and panels.' })
      ]),
      tint
    ]))

    // ---- live preview ----
    pad.append(U.el('h2', { class: 'detail-section-title', text: 'Preview' }))
    pad.append(U.el('div', { class: 'theme-preview' }, [
      U.el('div', { class: 'theme-preview-card' }, [
        U.el('div', { class: 'theme-preview-title', text: 'Attack on Titan' }),
        U.el('div', { class: 'theme-preview-sub', text: 'TV · Finished · 25 episodes' }),
        U.el('div', { style: 'display:flex;gap:.5rem;margin-top:.75rem;' }, [
          U.el('span', { class: 'btn btn-primary btn-sm', text: 'Play' }),
          U.el('span', { class: 'btn btn-secondary btn-sm', text: 'Add to list' }),
          U.el('span', { class: 'badge badge-outline', text: 'Action' })
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
