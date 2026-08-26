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
    const letter = () => document.createTextNode(key && !/^(https?:\/\/|\/)/.test(key)
      ? key
      : (ext.name ?? '?').slice(0, 1).toUpperCase())

    if (!key || !/^(https?:\/\/|\/)/.test(key)) return letter()

    // A remote icon is hosted by whoever wrote the extension, and an imported
    // one can point anywhere. When it does not load — the host is gone, the
    // viewer blocks it, there is no network — the card would otherwise keep a
    // broken-image glyph forever, which reads as the extension being broken.
    const img = U.el('img', { src: key, alt: '' })
    img.addEventListener('error', () => img.replaceWith(letter()))
    return img
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

  /** A star row: five buttons when it is a form, five glyphs when it is a score. */
  _stars (value, onpick) {
    const row = U.el('div', { class: 'ext-stars' + (onpick ? ' ext-stars-input' : '') })
    const paint = current => {
      for (const [index, star] of [...row.children].entries()) {
        star.classList.toggle('on', index < current)
      }
    }
    for (let i = 1; i <= 5; i++) {
      const star = onpick
        ? U.el('button', {
          type: 'button',
          class: 'ext-star',
          'aria-label': T('%s stars').replace('%s', i),
          onclick: () => { paint(i); onpick(i) }
        }, [document.createTextNode('★')])
        : U.el('span', { class: 'ext-star', text: '★' })
      row.append(star)
    }
    paint(value ?? 0)
    return row
  },

  /**
   * The review list and, for an account that has the extension installed, the
   * form to leave one.
   *
   * The server refuses a review from an account with no install, so the form
   * is only offered to one that has it — a 403 discovered after typing five
   * hundred characters is a worse way to learn the rule.
   */
  _reviews (slug, installed) {
    const section = U.el('section', { class: 'ext-reviews' }, [
      U.el('h3', { text: T('Reviews') })
    ])
    const list = U.el('div', { class: 'ext-review-list' }, [U.el('div', { class: 'spinner' })])
    const form = U.el('div')
    section.append(form, list)

    const load = async () => {
      let payload
      try {
        payload = await YumeAPI.extensionReviews(slug)
      } catch (error) {
        list.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load the reviews: ') + error.message }))
        return
      }

      list.replaceChildren(...(payload.data.length
        ? payload.data.map(review => this._review(review, payload.mine?.id === review.id))
        : [U.el('div', { class: 'empty-state', text: T('No reviews yet.') })]))

      if (!YumeAPI.user()) {
        form.replaceChildren(U.el('div', { class: 'ext-option-help', text: T('Sign in to leave a review.') }))
      } else if (!installed) {
        form.replaceChildren(U.el('div', { class: 'ext-option-help', text: T('Install the extension to review it.') }))
      } else {
        form.replaceChildren(this._reviewForm(slug, payload.mine, load))
      }
    }

    load()
    return section
  },

  _review (review, mine) {
    return U.el('article', { class: 'ext-review' + (mine ? ' mine' : '') }, [
      U.el('div', { class: 'ext-review-head' }, [
        this._stars(review.rating),
        U.el('span', { class: 'ext-review-author', text: review.author }),
        review.reviewed_version ? U.el('span', { class: 'ext-option-help', text: 'v' + review.reviewed_version }) : null,
        U.el('span', { class: 'ext-option-help', text: U.relTime(review.created_at) }),
        // Reporting your own review is not a thing anyone wants to do.
        mine || !YumeAPI.user()
          ? null
          : U.el('button', {
            class: 'btn btn-ghost btn-sm ext-review-report',
            onclick: e => this._report(e.currentTarget, review.id)
          }, [document.createTextNode(T('Report'))])
      ]),
      review.body ? U.el('p', { class: 'ext-review-body', text: review.body }) : null
    ])
  },

  async _report (button, reviewId) {
    const reason = window.prompt(T('Why are you reporting this review? (spam, harassment, nsfw, spoiler, illegal, other)'), 'spam')
    if (!reason) return
    button.disabled = true
    try {
      await YumeAPI.report('extension_review', reviewId, reason.trim().toLowerCase())
      U.toast(T('Thanks — a moderator will look at it.'), 'success')
    } catch (error) {
      U.toast(error.message, 'error')
      button.disabled = false
    }
  },

  _reviewForm (slug, mine, reload) {
    const draft = { rating: mine?.rating ?? 0, body: mine?.body ?? '' }
    const status = U.el('div', { class: 'ext-option-help' })

    const text = U.el('textarea', {
      class: 'input',
      rows: 3,
      maxlength: 5000,
      placeholder: T('What worked, what did not (optional)'),
      oninput: e => { draft.body = e.currentTarget.value }
    })
    text.value = draft.body

    const submit = U.el('button', {
      class: 'btn btn-primary btn-sm',
      onclick: async e => {
        if (!draft.rating) { status.textContent = T('Pick a rating first.'); return }
        const button = e.currentTarget
        button.disabled = true
        status.textContent = ''
        try {
          await YumeAPI.reviewExtension(slug, { rating: draft.rating, body: draft.body.trim() })
          reload()
        } catch (error) {
          status.textContent = error.message
          button.disabled = false
        }
      }
    }, [document.createTextNode(mine ? T('Update review') : T('Post review'))])

    return U.el('div', { class: 'ext-review-form' }, [
      this._stars(draft.rating, value => { draft.rating = value }),
      text,
      U.el('div', { class: 'ext-actions' }, [
        submit,
        mine
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async e => {
              e.currentTarget.disabled = true
              try {
                await YumeAPI.deleteExtensionReview(slug)
                reload()
              } catch (error) {
                status.textContent = error.message
                e.currentTarget.disabled = false
              }
            }
          }, [document.createTextNode(T('Delete'))])
          : null,
        status
      ])
    ])
  },

  HEALTH_LABEL: { healthy: '🟢', unstable: '🟡', broken: '🔴', unknown: '⚪' },

  /**
   * One extension in full: what it does, what it is allowed to reach, which
   * versions exist and what people who run it think of it.
   *
   * The declared permissions are shown before the install button rather than
   * after it. An extension asking for network access to a host you have never
   * heard of is the one thing worth reading before you press Install.
   */
  async _detail (root, slug) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('div', { class: 'spinner' }))

    let ext, install
    try {
      const [detail, installs] = await Promise.all([
        YumeAPI.extension(slug),
        YumeAPI.user() ? YumeAPI.installedExtensions().catch(() => []) : Promise.resolve([])
      ])
      ext = detail
      install = installs.find(row => row.slug === slug)
    } catch (error) {
      pad.replaceChildren(
        U.el('a', { class: 'btn btn-ghost btn-sm', href: '#/extensions', text: T('← Extension Store') }),
        U.el('div', { class: 'error-state', text: T('Failed to load this extension: ') + error.message })
      )
      return
    }

    // Installing or removing changes the actions, the install count and
    // whether the review form is offered, so the page is drawn again from the
    // server rather than patched in place.
    const redraw = () => { root.replaceChildren(); this._detail(root, slug) }

    const versions = ext.versions ?? []
    // Permissions belong to a version, and the latest published one is what an
    // install would actually run.
    const permissions = versions[0]?.permissions ?? []

    pad.replaceChildren(
      U.el('a', { class: 'btn btn-ghost btn-sm', href: '#/extensions', text: T('← Extension Store') }),

      U.el('header', { class: 'ext-detail-head' }, [
        U.el('div', { class: 'ext-icon ext-icon-lg' }, [this._icon(ext)]),
        U.el('div', {}, [
          U.el('h1', { text: ext.name }),
          U.el('div', { class: 'ext-dev' }, [
            document.createTextNode(ext.developer),
            ext.developer_verified ? U.el('span', { class: 'verified', text: ' ✓' }) : null
          ]),
          U.el('div', { class: 'ext-meta' }, [
            U.el('span', { class: 'ext-type-chip', text: ext.type }),
            U.el('span', { text: `${(ext.install_count ?? 0).toLocaleString(I18n.locale())} installs` }),
            ext.rating_count
              ? U.el('span', { text: `★ ${Number(ext.rating_avg).toFixed(1)} (${ext.rating_count})` })
              : U.el('span', { class: 'ext-option-help', text: T('No ratings yet') }),
            versions[0] ? U.el('span', { text: 'v' + versions[0].version }) : null,
            // The health badge is a failure rate over the last week, so an
            // extension with no installs reports "unknown" rather than green.
            U.el('span', {
              class: 'ext-health',
              title: T('%n failures in the last 7 days').replace('%n', ext.failures_7d ?? 0),
              text: `${this.HEALTH_LABEL[ext.health] ?? '⚪'} ${ext.health}`
            }),
            ext.status === 'deprecated' ? U.el('span', { class: 'ext-deprecated', text: T('deprecated') }) : null
          ])
        ])
      ]),

      U.el('div', { class: 'ext-detail-actions' }, [this._detailActions(ext, install, redraw)]),

      U.el('p', { class: 'ext-detail-summary', text: ext.summary }),
      ext.description ? U.el('p', { class: 'ext-detail-description', text: ext.description }) : null,

      U.el('section', { class: 'ext-permissions' }, [
        U.el('h3', { text: T('Requested permissions') }),
        permissions.length
          ? U.el('ul', {}, permissions.map(entry => U.el('li', {}, [
            U.el('code', { text: entry.permission }),
            entry.hosts?.length
              ? U.el('span', { class: 'ext-option-help', text: ' → ' + entry.hosts.join(', ') })
              : null
          ])))
          : U.el('div', { class: 'ext-option-help', text: T('None — this extension runs with no access beyond the sandbox.') })
      ]),

      U.el('section', { class: 'ext-versions' }, [
        U.el('h3', { text: T('Versions') }),
        versions.length
          ? U.el('ul', {}, versions.map(version => U.el('li', {}, [
            U.el('b', { text: 'v' + version.version }),
            U.el('span', { class: 'ext-option-help', text: ' ' + new Date(version.publishedAt).toLocaleDateString(I18n.locale()) }),
            version.changelog ? U.el('div', { class: 'ext-option-help', text: version.changelog }) : null,
            // The hash is what the client checks the downloaded bytes
            // against, so it is worth being able to read it.
            U.el('code', { class: 'ext-hash', text: (version.packageHash ?? '').slice(0, 16) })
          ])))
          : U.el('div', { class: 'ext-option-help', text: T('No published versions.') })
      ]),

      this._reviews(slug, !!install)
    )
  },

  /** Install / settings / uninstall for the detail page. */
  _detailActions (ext, install, reload) {
    if (!YumeAPI.user()) {
      return U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/settings', text: T('Sign in to install') })
    }

    const wrap = U.el('div', { class: 'ext-actions' })
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
      wrap.append(U.el('button', {
        class: 'btn btn-primary',
        onclick: e => act(e.currentTarget, () => YumeAPI.installExtension(ext.slug))
      }, [document.createTextNode(T('Install'))]))
      return wrap
    }

    const settings = this._settings(ext, install)
    settings.hidden = true
    wrap.append(
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
      settings
    )
    return wrap
  },

  render (root, params, slug) {
    if (slug) return this._detail(root, slug)

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
          // The name is the way into the detail page: a real link, so it can
          // be middle-clicked, copied and bookmarked like any other.
          U.el('a', { class: 'ext-name', href: '#/extensions/' + encodeURIComponent(ext.slug), text: ext.name }),
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
