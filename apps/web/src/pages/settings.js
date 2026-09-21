/* global window, document */
// Settings — categorized into sections (Account, Appearance, Content,
// Notifications, Data, About) with a left-hand tab rail, Netflix/Discord
// style. Each section is a builder that returns its content node.

import { afterAuth, applyNavCollapsed, navigate, refreshChrome, refreshNotifications } from '../shared/lib/shell.js'
import { configure, featureOn, flagDeclared, site } from '../shared/lib/site-config.js'
import { T } from '../shared/i18n/i18n.js'
import { LibrarySync } from '../features/library-sync/library-sync.js'
import { Onboarding } from '../features/onboarding/onboarding.js'
import { Prefs } from '../shared/state/preferences.js'
import { Store } from '../shared/state/store.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { ArtworkPicker } from '../features/profile-artwork/picker.js'
import { PageThemes } from '../features/themes/themes.js'
import { createSettingsPanel } from '../features/player2/ui/settings-panel.js'
import { createPlayerPreferences } from '../features/player2/preferences/player-preferences.js'

export const PageSettings = {
  SECTIONS: [
  // Labels are stored in English and translated where they are rendered, not
  // here: this literal is evaluated once when the script loads, so a T() call
  // in it would freeze the label in whatever language was active at boot and
  // never follow a language switch.
    { key: 'account', label: 'Account', icon: '👤' },
    { key: 'language', label: 'Language', icon: '🌐' },
    { key: 'appearance', label: 'Appearance', icon: '🎨' },
    { key: 'content', label: 'Content', icon: '🔞' },
    // A lejátszó fül CSAK a Player 2.0 mellett jelenik meg: a panel a 2.0
    // beállítássémájából épül, és a régi lejátszó egyik mezőt sem olvassa.
    // Egy fül, amin minden kapcsoló hatástalan, rosszabb, mint egy hiányzó.
    ...(flagDeclared('feature.player2') && featureOn('player2')
      ? [{ key: 'player', label: 'Player', icon: '▶️' }]
      : []),
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

  /**
   * A lejátszó beállításai.
   *
   * A panelt a `player2` saját modulja építi, a sémájából — nem itt felsorolt
   * mezőkből. Egy kézzel írt lista és egy séma előbb-utóbb eltér, és a
   * különbség csendben egy beállítás, amit nem lehet átállítani.
   */
  _player () {
    const prefs = createPlayerPreferences(Prefs)
    const panel = createSettingsPanel(prefs, {
      onChange: () => {
        // A már felállt lejátszó nem látja magától a változást; a nézőoldal a
        // következő felépítéskor olvassa újra. A visszajelzés viszont
        // azonnal jár, különben a néző nem tudja, mentődött-e.
        U.toast?.(T('Saved'))
      }
    })
    return U.el('section', { class: 'settings-group' }, [
      U.el('h2', { class: 'settings-group-head', text: T('Player') }),
      U.el('div', { class: 'settings-group-body', style: 'padding:var(--space-4);' }, [
        U.el('p', {
          class: 'setting-row-desc',
          style: 'margin:0 0 var(--space-4);',
          text: T('These apply to the video player. Changes take effect the next time a player opens.')
        }),
        panel.node
      ])
    ])
  },

  /**
   * Egy beállítás sora: balra a név és a magyarázat, jobbra a vezérlő.
   *
   * A régi `_card` minden beállítást külön dobozba tett, saját `h2`
   * címsorral — egy „Címek nyelve" ugyanakkora betűvel, mint az oldal címe.
   * Húsz beállításnál húsz doboz, amiből semmi nem mondja meg, mi tartozik
   * össze. A sorok egy csoportkártyán belül élnek (`_group`), és a csoport
   * címe mondja meg, miről van szó.
   *
   * `wide`: a vezérlő a szöveg ALÁ kerül — több gombnak vagy egy hosszú
   * beviteli mezőnek nincs értelme a sor jobb szélére szorítva.
   */
  _row (title, desc, control = null, { wide = false } = {}) {
    const card = U.el('div', { class: wide ? 'setting-row setting-row-wide' : 'setting-row' }, [
      U.el('div', { class: 'setting-row-text' }, [
        U.el('span', { class: 'setting-row-title', text: T(title) }),
        desc ? U.el('span', { class: 'setting-row-desc', text: T(desc) }) : null
      ]),
      control ? U.el('div', { class: 'setting-row-control' }, Array.isArray(control) ? control : [control]) : null
    ])
    // A SOR NEVE A VEZÉRLŐ NEVE. Egy képernyőolvasó a fölötte álló szöveget
    // nem kapcsolja a mezőhöz — enélkül több beállítás puszta „szerkesztőmező"
    // néven szólalt meg. Itt alkalmazva, nem a hívási helyeken: minden sor
    // megkapja, és egy új sor nem felejtheti el.
    for (const field of card.querySelectorAll('input, select, textarea')) {
      if (!field.getAttribute('aria-label') && !field.closest('label')) field.setAttribute('aria-label', T(title))
    }
    return card
  },

  /**
   * Egy csoport: fejléc és a hozzá tartozó sorok egyetlen kártyában.
   *
   * A cím NEM címsor-elem: rövid, nagybetűs felirat, ami elválaszt. Egy
   * beállításlapon a valódi címsor az oldal neve — húsz `h2` egymás alatt a
   * képernyőolvasónak is zajt jelent, nem szerkezetet.
   */
  _group (title, rows) {
    const real = rows.filter(Boolean)
    if (!real.length) return null
    return U.el('section', { class: 'settings-group' }, [
      title ? U.el('h2', { class: 'settings-group-head', text: T(title) }) : null,
      U.el('div', { class: 'settings-group-body' }, real)
    ])
  },

  // ---- Account ----
  //
  // A BELÉPÉS ÉS A REGISZTRÁCIÓ NINCS ITT. Volt, és rossz helyen volt: egy
  // teljes belépő űrlap a beállítások között a HARMADIK másolata volt
  // ugyanannak a logikának, és amikor az emberpróba bekerült, pont ebbe nem
  // került bele. A belépésnek saját lapja van (`#/login`), fülekkel; ez a
  // szakasz csak megmondja, hol tartunk, és odavisz.
  _account () {
    const wrap = U.el('div')
    const settings = Store.settings()
    const user = YumeAPI.user()

    /*
     * Az ÁLLAPOT az első sor, mert ez az első kérdés: be vagyok-e lépve.
     * Eddig a lap tetején egy „Profil neve" mező állt, és a fiók állapota
     * valahol alatta — vagyis a legfontosabb információ volt a legkevésbé
     * szem előtt.
     */
    const here = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0]
    const next = here ? `?next=${encodeURIComponent(here)}` : ''

    wrap.append(this._group('Account', [
      user
        ? this._row('Signed in', `${T('Signed in as ')}${user.username}.`,
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            onclick: async () => { await YumeAPI.logout(); await afterAuth() }
          }, [document.createTextNode(T('Sign out'))]))
        : this._row('Not signed in',
          'Sign in to sync your library across devices and join the discussion.',
          [
            U.el('a', { class: 'btn btn-primary btn-sm', href: `#/login${next}` },
              [document.createTextNode(T('Sign in'))]),
            U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/login/register${next}` },
              [document.createTextNode(T('Create account'))])
          ]),

      this._row('Profile name', 'Shown on your profile page.',
        U.el('input', {
          class: 'input',
          type: 'text',
          maxlength: '50',
          value: settings.profileName ?? '',
          placeholder: T('Dreamer'),
          onchange: e => Store.saveSettings({ profileName: e.target.value.trim() || undefined })
        })),

      user ? this._syncRow() : null
    ]))

    /*
     * A KÉPEK a fiókhoz tartoznak, nem a megjelenéshez: ez az, akinek
     * látszol, nem az, ahogy neked látszik az oldal. Csak belépve, mert a
     * fiókon tárolódik — és saját csoportot kap, mert a választó nem egy sor,
     * hanem egy rács.
     */
    if (user) {
      const cards = U.el('div', { class: 'settings-group-body', style: 'padding:var(--space-4);' })
      wrap.append(U.el('section', { class: 'settings-group' }, [
        U.el('h2', { class: 'settings-group-head', text: T('Profile artwork') }),
        cards
      ]))
      YumeAPI.profile.get()
        .then(profile => cards.replaceChildren(ArtworkPicker.cards(profile, updated => {
          // The sidebar and the mobile sheet draw the same face, so they are
          // told rather than left to refresh on the next navigation.
          refreshChrome()
          configure({ viewer: updated })
        })))
        .catch(() => { /* offline or signed out mid-render; the cards stay out */ })
    }

    return wrap
  },

  /** A könyvtár szinkronjának sora. Külön, mert állapotot mutat és cselekszik is. */
  _syncRow () {
    const LABEL = {
      off: T('Not syncing'),
      syncing: T('Syncing…'),
      synced: T('Synced to your account'),
      error: T('Sync unavailable')
    }
    const statusEl = U.el('span', { class: 'setting-row-desc', style: 'margin:0;', text: LABEL[LibrarySync?.status ?? 'off'] })
    const syncBtn = U.el('button', {
      class: 'btn btn-secondary btn-sm',
      onclick: async () => {
        statusEl.textContent = LABEL.syncing
        await LibrarySync?.init()
        statusEl.textContent = LABEL[LibrarySync?.status ?? 'off']
        U.toast(
          LibrarySync?.status === 'synced' ? T('Library synced') : T('Sync unavailable'),
          LibrarySync?.status === 'error' ? 'error' : 'success')
      }
    }, [document.createTextNode(T('Sync now'))])
    return this._row('Library sync',
      'Your library status and episode progress follow you across devices while signed in.',
      [statusEl, syncBtn])
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
      wrap.append(this._group('Language', [
        this._row('Language', 'Could not load the language options — check your connection and reload.')
      ]))
      return wrap
    }

    // The spec carries keys; these are the words for them. Enum labels come
    // from the onboarding wizard so the two screens never disagree about what
    // "sub" is called, and the rest are declared here.
    const choices = Onboarding?.CHOICES ?? {}
    const EXTRA = {
      'language.content': [{ value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }],
      'playback.subtitles': [{ value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }, { value: 'off', label: 'Off' }],
      'playback.audio': [{ value: 'ja', label: '日本語' }, { value: 'hu', label: 'Magyar' }, { value: 'en', label: 'English' }]
    }
    const GROUP_TITLES = { language: 'Interface', content: 'Catalogue', playback: 'Playback' }

    /*
     * AMI MÁSHOL IS OTT VAN, AZ ITT NEM JELENIK MEG.
     *
     * A kiszolgáló beállításkészletében két olyan kulcs van, aminek a
     * SAJÁT FÜLÉN már van kapcsolója: a felnőtt tartalom (Tartalom fül) és az
     * új részekről szóló értesítés (Értesítések fül). Két kapcsoló ugyanarra,
     * két külön fülön, egymástól függetlenül állítva — és a kettő közül CSAK
     * a másik csinált bármit is: a katalógus szűrése a helyi beállításra megy
     * (`public-routes.ts`: `if (!q.nsfw) where.push('NOT a.is_adult')`), ezt a
     * kulcsot szűrésre senki nem olvassa.
     *
     * Itt tehát kimarad, a saját fülén lévő kapcsoló pedig MINDKETTŐT írja —
     * így a fiókhoz kötött másolat is követi, és marad egy igazságforrás.
     */
    const ELSEWHERE = ['content.adult', 'notifications.episodes']

    // Ha a példány kikapcsolta a nyelvváltást, a felület nyelvének nincs mit
    // választani — a sor eltüntetése itt nem elrejtés, mert az I18n is a
    // házirendet követi és a /v1/config ugyanezt mondja. Egy vezérlő, ami
    // nem változtat semmin, rosszabb, mint ha ott sincs.
    const switching = site()?.languageSwitching !== false

    for (const group of ['language', 'content', 'playback']) {
      const items = spec.filter(item => item.group === group)
        .filter(item => switching || item.key !== 'language.ui')
        .filter(item => !ELSEWHERE.includes(item.key))
      if (!items.length) continue
      const rows = []

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

        rows.push(this._row(item.label, item.description ?? null, control))
      }
      wrap.append(this._group(GROUP_TITLES[group], rows))
    }

    wrap.append(this._group(null, [this._row(
      'Start over',
      'Restore every language and playback setting to its default.',
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          Prefs.reset()
          U.toast(T('Language settings restored'))
          navigate()
        }
      }, [document.createTextNode(T('Reset to default'))])
    )]))

    return wrap
  },

  _appearance () {
    const wrap = U.el('div')
    const settings = Store.settings()

    // A teljes témamotor beágyazva: alap, kiemelőszín, felületárnyalat, előnézet.
    wrap.append(U.el('section', { class: 'settings-group' }, [
      U.el('h2', { class: 'settings-group-head', text: T('Theme') }),
      U.el('div', { class: 'settings-group-body', style: 'padding:var(--space-4);' }, [
        U.el('p', {
          class: 'setting-row-desc',
          style: 'margin:0 0 var(--space-4);',
          text: T('Base, accent and surface tint apply instantly and are saved for this profile.')
        })
      ])
    ]))
    PageThemes.body(wrap.lastChild.lastChild)

    const langSelect = U.el('select', {
      class: 'select',
      onchange: e => Store.saveSettings({ titleLang: e.target.value })
    }, [
      ['userPreferred', 'Preferred (AniList default)'],
      ['english', 'English'],
      ['romaji', 'Romaji'],
      ['native', 'Native']
    ].map(([value, label]) => U.el('option', { value, text: T(label), ...(settings.titleLang === value ? { selected: '' } : {}) })))

    wrap.append(this._group('Titles', [
      this._row('Title language', 'How anime titles are displayed across the app.', langSelect)
    ]))

    /*
     * AZ OLDALSÁV ÁLLAPOTA.
     *
     * Ugyanaz a beállítás, amit a sávon lévő nyíl is állít — nem külön
     * másolat. A választás a profil beállításai közt él, tehát profilonként
     * külön, és az adatmentés is viszi.
     *
     * Az érvényesítést a shellre bízzuk: ha ez a képernyő maga igazgatná a sáv
     * DOM-ját, a nyíl felirata és az `aria` állapot előbb-utóbb széttartana
     * attól, amit a sáv mutat.
     */
    const navSelect = U.el('select', {
      class: 'select',
      onchange: e => {
        Store.saveSettings({ navCollapsed: e.target.value === 'collapsed' })
        applyNavCollapsed()
      }
    }, [
      ['expanded', 'Expanded'],
      ['collapsed', 'Collapsed']
    ].map(([value, label]) => U.el('option', {
      value,
      text: T(label),
      ...((settings.navCollapsed === true ? 'collapsed' : 'expanded') === value ? { selected: '' } : {})
    })))

    wrap.append(this._group('Navigation', [
      this._row('Sidebar',
        'Whether the side navigation shows its labels. The arrow at the bottom of the rail does the same thing. On a narrow screen the rail is replaced by the bottom bar, so this has no effect there.',
        navSelect)
    ]))
    return wrap
  },

  // ---- Content ----
  _content () {
    const settings = Store.settings()
    const toggle = (checked, onchange) => U.el('label', { class: 'switch' }, [
      U.el('input', { type: 'checkbox', ...(checked ? { checked: '' } : {}), onchange }),
      U.el('span', { class: 'slider' })
    ])

    const wrap = U.el('div')
    wrap.append(this._group('Catalogue', [
      this._row('Show adult content', 'Include 18+ entries in search results and listings.',
        toggle(settings.nsfw, e => {
          const on = e.target.checked
          // A SZŰRÉST a helyi beállítás vezérli: a katalóguskérés ebből kapja
          // az `nsfw` paramétert. A fiókhoz kötött másolatot is írjuk, hogy a
          // kettő ne tudjon széttartani — de a szűrés nem várja meg.
          Store.saveSettings({ nsfw: on })
          Store.clearCache()
          Prefs.set({ 'content.adult': on })
        }))
    ]))
    wrap.append(this._group('Playback', [
      this._row('Autoplay next episode', 'Automatically start the next episode when one finishes.',
        toggle(settings.autoplay !== false, e => Store.saveSettings({ autoplay: e.target.checked }))),
      this._row('Auto-skip intros', 'Skip openings and endings automatically when timing data is available (AniSkip).',
        toggle(settings.autoSkip, e => Store.saveSettings({ autoSkip: e.target.checked })))
    ]))
    return wrap
  },

  // ---- Notifications ----
  _notifications () {
    const wrap = U.el('div')
    const settings = Store.settings()
    const DEFAULTS = { airing: true, resume: true, achievement: true }
    const prefs = settings.notifPrefs ?? DEFAULTS

    const rows = [
      ['airing', 'Airing episodes', 'When a new episode of something in your library airs.'],
      ['resume', 'Continue watching', 'Reminders to pick up shows you started but paused.'],
      ['achievement', 'Achievements', 'When you unlock a new achievement.']
    ].map(([key, title, desc]) => this._row(title, desc,
      U.el('label', { class: 'switch' }, [
        U.el('input', {
          type: 'checkbox',
          ...(prefs[key] !== false ? { checked: '' } : {}),
          onchange: e => {
            const next = { ...(Store.settings().notifPrefs ?? DEFAULTS), [key]: e.target.checked }
            Store.saveSettings({ notifPrefs: next })
            // Az új részekről szóló értesítésnek a kiszolgálón is van
            // másolata; a kettő ne tudjon széttartani.
            if (key === 'airing') Prefs.set({ 'notifications.episodes': e.target.checked })
            refreshNotifications()
          }
        }),
        U.el('span', { class: 'slider' })
      ])))

    wrap.append(this._group('What you are told about', rows))
    wrap.append(this._group(null, [
      this._row('Notification inbox',
        'These are generated from your library and activity — no account required.',
        U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/notifications' },
          [document.createTextNode(T('Open inbox'))]))
    ]))
    return wrap
  },

  // ---- Data ----
  _data () {
    const wrap = U.el('div')

    const exportBtn = U.el('button', {
      class: 'btn btn-secondary btn-sm',
      onclick: () => {
        const data = { animelist: Store.list(), favourites: Store.favourites(), settings: Store.settings(), history: Store.history() }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const a = U.el('a', { href: URL.createObjectURL(blob), download: 'yume-data.json' })
        a.click(); URL.revokeObjectURL(a.href)
      }
    }, [document.createTextNode(T('Export data'))])

    const importBtn = U.el('button', {
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
    }, [document.createTextNode(T('Import data'))])

    wrap.append(this._group('Your data', [
      this._row('Export and import',
        'Your anime list, favourites and progress live only in this browser. Export them as JSON to back them up or move devices.',
        [exportBtn, importBtn]),
      this._row('API cache',
        'Responses from AniList, Jikan and ani.zip are kept locally to keep the app fast and to stay under their rate limits.',
        U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => Store.clearCache() },
          [document.createTextNode(T('Clear cache'))]))
    ]))

    /*
     * A TÖRLÉS KÜLÖN CSOPORTBAN, a lap alján. Egy visszavonhatatlan művelet ne
     * álljon egy sorban azzal, amit az ember naponta használ — a „Gyorsítótár
     * ürítése" és a „Minden adat törlése" mellérendelve egy elgépelt
     * kattintásnyira van egymástól.
     */
    wrap.append(this._group('Danger zone', [
      this._row('Delete all local data',
        'Your list, favourites, history and settings in this browser. This cannot be undone.',
        U.el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => {
            if (window.confirm(T('Delete ALL local data (list, favourites, settings)?'))) {
              Store.clearAll()
              window.location.reload()
            }
          }
        }, [document.createTextNode(T('Delete all data'))]))
    ]))
    return wrap
  },

  // ---- About ----
  _about () {
    const wrap = U.el('div')
    wrap.append(this._group('About', [
      this._row('Yume',
        'Framework-free web client on the Yume design system. Catalogue data from AniList, Jikan (MyAnimeList) and ani.zip.'),
      this._row('Sources', null, [
        U.el('a', { class: 'btn btn-ghost btn-sm', href: 'https://anilist.co', target: '_blank', rel: 'noopener' }, [document.createTextNode('AniList')]),
        U.el('a', { class: 'btn btn-ghost btn-sm', href: 'https://jikan.moe', target: '_blank', rel: 'noopener' }, [document.createTextNode('Jikan')]),
        U.el('a', { class: 'btn btn-ghost btn-sm', href: 'https://api.ani.zip', target: '_blank', rel: 'noopener' }, [document.createTextNode('ani.zip')])
      ])
    ]))
    return wrap
  }
}
