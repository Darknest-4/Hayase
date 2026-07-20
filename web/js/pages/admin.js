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

    if (!canUsers && !canModerate && !canAnalytics && !canWebhooks) {
      pad.append(U.el('div', { class: 'callout', text: 'You need moderator or admin permissions to see this page.' }))
      return
    }

    const TABS = [
      canAnalytics && ['overview', 'Overview'],
      canUsers && ['users', 'Users'],
      canModerate && ['reports', 'Reports'],
      canWebhooks && ['webhooks', 'Webhooks']
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
      else this.renderWebhooks(content)
    }

    renderTabs()
    renderContent()
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
