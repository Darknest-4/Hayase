/* global C, Charts, U, YumeAPI, confirm, document, history, window */
// Admin dashboard — overview analytics, user management and the
// moderation queue. Only reachable with the right permissions; the
// server enforces them regardless.

const PageAdmin = {
  SECTIONS: [
    { key: 'overview', label: 'Overview', sub: 'Platform health & analytics', perm: 'admin.analytics.view', render: 'renderOverview', icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
    { key: 'users', label: 'Users', sub: 'Accounts, suspensions & bans', perm: 'admin.users.manage', render: 'renderUsers', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { key: 'reports', label: 'Reports', sub: 'Moderation queue', perm: 'community.moderate', render: 'renderReports', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>' },
    { key: 'catalogue', label: 'Catalogue', sub: 'Anime, episodes & visibility', perm: 'anime.view', render: 'renderCatalogue', icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
    { key: 'monitoring', label: 'Infrastructure', sub: 'VPS health & services', perm: 'system.metrics.view', render: 'renderMonitoring', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
    { key: 'roles', label: 'Roles', sub: 'Permissions & RBAC', perm: 'roles.manage', render: 'renderRoles', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' },
    { key: 'webhooks', label: 'Webhooks', sub: 'Outbound integrations', perm: 'admin.webhooks.manage', render: 'renderWebhooks', icon: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>' },
    { key: 'config', label: 'Site Config', sub: 'Feature flags & settings', perm: 'settings.system', render: 'renderConfig', icon: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>' }
  ],

  async render (root, params) {
    const perms = await YumeAPI.myPermissions()
    const available = this.SECTIONS.filter(s => perms.includes(s.perm))

    if (!available.length) {
      const pad = U.el('div', { class: 'page-pad' })
      root.append(pad)
      pad.append(U.el('h1', { class: 'page-title', text: 'Admin' }))
      pad.append(U.el('div', { class: 'callout', text: 'You need moderator or admin permissions to see this page.' }))
      return
    }

    const start = available.find(s => s.key === params?.get?.('s')) ?? available[0]
    const state = { section: start }

    // ---- shell: admin nav rail + content ----
    const shell = U.el('div', { class: 'admin-shell' })
    root.append(shell)

    const nav = U.el('aside', { class: 'admin-nav' })
    nav.append(U.el('div', { class: 'admin-nav-head' }, [
      U.svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>', 18),
      U.el('span', { text: 'Admin' })
    ]))
    const navItems = {}
    for (const s of available) {
      const item = U.el('button', {
        class: 'admin-nav-item' + (s.key === state.section.key ? ' active' : ''),
        onclick: () => select(s)
      }, [
        U.svg(s.icon, 18),
        U.el('div', { class: 'admin-nav-text' }, [
          U.el('b', { text: s.label }),
          U.el('span', { text: s.sub })
        ])
      ])
      navItems[s.key] = item
      nav.append(item)
    }
    shell.append(nav)

    const main = U.el('div', { class: 'admin-content' })
    const head = U.el('div', { class: 'admin-content-head' })
    const body = U.el('div', { class: 'admin-content-body' })
    main.append(head, body)
    shell.append(main)

    const select = s => {
      state.section = s
      Object.values(navItems).forEach(i => i.classList.remove('active'))
      navItems[s.key]?.classList.add('active')
      history.replaceState(null, '', `#/admin?s=${s.key}`) // deep-link without a re-render
      head.replaceChildren(
        U.el('h1', { class: 'admin-content-title', text: s.label }),
        U.el('p', { class: 'admin-content-sub', text: s.sub })
      )
      body.replaceChildren(U.el('div', { class: 'spinner' }))
      this[s.render](body)
    }
    select(state.section)
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

      const liveTotal = catalog.filter(p => p.status === 'active').length
      panel.append(U.el('p', { class: 'perm-legend' }, [
        U.el('span', { class: 'perm-badge perm-badge-live', text: 'LIVE' }),
        document.createTextNode(` ${liveTotal} permissions are enforced by a route today · `),
        U.el('span', { class: 'perm-badge perm-badge-planned', text: 'planned' }),
        document.createTextNode(` ${total - liveTotal} are catalogued for upcoming modules (#2–#5).`)
      ]))

      const listWrap = U.el('div', { class: 'perm-groups' })
      panel.append(listWrap)

      const renderList = () => {
        listWrap.replaceChildren()
        for (const [group, perms] of Object.entries(groups)) {
          const visible = perms.filter(p => !state.filter || p.slug.includes(state.filter) || p.description.toLowerCase().includes(state.filter))
          if (!visible.length) continue
          const grantedInGroup = visible.filter(p => has(p.slug)).length
          const liveInGroup = visible.filter(p => p.status === 'active').length
          const groupBox = U.el('div', { class: 'perm-group' }, [
            U.el('div', { class: 'perm-group-head' }, [
              U.el('span', { class: 'perm-group-title', text: group }),
              liveInGroup ? U.el('span', { class: 'perm-live-count', title: `${liveInGroup} enforced by a route today`, text: `${liveInGroup} live` }) : null,
              U.el('span', { class: 'perm-group-count', text: `${grantedInGroup}/${visible.length}` }),
              isAdmin ? null : U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk(visible, grantedInGroup < visible.length) }, [document.createTextNode(grantedInGroup < visible.length ? 'Grant all' : 'Revoke all')])
            ])
          ])
          for (const p of visible) {
            const cb = U.el('input', {
              type: 'checkbox',
              ...(has(p.slug) ? { checked: '' } : {}),
              ...(isAdmin ? { disabled: '' } : {}),
              onchange: e => toggle(p.slug, e.target.checked, e.target)
            })
            groupBox.append(U.el('label', { class: 'perm-row' + (p.status === 'active' ? ' perm-active' : '') }, [
              cb,
              U.el('div', { class: 'perm-info' }, [
                U.el('div', { class: 'perm-slug-row' }, [
                  U.el('code', { class: 'perm-slug', text: p.slug }),
                  p.status === 'active'
                    ? U.el('span', { class: 'perm-badge perm-badge-live', title: 'Enforced by a route today', text: 'LIVE' })
                    : U.el('span', { class: 'perm-badge perm-badge-planned', title: 'Catalogued for an upcoming module', text: 'planned' })
                ]),
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
          U.el('input', {
            type: 'checkbox',
            ...(on ? { checked: '' } : {}),
            onchange: async e => {
              try { await YumeAPI.admin.setSetting(key, e.target.checked); settings[key] = e.target.checked; U.toast('Saved'); await applyLive() } catch (err) { U.toast(err.message, 'error'); e.target.checked = on }
            }
          }),
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
      U.el('input', {
        class: 'input',
        style: 'min-width:20rem;',
        value: settings[key] ?? '',
        onchange: async e => {
          try { await YumeAPI.admin.setSetting(key, e.target.value); U.toast('Saved'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
        }
      })
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
      style: 'min-width:11rem;',
      placeholder: 'permission slug',
      value: state.permission ?? ''
    })

    const save = async patch => {
      try { await YumeAPI.admin.setFlag(f.key, patch); U.toast(`${f.label} updated`); await applyLive() } catch (e) { U.toast(e.message, 'error') }
    }

    const accessSel = U.el('select', {
      class: 'select flag-access',
      onchange: async e => {
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

  // ---- Catalogue: anime + episode management, visibility control ----
  VIS_BADGE: { public: ['Public', 'vis-public'], unlisted: ['Unlisted', 'vis-unlisted'], hidden: ['Hidden', 'vis-hidden'] },
  FORMATS: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'],
  STATUSES: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'],
  SEASONS: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],

  async renderCatalogue (content) {
    const perms = await YumeAPI.myPermissions()
    const can = s => perms.includes(s)
    const state = { q: '', visibility: '', selected: null }

    const layout = U.el('div', { class: 'cat-layout' })
    const listCol = U.el('div', { class: 'cat-list-col' })
    const editCol = U.el('div', { class: 'cat-edit-col' })
    layout.append(listCol, editCol)
    content.replaceChildren(layout)

    // ---- toolbar ----
    const listBox = U.el('div', { class: 'cat-list' })
    const toolbar = U.el('div', { class: 'cat-toolbar' }, [
      U.el('input', { class: 'input', placeholder: 'Search catalogue…', oninput: U.debounce(e => { state.q = e.target.value.trim(); loadList() }) }),
      U.el('select', { class: 'select', onchange: e => { state.visibility = e.target.value; loadList() } },
        [['', 'All visibility'], ['public', 'Public'], ['unlisted', 'Unlisted'], ['hidden', 'Hidden']].map(([v, l]) =>
          U.el('option', { value: v, text: l }))),
      can('anime.create') ? U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => openEditor(null) }, [document.createTextNode('+ New anime')]) : null,
      can('anime.merge') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.selected = null; this.renderCatDuplicates(editCol, can, () => { loadList(); this.renderCatDuplicates(editCol, can, loadList) }) } }, [document.createTextNode('Duplicates')]) : null
    ])
    listCol.append(toolbar, listBox)

    const loadList = async () => {
      listBox.replaceChildren(U.el('div', { class: 'spinner' }))
      try {
        const { data, total } = await YumeAPI.admin.catalogue.list({ q: state.q, visibility: state.visibility, limit: 40 })
        listBox.replaceChildren()
        listBox.append(U.el('div', { class: 'cat-count', text: `${total.toLocaleString()} entries` }))
        if (!data.length) { listBox.append(U.el('div', { class: 'empty-state', style: 'padding:1rem;', text: 'No matching anime.' })); return }
        for (const a of data) listBox.append(this.catRow(a, state, openEditor))
      } catch (e) {
        listBox.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
      }
    }

    // ---- editor (null = create) ----
    const openEditor = async (anime) => {
      editCol.replaceChildren(U.el('div', { class: 'spinner' }))
      let full = anime
      if (anime?.id) { try { full = await YumeAPI.admin.catalogue.get(anime.id) } catch (e) { editCol.replaceChildren(U.el('div', { class: 'error-state', text: e.message })); return } }
      state.selected = full?.id ?? null
      listBox.querySelectorAll('.cat-row').forEach(r => r.classList.toggle('active', r.dataset.id === state.selected))
      this.renderCatEditor(editCol, full, { can, onSaved: loadList, onDeleted: () => { editCol.replaceChildren(this.catPlaceholder()); loadList() } })
    }

    editCol.append(this.catPlaceholder())
    loadList()
  },

  catPlaceholder () {
    return U.el('div', { class: 'cat-placeholder' }, [
      U.svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>', 40),
      U.el('p', { text: 'Select an anime to edit, or create a new one.' })
    ])
  },

  catRow (a, state, openEditor) {
    const [label, cls] = this.VIS_BADGE[a.visibility] ?? this.VIS_BADGE.public
    const row = U.el('button', {
      class: 'cat-row' + (a.id === state.selected ? ' active' : ''),
      dataset: { id: a.id },
      onclick: () => openEditor(a)
    }, [
      U.el('div', { class: 'cat-row-main' }, [
        U.el('div', { class: 'cat-row-title', text: a.canonical_title }),
        U.el('div', { class: 'cat-row-sub', text: `${a.format} · ${a.season_year ?? '—'} · ${a.episode_rows} ep` })
      ]),
      U.el('span', { class: 'vis-badge ' + cls, text: label })
    ])
    return row
  },

  renderCatEditor (host, anime, { can, onSaved, onDeleted }) {
    const isNew = !anime?.id
    const editable = isNew ? can('anime.create') : can('anime.edit')
    const draft = {
      canonical_title: anime?.canonical_title ?? '',
      format: anime?.format ?? 'TV',
      status: anime?.status ?? 'FINISHED',
      season: anime?.season ?? '',
      season_year: anime?.season_year ?? '',
      episode_count: anime?.episode_count ?? '',
      episode_duration: anime?.episode_duration ?? '',
      source_material: anime?.source_material ?? '',
      synopsis: anime?.synopsis ?? '',
      is_adult: anime?.is_adult ?? false,
      visibility: anime?.visibility ?? 'public'
    }

    host.replaceChildren()
    const form = U.el('div', { class: 'cat-editor' })
    host.append(form)

    form.append(U.el('div', { class: 'cat-editor-head' }, [
      U.el('h2', { class: 'cat-editor-title', text: isNew ? 'New anime' : draft.canonical_title || 'Untitled' }),
      anime?.id ? U.el('code', { class: 'cat-editor-id', text: anime.id }) : null
    ]))

    const field = (label, el) => U.el('label', { class: 'cat-field' }, [U.el('span', { class: 'cat-field-label', text: label }), el])
    const input = (key, attrs = {}) => U.el('input', { class: 'input', value: draft[key] ?? '', ...(editable ? {} : { disabled: '' }), oninput: e => { draft[key] = e.target.value }, ...attrs })
    const select = (key, opts, withEmpty) => U.el('select', { class: 'select', ...(editable ? {} : { disabled: '' }), onchange: e => { draft[key] = e.target.value } },
      [...(withEmpty ? [U.el('option', { value: '', text: '—', ...(draft[key] ? {} : { selected: '' }) })] : []),
        ...opts.map(o => U.el('option', { value: o, text: o.replace(/_/g, ' '), ...(draft[key] === o ? { selected: '' } : {}) }))])

    // visibility — the headline control
    form.append(U.el('div', { class: 'cat-visibility' }, [
      U.el('div', {}, [
        U.el('div', { class: 'cat-field-label', text: 'Visibility' }),
        U.el('p', { class: 'cat-vis-hint', text: 'Hidden hides it everywhere including the detail page. Unlisted keeps it reachable by direct link only.' })
      ]),
      select('visibility', ['public', 'unlisted', 'hidden'])
    ]))

    form.append(U.el('div', { class: 'cat-grid' }, [
      field('Title', input('canonical_title', { placeholder: 'Canonical title' })),
      field('Format', select('format', this.FORMATS)),
      field('Status', select('status', this.STATUSES)),
      field('Season', select('season', this.SEASONS, true)),
      field('Season year', input('season_year', { type: 'number', min: 1900, max: 2100 })),
      field('Episodes (planned)', input('episode_count', { type: 'number', min: 0 })),
      field('Episode duration (min)', input('episode_duration', { type: 'number', min: 0 })),
      field('Source material', input('source_material', { placeholder: 'MANGA, LIGHT_NOVEL…' }))
    ]))
    form.append(field('Synopsis', U.el('textarea', { class: 'input', rows: 4, ...(editable ? {} : { disabled: '' }), oninput: e => { draft.synopsis = e.target.value } }, [document.createTextNode(draft.synopsis)])))
    form.append(U.el('label', { class: 'cat-check' }, [
      U.el('input', { type: 'checkbox', ...(draft.is_adult ? { checked: '' } : {}), ...(editable ? {} : { disabled: '' }), onchange: e => { draft.is_adult = e.target.checked } }),
      U.el('span', { text: 'Adult (NSFW) content' })
    ]))

    // ---- actions ----
    if (editable) {
      const num = v => v === '' || v == null ? null : Number(v)
      const payload = () => ({
        canonical_title: draft.canonical_title.trim(),
        format: draft.format,
        status: draft.status,
        season: draft.season || null,
        season_year: num(draft.season_year),
        episode_count: num(draft.episode_count),
        episode_duration: num(draft.episode_duration),
        source_material: draft.source_material.trim() || null,
        synopsis: draft.synopsis.trim() || null,
        is_adult: draft.is_adult,
        visibility: draft.visibility
      })
      const actions = U.el('div', { class: 'cat-actions' })
      actions.append(U.el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!draft.canonical_title.trim()) return U.toast('Title is required', 'error')
          try {
            if (isNew) { const c = await YumeAPI.admin.catalogue.create(payload()); U.toast('Anime created'); onSaved?.(); anime = c } else { await YumeAPI.admin.catalogue.update(anime.id, payload()); U.toast('Saved'); onSaved?.() }
          } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode(isNew ? 'Create anime' : 'Save changes')]))
      if (!isNew && can('anime.delete')) {
        actions.append(U.el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            if (!confirm(`Delete "${anime.canonical_title}" and all its episodes? This cannot be undone.`)) return
            try { await YumeAPI.admin.catalogue.remove(anime.id); U.toast('Deleted'); onDeleted?.() } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('Delete')]))
      }
      form.append(actions)
    } else {
      form.append(U.el('div', { class: 'callout', text: 'You have read-only access to the catalogue.' }))
    }

    // ---- metadata provenance (existing anime only) ----
    if (!isNew) this.renderCatProvenance(form, anime, { can, onSaved })

    // ---- episodes (existing anime only) ----
    if (!isNew) this.renderCatEpisodes(form, anime, can)
  },

  // Shows where each field's value came from and which fields are locked
  // against the importers. Saving in this editor locks whatever it wrote, so
  // the only action needed here is releasing a field back to automation.
  renderCatProvenance (form, anime, { can, onSaved }) {
    const locked = anime.locked_fields ?? []
    const sources = anime.metadata_sources ?? {}
    const fields = [...new Set([...locked, ...Object.keys(sources)])].sort()
    if (!fields.length) return

    const wrap = U.el('div', { class: 'cat-provenance' })
    wrap.append(U.el('h3', { class: 'detail-section-title', style: 'margin:0 0 .5rem;', text: 'Metadata sources' }))
    wrap.append(U.el('p', { class: 'cat-vis-hint', text: 'A locked field was set by hand and is never overwritten by the AniList importer. Release it to let automatic updates resume.' }))

    const table = U.el('div', { class: 'prov-table' })
    for (const field of fields) {
      const src = sources[field]
      const isLocked = locked.includes(field)
      table.append(U.el('div', { class: 'prov-row' }, [
        U.el('code', { class: 'prov-field', text: field }),
        U.el('span', { class: 'prov-source', text: src ? [src.provider, src.at ? U.relTime(new Date(src.at)) : null].filter(Boolean).join(' · ') : 'unknown' }),
        isLocked
          ? U.el('span', { class: 'vis-badge vis-hidden', text: 'locked' })
          : U.el('span', { class: 'prov-auto', text: 'automatic' }),
        isLocked && can('anime.edit')
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async e => {
              e.target.disabled = true
              try { await YumeAPI.admin.catalogue.unlock(anime.id, [field]); U.toast(`"${field}" released to the importer`); onSaved?.() } catch (err) { U.toast(err.message, 'error'); e.target.disabled = false }
            }
          }, [document.createTextNode('Release')])
          : null
      ]))
    }
    wrap.append(table)
    form.append(wrap)
  },

  // Duplicate scan. Read-only by design: it proposes pairs and a human with
  // anime.merge confirms each one, because a merge cannot be undone.
  async renderCatDuplicates (host, can, reload) {
    host.replaceChildren(U.el('div', { class: 'spinner' }))
    try {
      const { data } = await YumeAPI.admin.catalogue.duplicates()
      host.replaceChildren()
      host.append(U.el('p', { class: 'cat-vis-hint', text: 'Entries with near-identical titles in the same year and format. Merging moves titles, synonyms, genres, tags, external ids and library entries onto the entry you keep, then deletes the other one. This cannot be undone.' }))
      if (!data.length) { host.append(U.el('div', { class: 'empty-state', style: 'padding:1rem;', text: 'No likely duplicates found.' })); return }
      for (const d of data) {
        const keep = (winner, loser, title) => can('anime.merge')
          ? U.el('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              if (!confirm(`Keep "${title}" and merge the other entry into it? This cannot be undone.`)) return
              try { await YumeAPI.admin.catalogue.merge(winner, loser); U.toast('Merged'); reload() } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Keep this')])
          : null
        host.append(U.el('div', { class: 'dup-pair' }, [
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.a_title }), keep(d.a_id, d.b_id, d.a_title)]),
          U.el('div', { class: 'dup-meta', text: `${(Number(d.similarity) * 100).toFixed(0)}% · ${d.season_year ?? '—'} · ${d.format ?? '—'}` }),
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.b_title }), keep(d.b_id, d.a_id, d.b_title)])
        ]))
      }
    } catch (e) {
      host.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  async renderCatEpisodes (form, anime, can) {
    const wrap = U.el('div', { class: 'cat-episodes' })

    // Publishing a season happens in batches — a set of subtitles lands and
    // several episodes go live together. Doing that one row at a time is one
    // chance per episode to miss one, and a half-published season is exactly
    // the state this is meant to prevent.
    const bulk = async (visibility) => {
      const label = visibility === 'public' ? 'Publish' : visibility === 'hidden' ? 'Unpublish' : 'Unlist'
      const range = window.prompt(`${label} which episodes? Blank = all. Examples: "1-6", "3"`, '')
      if (range === null) return
      const body = { visibility }
      const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(range)
      if (range.trim() && !match) return U.toast('Use a number or a range like 1-6', 'error')
      if (match) {
        body.from = Number(match[1])
        body.to = Number(match[2] ?? match[1])
      }
      try {
        const res = await YumeAPI.admin.catalogue.episodeVisibility(anime.id, body)
        U.toast(res.changed ? `${label}ed ${res.changed} episode(s)` : 'Nothing to change')
        load()
      } catch (e) { U.toast(e.message, 'error') }
    }

    form.append(U.el('div', { class: 'cat-ep-head' }, [
      U.el('h3', { class: 'detail-section-title', style: 'margin:0;', text: 'Episodes' }),
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('public') }, [document.createTextNode('Publish…')]) : null,
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('hidden') }, [document.createTextNode('Unpublish…')]) : null,
      can('episode.create') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, null, () => load()) }, [document.createTextNode('+ Add episode')]) : null
    ]))
    form.append(wrap)

    const load = async () => {
      wrap.replaceChildren(U.el('div', { class: 'spinner' }))
      try {
        const { data } = await YumeAPI.admin.catalogue.episodes(anime.id)
        wrap.replaceChildren()
        if (!data.length) { wrap.append(U.el('div', { class: 'empty-state', style: 'padding:.75rem;', text: 'No episodes yet.' })); return }

        // How much of the season is actually reachable, stated once rather
        // than left to be counted off the rows.
        const live = data.filter(e => e.visibility === 'public').length
        wrap.append(U.el('div', {
          class: 'cat-ep-summary' + (live === 0 ? ' cat-ep-summary-none' : ''),
          text: live === data.length
            ? `All ${data.length} episodes are published.`
            : `${live} of ${data.length} episodes published — the rest are not reachable by viewers.`
        }))

        for (const ep of data) {
          const flags = [ep.is_filler ? 'filler' : null, ep.is_recap ? 'recap' : null].filter(Boolean).join(' · ')
          const [visLabel, visClass] = this.VIS_BADGE[ep.visibility] ?? this.VIS_BADGE.hidden
          wrap.append(U.el('div', { class: 'cat-ep-row' + (ep.visibility === 'public' ? '' : ' cat-ep-row-unpublished') }, [
            U.el('div', { class: 'cat-ep-num', text: '#' + ep.number }),
            U.el('div', { class: 'cat-ep-main' }, [
              U.el('div', { class: 'cat-ep-title', text: ep.title || `Episode ${ep.number}` }),
              U.el('div', { class: 'cat-ep-sub', text: [ep.duration ? ep.duration + ' min' : null, flags || null].filter(Boolean).join(' · ') || '—' })
            ]),
            U.el('span', { class: 'cat-badge ' + visClass, text: visLabel }),
            can('episode.edit')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm',
                title: ep.visibility === 'public' ? 'Take this episode down' : 'Make this episode watchable',
                onclick: async () => {
                  const next = ep.visibility === 'public' ? 'hidden' : 'public'
                  try {
                    await YumeAPI.admin.catalogue.updateEpisode(ep.id, { visibility: next })
                    U.toast(next === 'public' ? `Episode ${ep.number} published` : `Episode ${ep.number} taken down`)
                    load()
                  } catch (e) { U.toast(e.message, 'error') }
                }
              }, [document.createTextNode(ep.visibility === 'public' ? 'Unpublish' : 'Publish')])
              : null,
            can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, ep, () => load()) }, [document.createTextNode('Edit')]) : null,
            can('episode.delete')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm cat-ep-del',
                onclick: async () => {
                  if (!confirm(`Delete episode ${ep.number}?`)) return
                  try { await YumeAPI.admin.catalogue.removeEpisode(ep.id); U.toast('Episode deleted'); load() } catch (e) { U.toast(e.message, 'error') }
                }
              }, [document.createTextNode('✕')])
              : null
          ]))
        }
      } catch (e) { wrap.replaceChildren(U.el('div', { class: 'error-state', text: e.message })) }
    }
    load()
  },

  episodeModal (anime, ep, onDone) {
    const isNew = !ep
    const d = {
      number: ep?.number ?? '',
      title: ep?.title ?? '',
      synopsis: ep?.synopsis ?? '',
      duration: ep?.duration ?? '',
      is_filler: ep?.is_filler ?? false,
      is_recap: ep?.is_recap ?? false,
      air_date: ep?.air_date ? String(ep.air_date).slice(0, 10) : ''
    }
    const inp = (key, attrs = {}) => U.el('input', { class: 'input', value: d[key], oninput: e => { d[key] = e.target.value }, ...attrs })
    const check = (key, label) => U.el('label', { class: 'cat-check' }, [
      U.el('input', { type: 'checkbox', ...(d[key] ? { checked: '' } : {}), onchange: e => { d[key] = e.target.checked } }), U.el('span', { text: label })
    ])
    const labelled = (t, el) => U.el('label', { class: 'cat-field' }, [U.el('span', { class: 'cat-field-label', text: t }), el])

    const backdrop = C.modalShell(isNew ? `Add episode — ${anime.canonical_title}` : `Edit episode ${ep.number}`, [
      labelled('Episode number', inp('number', { type: 'number', step: '0.5', min: 0, placeholder: 'e.g. 1 or 6.5' })),
      labelled('Title', inp('title', { placeholder: 'Optional episode title' })),
      labelled('Air date', inp('air_date', { type: 'date' })),
      labelled('Duration (min)', inp('duration', { type: 'number', min: 0 })),
      labelled('Synopsis', U.el('textarea', { class: 'input', rows: 3, oninput: e => { d.synopsis = e.target.value } }, [document.createTextNode(d.synopsis)])),
      U.el('div', { style: 'display:flex;gap:1.25rem;' }, [check('is_filler', 'Filler'), check('is_recap', 'Recap')])
    ], async () => {
      if (d.number === '' || isNaN(Number(d.number))) return U.toast('A valid episode number is required', 'error')
      const num = v => v === '' || v == null ? null : Number(v)
      const body = {
        number: Number(d.number),
        title: d.title.trim() || null,
        synopsis: d.synopsis.trim() || null,
        duration: num(d.duration),
        is_filler: d.is_filler,
        is_recap: d.is_recap,
        air_date: d.air_date ? new Date(d.air_date).toISOString() : null
      }
      try {
        if (isNew) await YumeAPI.admin.catalogue.addEpisode(anime.id, body)
        else await YumeAPI.admin.catalogue.updateEpisode(ep.id, body)
        U.toast(isNew ? 'Episode added' : 'Episode updated'); backdrop.remove(); onDone?.()
      } catch (e) { U.toast(e.message, 'error') }
    })
  },

  // ---- Infrastructure: VPS health & service status ----
  LEVEL_DOT: { green: '🟢', yellow: '🟡', red: '🔴', not_configured: '⚪' },
  LEVEL_WORD: { green: 'Healthy', yellow: 'Warning', red: 'Critical', not_configured: 'Not configured' },

  fmtBytes (bytes) {
    if (bytes === null || bytes === undefined) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes; let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value.toFixed(value >= 100 || unit <= 1 ? 0 : 1)} ${units[unit]}`
  },

  fmtBps (bps) {
    if (bps === null || bps === undefined) return '—'
    if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps'
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps'
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' Kbps'
    return Math.round(bps) + ' bps'
  },

  fmtUptime (seconds) {
    if (!seconds) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
  },

  async renderMonitoring (content) {
    const state = { history: {} }

    const load = async () => {
      // stop polling once the admin navigates to another section
      if (!document.body.contains(content)) { clearInterval(state.timer); return }
      let data
      try {
        data = await YumeAPI.admin.monitoring.current()
      } catch (e) {
        content.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load monitoring: ' + e.message }))
        return
      }
      this.paintMonitoring(content, data, state)
    }

    await load()
    state.timer = setInterval(load, 30_000)
  },

  paintMonitoring (content, data, state) {
    const m = data.metrics ?? {}
    const value = key => m[key]?.value ?? null
    const level = key => m[key]?.level ?? null
    content.replaceChildren()

    // ---- overall banner ----
    const banner = U.el('div', { class: 'mon-banner mon-' + data.level }, [
      U.el('span', { class: 'mon-banner-dot', text: this.LEVEL_DOT[data.level] ?? '⚪' }),
      U.el('div', { style: 'flex-grow:1;' }, [
        U.el('div', { class: 'mon-banner-title', text: this.LEVEL_WORD[data.level] ?? 'Unknown' }),
        U.el('div', {
          class: 'mon-banner-sub',
          text: data.stale
            ? 'No fresh samples — the monitor worker looks stopped. Values below may be out of date.'
            : `Last collected ${data.collectedAt ? U.relTime(new Date(data.collectedAt)) : 'never'}`
        })
      ])
    ])
    content.append(banner)

    // ---- metric cards ----
    const card = (label, big, sub, lvl) => U.el('div', { class: 'mon-card' + (lvl ? ' mon-' + lvl : '') }, [
      U.el('div', { class: 'mon-card-head' }, [
        U.el('span', { class: 'mon-card-label', text: label }),
        lvl ? U.el('span', { class: 'mon-card-dot', text: this.LEVEL_DOT[lvl] }) : null
      ]),
      U.el('div', { class: 'mon-card-value', text: big }),
      sub ? U.el('div', { class: 'mon-card-sub', text: sub }) : null
    ])

    const pct = v => v === null ? '—' : v.toFixed(1) + '%'
    const ms = v => v === null ? '—' : Math.round(v) + ' ms'

    const grid = U.el('div', { class: 'mon-grid' }, [
      card('CPU', pct(value('cpu.usage_pct')),
        `load ${(value('cpu.load1') ?? 0).toFixed(2)} · ${(value('cpu.load_per_core') ?? 0).toFixed(2)}/core`,
        level('cpu.usage_pct')),
      card('RAM', pct(value('mem.used_pct')),
        `${this.fmtBytes(value('mem.used_bytes'))} / ${this.fmtBytes(value('mem.total_bytes'))}`,
        level('mem.used_pct')),
      card('Disk', pct(value('disk.used_pct')),
        `${this.fmtBytes(value('disk.used_bytes'))} / ${this.fmtBytes(value('disk.total_bytes'))}`,
        level('disk.used_pct')),
      card('Swap', value('swap.used_pct') === null ? '—' : pct(value('swap.used_pct')),
        value('swap.used_pct') === 0 ? 'none in use' : 'of configured swap', level('swap.used_pct')),
      card('Network', this.fmtBps(value('net.rx_bps')),
        `↓ ${this.fmtBps(value('net.rx_bps'))} · ↑ ${this.fmtBps(value('net.tx_bps'))}`, level('net.drop_pct')),
      card('Net latency', ms(value('net.latency_ms')), 'TCP connect RTT', level('net.latency_ms')),
      card('API latency', ms(value('api.latency_ms')), 'self-probe of /v1/health', level('api.latency_ms')),
      card('DB latency', ms(value('db.latency_ms')), 'round-trip for SELECT 1', level('db.latency_ms')),
      card('Disk I/O', this.fmtBps((value('disk.read_bps') ?? 0) + (value('disk.write_bps') ?? 0)),
        `${Math.round(value('disk.iops') ?? 0)} IOPS · await ${ms(value('disk.await_ms'))}`, level('disk.await_ms')),
      card('Queue', String(Math.round(value('queue.pending') ?? 0)),
        `${Math.round(value('queue.dead') ?? 0)} dead letters`, level('queue.pending')),
      card('Uptime', this.fmtUptime(value('host.uptime_sec')), 'since last host boot', null)
    ])
    content.append(grid)

    // ---- services ----
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Services' }))
    const services = U.el('div', { class: 'mon-services' })
    for (const s of data.services ?? []) {
      services.append(U.el('div', { class: 'mon-service mon-' + s.status }, [
        U.el('span', { class: 'mon-service-dot', text: this.LEVEL_DOT[s.status] ?? '⚪' }),
        U.el('div', { class: 'mon-service-main' }, [
          U.el('div', { class: 'mon-service-name', text: s.service }),
          U.el('div', { class: 'mon-service-sub', text: s.detail ?? this.LEVEL_WORD[s.status] ?? s.status })
        ]),
        U.el('span', { class: 'mon-service-latency', text: s.latency_ms === null || s.latency_ms === undefined ? '' : Math.round(s.latency_ms) + ' ms' })
      ]))
    }
    content.append(services)

    // ---- dependency map: what a red service actually breaks ----
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Dependencies' }))
    const statusOf = Object.fromEntries((data.services ?? []).map(s => [s.service, s.status]))
    const deps = U.el('div', { class: 'mon-deps' })
    for (const d of data.dependencies ?? []) {
      const st = statusOf[d.service] ?? 'not_configured'
      deps.append(U.el('div', { class: 'mon-dep' }, [
        U.el('div', { class: 'mon-dep-head' }, [
          U.el('span', { text: this.LEVEL_DOT[st] ?? '⚪' }),
          U.el('b', { text: d.service }),
          U.el('span', { class: 'mon-dep-tag' + (d.required ? ' mon-dep-required' : ''), text: d.required ? 'required' : 'optional' })
        ]),
        U.el('ul', { class: 'mon-dep-list' }, d.provides.map(p => U.el('li', { text: p })))
      ]))
    }
    content.append(deps)

    // ---- sustained alerts ----
    const alertsBox = U.el('div')
    content.append(alertsBox)
    YumeAPI.admin.monitoring.alerts().then(({ active, history }) => {
      alertsBox.replaceChildren()
      alertsBox.append(U.el('h2', { class: 'detail-section-title', text: 'Alerts' }))
      if (!active.length) {
        alertsBox.append(U.el('div', { class: 'mon-alert-none' }, [
          U.el('span', { text: '🟢' }),
          U.el('span', { text: history.length ? 'Nothing firing right now.' : 'Nothing firing. No alerts recorded yet.' })
        ]))
      }
      for (const a of active) {
        alertsBox.append(U.el('div', { class: 'mon-alert mon-' + (a.severity === 'critical' ? 'red' : 'yellow') }, [
          U.el('span', { class: 'mon-alert-dot', text: a.severity === 'critical' ? '🔴' : '🟡' }),
          U.el('div', { class: 'mon-alert-main' }, [
            U.el('div', { class: 'mon-alert-subject', text: a.subject }),
            U.el('div', {
              class: 'mon-alert-sub',
              text: [
                a.value !== null && a.value !== undefined ? `value ${Number(a.value).toFixed(1)}` : null,
                a.threshold !== null && a.threshold !== undefined ? `threshold ${Number(a.threshold)}` : null,
                a.detail
              ].filter(Boolean).join(' · ') || a.severity
            })
          ]),
          U.el('span', { class: 'mon-alert-since', text: 'since ' + U.relTime(new Date(a.started_at)) })
        ]))
      }
      const resolved = history.filter(h => h.status === 'resolved').slice(0, 5)
      if (resolved.length) {
        alertsBox.append(U.el('div', { class: 'mon-alert-history' }, [
          U.el('div', { class: 'mon-trend-label', text: 'Recently resolved' }),
          ...resolved.map(h => U.el('div', { class: 'mon-alert-past' }, [
            U.el('span', { text: h.subject }),
            U.el('span', { class: 'mon-alert-since', text: h.resolved_at ? U.relTime(new Date(h.resolved_at)) : '' })
          ]))
        ]))
      }
    }).catch(() => alertsBox.replaceChildren())

    // ---- diagnostics ----
    const diagBox = U.el('div')
    content.append(diagBox)
    this.renderDiagnostics(diagBox)

    // ---- history sparklines ----
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Last 24 hours' }))
    const trends = U.el('div', { class: 'mon-trends' })
    content.append(trends)
    for (const [metric, label, max] of [['cpu.usage_pct', 'CPU %', 100], ['mem.used_pct', 'RAM %', 100], ['api.latency_ms', 'API latency (ms)', null], ['db.latency_ms', 'DB latency (ms)', null]]) {
      const box = U.el('div', { class: 'mon-trend' }, [
        U.el('div', { class: 'mon-trend-label', text: label }),
        U.el('div', { class: 'spinner' })
      ])
      trends.append(box)
      YumeAPI.admin.monitoring.history(metric, 24).then(res => {
        const values = (res.points ?? []).map(p => p.value)
        box.replaceChildren(
          U.el('div', { class: 'mon-trend-label', text: label }),
          values.length
            ? Charts.sparkline(values, { label, max })
            : U.el('div', { class: 'mon-trend-empty', text: 'no samples yet' })
        )
      }).catch(() => {
        box.replaceChildren(U.el('div', { class: 'mon-trend-label', text: label }), U.el('div', { class: 'mon-trend-empty', text: 'unavailable' }))
      })
    }
  },

  // ---- diagnostics: admin-triggered, bounded benchmarks ----
  DIAG_LABEL: { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' },

  async renderDiagnostics (box) {
    box.replaceChildren(U.el('h2', { class: 'detail-section-title', text: 'Diagnostics' }))

    const output = U.el('div', { class: 'mon-diag-output' })
    const runBtn = U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => run() }, [document.createTextNode('Run diagnostic')])
    box.append(U.el('div', { class: 'mon-diag-head' }, [
      U.el('p', { class: 'mon-diag-note', text: 'Controlled benchmarks with fixed time, memory and disk budgets. Runs in the worker, never on the request path.' }),
      runBtn
    ]), output)

    const paint = report => {
      output.replaceChildren()
      if (!report) { output.append(U.el('div', { class: 'mon-trend-empty', text: 'No diagnostic has been run yet.' })); return }
      if (report.status === 'running') { output.append(U.el('div', { class: 'spinner' })); return }
      if (report.status === 'failed') {
        output.append(U.el('div', { class: 'error-state', text: report.error || 'The diagnostic run failed.' }))
        return
      }
      const scored = (report.results || []).length - (report.results || []).filter(r => r.status === 'skip').length
      output.append(U.el('div', {
        class: 'mon-diag-total',
        text: `${report.passed}/${scored} PASS` +
        (report.warned ? ` · ${report.warned} WARN` : '') + (report.failed ? ` · ${report.failed} FAIL` : '') +
        ` · ${U.relTime(new Date(report.finished_at ?? report.started_at))}`
      }))
      let group = ''
      for (const r of report.results ?? []) {
        if (r.group !== group) { group = r.group; output.append(U.el('div', { class: 'mon-diag-group', text: group })) }
        output.append(U.el('div', { class: 'mon-diag-row mon-diag-' + r.status }, [
          U.el('span', { class: 'mon-diag-name', text: r.name }),
          U.el('span', { class: 'mon-diag-status', text: this.DIAG_LABEL[r.status] ?? r.status }),
          U.el('span', { class: 'mon-diag-value', text: r.value, title: r.detail ?? '' })
        ]))
      }
    }

    const poll = async (id, attempt = 0) => {
      const report = await YumeAPI.admin.monitoring.diagnostic(id)
      if (report.status !== 'running') { paint(report); runBtn.disabled = false; runBtn.textContent = 'Run diagnostic'; return }
      if (attempt > 40) { // ~2 minutes
        output.replaceChildren(U.el('div', { class: 'callout', text: 'Still queued — is the worker running? Diagnostics execute in the worker process.' }))
        runBtn.disabled = false; runBtn.textContent = 'Run diagnostic'
        return
      }
      setTimeout(() => poll(id, attempt + 1), 3000)
    }

    const run = async () => {
      runBtn.disabled = true
      runBtn.textContent = 'Running…'
      output.replaceChildren(U.el('div', { class: 'spinner' }))
      try {
        const { id } = await YumeAPI.admin.monitoring.runDiagnostic()
        poll(id)
      } catch (e) {
        output.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
        runBtn.disabled = false; runBtn.textContent = 'Run diagnostic'
      }
    }

    // show the most recent completed report on load
    try {
      const { data } = await YumeAPI.admin.monitoring.diagnostics()
      const latest = data?.[0]
      paint(latest ? await YumeAPI.admin.monitoring.diagnostic(latest.id) : null)
    } catch (e) {
      paint(null)
    }
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
            U.el('button', {
              class: 'btn btn-secondary btn-sm',
              onclick: async e => {
                e.target.disabled = true
                try { await YumeAPI.admin.testWebhook(hook.id); U.toast('Test delivered ✓') } catch (err) { U.toast('Test failed: ' + err.message, 'error') } finally { e.target.disabled = false }
              }
            }, [document.createTextNode('Send test')]),
            U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.webhookForm(content, events, hook) }, [document.createTextNode('Edit')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                await YumeAPI.admin.updateWebhook(hook.id, { enabled: !hook.enabled })
                this.renderWebhooks(content)
              }
            }, [document.createTextNode(hook.enabled ? 'Disable' : 'Enable')]),
            U.el('button', {
              class: 'btn btn-sm',
              style: 'background:var(--danger);color:white;',
              onclick: async () => {
                if (!window.confirm(`Delete webhook "${hook.name}"?`)) return
                await YumeAPI.admin.deleteWebhook(hook.id)
                U.toast('Webhook deleted')
                this.renderWebhooks(content)
              }
            }, [document.createTextNode('Delete')])
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
