/* global window, document, U, C, Store, T, Prefs */
// Settings — categorized into sections (Account, Appearance, Content,
// Notifications, Data, About) with a left-hand tab rail, Netflix/Discord
// style. Each section is a builder that returns its content node.

const PageSettings = {
  SECTIONS: [
  // Labels are stored in English and translated where they are rendered, not
  // here: this literal is evaluated once when the script loads, so a T() call
  // in it would freeze the label in whatever language was active at boot and
  // never follow a language switch.
    { key: 'account', label: 'Account', icon: '👤' },
    { key: 'language', label: 'Language', icon: '🌐' },
    { key: 'appearance', label: 'Appearance', icon: '🎨' },
    { key: 'content', label: 'Content', icon: '🔞' },
    { key: 'notifications', label: 'Notifications', icon: '🔔' },
    { key: 'data', label: 'Data', icon: '💾' },
    { key: 'about', label: 'About', icon: 'ℹ️' }
  ],

  render (root, params) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('h1', { class: 'page-title', text: T('Settings') }))

    const active = params.get('tab') ?? 'account'
    const layout = U.el('div', { class: 'settings-layout' })
    pad.append(layout)

    // ---- tab rail ----
    const rail = U.el('nav', { class: 'settings-rail' })
    for (const s of this.SECTIONS) {
      rail.append(U.el('a', {
        class: 'settings-tab' + (s.key === active ? ' active' : ''),
        href: `#/settings?tab=${s.key}`
      }, [U.el('span', { class: 'settings-tab-icon', text: s.icon }), document.createTextNode(T(s.label))]))
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
        class: 'input',
        type: 'text',
        maxlength: '50',
        value: settings.profileName ?? '',
        placeholder: T('Dreamer'),
        onchange: e => Store.saveSettings({ profileName: e.target.value.trim() || undefined })
      })
    ))
    wrap.append(C.authCard())
    if (window.YumeAPI.user()) {
      const LABEL = { off: 'Not syncing', syncing: 'Syncing…', synced: '✓ Synced to your account', error: '⚠ Sync unavailable' }
      const statusEl = U.el('span', { class: 'list-row-sub', style: 'align-self:center;', text: LABEL[window.LibrarySync?.status ?? 'off'] })
      const syncBtn = U.el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: async () => {
          statusEl.textContent = LABEL.syncing
          await window.LibrarySync?.init()
          statusEl.textContent = LABEL[window.LibrarySync?.status ?? 'off']
          U.toast(window.LibrarySync?.status === 'synced' ? 'Library synced' : 'Sync unavailable', window.LibrarySync?.status === 'error' ? 'error' : 'success')
        }
      }, [document.createTextNode(T('Sync now'))])
      wrap.append(this._card('Library sync', 'Your library status and episode progress sync to your account and follow you across devices while signed in.',
        U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [syncBtn, statusEl])))
    }
    wrap.append(this._card('Yume server', 'Backend endpoint for platform features (extension store, sync). Leave as-is for local development.',
      U.el('input', {
        class: 'input',
        type: 'url',
        style: 'min-width:20rem;',
        value: window.YumeAPI.base(),
        onchange: e => { window.YumeAPI.setBase(e.target.value); U.toast(T('Yume server updated')) }
      })
    ))
    wrap.append(this._card('Watch profiles', 'Manage the profiles on this account — each has its own library, history and settings.',
      U.el('div', { style: 'display:flex;gap:.6rem;flex-wrap:wrap;' }, [
        U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/profiles?manage=1' }, [document.createTextNode(T('Manage profiles'))]),
        U.el('a', { class: 'btn btn-ghost btn-sm', href: '#/profiles' }, [document.createTextNode(T('Switch profile'))])
      ])
    ))
    return wrap
  },

  // ---- Appearance ----
  // ---- Language ----
  //
  // Its own section rather than a corner of Appearance: which language the
  // descriptions and the subtitles are in is not a matter of how the site
  // looks. It renders from the preference spec the server publishes, so a new
  // preference shows up here without this file changing.
  _language () {
    const wrap = U.el('div')
    const spec = Prefs.spec
    const values = Prefs.all()

    if (!spec) {
      wrap.append(this._card(T('Language'), T('Could not load the language options — check your connection and reload.')))
      return wrap
    }

    // The spec carries keys; these are the words for them. Enum labels come
    // from the onboarding wizard so the two screens never disagree about what
    // "sub" is called, and the rest are declared here.
    const choices = window.Onboarding?.CHOICES ?? {}
    const EXTRA = {
      'language.content': [{ value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }],
      'playback.subtitles': [{ value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }, { value: 'off', label: 'Off' }],
      'playback.audio': [{ value: 'ja', label: '日本語' }, { value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }]
    }
    const GROUP_TITLES = { language: 'Interface', content: 'Catalogue', playback: 'Playback' }

    for (const group of ['language', 'content', 'playback']) {
      const items = spec.filter(item => item.group === group)
      if (!items.length) continue
      wrap.append(U.el('h3', { class: 'settings-group-title', text: T(GROUP_TITLES[group]) }))

      for (const item of items) {
        const options = choices[item.key] ?? EXTRA[item.key]
        let control

        if (!options) {
          const input = U.el('input', {
            type: 'checkbox',
            ...(values[item.key] === true ? { checked: '' } : {}),
            onchange: e => Prefs.set({ [item.key]: e.target.checked })
          })
          control = U.el('label', { class: 'switch' }, [input, U.el('span', { class: 'slider' })])
        } else {
          const select = U.el('select', { class: 'input' }, options.map(option =>
            U.el('option', {
              value: option.value,
              ...(values[item.key] === option.value ? { selected: '' } : {})
            }, [document.createTextNode(T(option.label))])
          ))
          select.addEventListener('change', () => Prefs.set({ [item.key]: select.value }))
          control = select
        }

        wrap.append(this._card(T(item.label), item.description ? T(item.description) : null, control))
      }
    }

    wrap.append(this._card(
      T('Start over'),
      T('Restore every language and playback setting to its default.'),
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          Prefs.reset()
          U.toast(T('Language settings restored'))
          window.App?.navigate?.()
        }
      }, [document.createTextNode(T('Reset to default'))])
    ))

    return wrap
  },

  _appearance () {
    const wrap = U.el('div')
    const settings = Store.settings()

    // full Theme Engine, embedded (base, accent presets, custom colour, preview)
    wrap.append(U.el('p', { class: 'list-row-sub', style: 'margin:0 0 1rem;', text: T('Personalise Yume — base, accent and surface tint apply instantly and are saved for this profile.') }))
    window.PageThemes.body(wrap)

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
        type: 'checkbox',
        ...(settings.nsfw ? { checked: '' } : {}),
        onchange: e => { Store.saveSettings({ nsfw: e.target.checked }); Store.clearCache() }
      }),
      U.el('span', { class: 'slider' })
    ])
    wrap.append(this._card('Show adult content', 'Include 18+ entries in search results and listings.', nsfwToggle))

    const autoplayToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox',
        ...(settings.autoplay !== false ? { checked: '' } : {}),
        onchange: e => Store.saveSettings({ autoplay: e.target.checked })
      }),
      U.el('span', { class: 'slider' })
    ])
    wrap.append(this._card('Autoplay next episode', 'Automatically start the next episode when one finishes.', autoplayToggle))

    const skipToggle = U.el('label', { class: 'switch' }, [
      U.el('input', {
        type: 'checkbox',
        ...(settings.autoSkip ? { checked: '' } : {}),
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

    wrap.append(U.el('p', { class: 'list-row-sub', style: 'margin-bottom:1rem;', text: T('Choose which notifications appear in your inbox. These are generated from your library and activity — no account required.') }))

    for (const [key, title, desc] of [
      ['airing', 'Airing episodes', 'When a new episode of something in your library airs.'],
      ['resume', 'Continue watching', 'Reminders to pick up shows you started but paused.'],
      ['achievement', 'Achievements', 'When you unlock a new achievement.']
    ]) {
      const toggle = U.el('label', { class: 'switch' }, [
        U.el('input', {
          type: 'checkbox',
          ...(prefs[key] !== false ? { checked: '' } : {}),
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
      U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/notifications' }, [document.createTextNode(T('Open inbox'))])
    ))
    return wrap
  },

  // ---- Data ----
  _data () {
    const wrap = U.el('div')
    wrap.append(this._card('API cache', 'Responses from AniList / Jikan / ani.zip are cached locally to keep the app fast and avoid rate limits.',
      U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => Store.clearCache() }, [document.createTextNode(T('Clear cache'))])
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
        }, [document.createTextNode(T('Export data'))]),
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
                U.toast(T('Data imported'))
              } catch (e) { U.toast(T('Invalid file'), 'error') }
            }
            input.click()
          }
        }, [document.createTextNode(T('Import data'))]),
        U.el('button', {
          class: 'btn btn-sm',
          style: 'background:var(--danger);color:white;',
          onclick: () => { if (window.confirm('Delete ALL local data (list, favourites, settings)?')) { Store.clearAll(); window.location.reload() } }
        }, [document.createTextNode(T('Delete all data'))])
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
