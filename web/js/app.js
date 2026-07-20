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
    notifications: (root, params) => PageNotifications.render(root, params),
    dashboard: (root, params) => PageDashboard.render(root, params),
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

  // pages folded into a hub keep working as deep links via a redirect
  REDIRECTS: {
    analytics: '#/profile?tab=analytics',
    achievements: '#/profile?tab=achievements',
    history: '#/profile?tab=history',
    themes: '#/settings?tab=appearance'
  },

  navigate () {
    const { route, arg, params } = this.parseHash()
    if (this.REDIRECTS[route]) { window.location.replace(this.REDIRECTS[route]); return }
    const page = document.getElementById('page')
    document.getElementById('w2g-modal')?.remove() // close the W2G popup on nav
    page.replaceChildren()
    page.scrollTop = 0

    // banner only persists on home; pages set their own
    if (route !== 'home') U.setBanner(null)

    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.route === route || ((route === 'anime' || route === 'watch') && btn.dataset.route === 'home') || (route === 'developer' && btn.dataset.route === 'extensions'))
    })
    // mobile bottom bar: the "More" tab lights up for any route that isn't a
    // primary tab (or its home-mapped detail/watch pages)
    const primary = ['home', 'search', 'list', 'notifications', 'anime', 'watch']
    document.getElementById('nav-more')?.classList.toggle('active', !primary.includes(route))
    this.refreshNotifBadge()

    const handler = this.routes[route] ?? this.routes.home
    try {
      handler(page, params, arg)
    } catch (e) {
      page.replaceChildren(U.el('div', { class: 'error-state', text: 'Something went wrong: ' + e.message }))
    }

    // site footer on standard content pages (not on immersive / picker screens)
    if (!['watch', 'w2g', 'profiles'].includes(route)) page.append(C.footer())
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

  refreshNotifBadge () {
    const badge = document.getElementById('notif-badge')
    if (!badge) return
    let count = 0
    try { count = Store.unreadCount() } catch (e) { /* no data */ }
    badge.textContent = count > 9 ? '9+' : String(count)
    badge.classList.toggle('hidden', count === 0)
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
        U.el('a', { class: 'profile-menu-item', href: '#/profile', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '📊' }), document.createTextNode('Profile & stats')]),
        U.el('a', { class: 'profile-menu-item', href: '#/profile?tab=analytics', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '📈' }), document.createTextNode('Analytics')]),
        U.el('a', { class: 'profile-menu-item', href: '#/profile?tab=achievements', onclick: () => menu.remove() }, [U.el('span', { class: 'profile-menu-avatar', text: '🏆' }), document.createTextNode('Achievements')]),
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

  // ---- mobile "More" bottom sheet ----

  // every destination that isn't a primary bottom-bar tab. Icons are inline
  // SVG paths (drawn via U.svg) so the sheet stays self-contained.
  MORE_ITEMS: [
    { route: 'dashboard', label: 'Dashboard', icon: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>' },
    { route: 'schedule', label: 'Schedule', icon: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>' },
    { route: 'w2g', label: 'Together', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { route: 'community', label: 'Community', icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>' },
    { route: 'profile', label: 'Profile', icon: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
    { route: 'profile', href: '#/profile?tab=analytics', label: 'Analytics', icon: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7"/><rect x="12" y="7" width="3" height="11"/><rect x="17" y="4" width="3" height="14"/>' },
    { route: 'profile', href: '#/profile?tab=achievements', label: 'Awards', icon: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>' },
    { route: 'extensions', label: 'Extensions', icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 13v8M13.5 17h8"/>' },
    { route: 'settings', label: 'Settings', icon: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' }
  ],

  initMobileMore () {
    const btn = document.getElementById('nav-more')
    if (!btn) return
    btn.addEventListener('click', () => {
      if (document.getElementById('more-sheet')) { this.closeMoreSheet(); return }
      this.openMoreSheet()
    })
  },

  openMoreSheet () {
    const current = this.parseHash().route
    const backdrop = U.el('div', { class: 'more-backdrop', id: 'more-backdrop', onclick: () => this.closeMoreSheet() })
    const sheet = U.el('div', { class: 'more-sheet', id: 'more-sheet' })

    sheet.append(U.el('div', { class: 'more-grabber' }))

    const p = Store.activeProfile()
    sheet.append(U.el('div', { class: 'more-profile' }, [
      U.el('div', { class: 'more-profile-avatar', text: p?.avatar ?? (p?.name?.slice(0, 1).toUpperCase() ?? '🦊') }),
      U.el('div', { style: 'min-width:0;' }, [
        U.el('div', { class: 'more-profile-name', text: p?.name ?? 'Profile' }),
        U.el('div', { class: 'more-profile-sub', text: 'Watch profile' })
      ]),
      U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/profiles', onclick: () => this.closeMoreSheet() }, [document.createTextNode('Switch')])
    ]))

    // build the destination grid, appending Admin only when it's available
    const items = [...this.MORE_ITEMS]
    const adminNav = document.getElementById('nav-admin')
    if (adminNav && !adminNav.classList.contains('hidden')) {
      items.splice(items.length - 1, 0, { route: 'admin', label: 'Admin', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' })
    }

    const grid = U.el('div', { class: 'more-grid' })
    for (const it of items) {
      // plain profile route is "active" only for the bare Profile item, not its tabs
      const isActive = it.route === current && (it.route !== 'profile' || !it.href)
      grid.append(U.el('a', {
        class: 'more-item' + (isActive ? ' active' : ''),
        href: it.href ?? `#/${it.route}`,
        onclick: () => this.closeMoreSheet()
      }, [U.svg(it.icon, 22), U.el('span', { text: it.label })]))
    }
    sheet.append(grid)

    document.body.append(backdrop, sheet)
    // next frame -> trigger the slide-up / fade-in transitions
    requestAnimationFrame(() => { backdrop.classList.add('open'); sheet.classList.add('open') })
  },

  closeMoreSheet () {
    const backdrop = document.getElementById('more-backdrop')
    const sheet = document.getElementById('more-sheet')
    if (sheet) { sheet.classList.remove('open'); setTimeout(() => sheet.remove(), 300) }
    if (backdrop) { backdrop.classList.remove('open'); setTimeout(() => backdrop.remove(), 300) }
  },

  init () {
    Store.ensureProfiles()
    Store.applyTheme()
    this.refreshProfileAvatar()
    this.refreshNotifBadge()
    this.initProfileSwitcher()
    // icon-rail sidebar: hidden labels become native tooltips
    document.querySelectorAll('.sidebar-btn').forEach(btn => {
      const label = btn.querySelector('span')?.textContent
      if (label) btn.title = label
    })
    this.refreshAdminNav()
    this.initSearchModal()
    this.initMobileMore()
    window.addEventListener('hashchange', () => { this.closeMoreSheet(); this.navigate() })
    this.navigate()
  }
}

window.App = App
App.init()
