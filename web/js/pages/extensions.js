/* global window, document, U, YumeAPI, T, I18n */
// Extension Store — browses the Yume API's extension registry.
// Shows a clear connect state when no backend is reachable instead of
// pretending: the store is a platform feature, not a client-side mock.

const PageExtensions = {
  TYPES: ['torrent', 'http', 'nzb', 'subtitle', 'metadata', 'theme'],

  render (root, params) {
    const pad = U.el('div', { class: 'page-pad' })
    root.append(pad)

    root.prepend(window.C.spotlight(T('Extension Store'), {
      subtitle: 'Sources, trackers and tools — sandboxed and permission-scoped',
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
        const { data } = await YumeAPI.extensions(state.type || undefined, state.sort)
        if (!data.length) {
          content.replaceChildren(U.el('div', { class: 'empty-state', text: T('No published extensions in this category yet.') }))
          return
        }

        const grid = U.el('div', { class: 'ext-grid' })
        for (const ext of data) {
          grid.append(U.el('div', { class: 'ext-card' }, [
            U.el('div', { class: 'ext-card-head' }, [
              U.el('div', { class: 'ext-icon' }, [
                ext.icon_key
                  ? U.el('img', { src: ext.icon_key, alt: '' })
                  : document.createTextNode(ext.name.slice(0, 1).toUpperCase())
              ]),
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
          ]))
        }
        content.replaceChildren(grid)
      } catch (e) {
        content.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load the store: ') + e.message }))
      }
    }

    renderTabs()
    load()
  }
}

window.PageExtensions = PageExtensions
