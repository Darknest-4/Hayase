/* global window, document, U, YumeAPI, T, I18n */
// Extension Store — browses the Yume API's extension registry, and installs
// from it.
//
// The store listed extensions and stopped there: no install button, no way to
// set an option, no way to turn one off. So an extension could be browsed and
// never run, and the ones that need a server URL or a token — Jellyfin, Plex,
// the library server, the translation feed — had no way to be told either.
// This page is that missing half.
//
// Shows a clear connect state when no backend is reachable instead of
// pretending: the store is a platform feature, not a client-side mock.

const PageExtensions = {
  TYPES: ['torrent', 'http', 'nzb', 'subtitle', 'metadata', 'theme'],

  /**
   * An icon is either an image or an emoji.
   *
   * `icon_key` was rendered as an `<img src>` unconditionally, so a manifest
   * declaring `"icon": "🎨"` drew a broken image. Anything that is not a URL
   * or a path is drawn as text.
   */
  _icon (ext) {
    const key = ext.icon_key
    if (key && /^(https?:\/\/|\/)/.test(key)) return U.el('img', { src: key, alt: '' })
    return document.createTextNode(key || (ext.name ?? '?').slice(0, 1).toUpperCase())
  },

  /**
   * One control per option the installed version declares.
   *
   * Drawn from the schema the server returns with the install, not from the
   * package: the client would otherwise have to download and parse a manifest
   * to know what to ask for, and would then be describing a different version
   * than the one actually installed.
   */
  _optionField (key, spec, value, onchange) {
    const label = key.replaceAll('_', ' ')
    const describe = spec.description ? U.el('div', { class: 'ext-option-help', text: spec.description }) : null

    if (spec.type === 'boolean') {
      const input = U.el('input', { type: 'checkbox', onchange: e => onchange(e.currentTarget.checked) })
      input.checked = value ?? spec.default ?? false
      return U.el('label', { class: 'ext-option ext-option-inline' }, [input, U.el('span', { text: label }), describe])
    }

    let input
    if (spec.type === 'select') {
      input = U.el('select', { class: 'input', onchange: e => onchange(e.currentTarget.value) },
        (spec.choices ?? []).map(choice => U.el('option', { value: choice, text: choice })))
      input.value = value ?? spec.default ?? (spec.choices ?? [])[0] ?? ''
    } else if (spec.type === 'number') {
      input = U.el('input', {
        class: 'input',
        type: 'number',
        value: value ?? spec.default ?? '',
        // An empty number field means "unset", not zero, so it is sent as null
        // and the server leaves the option out.
        onchange: e => onchange(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))
      })
    } else {
      input = U.el('input', {
        class: 'input',
        // A token is a password: it should not sit on screen in a room with
        // other people in it, and it must never end up in a screenshot.
        type: /token|key|password|secret/.test(key) ? 'password' : 'text',
        value: value ?? spec.default ?? '',
        placeholder: spec.default != null ? String(spec.default) : '',
        onchange: e => onchange(e.currentTarget.value)
      })
    }

    return U.el('label', { class: 'ext-option' }, [U.el('span', { class: 'ext-option-label', text: label }), input, describe])
  },

  /**
   * The settings panel for an installed extension.
   *
   * Every field is submitted together, because options replace rather than
   * merge server-side: sending only what changed would clear everything else.
   */
  _settings (ext, install, onsaved) {
    const schema = install.option_schema ?? {}
    const keys = Object.keys(schema)
    const draft = { ...(install.options ?? {}) }

    const panel = U.el('div', { class: 'ext-settings' })
    if (!keys.length) {
      panel.append(U.el('div', { class: 'ext-option-help', text: T('This extension has nothing to configure.') }))
      return panel
    }

    for (const key of keys) {
      panel.append(this._optionField(key, schema[key], draft[key], value => {
        if (value === null) delete draft[key]
        else draft[key] = value
      }))
    }

    const status = U.el('div', { class: 'ext-option-help' })
    panel.append(U.el('div', { class: 'ext-actions' }, [
      U.el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async e => {
          const button = e.currentTarget
          button.disabled = true
          status.textContent = ''
          try {
            await YumeAPI.configureExtension(ext.slug, { options: draft })
            // The sandbox holds the options it was started with, so a saved
            // change does nothing until the worker is restarted with them.
            await this._reloadHost()
            status.textContent = T('Saved.')
            onsaved?.()
          } catch (error) {
            status.textContent = error.message
          } finally {
            button.disabled = false
          }
        }
      }, [document.createTextNode(T('Save settings'))]),
      status
    ]))
    return panel
  },

  /** Restart the sandbox so an install, a change or a removal takes effect now. */
  async _reloadHost () {
    const host = window.ExtensionHost
    if (!host) return
    host.unloadAll?.()
    try {
      await host.bootstrap()
    } catch (error) {
      console.warn('[extensions] reload failed:', error.message)
    }
  },

  render (root, params) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    root.prepend(window.C.spotlight(T('Extension Store'), {
      subtitle: T('Sources, trackers and tools — sandboxed and permission-scoped'),
      actions: U.el('a', { class: 'btn btn-secondary btn-sm', style: 'margin-top:.8rem;', href: '#/developer' }, [document.createTextNode(T('Developer Portal →'))])
    }))

    const state = { type: params.get('type') ?? '', sort: 'installs' }

    const tabs = U.el('div', { class: 'tabs' })
    const content = U.el('div')
    pad.append(tabs, content)

    const renderTabs = () => {
      tabs.replaceChildren(
        U.el('button', {
          class: 'tab' + (state.type === '' ? ' active' : ''),
          onclick: () => { state.type = ''; renderTabs(); load() }
        }, [document.createTextNode(T('All'))]),
        ...this.TYPES.map(type => U.el('button', {
          class: 'tab' + (state.type === type ? ' active' : ''),
          onclick: () => { state.type = type; renderTabs(); load() }
        }, [document.createTextNode(type)]))
      )
    }

    const load = async () => {
      content.replaceChildren(U.el('div', { class: 'spinner' }))

      if (!await YumeAPI.available()) {
        content.replaceChildren(
          U.el('div', {
            class: 'callout',
            html: `
            <b>Extension store is a platform feature.</b><br>
            No Yume API reachable at <code>${YumeAPI.base()}</code>.
            Start the backend (<code>docker compose up -d && cd server && npm run dev</code>)
            or point the client at your server in <a href="#/settings" style="text-decoration:underline">Settings</a>.
            <br><br>
            Extensions resolve video sources (torrent, HTTP, NZB), subtitles and
            metadata inside sandboxed workers with declared permissions — see
            <code>docs/extensions.md</code> for how to build one.`
          })
        )
        return
      }

      try {
        // Installs are per account, so this is only asked when signed in; a
        // failure there must not empty the store listing.
        const [{ data }, installs] = await Promise.all([
          YumeAPI.extensions(state.type || undefined, state.sort),
          YumeAPI.user() ? YumeAPI.installedExtensions().catch(() => []) : Promise.resolve([])
        ])
        const installed = new Map(installs.map(row => [row.slug, row]))

        if (!data.length) {
          content.replaceChildren(U.el('div', { class: 'empty-state', text: T('No published extensions in this category yet.') }))
          return
        }

        const grid = U.el('div', { class: 'ext-grid' })
        for (const ext of data) grid.append(this._card(ext, installed.get(ext.slug), load))
        content.replaceChildren(grid)
      } catch (e) {
        content.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load the store: ') + e.message }))
      }
    }

    renderTabs()
    load()
  },

  _card (ext, install, reload) {
    const card = U.el('div', { class: 'ext-card' + (install ? ' installed' : '') }, [
      U.el('div', { class: 'ext-card-head' }, [
        U.el('div', { class: 'ext-icon' }, [this._icon(ext)]),
        U.el('div', {}, [
          U.el('div', { class: 'ext-name', text: ext.name }),
          U.el('div', { class: 'ext-dev' }, [
            document.createTextNode(ext.developer),
            ext.developer_verified ? U.el('span', { class: 'verified', text: ' ✓' }) : null
          ])
        ])
      ]),
      U.el('div', { class: 'ext-summary', text: ext.summary }),
      U.el('div', { class: 'ext-meta' }, [
        U.el('span', { class: 'ext-type-chip', text: ext.type }),
        U.el('span', { text: `${(ext.install_count ?? 0).toLocaleString(I18n.locale())} installs` }),
        ext.rating_avg ? U.el('span', { text: `★ ${Number(ext.rating_avg).toFixed(1)} (${ext.rating_count})` }) : null,
        ext.latest_version ? U.el('span', { text: 'v' + ext.latest_version }) : null
      ])
    ])

    // Signed out there is nothing to install into, and saying so beats a
    // button that fails when it is pressed.
    if (!YumeAPI.user()) {
      card.append(U.el('div', { class: 'ext-actions' }, [
        U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/settings', text: T('Sign in to install') })
      ]))
      return card
    }

    const actions = U.el('div', { class: 'ext-actions' })
    card.append(actions)

    const act = async (button, work) => {
      button.disabled = true
      try {
        await work()
        await this._reloadHost()
        reload()
      } catch (error) {
        U.toast(error.message, 'error')
        button.disabled = false
      }
    }

    if (!install) {
      actions.append(U.el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: e => act(e.currentTarget, () => YumeAPI.installExtension(ext.slug))
      }, [document.createTextNode(T('Install'))]))
      return card
    }

    const settings = this._settings(ext, install)
    settings.hidden = true

    actions.append(
      U.el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: () => { settings.hidden = !settings.hidden }
      }, [document.createTextNode(T('Settings'))]),
      U.el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: e => act(e.currentTarget, () => YumeAPI.configureExtension(ext.slug, { enabled: !install.enabled }))
      }, [document.createTextNode(install.enabled ? T('Disable') : T('Enable'))]),
      U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: e => act(e.currentTarget, () => YumeAPI.uninstallExtension(ext.slug))
      }, [document.createTextNode(T('Uninstall'))]),
      // `append` is the raw DOM one, not U.el's: a null child would be
      // inserted as the text "null".
      ...(install.enabled ? [] : [U.el('span', { class: 'ext-option-help', text: T('Installed, not running') })])
    )
    card.append(settings)
    return card
  }
}

window.PageExtensions = PageExtensions
