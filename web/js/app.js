/* global window, document, U, C, API, Store, PageHome, PageSearch, PageAnime, PageSchedule, PageList, PageSettings */
// App bootstrap: hash router (same #/route scheme as the original SvelteKit
// build), sidebar active state and the quick-search modal (Ctrl+K / S).

const App = {
  routes: {
    home: (root, params) => PageHome.render(root, params),
    search: (root, params) => PageSearch.render(root, params),
    schedule: (root, params) => PageSchedule.render(root, params),
    list: (root, params) => PageList.render(root, params),
    profile: (root, params) => PageProfile.render(root, params),
    profiles: (root, params) => PageProfiles.render(root, params),
    history: (root, params) => PageHistory.render(root, params),
    community: (root, params) => PageCommunity.render(root, params),
    w2g: (root, params, arg) => PageW2G.render(root, params, arg),
    watch: (root, params, arg) => PageWatch.render(root, params, arg),
    extensions: (root, params) => PageExtensions.render(root, params),
    developer: (root, params) => PageDeveloper.render(root, params),
    admin: (root, params) => PageAdmin.render(root, params),
    settings: (root, params) => PageSettings.render(root, params),
    anime: (root, params, arg) => PageAnime.render(root, params, arg)
  },

  parseHash () {
    // "#/anime/123?x=y" -> { route: 'anime', arg: '123', params }
    const hash = window.location.hash.replace(/^#\/?/, '') || 'home'
    const [path, query] = hash.split('?')
    const [route, arg] = path.split('/')
    return { route: route || 'home', arg, params: new URLSearchParams(query ?? '') }
  },

  navigate () {
    const { route, arg, params } = this.parseHash()
    const page = document.getElementById('page')
    page.replaceChildren()
    page.scrollTop = 0

    // banner only persists on home; pages set their own
    if (route !== 'home') U.setBanner(null)

    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.route === route || ((route === 'anime' || route === 'watch') && btn.dataset.route === 'home') || (route === 'developer' && btn.dataset.route === 'extensions'))
    })

    const handler = this.routes[route] ?? this.routes.home
    try {
      handler(page, params, arg)
    } catch (e) {
      page.replaceChildren(U.el('div', { class: 'error-state', text: 'Something went wrong: ' + e.message }))
    }
  },

  // ---- quick search modal ----

  openSearchModal () {
    const backdrop = document.getElementById('search-modal')
    const input = document.getElementById('search-modal-input')
    backdrop.classList.remove('hidden')
    input.value = ''
    document.getElementById('search-modal-results').replaceChildren(
      U.el('div', { class: 'search-modal-empty', text: 'Type to search…' })
    )
    input.focus()
  },

  closeSearchModal () {
    document.getElementById('search-modal').classList.add('hidden')
  },

  initSearchModal () {
    const backdrop = document.getElementById('search-modal')
    const input = document.getElementById('search-modal-input')
    const results = document.getElementById('search-modal-results')

    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) this.closeSearchModal()
    })

    let token = 0
    input.addEventListener('input', U.debounce(async () => {
      const query = input.value.trim()
      const current = ++token
      if (query.length < 2) {
        results.replaceChildren(U.el('div', { class: 'search-modal-empty', text: 'Type to search…' }))
        return
      }
      results.replaceChildren(U.el('div', { class: 'spinner' }))
      try {
        const page = await API.search({ search: query, sort: ['SEARCH_MATCH'], perPage: 10 })
        if (current !== token) return
        results.replaceChildren()
        const media = page.media ?? []
        if (!media.length) {
          results.append(U.el('div', { class: 'search-modal-empty', text: 'No results.' }))
          return
        }
        for (const m of media) {
          results.append(U.el('a', {
            class: 'search-result',
            href: `#/anime/${m.id}`,
            onclick: () => this.closeSearchModal()
          }, [
            U.el('img', { src: m.coverImage?.large ?? '', alt: '' }),
            U.el('div', {}, [
              U.el('div', { class: 'search-result-title', text: U.title(m) }),
              U.el('div', { class: 'search-result-sub', text: [U.format(m), U.seasonYear(m), m.episodes ? `${m.episodes} ep` : null].filter(Boolean).join(' • ') })
            ])
          ]))
        }
      } catch (e) {
        if (current !== token) return
        results.replaceChildren(U.el('div', { class: 'search-modal-empty', text: 'Search failed: ' + e.message }))
      }
    }, 300))

    document.addEventListener('keydown', e => {
      const modalOpen = !backdrop.classList.contains('hidden')
      if (e.key === 'Escape' && modalOpen) {
        this.closeSearchModal()
        return
      }
      // Ctrl/Cmd+K or "s" (outside inputs) opens quick search — same keybinds as the app
      const inField = /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? '')
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (!inField && !modalOpen && e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault()
        this.openSearchModal()
      }
    })
  },

  async refreshAdminNav () {
    /* global YumeAPI */
    const nav = document.getElementById('nav-admin')
    if (!nav) return
    const perms = window.YumeAPI.user() ? await window.YumeAPI.myPermissions() : []
    nav.classList.toggle('hidden', !perms.some(p => p === 'community.moderate' || p.startsWith('admin.')))
  },

  refreshProfileAvatar () {
    const p = Store.activeProfile()
    const el = document.getElementById('sidebar-avatar')
    if (el && p) el.textContent = p.avatar ?? p.name.slice(0, 1).toUpperCase()
  },

  initProfileSwitcher () {
    const btn = document.getElementById('profile-switcher')
    if (!btn) return
    btn.addEventListener('click', () => {
      // close any existing menu
      document.getElementById('profile-menu')?.remove()
      const active = Store.activeProfileId()
      const menu = U.el('div', { class: 'profile-menu', id: 'profile-menu' }, [
        ...Store.profiles().map(p => U.el('button', {
          class: 'profile-menu-item' + (p.id === active ? ' active' : ''),
          onclick: () => {
            if (p.id !== active) { Store.setActiveProfile(p.id); window.location.reload() }
            menu.remove()
          }
        }, [
          U.el('span', { class: 'profile-menu-avatar', text: p.avatar ?? p.name.slice(0, 1).toUpperCase() }),
          U.el('span', { text: p.name }),
          p.id === active ? U.el('span', { style: 'margin-left:auto;color:var(--accent);', text: '✓' }) : null
        ])),
        U.el('div', { class: 'profile-menu-sep' }),
        U.el('a', { class: 'profile-menu-item', href: '#/profile', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '📊' }), document.createTextNode('View profile & stats')]),
        U.el('a', { class: 'profile-menu-item', href: '#/profiles?manage=1', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '⚙' }), document.createTextNode('Manage profiles')]),
        U.el('a', { class: 'profile-menu-item', href: '#/profiles', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '🔄' }), document.createTextNode('Switch profile')])
      ])
      document.body.append(menu)
      const rect = btn.getBoundingClientRect()
      menu.style.left = (rect.right + 8) + 'px'
      menu.style.bottom = (window.innerHeight - rect.bottom) + 'px'
      const close = e => { if (!menu.contains(e.target) && e.target !== btn) { menu.remove(); document.removeEventListener('click', close) } }
      setTimeout(() => document.addEventListener('click', close), 0)
    })
  },

  init () {
    Store.ensureProfiles()
    Store.applyTheme()
    this.refreshProfileAvatar()
    this.initProfileSwitcher()
    // icon-rail sidebar: hidden labels become native tooltips
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      const label = btn.querySelector('span')?.textContent
      if (label) btn.title = label
    })
    this.refreshAdminNav()
    this.initSearchModal()
    window.addEventListener('hashchange', () => this.navigate())
    this.navigate()
  }
}

App.init()
