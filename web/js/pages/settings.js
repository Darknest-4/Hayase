/* global window, document, U, Store */
// Settings page — theme, NSFW toggle, cache/data management.
// The theme values are the same ones the original app ships (app.css).

const PageSettings = {
  render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    pad.append(U.el('h1', { class: 'section-title', style: 'font-size:1.6rem;margin-bottom:1.25rem;', text: 'Settings' }))

    const settings = Store.settings()

    // ---- theme ----
    const themeSelect = U.el('select', {
      class: 'select',
      onchange: e => {
        Store.saveSettings({ theme: e.target.value })
        Store.applyTheme()
      }
    }, [
      ['default', 'Dark (default)'],
      ['light', 'Light'],
      ['catppuccin', 'Catppuccin']
    ].map(([value, label]) => U.el('option', { value, text: label, ...(settings.theme === value ? { selected: '' } : {}) })))

    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'Theme' }),
      U.el('p', { text: 'Interface color scheme — same palettes as the desktop app.' }),
      themeSelect
    ]))

    // ---- NSFW ----
    const nsfwToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox',
        ...(settings.nsfw ? { checked: '' } : {}),
        onchange: e => {
          Store.saveSettings({ nsfw: e.target.checked })
          // search cache depends on this flag
          Store.clearCache()
        }
      }),
      U.el('span', { class: 'slider' })
    ])

    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'Show adult content' }),
      U.el('p', { text: 'Include 18+ entries in search results and listings.' }),
      nsfwToggle
    ]))

    // ---- cache ----
    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'API cache' }),
      U.el('p', { text: 'Responses from AniList / Jikan / ani.zip are cached locally to keep the app fast and avoid rate limits.' }),
      U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => Store.clearCache() }, [document.createTextNode('Clear cache')])
    ]))

    // ---- data ----
    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'My data' }),
      U.el('p', { text: 'Your anime list, favourites and progress are stored only in this browser (localStorage). Export it as JSON to back it up or move it to another device.' }),
      U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => {
            const data = {
              animelist: Store.list(),
              favourites: Store.favourites(),
              settings: Store.settings()
            }
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
            const a = U.el('a', { href: URL.createObjectURL(blob), download: 'hayase-data.json' })
            a.click()
            URL.revokeObjectURL(a.href)
          }
        }, [document.createTextNode('Export data')]),
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => {
            const input = U.el('input', { type: 'file', accept: 'application/json' })
            input.onchange = async () => {
              try {
                const data = JSON.parse(await input.files[0].text())
                if (data.animelist) Store._write('animelist', data.animelist)
                if (data.favourites) Store._write('favourites', data.favourites)
                if (data.settings) Store._write('settings', data.settings)
                Store.applyTheme()
                U.toast('Data imported')
              } catch (e) {
                U.toast('Invalid file', 'error')
              }
            }
            input.click()
          }
        }, [document.createTextNode('Import data')]),
        U.el('button', {
          class: 'btn btn-sm',
          style: 'background:var(--destructive);color:var(--destructive-foreground);',
          onclick: () => {
            if (window.confirm('Delete ALL local data (list, favourites, settings)?')) {
              Store.clearAll()
              window.location.reload()
            }
          }
        }, [document.createTextNode('Delete all data')])
      ])
    ]))

    // ---- about ----
    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'About' }),
      U.el('p', { html: 'Hayase — pure HTML/CSS/JS build. Data from <a href="https://anilist.co" target="_blank" rel="noopener" style="text-decoration:underline;">AniList</a>, <a href="https://jikan.moe" target="_blank" rel="noopener" style="text-decoration:underline;">Jikan (MyAnimeList)</a> and <a href="https://api.ani.zip" target="_blank" rel="noopener" style="text-decoration:underline;">ani.zip</a>. This build has no torrent playback — that requires the desktop app with its native client.' })
    ]))
  }
}

window.PageSettings = PageSettings
