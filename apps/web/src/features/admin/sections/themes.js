/* global confirm, document */
// Admin — Témák.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('themes')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  // ---- themes ----
  //
  // A theme used to be an extension: a package in a store, sandboxed in a
  // worker, asked over a message channel for a list of colours. That is a lot
  // of machinery for twelve hex values, and it meant an operator could not put
  // their own palette in front of their own viewers without publishing one.

  async renderThemes (content) {
    const load = async () => {
      content.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.themes.list()
        this.paintThemes(content, data, load)
      } catch (e) {
        content.replaceChildren(P.errorState('A témák betöltése nem sikerült: ' + e.message))
      }
    }
    await load()
  },

  paintThemes (content, themes, reload) {
    content.replaceChildren()
    content.append(U.el('p', { class: 'meta-note', text: 'The default is what a viewer who has never chosen sees. Changing it does not repaint anyone who has picked their own — that is their choice.' }))

    const grid = U.el('div', { class: 'theme-admin-grid' })
    for (const theme of themes) {
      const card = U.el('div', { class: 'theme-admin-card' + (theme.enabled ? '' : ' theme-admin-off') }, [
        U.el('div', { class: 'theme-admin-head' }, [
          U.el('span', { class: 'theme-admin-swatch', style: `background:${theme.accent ?? 'var(--accent)'};` }),
          U.el('div', { class: 'theme-admin-name' }, [
            U.el('div', { class: 'theme-admin-title', text: theme.name }),
            U.el('div', { class: 'theme-admin-slug', text: `${theme.slug} · ${theme.base}${theme.accent ? '' : ' · stylesheet accent'}` })
          ]),
          theme.is_default ? U.el('span', { class: 'cat-badge cat-badge-default', text: 'alapértelmezett' }) : null,
          theme.built_in ? U.el('span', { class: 'cat-badge', title: 'A telepítés része; átszínezhető és kikapcsolható, de nem törölhető.', text: 'beépített' }) : null
        ]),
        U.el('div', { class: 'theme-admin-actions' }, [
          // An accent is a colour, so the control is a colour picker: typing
          // a hex value by hand is how a theme ends up one character wrong.
          U.el('input', {
            type: 'color',
            class: 'theme-color-input theme-admin-picker',
            value: U.toHex(theme.accent) ?? '#f43f6e',
            title: 'Átszínezés',
            onchange: async e => {
              try {
                await YumeAPI.admin.themes.update(theme.id, { accent: e.target.value })
                U.toast(`${theme.name} recoloured`)
                await reload()
              } catch (err) { U.toast(err.message, 'error') }
            }
          }),
          theme.is_default
            ? null
            : U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                try {
                  await YumeAPI.admin.themes.update(theme.id, { isDefault: true })
                  U.toast(`${theme.name} is now the default`)
                  await reload()
                } catch (err) { U.toast(err.message, 'error') }
              }
            }, [document.createTextNode('Legyen az alapértelmezett')]),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              try {
                await YumeAPI.admin.themes.update(theme.id, { enabled: !theme.enabled })
                await reload()
              } catch (err) { U.toast(err.message, 'error') }
            }
          }, [document.createTextNode(theme.enabled ? 'Disable' : 'Enable')]),
          theme.built_in
            ? null
            : U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                if (!confirm(`Delete the "${theme.name}" theme?`)) return
                try {
                  await YumeAPI.admin.themes.remove(theme.id)
                  U.toast('Téma törölve')
                  await reload()
                } catch (err) { U.toast(err.message, 'error') }
              }
            }, [document.createTextNode('✕')])
        ])
      ])
      grid.append(card)
    }
    content.append(grid)

    // ---- add one ----
    const draft = { slug: '', name: '', base: 'dark', accent: '#7c5cff' }
    let slugInput
    const field = (label, node) => U.el('label', { class: 'cat-field' }, [
      U.el('span', { class: 'cat-field-label', text: label }), node
    ])
    content.append(
      U.el('h3', { class: 'detail-section-title', text: 'Téma hozzáadása' }),
      U.el('div', { class: 'src-add-grid' }, [
        field('Név', U.el('input', {
          class: 'input',
          placeholder: 'A látogatóknak látszik',
          oninput: e => {
            draft.name = e.target.value
            // The slug follows the name until somebody edits it themselves:
            // it is an identifier, and asking for one is asking a viewer-facing
            // question about a machine-facing field.
            if (!draft.slugTouched) {
              draft.slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
              slugInput.value = draft.slug
            }
          }
        })),
        field('Azonosító', slugInput = U.el('input', {
          class: 'input',
          placeholder: 'my-theme',
          oninput: e => { draft.slugTouched = true; draft.slug = e.target.value }
        })),
        field('Alap', U.el('select', {
          class: 'select',
          onchange: e => { draft.base = e.target.value }
        }, [U.el('option', { value: 'dark', text: 'Sötét' }), U.el('option', { value: 'light', text: 'Világos' })])),
        field('Kiemelőszín', U.el('input', {
          class: 'theme-color-input',
          type: 'color',
          value: '#7c5cff',
          oninput: e => { draft.accent = e.target.value }
        }))
      ]),
      U.el('div', { class: 'admin-toolbar' }, [
        U.el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!draft.name.trim() || !draft.slug.trim()) { U.toast('A név és az azonosító kötelező', 'error'); return }
            try {
              await YumeAPI.admin.themes.create({
                slug: draft.slug.trim(), name: draft.name.trim(), base: draft.base, accent: draft.accent
              })
              U.toast('Téma hozzáadva')
              await reload()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [U.el('span', { text: 'Téma hozzáadása' })])
      ])
    )
  }
}
