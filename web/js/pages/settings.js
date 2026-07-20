/* global window, document, U, C, Store */
// Settings — categorized into sections (Account, Appearance, Content,
// Notifications, Data, About) with a left-hand tab rail, Netflix/Discord
// style. Each section is a builder that returns its content node.

const PageSettings = {
  SECTIONS: [
    { key: 'account', label: 'Account', icon: '👤' },
    { key: 'appearance', label: 'Appearance', icon: '🎨' },
    { key: 'content', label: 'Content', icon: '🔞' },
    { key: 'notifications', label: 'Notifications', icon: '🔔' },
    { key: 'data', label: 'Data', icon: '💾' },
    { key: 'about', label: 'About', icon: 'ℹ️' }
  ],

  render (root, params) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('h1', { class: 'page-title', text: 'Settings' }))

    const active = params.get('tab') ?? 'account'
    const layout = U.el('div', { class: 'settings-layout' })
    pad.append(layout)

    // ---- tab rail ----
    const rail = U.el('nav', { class: 'settings-rail' })
    for (const s of this.SECTIONS) {
      rail.append(U.el('a', {
        class: 'settings-tab' + (s.key === active ? ' active' : ''),
        href: `#/settings?tab=${s.key}`
      }, [U.el('span', { class: 'settings-tab-icon', text: s.icon }), document.createTextNode(s.label)]))
    }
    layout.append(rail)

    // ---- panel ----
    const panel = U.el('div', { class: 'settings-panel' })
    layout.append(panel)
    const builder = this['_' + active] ?? this._account
    panel.append(builder.call(this))
  },

  _card (title, desc, ...children) {
    return U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: title }),
      desc ? U.el('p', { text: desc }) : null,
      ...children
    ])
  },

  // ---- Account ----
  _account () {
    const wrap = U.el('div')
    const settings = Store.settings()
    wrap.append(this._card('Profile name', 'Shown on your profile page.',
      U.el('input', {
        class: 'input', type: 'text', maxlength: '50',
        value: settings.profileName ?? '', placeholder: 'Dreamer',
        onchange: e => Store.saveSettings({ profileName: e.target.value.trim() || undefined })
      })
    ))
    wrap.append(C.authCard())
    wrap.append(this._card('Yume server', 'Backend endpoint for platform features (extension store, sync). Leave as-is for local development.',
      U.el('input', {
        class: 'input', type: 'url', style: 'min-width:20rem;',
        value: window.YumeAPI.base(),
        onchange: e => { window.YumeAPI.setBase(e.target.value); U.toast('Yume server updated') }
      })
    ))
    wrap.append(this._card('Watch profiles', 'Manage the profiles on this account — each has its own library, history and settings.',
      U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [
        U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/profiles?manage=1' }, [document.createTextNode('Manage profiles')]),
        U.el('a', { class: 'btn btn-ghost btn-sm', href: '#/profiles' }, [document.createTextNode('Switch profile')])
      ])
    ))
    return wrap
  },

  // ---- Appearance ----
  _appearance () {
    const wrap = U.el('div')
    const settings = Store.settings()
    const base = settings.themeBase ?? (settings.theme === 'light' ? 'light' : 'dark')

    const themeSelect = U.el('select', {
      class: 'select',
      onchange: e => { Store.setTheme({ base: e.target.value }) }
    }, [['dark', 'Dark'], ['light', 'Light']].map(([value, label]) =>
      U.el('option', { value, text: label, ...(base === value ? { selected: '' } : {}) })))

    wrap.append(this._card('Base theme', 'Dark by default, light for daylight.', themeSelect))
    wrap.append(this._card('Theme Engine', 'Custom accent colours, curated presets and a live preview.',
      U.el('a', { class: 'btn btn-primary btn-sm', href: '#/themes' }, [document.createTextNode('Open Theme Engine →')])
    ))

    // title language
    const langSelect = U.el('select', {
      class: 'select',
      onchange: e => Store.saveSettings({ titleLang: e.target.value })
    }, [
      ['userPreferred', 'Preferred (AniList default)'],
      ['english', 'English'],
      ['romaji', 'Romaji'],
      ['native', 'Native']
    ].map(([value, label]) => U.el('option', { value, text: label, ...(settings.titleLang === value ? { selected: '' } : {}) })))
    wrap.append(this._card('Title language', 'How anime titles are displayed across the app.', langSelect))
    return wrap
  },

  // ---- Content ----
  _content () {
    const wrap = U.el('div')
    const settings = Store.settings()
    const nsfwToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox', ...(settings.nsfw ? { checked: '' } : {}),
        onchange: e => { Store.saveSettings({ nsfw: e.target.checked }); Store.clearCache() }
      }),
      U.el('span', { class: 'slider' })
    ])
    wrap.append(this._card('Show adult content', 'Include 18+ entries in search results and listings.', nsfwToggle))

    const autoplayToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox', ...(settings.autoplay !== false ? { checked: '' } : {}),
        onchange: e => Store.saveSettings({ autoplay: e.target.checked })
      }),
      U.el('span', { class: 'slider' })
    ])
    wrap.append(this._card('Autoplay next episode', 'Automatically start the next episode when one finishes.', autoplayToggle))

    const skipToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox', ...(settings.autoSkip ? { checked: '' } : {}),
        onchange: e => Store.saveSettings({ autoSkip: e.target.checked })
      }),
      U.el('span', { class: 'slider' })
    ])
    wrap.append(this._card('Auto-skip intros', 'Skip openings and endings automatically when timing data is available (AniSkip).', skipToggle))
    return wrap
  },

  // ---- Notifications ----
  _notifications () {
    const wrap = U.el('div')
    const settings = Store.settings()
    const prefs = settings.notifPrefs ?? { airing: true, resume: true, achievement: true }

    wrap.append(U.el('p', { class: 'list-row-sub', style: 'margin-bottom:1rem;', text: 'Choose which notifications appear in your inbox. These are generated from your library and activity — no account required.' }))

    for (const [key, title, desc] of [
      ['airing', 'Airing episodes', 'When a new episode of something in your library airs.'],
      ['resume', 'Continue watching', 'Reminders to pick up shows you started but paused.'],
      ['achievement', 'Achievements', 'When you unlock a new achievement.']
    ]) {
      const toggle = U.el('label', { class: 'switch' }, [
        U.el('input', {
          type: 'checkbox', ...(prefs[key] !== false ? { checked: '' } : {}),
          onchange: e => {
            const next = { ...(Store.settings().notifPrefs ?? { airing: true, resume: true, achievement: true }), [key]: e.target.checked }
            Store.saveSettings({ notifPrefs: next })
            window.App.refreshNotifBadge?.()
          }
        }),
        U.el('span', { class: 'slider' })
      ])
      wrap.append(this._card(title, desc, toggle))
    }
    wrap.append(this._card('Notification inbox', 'View and manage all your notifications.',
      U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/notifications' }, [document.createTextNode('Open inbox')])
    ))
    return wrap
  },

  // ---- Data ----
  _data () {
    const wrap = U.el('div')
    wrap.append(this._card('API cache', 'Responses from AniList / Jikan / ani.zip are cached locally to keep the app fast and avoid rate limits.',
      U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => Store.clearCache() }, [document.createTextNode('Clear cache')])
    ))
    wrap.append(this._card('My data', 'Your anime list, favourites and progress live only in this browser (localStorage). Export it as JSON to back it up or move devices.',
      U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => {
            const data = { animelist: Store.list(), favourites: Store.favourites(), settings: Store.settings(), history: Store.history() }
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
            const a = U.el('a', { href: URL.createObjectURL(blob), download: 'yume-data.json' })
            a.click(); URL.revokeObjectURL(a.href)
          }
        }, [document.createTextNode('Export data')]),
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => {
            const input = U.el('input', { type: 'file', accept: 'application/json' })
            input.onchange = async () => {
              try {
                const data = JSON.parse(await input.files[0].text())
                if (data.animelist) Store._write(Store._profileKey('animelist'), data.animelist)
                if (data.favourites) Store._write(Store._profileKey('favourites'), data.favourites)
                if (data.settings) Store._write(Store._profileKey('settings'), data.settings)
                if (data.history) Store._write(Store._profileKey('history'), data.history)
                Store.applyTheme()
                U.toast('Data imported')
              } catch (e) { U.toast('Invalid file', 'error') }
            }
            input.click()
          }
        }, [document.createTextNode('Import data')]),
        U.el('button', {
          class: 'btn btn-sm', style: 'background:var(--danger);color:white;',
          onclick: () => { if (window.confirm('Delete ALL local data (list, favourites, settings)?')) { Store.clearAll(); window.location.reload() } }
        }, [document.createTextNode('Delete all data')])
      ])
    ))
    return wrap
  },

  // ---- About ----
  _about () {
    const wrap = U.el('div')
    wrap.append(this._card('About Yume', null,
      U.el('p', { html: 'Yume (夢) — framework-free web client on the Yume design system. Data from <a href="https://anilist.co" target="_blank" rel="noopener" style="text-decoration:underline;">AniList</a>, <a href="https://jikan.moe" target="_blank" rel="noopener" style="text-decoration:underline;">Jikan (MyAnimeList)</a> and <a href="https://api.ani.zip" target="_blank" rel="noopener" style="text-decoration:underline;">ani.zip</a>. This build has no torrent playback — that requires the desktop app with its native client.' })
    ))
    return wrap
  }
}

window.PageSettings = PageSettings
