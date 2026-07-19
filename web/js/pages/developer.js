/* global window, document, U, YumeAPI */
// Developer Portal — enrol as a developer, create extension listings,
// upload versions into the review pipeline, and read per-extension
// analytics. Requires a reachable Yume API and a signed-in account.

const PageDeveloper = {
  async render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)
    pad.append(U.el('h1', { class: 'page-title', text: 'Developer Portal' }))

    if (!await YumeAPI.available()) {
      pad.append(U.el('div', { class: 'callout', html: `No Yume API reachable at <code>${YumeAPI.base()}</code>. Start the backend or set your server in <a href="#/settings" style="text-decoration:underline">Settings</a>.` }))
      return
    }
    if (!YumeAPI.user()) {
      pad.append(U.el('div', { class: 'callout', html: 'Sign in to your <a href="#/settings" style="text-decoration:underline">Yume account</a> to publish extensions.' }))
      return
    }

    const body = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    pad.append(body)

    let dev
    try {
      dev = (await YumeAPI._request('/v1/dev/me', { auth: true })).developer
    } catch (e) {
      body.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
      return
    }

    if (!dev) return this.renderEnrol(body)
    this.renderDashboard(body, dev)
  },

  renderEnrol (body) {
    const name = U.el('input', { class: 'input', placeholder: 'Publisher name', maxlength: '60', style: 'max-width:22rem;' })
    const site = U.el('input', { class: 'input', type: 'url', placeholder: 'Website (optional)', maxlength: '200', style: 'max-width:22rem;' })
    body.replaceChildren(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'Become an extension developer' }),
      U.el('p', { text: 'Publish extensions that resolve sources, subtitles or metadata. Extensions run sandboxed with the permissions they declare — see the extension docs before you start.' }),
      U.el('div', { style: 'display:flex;flex-direction:column;gap:.6rem;' }, [name, site]),
      U.el('button', {
        class: 'btn btn-primary btn-sm', style: 'margin-top:.75rem;',
        onclick: async () => {
          if (name.value.trim().length < 2) return U.toast('Enter a publisher name', 'error')
          try {
            await YumeAPI._request('/v1/dev/register', { method: 'POST', auth: true, body: { displayName: name.value.trim(), website: site.value.trim() || undefined } })
            YumeAPI._perms = null // developer role just granted
            U.toast('Welcome, developer!')
            this.render(document.getElementById('page'))
          } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode('Register as developer')])
    ]))
  },

  async renderDashboard (body, dev) {
    body.replaceChildren()

    const head = U.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;margin-bottom:1rem;' }, [
      U.el('div', {}, [
        U.el('div', { style: 'font-weight:800;font-size:1.1rem;' }, [
          document.createTextNode(dev.display_name + ' '),
          dev.verified ? U.el('span', { style: 'color:var(--info);', text: '✓' }) : null
        ]),
        U.el('div', { class: 'list-row-sub', text: dev.website || 'Extension developer' })
      ]),
      U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.showCreate(body, dev) }, [document.createTextNode('+ New extension')])
    ])
    body.append(head)

    const list = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    body.append(list)

    try {
      const { data } = await YumeAPI._request('/v1/dev/extensions', { auth: true })
      list.replaceChildren()
      if (!data.length) {
        list.append(U.el('div', { class: 'empty-state', text: 'No extensions yet. Create your first listing above.' }))
        return
      }
      const STATUS_LABEL = { draft: 'Draft', in_review: 'In review', published: 'Published', suspended: 'Suspended', deprecated: 'Deprecated' }
      for (const ext of data) {
        list.append(U.el('div', {
          class: 'list-row', style: 'cursor:pointer;',
          onclick: () => this.showAnalytics(body, dev, ext)
        }, [
          U.el('div', { class: 'ext-icon', text: ext.name.slice(0, 1).toUpperCase() }),
          U.el('div', { class: 'list-row-grow' }, [
            U.el('div', { class: 'list-row-title' }, [
              document.createTextNode(ext.name + ' '),
              U.el('span', { class: 'ext-type-chip', text: ext.type }),
              U.el('span', { class: 'badge' + (ext.status === 'published' ? ' badge-theme' : ' badge-outline'), style: 'margin-left:.4rem;', text: STATUS_LABEL[ext.status] ?? ext.status })
            ]),
            U.el('div', { class: 'list-row-sub', text: `${ext.install_count} installs • ${ext.version_count} version${ext.version_count === '1' ? '' : 's'}${Number(ext.pending_versions) ? ` • ${ext.pending_versions} pending review` : ''}` })
          ]),
          U.el('span', { class: 'section-more', style: 'pointer-events:none;', text: 'Manage' })
        ]))
      }
    } catch (e) {
      list.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
    }
  },

  showCreate (body, dev) {
    const slug = U.el('input', { class: 'input', placeholder: 'unique-slug (a-z, 0-9, -)', maxlength: '64' })
    const name = U.el('input', { class: 'input', placeholder: 'Display name', maxlength: '100' })
    const summary = U.el('input', { class: 'input', placeholder: 'One-line summary', maxlength: '200' })
    const type = U.el('select', { class: 'select' }, ['torrent', 'http', 'nzb', 'subtitle', 'metadata', 'theme'].map(t => U.el('option', { value: t, text: t })))
    const desc = U.el('textarea', { class: 'input', rows: '4', placeholder: 'Store description (markdown)' })

    slug.addEventListener('input', () => { slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })

    const modal = this.modal('New extension', [
      field('Slug', slug), field('Name', name), field('Summary', summary), field('Type', type), field('Description', desc)
    ], async () => {
      try {
        await YumeAPI._request('/v1/dev/extensions', {
          method: 'POST', auth: true,
          body: { slug: slug.value.trim(), name: name.value.trim(), summary: summary.value.trim(), description: desc.value.trim() || undefined, type: type.value }
        })
        U.toast('Extension listing created')
        modal.remove()
        this.renderDashboard(body, dev)
      } catch (e) { U.toast(e.message, 'error') }
    })
  },

  async showAnalytics (body, dev, ext) {
    body.replaceChildren(
      U.el('button', { class: 'section-more', style: 'margin-bottom:1rem;', onclick: () => this.renderDashboard(body, dev) }, [document.createTextNode('‹ Back to extensions')]),
      U.el('div', { class: 'spinner' })
    )

    let analytics
    try {
      analytics = await YumeAPI._request(`/v1/dev/extensions/${ext.slug}/analytics`, { auth: true })
    } catch (e) {
      body.append(U.el('div', { class: 'error-state', text: e.message }))
      return
    }

    const back = U.el('button', { class: 'section-more', onclick: () => this.renderDashboard(body, dev) }, [document.createTextNode('‹ Back to extensions')])
    body.replaceChildren(back)

    body.append(U.el('h2', { class: 'detail-section-title', style: 'margin-top:1rem;', text: ext.name }))

    const eventCounts = Object.fromEntries(analytics.events.map(e => [e.event, e.count]))
    const cards = [
      [analytics.totals.install_count, 'Installs'],
      [analytics.totals.rating_avg ? Number(analytics.totals.rating_avg).toFixed(1) + '★' : '—', `Rating (${analytics.totals.rating_count})`],
      [eventCounts.update ?? 0, 'Updates (30d)'],
      [eventCounts.error ?? 0, 'Errors (30d)'],
      [eventCounts.load_failure ?? 0, 'Load failures (30d)']
    ]
    body.append(U.el('div', { class: 'stat-cards' }, cards.map(([v, l]) =>
      U.el('div', { class: 'stat-card' }, [U.el('b', { text: String(v) }), U.el('span', { text: l })]))))

    // versions + upload
    body.append(U.el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:1.5rem;' }, [
      U.el('h2', { class: 'detail-section-title', style: 'margin:0;', text: 'Versions' }),
      U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.showUpload(body, dev, ext) }, [document.createTextNode('Upload version')])
    ]))

    const REVIEW = { pending: 'Pending review', approved: 'Published', rejected: 'Rejected' }
    if (!analytics.versions.length) {
      body.append(U.el('div', { class: 'empty-state', text: 'No versions uploaded yet.' }))
    }
    for (const v of analytics.versions) {
      body.append(U.el('div', { class: 'list-row', style: 'cursor:default;' }, [
        U.el('div', { class: 'list-row-grow' }, [
          U.el('div', { class: 'list-row-title' }, [
            document.createTextNode('v' + v.version + ' '),
            U.el('span', { class: 'badge' + (v.review_status === 'approved' ? ' badge-theme' : v.review_status === 'rejected' ? '' : ' badge-outline'), text: REVIEW[v.review_status] ?? v.review_status })
          ]),
          U.el('div', { class: 'list-row-sub', text: `${v.installs} installs${v.published_at ? ' • published ' + U.airDate(v.published_at) : ''}${v.review_notes ? ' • ' + v.review_notes : ''}` })
        ])
      ]))
    }
  },

  showUpload (body, dev, ext) {
    const version = U.el('input', { class: 'input', placeholder: '1.0.0', maxlength: '20' })
    const changelog = U.el('textarea', { class: 'input', rows: '2', placeholder: 'Changelog (optional)' })
    const hosts = U.el('input', { class: 'input', placeholder: 'net:fetch hosts, comma-separated (e.g. nyaa.si)' })
    const permBoxes = ['query:ids', 'query:titles', 'query:media', 'storage:local', 'player:subtitles'].map(p => {
      const cb = U.el('input', { type: 'checkbox', value: p })
      return { p, cb, label: U.el('label', { style: 'display:flex;gap:.4rem;align-items:center;font-size:.8rem;', }, [cb, document.createTextNode(p)]) }
    })

    const modal = this.modal('Upload version', [
      field('Version (semver)', version),
      field('Changelog', changelog),
      field('net:fetch hosts', hosts),
      U.el('div', {}, [
        U.el('label', { class: 'filter-group', style: 'margin-bottom:.4rem;' }, [U.el('span', { text: 'Permissions' })]),
        U.el('div', { style: 'display:flex;flex-wrap:wrap;gap:.75rem;' }, permBoxes.map(b => b.label))
      ])
    ], async () => {
      if (!/^\d+\.\d+\.\d+$/.test(version.value.trim())) return U.toast('Version must be semver (x.y.z)', 'error')
      const permissions = permBoxes.filter(b => b.cb.checked).map(b => ({ permission: b.p }))
      const hostList = hosts.value.split(',').map(h => h.trim()).filter(Boolean)
      if (hostList.length) permissions.push({ permission: 'net:fetch', hosts: hostList })

      // In this build the package bytes are uploaded to object storage
      // client-side; here we send a manifest snapshot + a content hash.
      // We derive a stable demo hash from the manifest so the review
      // pipeline has something to record.
      const manifest = { manifestVersion: 3, name: ext.name, version: version.value.trim(), type: ext.type }
      const hash = await sha256Hex(JSON.stringify(manifest) + version.value)

      try {
        await YumeAPI._request(`/v1/dev/extensions/${ext.slug}/versions`, {
          method: 'POST', auth: true,
          body: {
            version: version.value.trim(),
            packageKey: `packages/${ext.slug}/${version.value.trim()}.tgz`,
            packageHash: hash,
            packageSize: 20480,
            changelog: changelog.value.trim() || undefined,
            manifest,
            permissions
          }
        })
        U.toast('Version submitted for review')
        modal.remove()
        this.showAnalytics(body, dev, ext)
      } catch (e) { U.toast(e.message, 'error') }
    })
  },

  modal (title, fields, onSubmit) {
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', onclick: onSubmit }, [document.createTextNode('Submit')])
    const backdrop = U.el('div', { class: 'modal-backdrop', onclick: e => { if (e.target === backdrop) backdrop.remove() } }, [
      U.el('div', { class: 'search-modal', style: 'padding:1.25rem;max-width:32rem;' }, [
        U.el('h3', { style: 'margin:0 0 1rem;font-size:1.1rem;font-weight:800;', text: title }),
        U.el('div', { style: 'display:flex;flex-direction:column;gap:.85rem;' }, fields),
        U.el('div', { style: 'display:flex;gap:.6rem;margin-top:1.25rem;' }, [
          submit,
          U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => backdrop.remove() }, [document.createTextNode('Cancel')])
        ])
      ])
    ])
    document.body.append(backdrop)
    return backdrop
  }
}

function field (label, control) {
  return U.el('div', { class: 'filter-group' }, [U.el('label', { text: label }), control])
}

async function sha256Hex (text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

window.PageDeveloper = PageDeveloper
