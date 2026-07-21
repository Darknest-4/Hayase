/* global window, document, U, C, YumeAPI */
// Admin dashboard — overview analytics, user management and the
// moderation queue. Only reachable with the right permissions; the
// server enforces them regardless.

const PageAdmin = {
  async render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('h1', { class: 'page-title', text: 'Admin' }))

    const perms = await YumeAPI.myPermissions()
    const canUsers = perms.includes('admin.users.manage')
    const canModerate = perms.includes('community.moderate')
    const canAnalytics = perms.includes('admin.analytics.view')
    const canWebhooks = perms.includes('admin.webhooks.manage')
    const canConfig = perms.includes('settings.system')
    const canRoles = perms.includes('roles.manage')

    if (!canUsers && !canModerate && !canAnalytics && !canWebhooks && !canConfig && !canRoles) {
      pad.append(U.el('div', { class: 'callout', text: 'You need moderator or admin permissions to see this page.' }))
      return
    }

    const TABS = [
      canAnalytics && ['overview', 'Overview'],
      canUsers && ['users', 'Users'],
      canModerate && ['reports', 'Reports'],
      canRoles && ['roles', 'Roles'],
      canWebhooks && ['webhooks', 'Webhooks'],
      canConfig && ['config', 'Site Config']
    ].filter(Boolean)

    const state = { tab: TABS[0][0] }
    const tabs = U.el('div', { class: 'tabs' })
    const content = U.el('div', { style: 'margin-top:1.25rem;' })
    pad.append(tabs, content)

    const renderTabs = () => {
      tabs.replaceChildren(...TABS.map(([value, label]) => U.el('button', {
        class: 'tab' + (state.tab === value ? ' active' : ''),
        onclick: () => { state.tab = value; renderTabs(); renderContent() }
      }, [document.createTextNode(label)])))
    }

    const renderContent = () => {
      content.replaceChildren(U.el('div', { class: 'spinner' }))
      if (state.tab === 'overview') this.renderOverview(content)
      else if (state.tab === 'users') this.renderUsers(content)
      else if (state.tab === 'reports') this.renderReports(content)
      else if (state.tab === 'roles') this.renderRoles(content)
      else if (state.tab === 'config') this.renderConfig(content)
      else this.renderWebhooks(content)
    }

    renderTabs()
    renderContent()
  },

  // ---- Roles & permissions (fine-grained RBAC) ----
  async renderRoles (content) {
    let rolesRes, catRes
    try {
      [rolesRes, catRes] = await Promise.all([YumeAPI.admin.roles(), YumeAPI.admin.permissionCatalog()])
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load roles: ' + e.message }))
      return
    }
    content.replaceChildren()

    const roles = rolesRes.data
    const catalog = catRes.data
    const total = catalog.length
    const groups = {}
    for (const p of catalog) (groups[p.group] ??= []).push(p)

    const state = { role: roles[0], granted: new Set(roles[0].permissions), filter: '' }

    const layout = U.el('div', { class: 'roles-layout' })
    content.append(layout)

    // ---- role rail ----
    const rail = U.el('div', { class: 'roles-rail' })
    const countLabel = {}
    for (const r of roles) {
      const cnt = U.el('span', { class: 'role-count' })
      countLabel[r.slug] = cnt
      rail.append(U.el('button', {
        class: 'role-item' + (r.slug === state.role.slug ? ' active' : ''),
        dataset: { slug: r.slug },
        onclick: () => {
          state.role = r
          state.granted = new Set(r.permissions)
          rail.querySelectorAll('.role-item').forEach(b => b.classList.toggle('active', b.dataset.slug === r.slug))
          renderPanel()
        }
      }, [
        U.el('div', { class: 'role-name', text: r.name }),
        U.el('div', { class: 'role-sub' }, [
          U.el('code', { text: r.slug }),
          document.createTextNode(` · ${r.user_count} user${r.user_count === '1' ? '' : 's'}`)
        ]),
        cnt
      ]))
    }
    layout.append(rail)

    // ---- permission panel ----
    const panel = U.el('div', { class: 'roles-panel' })
    layout.append(panel)

    const updateCounts = () => {
      for (const r of roles) {
        const n = r.slug === state.role.slug ? state.granted.size : r.permissions.length
        countLabel[r.slug].textContent = `${r.slug === 'admin' ? total : n}/${total}`
      }
    }

    const renderPanel = () => {
      panel.replaceChildren()
      const isAdmin = state.role.slug === 'admin'
      const has = slug => isAdmin || state.granted.has(slug)

      const head = U.el('div', { class: 'roles-panel-head' }, [
        U.el('div', {}, [
          U.el('h3', { style: 'margin:0;', text: state.role.name }),
          U.el('p', { class: 'list-row-sub', style: 'margin:.15rem 0 0;', text: isAdmin ? 'The admin role always holds every permission.' : `${state.granted.size} of ${total} permissions granted` })
        ]),
        U.el('input', { class: 'input', placeholder: 'Filter permissions…', value: state.filter, oninput: e => { state.filter = e.target.value.toLowerCase(); renderList() } })
      ])
      panel.append(head)

      const listWrap = U.el('div', { class: 'perm-groups' })
      panel.append(listWrap)

      const renderList = () => {
        listWrap.replaceChildren()
        for (const [group, perms] of Object.entries(groups)) {
          const visible = perms.filter(p => !state.filter || p.slug.includes(state.filter) || p.description.toLowerCase().includes(state.filter))
          if (!visible.length) continue
          const grantedInGroup = visible.filter(p => has(p.slug)).length
          const groupBox = U.el('div', { class: 'perm-group' }, [
            U.el('div', { class: 'perm-group-head' }, [
              U.el('span', { class: 'perm-group-title', text: group }),
              U.el('span', { class: 'perm-group-count', text: `${grantedInGroup}/${visible.length}` }),
              isAdmin ? null : U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk(visible, grantedInGroup < visible.length) }, [document.createTextNode(grantedInGroup < visible.length ? 'Grant all' : 'Revoke all')])
            ])
          ])
          for (const p of visible) {
            const cb = U.el('input', {
              type: 'checkbox', ...(has(p.slug) ? { checked: '' } : {}), ...(isAdmin ? { disabled: '' } : {}),
              onchange: e => toggle(p.slug, e.target.checked, e.target)
            })
            groupBox.append(U.el('label', { class: 'perm-row' }, [
              cb,
              U.el('div', { class: 'perm-info' }, [
                U.el('code', { class: 'perm-slug', text: p.slug }),
                U.el('span', { class: 'perm-desc', text: p.description })
              ])
            ]))
          }
          listWrap.append(groupBox)
        }
      }

      const toggle = async (slug, granted, el) => {
        try {
          await YumeAPI.admin.setRolePermission(state.role.id, slug, granted)
          if (granted) state.granted.add(slug); else state.granted.delete(slug)
          // keep the source role object in sync so counts persist across switches
          state.role.permissions = [...state.granted]
          updateCounts()
          head.querySelector('.list-row-sub').textContent = `${state.granted.size} of ${total} permissions granted`
          renderList()
        } catch (err) { U.toast(err.message, 'error'); if (el) el.checked = !granted }
      }

      const bulk = async (perms, grant) => {
        for (const p of perms) {
          if (grant === has(p.slug)) continue
          try { await YumeAPI.admin.setRolePermission(state.role.id, p.slug, grant); grant ? state.granted.add(p.slug) : state.granted.delete(p.slug) } catch (e) { /* skip */ }
        }
        state.role.permissions = [...state.granted]
        updateCounts(); renderList()
        head.querySelector('.list-row-sub').textContent = `${state.granted.size} of ${total} permissions granted`
        U.toast(grant ? 'Granted group' : 'Revoked group')
      }

      renderList()
    }

    updateCounts()
    renderPanel()
  },

  // ---- Site Config: feature flags + global settings ----
  async renderConfig (content) {
    let data
    try {
      data = await YumeAPI.admin.config()
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load config: ' + e.message }))
      return
    }
    content.replaceChildren()

    const settings = data.settings ?? {}
    const applyLive = async () => { await window.App.loadConfig(); window.App.applyNavVisibility(); window.App.refreshAdminNav() }

    // ---------- global settings ----------
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Global' }))

    const boolSetting = (key, title, desc) => {
      const on = settings[key] === true
      return U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:1rem;' }, [
        U.el('div', { style: 'flex-grow:1;' }, [U.el('h3', { style: 'margin:0;', text: title }), U.el('p', { style: 'margin:.2rem 0 0;', text: desc })]),
        U.el('label', { class: 'switch' }, [
          U.el('input', { type: 'checkbox', ...(on ? { checked: '' } : {}), onchange: async e => {
            try { await YumeAPI.admin.setSetting(key, e.target.checked); settings[key] = e.target.checked; U.toast('Saved'); await applyLive() } catch (err) { U.toast(err.message, 'error'); e.target.checked = on }
          } }),
          U.el('span', { class: 'slider' })
        ])
      ])
    }
    content.append(
      boolSetting('require_login', 'Require login for the whole site', 'Lock every page behind a sign-in screen (Settings stays reachable).'),
      boolSetting('registration_open', 'Open registration', 'Allow new accounts to sign up.')
    )

    const textSetting = (key, title, desc) => U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: title }), U.el('p', { text: desc }),
      U.el('input', { class: 'input', style: 'min-width:20rem;', value: settings[key] ?? '', onchange: async e => {
        try { await YumeAPI.admin.setSetting(key, e.target.value); U.toast('Saved'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
      } })
    ])
    content.append(
      textSetting('site_name', 'Site name', 'Shown in the sidebar wordmark and the browser tab.'),
      textSetting('tagline', 'Tagline', 'Short description used around the app.')
    )

    // ---------- feature flags ----------
    const flags = data.flags ?? []
    const groups = { page: 'Pages', feature: 'Features' }
    for (const [cat, heading] of Object.entries(groups)) {
      const rows = flags.filter(f => f.category === cat)
      if (!rows.length) continue
      content.append(U.el('h2', { class: 'detail-section-title', text: heading }))
      const table = U.el('div', { class: 'flag-list' })
      for (const f of rows) table.append(this.flagRow(f, applyLive))
      content.append(table)
    }
  },

  flagRow (f, applyLive) {
    const state = { access: f.access, permission: f.required_permission }

    const permInput = U.el('input', {
      class: 'input flag-perm' + (state.access === 'permission' ? '' : ' hidden'),
      style: 'min-width:11rem;', placeholder: 'permission slug', value: state.permission ?? ''
    })

    const save = async patch => {
      try { await YumeAPI.admin.setFlag(f.key, patch); U.toast(`${f.label} updated`); await applyLive() } catch (e) { U.toast(e.message, 'error') }
    }

    const accessSel = U.el('select', {
      class: 'select flag-access', onchange: async e => {
        state.access = e.target.value
        permInput.classList.toggle('hidden', state.access !== 'permission')
        await save({ access: state.access, requiredPermission: state.access === 'permission' ? (permInput.value.trim() || 'analytics.view') : null })
        if (state.access === 'permission' && !permInput.value.trim()) permInput.value = 'analytics.view'
      }
    }, [['public', 'Public'], ['auth', 'Login required'], ['permission', 'Permission']].map(([v, l]) =>
      U.el('option', { value: v, text: l, ...(state.access === v ? { selected: '' } : {}) })))

    permInput.addEventListener('change', () => save({ requiredPermission: permInput.value.trim() || null }))

    const toggle = U.el('label', { class: 'switch' }, [
      U.el('input', { type: 'checkbox', ...(f.enabled ? { checked: '' } : {}), onchange: e => save({ enabled: e.target.checked }) }),
      U.el('span', { class: 'slider' })
    ])

    return U.el('div', { class: 'flag-row' }, [
      U.el('div', { class: 'flag-meta' }, [
        U.el('div', { class: 'flag-label', text: f.label }),
        f.description ? U.el('div', { class: 'flag-desc', text: f.description }) : null,
        U.el('code', { class: 'flag-key', text: f.key })
      ]),
      U.el('div', { class: 'flag-controls' }, [accessSel, permInput, toggle])
    ])
  },

  async renderOverview (content) {
    try {
      const o = await YumeAPI.admin.overview()
      content.replaceChildren()

      const cards = [
        [o.users.total, 'Users'],
        [o.users.new_7d, 'New (7d)'],
        [o.users.active_1d, 'Active (24h)'],
        [o.content.anime, 'Anime'],
        [o.content.comments, 'Comments'],
        [o.content.open_reports, 'Open reports'],
        [Math.round(o.watch.minutes_7d / 60) + 'h', 'Watched (7d)'],
        [o.watch.completions_7d, 'Episodes finished (7d)'],
        [o.jobs.pending, 'Pending jobs'],
        [o.jobs.dead, 'Dead jobs']
      ]
      content.append(U.el('div', { class: 'stat-cards' }, cards.map(([value, label]) =>
        U.el('div', { class: 'stat-card' }, [U.el('b', { text: String(value ?? 0) }), U.el('span', { text: label })]))))

      if (o.trending.length) {
        content.append(U.el('h2', { class: 'detail-section-title', text: 'Trending now' }))
        const max = Number(o.trending[0].trending)
        const bars = U.el('div', { class: 'genre-bars' })
        for (const t of o.trending) {
          bars.append(U.el('div', { class: 'genre-bar' }, [
            U.el('span', { class: 'genre-name', text: t.canonical_title, title: t.canonical_title }),
            U.el('div', { class: 'genre-track' }, [U.el('div', { class: 'genre-fill', style: `width:${Number(t.trending) / max * 100}%;` })]),
            U.el('span', { class: 'genre-count', text: String(t.trending) })
          ]))
        }
        content.append(bars)
      }

      content.append(U.el('h2', { class: 'detail-section-title', text: 'Error groups' }))
      if (!o.errorGroups.length) {
        content.append(U.el('div', { class: 'empty-state', style: 'padding:1rem;text-align:left;', text: 'No open error groups. 🎉' }))
      } else {
        for (const err of o.errorGroups) {
          content.append(U.el('div', { class: 'list-row' }, [
            U.el('div', { class: 'list-row-grow' }, [
              U.el('div', { class: 'list-row-title', text: err.title }),
              U.el('div', { class: 'list-row-sub', text: `${err.event_count} events • last ${U.relTime(new Date(err.last_seen))}` })
            ])
          ]))
        }
      }
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  async renderUsers (content, search = '') {
    const input = U.el('input', {
      class: 'input search-input-big',
      placeholder: 'Search by username or email…',
      value: search,
      oninput: U.debounce(e => this.renderUsers(content, e.target.value.trim()))
    })

    try {
      const { data } = await YumeAPI.admin.users(search || undefined)
      content.replaceChildren(U.el('div', { class: 'filters' }, [input]))
      if (search) input.focus()

      for (const user of data) {
        const statusBadge = U.el('span', {
          class: 'badge' + (user.status === 'active' ? '' : ' badge-theme'),
          text: user.status
        })
        const actions = U.el('div', { class: 'progress-controls' })

        const act = (status, label) => U.el('button', {
          class: 'btn btn-sm ' + (status === 'active' ? 'btn-secondary' : 'btn-ghost'),
          onclick: async () => {
            const reason = window.prompt(`Reason for "${label}" on ${user.username}:`)
            if (!reason || reason.length < 3) return
            try {
              await YumeAPI.admin.setUserStatus(user.id, status, reason)
              U.toast(`${user.username}: ${label}`)
              this.renderUsers(content, search)
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode(label)])

        if (user.status === 'active') actions.append(act('suspended', 'Suspend'), act('banned', 'Ban'))
        else actions.append(act('active', 'Restore'))

        content.append(U.el('div', { class: 'list-row', style: 'cursor:default;' }, [
          U.el('div', { class: 'list-row-grow' }, [
            U.el('div', { class: 'list-row-title' }, [
              document.createTextNode(user.username + ' '),
              statusBadge,
              ...(user.roles.filter(r => r !== 'user').map(role => U.el('span', { class: 'badge badge-outline', style: 'margin-left:.35rem;', text: role })))
            ]),
            U.el('div', { class: 'list-row-sub', text: `${user.email} • joined ${U.airDate(user.created_at)}${user.last_login_at ? ' • last seen ' + U.relTime(new Date(user.last_login_at)) : ''}` })
          ]),
          actions
        ]))
      }
      if (!data.length) content.append(U.el('div', { class: 'empty-state', text: 'No users match.' }))
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  async renderReports (content) {
    try {
      const { data } = await YumeAPI.admin.reports('open')
      content.replaceChildren()

      if (!data.length) {
        content.append(U.el('div', { class: 'empty-state', text: 'Moderation queue is empty. ✨' }))
        return
      }

      for (const report of data) {
        const act = (action, label, primary = false) => U.el('button', {
          class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'),
          onclick: async () => {
            const reason = window.prompt(`Reason (${label}):`, action === 'dismiss' ? 'Not a violation' : '')
            if (!reason || reason.length < 3) return
            try {
              await YumeAPI.admin.resolveReport(report.id, action, reason)
              U.toast(`Report ${label.toLowerCase()}ed`)
              this.renderReports(content)
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode(label)])

        content.append(U.el('div', { class: 'comment', style: 'max-width:none;' }, [
          U.el('div', { class: 'comment-head' }, [
            U.el('span', { class: 'comment-author', text: report.reason.toUpperCase() }),
            U.el('span', { class: 'comment-context', text: `${report.subject_type} • reported by ${report.reporter}` }),
            U.el('span', { class: 'comment-time', text: U.relTime(new Date(report.created_at)) })
          ]),
          report.excerpt ? U.el('div', { class: 'comment-body', style: 'background:var(--bg-sunken);border-radius:6px;padding:.5rem .75rem;margin:.35rem 0;', text: report.excerpt }) : null,
          report.details ? U.el('div', { class: 'list-row-sub', text: 'Details: ' + report.details }) : null,
          U.el('div', { style: 'display:flex;gap:.5rem;margin-top:.6rem;' }, [
            ...(report.subject_type in { comment: 1, post: 1, review: 1 } ? [act('hide', 'Hide', true)] : []),
            act('dismiss', 'Dismiss')
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  // ---- webhooks ----

  EVENT_LABELS: {
    'user.registered': 'New user registered',
    'user.moderated': 'User suspended/banned/restored',
    'comment.created': 'New comment',
    'report.created': 'Content reported',
    'report.resolved': 'Report resolved',
    'extension.submitted': 'Extension version submitted',
    'extension.reviewed': 'Extension reviewed',
    'extension.installed': 'Extension installed',
    'w2g.room_created': 'Watch Together room opened',
    'stats.daily': 'Daily stats digest',
    'stats.trending': 'Trending refreshed',
    'catalogue.imported': 'Catalogue import finished',
    'job.failed': 'Background job failed',
    'webhook.test': 'Manual test'
  },

  async renderWebhooks (content) {
    try {
      const [{ events }, { data }] = await Promise.all([
        YumeAPI.admin.webhookEvents(),
        YumeAPI.admin.webhooks()
      ])
      content.replaceChildren()

      content.append(U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;' }, [
        U.el('p', { class: 'list-row-sub', style: 'max-width:40rem;', text: 'Outbound webhooks fire on the events you subscribe each one to. Discord endpoints get rich embeds; generic endpoints get signed JSON.' }),
        U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.webhookForm(content, events, null) }, [document.createTextNode('+ New webhook')])
      ]))

      if (!data.length) {
        content.append(U.el('div', { class: 'empty-state', text: 'No webhooks yet. Add one to start receiving events.' }))
        return
      }

      for (const hook of data) {
        const healthy = hook.enabled && hook.failure_count === 0
        content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
          U.el('div', { style: 'display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;' }, [
            U.el('span', { style: `width:.6rem;height:.6rem;border-radius:50%;background:${healthy ? 'var(--ok)' : hook.enabled ? 'var(--status-paused)' : 'var(--fg-faint)'};` }),
            U.el('h3', { style: 'margin:0;', text: hook.name }),
            U.el('span', { class: 'ext-type-chip', text: hook.format }),
            U.el('span', { class: 'list-row-sub', text: `${hook.events.length} events • ${hook.delivery_count} deliveries` }),
            hook.last_error ? U.el('span', { class: 'badge', style: 'background:var(--danger);color:white;', text: 'last error: ' + hook.last_error }) : null
          ]),
          U.el('div', { class: 'list-row-sub', style: 'margin:.4rem 0;word-break:break-all;', text: hook.url.replace(/\/[^/]+$/, '/•••') }),
          U.el('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem;' }, [
            U.el('button', { class: 'btn btn-secondary btn-sm', onclick: async e => {
              e.target.disabled = true
              try { await YumeAPI.admin.testWebhook(hook.id); U.toast('Test delivered ✓') }
              catch (err) { U.toast('Test failed: ' + err.message, 'error') }
              finally { e.target.disabled = false }
            } }, [document.createTextNode('Send test')]),
            U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.webhookForm(content, events, hook) }, [document.createTextNode('Edit')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                await YumeAPI.admin.updateWebhook(hook.id, { enabled: !hook.enabled })
                this.renderWebhooks(content)
              }
            }, [document.createTextNode(hook.enabled ? 'Disable' : 'Enable')]),
            U.el('button', { class: 'btn btn-sm', style: 'background:var(--danger);color:white;', onclick: async () => {
              if (!window.confirm(`Delete webhook "${hook.name}"?`)) return
              await YumeAPI.admin.deleteWebhook(hook.id)
              U.toast('Webhook deleted')
              this.renderWebhooks(content)
            } }, [document.createTextNode('Delete')])
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  webhookForm (content, events, hook) {
    const isEdit = !!hook
    const name = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Name', value: hook?.name ?? '' })
    const url = U.el('input', { class: 'input', type: 'url', style: 'width:100%;', placeholder: 'https://discord.com/api/webhooks/…', value: hook?.url ?? '' })
    const format = U.el('select', { class: 'select' }, [
      U.el('option', { value: 'discord', text: 'Discord (rich embeds)', ...(hook?.format !== 'json' ? { selected: '' } : {}) }),
      U.el('option', { value: 'json', text: 'Generic JSON (HMAC signed)', ...(hook?.format === 'json' ? { selected: '' } : {}) })
    ])

    const subscribed = new Set(hook?.events ?? events) // new hooks default to all events
    const checkboxes = events.map(ev => {
      const cb = U.el('input', { type: 'checkbox', value: ev, ...(subscribed.has(ev) ? { checked: '' } : {}) })
      return U.el('label', { style: 'display:flex;gap:.5rem;align-items:center;font-size:.8rem;padding:.15rem 0;cursor:pointer;' }, [
        cb, U.el('span', {}, [document.createTextNode(this.EVENT_LABELS[ev] ?? ev), U.el('code', { style: 'color:var(--fg-faint);margin-left:.4rem;font-family:var(--font-mono);font-size:.85em;', text: ev })])
      ])
    })
    const eventGrid = U.el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.1rem .75rem;margin-top:.4rem;' }, checkboxes)

    const toggleAll = on => checkboxes.forEach(l => { l.querySelector('input').checked = on })

    const modal = C.modalShell(isEdit ? 'Edit webhook' : 'New webhook', [
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Name' }), name]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'URL' }), url]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Format' }), format]),
      U.el('div', {}, [
        U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
          U.el('label', { class: 'filter-group', style: 'display:block;', text: 'Events' }),
          U.el('div', {}, [
            U.el('button', { class: 'section-more', style: 'margin-right:.75rem;', onclick: () => toggleAll(true) }, [document.createTextNode('All')]),
            U.el('button', { class: 'section-more', onclick: () => toggleAll(false) }, [document.createTextNode('None')])
          ])
        ]),
        eventGrid
      ])
    ], async () => {
      const body = {
        name: name.value.trim(),
        url: url.value.trim(),
        format: format.value,
        events: checkboxes.filter(l => l.querySelector('input').checked).map(l => l.querySelector('input').value)
      }
      if (!body.name || !body.url) return U.toast('Name and URL are required', 'error')
      try {
        if (isEdit) await YumeAPI.admin.updateWebhook(hook.id, body)
        else await YumeAPI.admin.createWebhook(body)
        U.toast(isEdit ? 'Webhook updated' : 'Webhook created')
        modal.remove()
        this.renderWebhooks(content)
      } catch (e) { U.toast(e.message, 'error') }
    })
  }
}

window.PageAdmin = PageAdmin
