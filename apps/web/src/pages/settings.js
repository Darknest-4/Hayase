/* global window, document */
// Settings — categorized into sections (Account, Appearance, Content,
// Notifications, Data, About) with a left-hand tab rail, Netflix/Discord
// style. Each section is a builder that returns its content node.
//
// 2026-09: the account section gained what the server has always offered and
// the client never exposed — changing the password, signing out on every
// device and deleting the account (POST /v1/auth/password, POST
// /v1/auth/logout-all, DELETE /v1/auth/me). The rail's emoji became the same
// line icons as the navigation, and every switch is a real role="switch".

import { afterAuth, applyNavCollapsed, navigate, refreshChrome, refreshNotifications } from '../shared/lib/shell.js'
import { configure, featureOn, flagDeclared, site } from '../shared/lib/site-config.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { ONBOARDING_CHOICES } from '../features/onboarding/meta.js'
import { Prefs } from '../shared/state/preferences.js'
import { Store } from '../shared/state/store.js'
import { U } from '../shared/lib/dom.js'
import { C } from '../shared/ui/components.js'
import { P } from '../shared/ui/primitives.js'
import { authErrorMessage, passwordField } from '../features/auth/password-field.js'
import { YumeAPI } from '../shared/api/yume.js'
import { loadStylesheet } from '../shared/lib/stylesheet.js'

export const PageSettings = {
  /*
   * GETTER, NEM TÖMB: a lejátszó fül a `feature.player2` kapcsolótól függ, és a
   * router a kezdő útvonal modulját már a konfiguráció megérkezése ELŐTT
   * betölti (párhuzamosan vele). Egy betöltéskor kiértékelt tömb így a
   * kapcsoló nélkül állt össze, és a fül eltűnt — rajzoláskor kérdezzük.
   */
  get SECTIONS () {
    return [
      // Labels are stored in English and translated where they are rendered
      // (the rail and the page title), so every label has one translation path.
      { key: 'account', label: 'Account', icon: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
      { key: 'language', label: 'Language', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>' },
      { key: 'appearance', label: 'Appearance', icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>' },
      { key: 'content', label: 'Content', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' },
      // A lejátszó fül CSAK a Player 2.0 mellett jelenik meg: a panel a 2.0
      // beállítássémájából épül, és a régi lejátszó egyik mezőt sem olvassa.
      // Egy fül, amin minden kapcsoló hatástalan, rosszabb, mint egy hiányzó.
      ...(flagDeclared('feature.player2') && featureOn('player2')
        ? [{ key: 'player', label: 'Player', icon: '<polygon points="6 3 20 12 6 21 6 3"/>' }]
        : []),
      { key: 'notifications', label: 'Notifications', icon: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' },
      { key: 'data', label: 'Data', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>' },
      { key: 'about', label: 'About', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' }
    ]
  },

  async render (root, params) {
    this._discordOutcome(params)
    const wanted = params.get('tab') ?? 'account'
    const active = this.SECTIONS.some(s => s.key === wanted) ? wanted : 'account'
    // Csak a megnyitott fül saját moduljai töltődnek le — a témaválasztó, a
    // lejátszó beállításpanele és a könyvtár-szinkron nem kell minden fülhöz.
    await this._loadTab(active)

    const pad = U.el('div', { class: 'page-pad settings-page' })
    root.append(pad)
    pad.append(U.el('header', { class: 'page-header' }, [
      U.el('div', { class: 'page-header-text' }, [
        U.el('h1', { class: 'page-title', text: T('Settings') })
      ])
    ]))

    const layout = U.el('div', { class: 'settings-layout' })
    pad.append(layout)

    // Hivatkozások, nem gombok: minden fülnek saját címe van, a vissza gomb
    // működik, és egy fül megosztható.
    const rail = U.el('nav', { class: 'settings-rail', 'aria-label': T('Settings') })
    for (const s of this.SECTIONS) {
      rail.append(U.el('a', {
        class: 'settings-tab' + (s.key === active ? ' active' : ''),
        href: `#/settings?tab=${s.key}`,
        ...(s.key === active ? { 'aria-current': 'page' } : {})
      }, [U.svg(s.icon, 18), U.el('span', { text: T(s.label) })]))
    }
    layout.append(rail)

    const panel = U.el('div', { class: 'settings-panel' })
    layout.append(panel)
    const builder = this['_' + active] ?? this._account
    panel.append(builder.call(this))
    // Telefonon a fülsor vízszintesen görget: a kiválasztott fül látsszon.
    window.requestAnimationFrame(() => rail.querySelector('.active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' }))
  },

  /**
   * Egy fül saját moduljai, a rajzolás előtt.
   *
   * Eddig mind statikus import volt, tehát a Fiók fül megnyitása is letöltötte
   * a témaválasztót, a lejátszó beállításpanelét (a sémájával) és a
   * könyvtár-szinkront. A lejátszó fül paneljét ráadásul a lejátszó saját
   * stíluslapja rajzolja (`.yp-settings*`, player2.css), ami csak a
   * lejátszóoldalon jött le — friss betöltés után a panel stílus nélkül állt.
   */
  async _loadTab (tab) {
    if (tab === 'player') {
      const [panel, prefs] = await Promise.all([
        import('../features/player2/ui/settings-panel.js'),
        import('../features/player2/preferences/player-preferences.js'),
        loadStylesheet('player2.css')
      ])
      this._playerPanel = { createSettingsPanel: panel.createSettingsPanel, createPlayerPreferences: prefs.createPlayerPreferences }
    } else if (tab === 'appearance') {
      this._themes = (await import('../features/themes/themes.js')).PageThemes
    } else if (tab === 'account' && YumeAPI.user()) {
      // Belépve a router már betöltötte (a szinkron vele indul): ez nem új letöltés.
      this._sync = (await import('../features/library-sync/library-sync.js')).LibrarySync
    }
  },

  /**
   * A lejátszó beállításai.
   *
   * A panelt a `player2` saját modulja építi, a sémájából — nem itt felsorolt
   * mezőkből. Egy kézzel írt lista és egy séma előbb-utóbb eltér, és a
   * különbség csendben egy beállítás, amit nem lehet átállítani.
   */
  _player () {
    const { createSettingsPanel, createPlayerPreferences } = this._playerPanel
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
    // Every control needs a name a screen reader can say. The row's own title
    // is that name unless the control already has one.
    for (const field of card.querySelectorAll('input, select, textarea')) {
      if (!field.getAttribute('aria-label') && !field.closest('label')) field.setAttribute('aria-label', T(title))
    }
    return card
  },

  /** Egy kapcsoló (`role="switch"`), a sor címével mint névvel. */
  _switch (checked, onchange) {
    return U.el('label', { class: 'switch' }, [
      U.el('input', { type: 'checkbox', role: 'switch', checked: !!checked, onchange })
    ])
  },

  /** Egy legördülő a közös `.select` stílussal. options: [[value, label]] */
  _select (options, value, onchange) {
    const select = P.select(options.map(([v, label]) => [v, T(label)]), { value })
    select.addEventListener('change', () => onchange(select.value))
    return select
  },

  /**
   * Egy csoport: fejléc és a hozzá tartozó sorok egyetlen kártyában.
   *
   * A cím NEM címsor-elem: rövid, nagybetűs felirat, ami elválaszt. Egy
   * beállításlapon a valódi címsor az oldal neve — húsz `h2` egymás alatt a
   * képernyőolvasónak is zajt jelent, nem szerkezetet.
   */
  _group (title, rows, { danger = false } = {}) {
    const real = rows.filter(Boolean)
    if (!real.length) return null
    return U.el('section', { class: 'settings-group' + (danger ? ' settings-group-danger' : '') }, [
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
    const wrap = U.el('div', { class: 'settings-stack' })
    const settings = Store.settings()
    const user = YumeAPI.user()
    const here = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0]
    const next = here ? `?next=${encodeURIComponent(here)}` : ''

    if (!user) {
      wrap.append(U.el('section', { class: 'settings-hero surface' }, [
        U.el('div', {}, [
          U.el('h2', { class: 'surface-title', text: T('Not signed in') }),
          U.el('p', { class: 'surface-sub', text: T('Sign in to sync your library across devices and join the discussion.') })
        ]),
        U.el('div', { class: 'cluster' }, [
          U.el('a', { class: 'btn btn-primary', href: `#/login${next}` }, [document.createTextNode(T('Sign in'))]),
          site()?.registrationOpen === false
            ? null
            : U.el('a', { class: 'btn btn-ghost', href: `#/login/register${next}` }, [document.createTextNode(T('Create account'))])
        ])
      ]))
      wrap.append(this._group('Profile', [
        this._row('Profile name', 'Shown on your profile page.', this._profileName(settings))
      ]))
      return wrap
    }

    // ---- ki van belépve ----
    const head = U.el('section', { class: 'settings-hero surface' }, [
      U.el('div', { class: 'settings-who' }, [
        C.avatar({ name: user.username }, { size: 'md' }),
        U.el('div', { style: 'min-width:0' }, [
          U.el('h2', { class: 'surface-title', text: user.username }),
          U.el('p', { class: 'surface-sub', text: I18n.f(T('Signed in as {name}'), { name: '@' + user.username }) })
        ])
      ]),
      U.el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        onclick: async () => { await YumeAPI.logout(); U.toast(T('You are signed out.')); await afterAuth() }
      }, [document.createTextNode(T('Sign out'))])
    ])
    wrap.append(head)

    wrap.append(this._group('Profile', [
      this._row('Profile name', 'Shown on your profile page.', this._profileName(settings)),
      this._syncRow()
    ]))

    const cards = U.el('div', { class: 'settings-group-body settings-group-padded' })
    wrap.append(U.el('section', { class: 'settings-group' }, [
      U.el('h2', { class: 'settings-group-head', text: T('Profile artwork') }),
      cards
    ]))
    // A profilkép-választó a profil adataival együtt jön: csak belépve kell.
    Promise.all([YumeAPI.profile.get(), import('../features/profile-artwork/picker.js')])
      .then(([profile, { ArtworkPicker }]) => {
        cards.replaceChildren(ArtworkPicker.cards(profile, updated => {
          refreshChrome()
          configure({ viewer: updated })
        }))
        const avatar = head.querySelector('.avatar')
        if (avatar && profile) avatar.replaceWith(C.avatar(profile, { size: 'md' }))
      })
      .catch(() => { /* offline or signed out mid-render; the cards stay out */ })

    wrap.append(this._discordGroup())

    wrap.append(this._group('Security', [
      this._row('Password', 'Changing it signs you out everywhere else; this device stays signed in.',
        P.button(T('Change password'), { variant: 'secondary', onclick: () => this._changePassword() })),
      this._row('Sign out everywhere', 'Ends every session of this account — phones, other browsers, this one too. Use it if you think somebody else is signed in.',
        P.button(T('Sign out everywhere'), { variant: 'secondary', onclick: () => this._logoutAll() }))
    ]))

    wrap.append(this._group('Danger zone', [
      this._row('Delete account', 'Your email address, username and password are erased and every session ends. Comments you wrote stay, without your name. This cannot be undone.',
        P.button(T('Delete account'), { variant: 'danger', onclick: () => this._deleteAccount() }))
    ], { danger: true }))
    return wrap
  },

  /**
   * A Discord-fiók összekötése.
   *
   * A kiszolgáló régóta tudja (/v1/discord/oauth/*), de eddig csak a
   * Discord-vezérlőpult kínálta — az viszont 2026-09-29 óta jogosultsághoz
   * kötött, és a bot `/link` parancsa ide küldi a tagokat. Ha a példányon nincs
   * beállítva Discord OAuth, a sor ezt mondja ki: gomb egy nem működő
   * folyamathoz nem jár.
   */
  _discordGroup () {
    const slot = U.el('div', { class: 'cluster settings-discord' }, [P.spinner()])
    // A DM-értesítés sora csak összekötött fióknál jelenik meg — addig üres.
    const dm = U.el('div', { class: 'settings-discord-dm' })
    this._fillDiscord(slot, dm)
    return this._group('Connected accounts', [
      this._row('Discord', 'The Yume bot recognises you in the Discord servers that use it.', slot),
      dm
    ])
  },

  async _fillDiscord (slot, dm = null) {
    let link
    dm?.replaceChildren()
    try {
      link = await YumeAPI.discordLink()
    } catch {
      slot.replaceChildren(U.el('span', { class: 'setting-row-desc', text: T('The Discord link could not be checked right now.') }))
      return
    }
    if (link?.linked) {
      slot.replaceChildren(
        U.el('span', { class: 'settings-discord-who', text: I18n.f(T('Linked as {name}'), { name: '@' + (link.username ?? '?') }) }),
        P.button(T('Unlink'), { variant: 'secondary', onclick: () => this._discordUnlink(slot, dm) }))
      /*
       * DM AZ ÚJ RÉSZEKRŐL — a könyvtár címeiről, bekapcsolás után. A Discord
       * csak közös szerveren lévő tagnak engedi a botot írni, és csak ha a tag
       * engedi a szerverről jövő privát üzeneteket; a leírás ezt kimondja.
       */
      dm?.replaceChildren(this._row('Discord notifications',
        'A direct message from the Yume bot when a new episode of a title on your list comes out. It needs a server you share with the bot, with direct messages from server members allowed.',
        this._switch(link.dmNewEpisodes, async e => {
          const on = e.target.checked
          try {
            await YumeAPI.discordSetDm(on)
            U.toast(on ? T('New episodes will arrive as Discord messages.') : T('Discord notifications are off.'), 'success')
          } catch (err) {
            e.target.checked = !on
            U.toast(err.message, 'error')
          }
        })))
      return
    }
    if (!link?.configured) {
      slot.replaceChildren(U.el('span', { class: 'setting-row-desc', text: T('Discord linking is not set up on this site.') }))
      return
    }
    const start = P.button(T('Link Discord account'), {
      variant: 'secondary',
      onclick: async () => {
        start.disabled = true
        try {
          const { url } = await YumeAPI.discordLinkStart()
          window.location.assign(url)
        } catch (e) {
          start.disabled = false
          U.toast(e.status === 503 ? T('Discord linking is not set up on this site.') : e.message, 'error')
        }
      }
    })
    slot.replaceChildren(start)
  },

  async _discordUnlink (slot, dm = null) {
    const ok = await C.confirm({
      title: T('Unlink Discord?'),
      message: T('The Yume bot will no longer recognise you in Discord servers. You can link again at any time.'),
      confirmLabel: T('Unlink')
    })
    if (!ok) return
    try {
      await YumeAPI.discordUnlink()
      U.toast(T('Your Discord account is unlinked.'), 'success')
    } catch (e) {
      U.toast(e.message, 'error')
    }
    await this._fillDiscord(slot, dm)
  },

  /**
   * A Discordtól visszaérve: a kimenet egy üzenet, és a paraméter kikerül a
   * címből — egy frissítés vagy egy könyvjelző ne mondja újra.
   */
  _discordOutcome (params) {
    const outcome = params.get('discord')
    if (!outcome) return
    const MESSAGES = {
      ok: ['Your Discord account is linked.', 'success'],
      cancelled: ['Discord linking was cancelled.', ''],
      expired: ['The link request expired. Try again.', 'error'],
      taken: ['This Discord account is already linked to another Yume account.', 'error'],
      invalid: ['Discord linking failed. Try again.', 'error'],
      failed: ['Discord linking failed. Try again.', 'error']
    }
    const [text, type] = MESSAGES[outcome] ?? MESSAGES.failed
    U.toast(T(text), type)
    window.history.replaceState(window.history.state, '', '#/settings?tab=account')
  },

  _profileName (settings) {
    return U.el('input', {
      class: 'input',
      type: 'text',
      maxlength: '50',
      value: settings.profileName ?? '',
      placeholder: T('Dreamer'),
      onchange: e => {
        Store.saveSettings({ profileName: e.target.value.trim() || undefined })
        U.toast(T('Saved'), 'success')
      }
    })
  },

  /** Jelszócsere: jelenlegi + új kétszer, a kiszolgáló szabályaival. */
  _changePassword () {
    const current = P.input({ type: 'password', name: 'current-password', autocomplete: 'current-password', required: true, minlength: 8, maxlength: 128 })
    const fresh = P.input({ type: 'password', name: 'new-password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 })
    const again = P.input({ type: 'password', name: 'confirm-password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 })
    const error = U.el('p', { class: 'field-error', role: 'alert', hidden: true })
    const submit = P.button(T('Save password'), { variant: 'primary', type: 'submit' })
    const form = U.el('form', { class: 'dialog-form' }, [
      P.field(T('Current password'), passwordField(current)),
      P.field(T('New password'), passwordField(fresh), { hint: T('At least 8 characters.') }),
      P.field(T('New password again'), passwordField(again)),
      error
    ])
    const fail = message => { error.textContent = message; error.hidden = false }
    form.addEventListener('submit', async event => {
      event.preventDefault()
      error.hidden = true
      if (fresh.value !== again.value) { fail(T('A két jelszó nem egyezik.')); again.focus(); return }
      if (fresh.value === current.value) { fail(T('The new password must differ from the current one.')); fresh.focus(); return }
      submit.disabled = true
      submit.dataset.loading = '1'
      try {
        await YumeAPI.changePassword(current.value, fresh.value)
        dialog.close()
        U.toast(T('Password changed. Every other device has been signed out.'), 'success')
      } catch (e) {
        fail(e?.status === 403 ? T('The current password is not right.') : authErrorMessage(e, 'password'))
      } finally {
        submit.disabled = false
        delete submit.dataset.loading
      }
    })
    const dialog = C.openDialog({
      title: T('Change password'),
      body: [form],
      actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => dialog.close() }), submit],
      initialFocus: current
    })
    // A gomb a lábrészben ül, az űrlapon kívül: így küldi el.
    submit.setAttribute('form', form.id || (form.id = 'pw-' + Math.random().toString(36).slice(2, 8)))
  },

  async _logoutAll () {
    const ok = await C.confirm({
      title: T('Sign out everywhere?'),
      message: T('Every device signed in to this account will be signed out, including this one.'),
      confirmLabel: T('Sign out everywhere')
    })
    if (!ok) return
    try {
      await YumeAPI.logoutAll()
      U.toast(T('Signed out on every device.'), 'success')
    } catch (e) {
      U.toast(authErrorMessage(e, 'logout'), 'error')
    }
    await afterAuth()
  },

  /** Fióktörlés: a jelszó a megerősítés — egy ellopott token nem elég hozzá. */
  _deleteAccount () {
    const password = P.input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 200 })
    const error = U.el('p', { class: 'field-error', role: 'alert', hidden: true })
    const submit = P.button(T('Delete my account'), { variant: 'danger-solid', type: 'submit' })
    const form = U.el('form', { class: 'dialog-form', id: 'del-' + Math.random().toString(36).slice(2, 8) }, [
      U.el('div', { class: 'callout callout-danger' }, [
        U.svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 18),
        U.el('p', { text: T('Your email address, username and password are erased and every session ends. Comments you wrote stay, without your name. This cannot be undone.') })
      ]),
      P.field(T('Your password'), passwordField(password), { hint: T('Type it to confirm that it is you.') }),
      error
    ])
    submit.setAttribute('form', form.id)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      error.hidden = true
      submit.disabled = true
      submit.dataset.loading = '1'
      try {
        await YumeAPI.deleteAccount(password.value)
        dialog.close()
        U.toast(T('Your account has been deleted.'), 'success')
        await afterAuth()
        window.location.hash = '#/landing'
      } catch (e) {
        error.textContent = e?.status === 401 ? T('The password is not right.') : authErrorMessage(e, 'delete')
        error.hidden = false
      } finally {
        submit.disabled = false
        delete submit.dataset.loading
      }
    })
    const dialog = C.openDialog({
      title: T('Delete account'),
      body: [form],
      actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => dialog.close() }), submit],
      initialFocus: password
    })
  },

  /** A könyvtár szinkronjának sora. Külön, mert állapotot mutat és cselekszik is. */
  _syncRow () {
    const LABEL = {
      off: T('Not syncing'),
      syncing: T('Syncing…'),
      synced: T('Synced to your account'),
      error: T('Sync unavailable')
    }
    const statusEl = U.el('span', { class: 'setting-row-desc', role: 'status', style: 'margin:0;', text: LABEL[this._sync?.status ?? 'off'] })
    // A szinkron a lap megnyitásakor gyakran még fut: az állapot addig
    // frissül, amíg a folyamat véget nem ér (legfeljebb fél percig).
    let checks = 0
    const follow = () => {
      if (!statusEl.isConnected || checks++ > 30) return
      statusEl.textContent = LABEL[this._sync?.status ?? 'off']
      if (this._sync?.status === 'syncing') setTimeout(follow, 1000)
    }
    setTimeout(follow, 1000)
    const syncBtn = U.el('button', {
      class: 'btn btn-secondary btn-sm',
      onclick: async () => {
        statusEl.textContent = LABEL.syncing
        await this._sync?.init()
        statusEl.textContent = LABEL[this._sync?.status ?? 'off']
        U.toast(
          this._sync?.status === 'synced' ? T('Library synced') : T('Sync unavailable'),
          this._sync?.status === 'error' ? 'error' : 'success')
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
    const choices = ONBOARDING_CHOICES
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
          input.setAttribute('role', 'switch')
          control = U.el('label', { class: 'switch' }, [input])
        } else {
          const select = U.el('select', { class: 'select' }, options.map(option =>
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
    this._themes.body(wrap.lastChild.lastChild)

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
    const toggle = (checked, onchange) => this._switch(checked, onchange)

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
          role: 'switch',
          ...(prefs[key] !== false ? { checked: '' } : {}),
          onchange: e => {
            const next = { ...(Store.settings().notifPrefs ?? DEFAULTS), [key]: e.target.checked }
            Store.saveSettings({ notifPrefs: next })
            // Az új részekről szóló értesítésnek a kiszolgálón is van
            // másolata; a kettő ne tudjon széttartani.
            if (key === 'airing') Prefs.set({ 'notifications.episodes': e.target.checked })
            refreshNotifications()
          }
        })
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
    const wrap = U.el('div', { class: 'settings-stack' })
    const signedIn = !!YumeAPI.user()

    const exportBtn = P.button(T('Export data'), {
      variant: 'secondary',
      onclick: () => {
        const data = { animelist: Store.list(), favourites: Store.favourites(), settings: Store.settings(), history: Store.history() }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const a = U.el('a', { href: URL.createObjectURL(blob), download: 'yume-data.json' })
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      }
    })

    /*
     * A BETÖLTÖTT FÁJLT ELLENŐRIZZÜK, mielőtt bármit felülír. Eddig bármilyen
     * JSON bekerült a böngésző tárába — egy rossz fájl egy üres könyvtárat
     * vagy használhatatlan beállításokat hagyott maga után. És rákérdezünk:
     * a betöltés a mostani helyi adatok helyére lép.
     */
    const importBtn = P.button(T('Import data'), {
      variant: 'secondary',
      onclick: () => {
        const input = U.el('input', { type: 'file', accept: 'application/json,.json' })
        input.onchange = async () => {
          let data
          try {
            data = JSON.parse(await input.files[0].text())
          } catch (e) { U.toast(T('Invalid file'), 'error'); return }
          const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v)
          const valid = isObject(data) &&
            (data.animelist === undefined || isObject(data.animelist)) &&
            (data.favourites === undefined || Array.isArray(data.favourites)) &&
            (data.settings === undefined || isObject(data.settings)) &&
            (data.history === undefined || Array.isArray(data.history)) &&
            [data.animelist, data.favourites, data.settings, data.history].some(v => v !== undefined)
          if (!valid) { U.toast(T('This is not a Yume export file.'), 'error'); return }
          const ok = await C.confirm({
            title: T('Import data?'),
            message: T('The file replaces the list, favourites, settings and history stored in this browser.'),
            confirmLabel: T('Import data')
          })
          if (!ok) return
          if (data.animelist) Store._write(Store._profileKey('animelist'), data.animelist)
          if (data.favourites) Store._write(Store._profileKey('favourites'), data.favourites)
          if (data.settings) Store._write(Store._profileKey('settings'), data.settings)
          if (data.history) Store._write(Store._profileKey('history'), data.history)
          Store.applyTheme()
          U.toast(signedIn
            ? T('Data imported into this browser. Your account copy is not overwritten; a title is sent to it the next time you change it.')
            : T('Data imported'), 'success')
        }
        input.click()
      }
    })

    wrap.append(this._group('Your data', [
      this._row('Export and import',
        signedIn
          ? 'Your library is also kept in your account. This exports what this browser holds — list, favourites, settings and history — as a JSON file.'
          : 'Your anime list, favourites and progress live only in this browser. Export them as JSON to back them up or move devices.',
        [exportBtn, importBtn]),
      this._row('API cache',
        'Responses from AniList, Jikan and ani.zip are kept locally to keep the app fast and to stay under their rate limits.',
        P.button(T('Clear cache'), { variant: 'secondary', onclick: () => { Store.clearCache(); U.toast(T('Cache cleared'), 'success') } }))
    ]))

    /*
     * A TÖRLÉS KÜLÖN CSOPORTBAN, a lap alján. Egy visszavonhatatlan művelet ne
     * álljon egy sorban azzal, amit az ember naponta használ.
     */
    wrap.append(this._group('Danger zone', [
      this._row('Delete all local data',
        signedIn
          ? 'Your list, favourites, history and settings in this browser. Your account keeps its copy. This cannot be undone.'
          : 'Your list, favourites, history and settings in this browser. This cannot be undone.',
        P.button(T('Delete all data'), {
          variant: 'danger',
          onclick: async () => {
            const ok = await C.confirm({
              title: T('Delete all local data?'),
              message: T('Delete ALL local data (list, favourites, settings)?'),
              confirmLabel: T('Delete all data'),
              danger: true
            })
            if (!ok) return
            Store.clearAll()
            window.location.reload()
          }
        }))
    ], { danger: true }))
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
