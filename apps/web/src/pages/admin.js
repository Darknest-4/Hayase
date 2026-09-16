/* global confirm, document, history, window */
// Admin dashboard — overview analytics, user management and the
// moderation queue. Only reachable with the right permissions; the
// server enforces them regardless.

import { site } from '../shared/lib/site-config.js'
import { navigate, refreshChrome } from '../shared/lib/shell.js'
import { Charts } from '../shared/ui/charts.js'
import { AP } from '../shared/ui/admin-ui.js'
import { C } from '../shared/ui/components.js'
import { I18n } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'

export const PageAdmin = {
  /**
   * The admin surface, grouped.
   *
   * A flat list of eight was already at the point where finding something
   * meant reading all of it, and two more were waiting to be added. The groups
   * are how the work actually divides: what is happening right now, who is
   * doing it, what they are doing it to, and how the machine underneath is.
   */
  /**
   * A jogosultságok csoportjai.
   *
   * A csoport neve az adatbázisban azonosító (`permissions.group`), és a
   * szűrés is arra megy — ezért nem ott fordítjuk, hanem itt, megjelenítéskor.
   * Ami nincs a térképen, az a saját nevén jelenik meg: egy új csoport nem
   * tűnik el attól, hogy még nincs magyar neve.
   */
  PERM_GROUPS: {
    admin: 'Adminisztráció',
    ai: 'Mesterséges intelligencia',
    analytics: 'Statisztika',
    anime: 'Anime',
    catalogue: 'Katalógus',
    community: 'Közösség',
    developer: 'Fejlesztői',
    gamification: 'Játékosítás',
    library: 'Könyvtár',
    moderation: 'Moderálás',
    security: 'Biztonság',
    streaming: 'Lejátszás',
    system: 'Rendszer',
    users: 'Felhasználók'
  },

  /*
   * A rál csoportjai.
   *
   * Eddig négy csoport volt, és a „Rendszer" kilenc bejegyzést tartott — ott
   * kötött ki minden, aminek nem volt jobb helye: mentés, biztonság,
   * webhookok, témák, hírek, fejlesztési napló, auditállapot, beállítások,
   * infrastruktúra. Kilenc egymás alatti sor nem csoport, hanem maradék.
   *
   * Öt csoport, KÉRDÉSEK szerint, nem technológia szerint:
   *
   *   Áttekintés   — megy az oldal?
   *   Katalógus    — mi van rajta?
   *   Közösség     — kik vannak rajta, és mit csinálnak?
   *   Üzemeltetés  — mi romlott el, és mi védi?
   *   Megjelenés   — hogy néz ki, és mi van bekapcsolva?
   *
   * Így a legnagyobb csoport hét bejegyzés, és mindegyikről egy mondatban
   * meg lehet mondani, miért ott van.
   */
  GROUPS: [
    { key: 'insight', label: 'Áttekintés' },
    { key: 'content', label: 'Katalógus' },
    { key: 'people', label: 'Közösség' },
    { key: 'ops', label: 'Üzemeltetés' },
    { key: 'look', label: 'Megjelenés' }
  ],

  SECTIONS: [
    { key: 'overview', group: 'insight', label: 'Áttekintés', sub: 'A platform állapota és statisztikája', perm: 'admin.analytics.view', render: 'renderOverview', icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
    { key: 'errors', group: 'ops', label: 'Hibák', sub: 'Csoportosított hibák és hívási láncok', perm: 'admin.analytics.view', render: 'renderErrors', icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0"/>' },
    { key: 'audit-log', group: 'ops', label: 'Műveleti napló', sub: 'Ki mit változtatott, és mikor', perm: 'admin.users.manage', render: 'renderAudit', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M9 11h2"/>' },
    { key: 'analytics', group: 'insight', label: 'Látogatottság', sub: 'Kik jártak itt, és mit csináltak', perm: 'analytics.view', render: 'renderAnalytics', icon: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>' },

    { key: 'users', group: 'people', label: 'Felhasználók', sub: 'Fiókok, felfüggesztések, kitiltások', perm: 'admin.users.manage', render: 'renderUsers', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { key: 'roles', group: 'people', label: 'Szerepkörök', sub: 'Jogosultságok és szerepkörök', perm: 'roles.manage', render: 'renderRoles', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' },
    { key: 'reports', group: 'people', label: 'Bejelentések', sub: 'Moderálási sor', perm: 'community.moderate', render: 'renderReports', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>' },

    { key: 'catalogue', group: 'content', label: 'Katalógus', sub: 'Animék, epizódok, publikálás', perm: 'anime.view', render: 'renderCatalogue', icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
    { key: 'metadata', group: 'content', label: 'Metaadatok', sub: 'AniList-lefedettség és szinkronfutások', perm: 'anime.edit', render: 'renderMetadata', icon: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><path d="M21 3v6h-6"/>' },
    { key: 'translations', group: 'content', label: 'Fordítások', sub: 'Magyar címek és leírások', perm: 'anime.edit', render: 'renderTranslations', icon: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>' },

    { key: 'monitoring', group: 'insight', label: 'Infrastruktúra', sub: 'A kiszolgáló állapota és szolgáltatásai', perm: 'system.metrics.view', render: 'renderMonitoring', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
    { key: 'announcements', group: 'people', label: 'Hírek', sub: 'Az egész oldalra szóló üzenetek', perm: 'announcement.manage', render: 'renderAnnouncements', icon: '<path d="M3 11v3a1 1 0 0 0 1 1h3l4 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19.5 6a8 8 0 0 1 0 12"/>' },
    { key: 'changelog', group: 'people', label: 'Fejlesztési napló', sub: 'Kiadások és a bennük lévő sorok', perm: 'changelog.manage', render: 'renderChangelog', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>' },
    { key: 'webhooks', group: 'ops', label: 'Webhookok', sub: 'Kimenő integrációk', perm: 'admin.webhooks.manage', render: 'renderWebhooks', icon: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>' },
    { key: 'themes', group: 'look', label: 'Témák', sub: 'Színek, amikből a látogatók választhatnak', perm: 'theme.publish', render: 'renderThemes', icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h2a4 4 0 0 0 4-4 10 10 0 0 0-10-11"/>' },
    { key: 'backups', group: 'ops', label: 'Mentések', sub: 'Mentés, ellenőrzés, visszaállítás', perm: 'backup.manage', render: 'renderBackups', icon: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>' },
    { key: 'security', group: 'ops', label: 'Biztonság', sub: 'Biztonsági állapot és vészkapcsolók', perm: 'security.manage', render: 'renderSecurity', icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>' },
    // The code audit, which is not the audit *log* in Insight above — that one
    // is what people did, this one is what is wrong with the software. It took
    // the shorter key because /admin/audit is the address it was specified at;
    // the log moved to audit-log. See YUME-AUDIT-0013.
    { key: 'audit', group: 'ops', label: 'Kódaudit', sub: 'A legutóbbi kódátvizsgálás észrevételei', perm: 'audit.read', render: 'renderAuditStatus', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 11 2 2 4-4"/>' },
    { key: 'config', group: 'look', label: 'Beállítások', sub: 'Funkciókapcsolók és beállítások', perm: 'settings.system', render: 'renderConfig', icon: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>' }
  ],

  /**
   * Jump to a section by typing.
   *
   * Twelve sections is past the point where scanning a rail is faster than
   * saying where you want to go. It searches labels and their sub-lines, so
   * "colours" finds Themes and "coverage" finds Metadata — the words somebody
   * has in mind are rarely the words in the menu.
   */
  sectionJump (available, select) {
    const results = U.el('div', { class: 'admin-jump-results hidden' })

    const paint = term => {
      const matches = available.filter(s =>
        !term || s.label.toLowerCase().includes(term) || s.sub.toLowerCase().includes(term))
      results.replaceChildren(...matches.slice(0, 6).map(s => U.el('button', {
        class: 'admin-jump-item',
        type: 'button',
        onclick: () => {
          select(s)
          input.value = ''
          results.classList.add('hidden')
        }
      }, [
        U.svg(s.icon, 14),
        U.el('span', { class: 'admin-jump-label', text: s.label }),
        U.el('span', { class: 'admin-jump-sub', text: s.sub })
      ])))
      results.classList.toggle('hidden', !matches.length)
    }

    const input = U.el('input', {
      class: 'input admin-jump-input',
      type: 'search',
      placeholder: 'Szekció keresése…',
      oninput: e => paint(e.target.value.trim().toLowerCase()),
      onfocus: e => paint(e.target.value.trim().toLowerCase()),
      onkeydown: e => {
        if (e.key === 'Escape') { e.target.value = ''; results.classList.add('hidden'); e.target.blur() }
        if (e.key === 'Enter') results.querySelector('.admin-jump-item')?.click()
      }
    })

    // Blur closes it, but not before a click on a result has been delivered.
    input.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 120))

    // `/` focuses it, the way search boxes work everywhere else. Bound to the
    // document because the point is not having to reach for it first.
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.target.matches('input, textarea, select')) return
      if (!document.body.contains(input)) return
      e.preventDefault()
      input.focus()
    })

    return U.el('div', { class: 'admin-jump' }, [
      U.el('span', { class: 'admin-jump-icon' }, [
        U.svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 15)
      ]),
      input,
      U.el('kbd', { class: 'admin-jump-kbd', text: '/' }),
      results
    ])
  },

  /**
   * Unread notifications, from the same two sources the site header counts:
   * what is stored in this browser, and what is on the account.
   */
  notifBell () {
    const badge = U.el('span', { class: 'admin-bell-badge hidden' })
    const bell = U.el('a', { class: 'admin-bell', href: '#/notifications', title: 'Értesítések' }, [
      U.svg('<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>', 17),
      badge
    ])
    const paint = count => {
      badge.textContent = count > 9 ? '9+' : String(count)
      badge.classList.toggle('hidden', !count)
    }
    let local = 0
    try { local = Store?.unreadCount?.() ?? 0 } catch (e) { /* no data */ }
    paint(local)
    YumeAPI.notifications?.({ unreadOnly: true, limit: 100 })
      ?.then(rows => paint(local + rows.length))
      ?.catch(() => {})
    return bell
  },

  /**
   * Who you are acting as.
   *
   * The panel deletes accounts, republishes the catalogue and changes what
   * every viewer sees. Which account is doing that is worth stating on screen
   * rather than leaving to memory — and the permission count is the short
   * answer to "why can I not see that section".
   */
  accountChip (perms) {
    const user = YumeAPI.user?.() ?? null
    const name = user?.username ?? 'signed out'
    // The strongest thing this account can do, named. "58 permissions" is a
    // number; "can delete accounts" is what somebody actually needs to know
    // before pressing anything in here.
    const role = perms.includes('admin.users.manage')
      ? 'Administrator'
      : perms.includes('community.moderate')
        ? 'Moderator'
        : perms.includes('anime.edit')
          ? 'Editor'
          : 'Staff'
    return U.el('a', {
      class: 'admin-account',
      href: '#/profile',
      title: `${perms.length} permissions`
    }, [
      U.el('span', { class: 'admin-account-avatar', text: (name[0] ?? '?').toUpperCase() }),
      U.el('span', { class: 'admin-account-text' }, [
        U.el('span', { class: 'admin-account-name', text: name }),
        U.el('span', { class: 'admin-account-role', text: role })
      ]),
      U.svg('<path d="m6 9 6 6 6-6"/>', 13)
    ])
  },

  /**
   * Read or write the collapsed state of the section rail.
   *
   * localStorage rather than the account's preferences: it describes this
   * browser's window, not the person, and a preference that has to survive a
   * sign-out is the wrong shape for a server round trip.
   */
  _navCollapsed (value) {
    if (value === undefined) return window.localStorage?.getItem('yume-admin-nav') === 'collapsed'
    try { window.localStorage?.setItem('yume-admin-nav', value ? 'collapsed' : 'open') } catch (e) { /* private mode */ }
    return value
  },

  async render (root, params, arg) {
    const perms = await YumeAPI.myPermissions()
    const available = this.SECTIONS.filter(s => perms.includes(s.perm))

    if (!available.length) {
      const pad = U.el('div', { class: 'page-pad' })
      root.append(pad)
      pad.append(U.el('h1', { class: 'page-title', text: 'Admin' }))
      pad.append(U.el('div', { class: 'callout', text: 'Ehhez az oldalhoz moderátori vagy admin jogosultság kell.' }))
      return
    }

    // `#/admin/audit` first, then `#/admin?s=audit`, then whatever this
    // account can actually open. A section named in the address that this
    // account may not see falls through to the first one it may, rather than
    // reporting that the section exists — which is the same reason the routes
    // behind it answer 404 instead of 403.
    const start = available.find(s => s.key === arg) ??
      available.find(s => s.key === params?.get?.('s')) ??
      available[0]
    const state = { section: start }

    // ---- shell: admin nav rail + content ----
    //
    // The panel owns the window here: navigate() puts `admin-route` on
    // <body>, which takes away the site's icon rail, its mobile tab bar and
    // its footer. What is left is this rail and the section beside it.
    const shell = U.el('div', { class: 'admin-shell' + (this._navCollapsed() ? ' nav-collapsed' : '') })
    root.append(shell)

    const nav = U.el('aside', { class: 'admin-nav', id: 'admin-nav' })

    /*
     * Collapse the rail to icons.
     *
     * Worth having because the panel is now the whole window: the tables it
     * shows — audit rows, permission grids, flag lists — are the widest thing
     * in the app, and a 15rem rail is 15rem those tables do not get. The
     * choice is remembered per browser; it is a viewing preference, not
     * account data worth a round trip.
     */
    const collapseBtn = U.el('button', {
      class: 'admin-nav-collapse',
      type: 'button',
      title: 'Menü összecsukása',
      'aria-label': 'Menü összecsukása',
      onclick: () => {
        const collapsed = !shell.classList.contains('nav-collapsed')
        shell.classList.toggle('nav-collapsed', collapsed)
        this._navCollapsed(collapsed)
        collapseBtn.title = collapsed ? 'Expand the menu' : 'Collapse the menu'
        collapseBtn.setAttribute('aria-label', collapseBtn.title)
      }
    }, [U.svg('<path d="m15 18-6-6 6-6"/>', 15)])

    // The wordmark, then what this corner of it is. The count of reachable
    // sections used to sit here; the account chip in the bar says how many
    // permissions you hold, which answers the same question — "why can I not
    // see Roles" — closer to where you would ask it.
    nav.append(U.el('div', { class: 'admin-nav-head' }, [
      U.el('span', { class: 'admin-nav-mark' }, [
        U.svg('<path d="M23.5 4.5A13 13 0 1 0 27.5 21 10.5 10.5 0 0 1 23.5 4.5Z" fill="currentColor" stroke="none"/>', 18)
      ]),
      U.el('span', { class: 'admin-nav-brand' }, [
        U.el('span', { class: 'admin-nav-brand-name', text: site()?.name ?? 'Yume' }),
        U.el('span', { class: 'admin-nav-brand-sub', text: 'Adminfelület' })
      ]),
      collapseBtn
    ]))

    const navItems = {}
    for (const group of this.GROUPS) {
      const inGroup = available.filter(s => s.group === group.key)
      if (!inGroup.length) continue // a group nobody can reach is not a heading

      nav.append(U.el('div', { class: 'admin-nav-group', text: group.label }))
      for (const s of inGroup) {
        const item = U.el('button', {
          class: 'admin-nav-item' + (s.key === state.section.key ? ' active' : ''),
          type: 'button',
          // Doubles as the tooltip when the rail is collapsed to icons.
          title: `${s.label} — ${s.sub}`,
          onclick: () => select(s)
        }, [
          U.svg(s.icon, 17),
          U.el('span', { class: 'admin-nav-label', text: s.label }),
          // Filled in below, once the counts arrive.
          U.el('span', { class: 'admin-nav-badge hidden', dataset: { badge: s.key } })
        ])
        navItems[s.key] = item
        nav.append(item)
      }
    }

    // The way out. With the site's own rail hidden there is otherwise no link
    // back to the app from inside the panel — only the browser's Back button,
    // which is not a navigation design.
    nav.append(U.el('div', { class: 'admin-nav-foot' }, [
      U.el('a', { class: 'admin-nav-item admin-nav-back', href: '#/home', title: 'Vissza az oldalra' }, [
        U.svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', 17),
        U.el('span', { class: 'admin-nav-label', text: 'Vissza az oldalra' })
      ])
    ]))

    /*
     * How much is waiting, on the item it is waiting under.
     *
     * Best-effort and after the rail is on screen: a count nobody asked for
     * must not delay the panel opening, and a deployment where the request
     * fails simply shows no badges rather than an error over a working menu.
     */
    YumeAPI.admin.badges().then(counts => {
      for (const [key, count] of Object.entries(counts)) {
        const badge = nav.querySelector(`[data-badge="${key}"]`)
        if (!badge || !count) continue
        badge.textContent = count > 99 ? '99+' : String(count)
        badge.classList.remove('hidden')
      }
    }).catch(() => {})

    shell.append(nav)

    const main = U.el('div', { class: 'admin-content' })

    /*
     * The panel's own top bar.
     *
     * On a narrow screen it carries the drawer's handle and says where you
     * are — the rail used to become a horizontally scrolling strip of buttons
     * with most of the panel off the edge of the screen. At every width it
     * also carries the two things an operator reaches for constantly: a jump
     * box for the sections, and the account they are acting as, which is the
     * single most useful thing to be sure of before pressing anything in here.
     */
    const closeDrawer = () => {
      shell.classList.remove('nav-open')
      menuBtn.setAttribute('aria-expanded', 'false')
    }
    const menuBtn = U.el('button', {
      class: 'admin-menu-btn',
      type: 'button',
      'aria-label': 'Szekciók',
      'aria-controls': 'admin-nav',
      'aria-expanded': 'false',
      onclick: () => {
        const open = !shell.classList.contains('nav-open')
        shell.classList.toggle('nav-open', open)
        menuBtn.setAttribute('aria-expanded', String(open))
      }
    }, [U.svg('<line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/>', 18)])

    /*
     * Hol vagyok?
     *
     * Telefonon a rál egy fiók mögött van, tehát a képernyőn semmi nem mondta
     * meg, melyik szakaszban vagy — a címet le kellett görgetni, és görgetés
     * közben az is eltűnt. A felső sáv mostantól kiírja, és a `select()`
     * frissíti. Asztali gépen rejtett: ott a rál mondja meg.
     */
    const barTitle = U.el('span', { class: 'admin-topbar-title', text: state.section.label })

    main.append(U.el('div', { class: 'admin-topbar' }, [
      U.el('div', { class: 'admin-topbar-inner' }, [
        menuBtn,
        barTitle,
        this.sectionJump(available, section => select(section)),
        U.el('div', { class: 'admin-topbar-spacer' }),
        this.notifBell(),
        this.accountChip(perms),
        U.el('a', { class: 'admin-topbar-back', href: '#/home', title: 'Vissza az oldalra' }, [
          U.svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', 16)
        ])
      ])
    ]))

    // Tapping the dimmed page closes the drawer, which is what every drawer
    // does and what a thumb reaches for first.
    const backdrop = U.el('div', { class: 'admin-backdrop', onclick: closeDrawer })
    shell.append(backdrop)

    const head = U.el('div', { class: 'admin-content-head' })
    const body = U.el('div', { class: 'admin-content-body' })
    main.append(head, body)
    shell.append(main)

    const select = s => {
      state.section = s
      barTitle.textContent = s.label
      Object.values(navItems).forEach(i => i.classList.remove('active'))
      navItems[s.key]?.classList.add('active')
      closeDrawer() // picking a section is the drawer's whole purpose
      history.replaceState(null, '', `#/admin?s=${s.key}`) // deep-link without a re-render
      // A slot on the heading row for whatever the section needs beside its
      // own title — a range picker, a refresh state. Rebuilt per selection so
      // one section's controls can never survive into another's.
      this._headActions = U.el('div', { class: 'admin-content-actions' })
      head.replaceChildren(
        U.el('div', { class: 'admin-content-heading' }, [
          U.svg(s.icon, 20),
          U.el('div', { class: 'admin-content-heading-text' }, [
            U.el('h1', { class: 'admin-content-title', text: s.label }),
            // The sub-line lives here now rather than under every nav item:
            // eleven descriptions in a rail is noise, one under the heading you
            // are actually looking at is context.
            U.el('p', { class: 'admin-content-sub', text: s.sub })
          ]),
          this._headActions
        ])
      )
      body.replaceChildren(P.spinner())
      this[s.render](body)
    }
    select(state.section)
  },

  // ---- Errors: the triage loop ----
  //
  // The API for this existed and had no interface: errorGroups,
  // errorOccurrences and setErrorGroupStatus were all written and none had a
  // caller, so a 500 was only ever noticed because a user complained.

  ERR_STATUS: { open: ['Nyitott', 'vis-hidden'], resolved: ['Megoldva', 'vis-public'], ignored: ['Figyelmen kívül', 'vis-unlisted'] },

  async renderErrors (content) {
    const state = { status: 'open', open: null }
    const wrap = U.el('div', { class: 'err-layout' })
    const list = U.el('div', { class: 'err-list' })
    const detail = U.el('div', { class: 'err-detail' })

    /*
     * Look up the failure somebody is quoting.
     *
     * A 500 tells the caller "Request <id> failed — quote this id when
     * reporting it". This is where it gets quoted to. Before the id was
     * recorded on the occurrence, that sentence sent people to an operator
     * with no way to search for the number they were carrying.
     */
    const lookup = U.el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Illessz be egy kérésazonosítót…',
      style: 'max-width:22rem;',
      'aria-label': 'Hiba keresése kérésazonosító alapján',
      onkeydown: async e => {
        if (e.key !== 'Enter') return
        const id = e.target.value.trim()
        if (!id) return
        detail.replaceChildren(P.spinner())
        try {
          const { occurrence, group } = await YumeAPI.admin.errorByRequest(id)
          if (group) { await showDetail(group) } else { detail.replaceChildren() }
          // The occurrence is what happened to that person at that moment; the
          // group above is whether it is happening to everybody.
          detail.prepend(U.el('div', { class: 'err-lookup-hit' }, [
            U.el('div', { class: 'err-lookup-line', text: `${occurrence.context?.code ?? 'no code'} · ${occurrence.context?.method ?? ''} ${occurrence.context?.route ?? ''}`.trim() }),
            U.el('time', { class: 'err-lookup-when', text: new Date(occurrence.created_at).toLocaleString() })
          ]))
        } catch (err) {
          detail.replaceChildren(C.errorState(err))
        }
      }
    })

    const bar = U.el('div', { class: 'admin-toolbar' }, [
      U.el('select', {
        class: 'select',
        onchange: e => { state.status = e.target.value; load() }
      }, [['open', 'Nyitott'], ['all', 'Mind'], ['resolved', 'Megoldva'], ['ignored', 'Figyelmen kívül']].map(([v, l]) =>
        U.el('option', { value: v, text: l, selected: v === state.status }))),
      lookup
    ])

    const showDetail = async group => {
      state.open = group.id
      detail.replaceChildren(P.spinner())
      try {
        const { group: g, occurrences } = await YumeAPI.admin.error(group.id)
        detail.replaceChildren()
        detail.append(U.el('div', { class: 'err-detail-head' }, [
          U.el('h3', { class: 'err-detail-title', text: g.title }),
          U.el('div', { class: 'err-detail-meta', text: `${g.event_count} events · first ${U.relTime(g.first_seen)} · last ${U.relTime(g.last_seen)}` }),
          U.el('div', { class: 'err-actions' }, ['resolved', 'ignored', 'open']
            .filter(v => v !== g.status)
            .map(v => U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                try { await YumeAPI.admin.setErrorStatus(g.id, v); U.toast(`Marked ${v}`); load() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode(v === 'open' ? 'Reopen' : 'Mark ' + v)])))
        ]))
        if (!occurrences.length) {
          detail.append(P.emptyState('Nincs rögzített előfordulás.'))
          return
        }
        const occList = U.el('div', { class: 'err-occurrences' })
        detail.append(occList)
        for (const occ of occurrences) {
          occList.append(U.el('details', { class: 'err-occ' }, [
            U.el('summary', { text: `${U.relTime(occ.created_at)} · ${occ.context?.method ?? ''} ${occ.context?.route ?? occ.source}` }),
            U.el('pre', { class: 'err-stack', text: occ.stack || occ.message })
          ]))
        }
      } catch (e) { detail.replaceChildren(P.errorState(e.message)) }
    }

    const load = async () => {
      list.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.errors(state.status)
        list.replaceChildren()
        if (!data.length) {
          list.append(P.emptyState(state.status === 'open' ? 'No open errors. ' : 'Nothing here.'))
          detail.replaceChildren(U.el('div', { class: 'cat-placeholder', text: 'Nincs mit megnézni.' }))
          return
        }
        for (const g of data) {
          const [label, cls] = this.ERR_STATUS[g.status] ?? this.ERR_STATUS.open
          list.append(U.el('button', {
            class: 'err-row' + (g.id === state.open ? ' active' : ''),
            onclick: () => { list.querySelectorAll('.err-row').forEach(r => r.classList.remove('active')); showDetail(g) }
          }, [
            U.el('div', { class: 'err-row-count', text: String(g.event_count) }),
            U.el('div', { class: 'err-row-main' }, [
              U.el('div', { class: 'err-row-title', text: g.title }),
              U.el('div', { class: 'err-row-sub', text: 'last ' + U.relTime(g.last_seen) })
            ]),
            U.el('span', { class: 'cat-badge ' + cls, text: label })
          ]))
        }
        if (!state.open) detail.replaceChildren(U.el('div', { class: 'cat-placeholder', text: 'Válassz egy hibát, és megjelenik a hívási lánc.' }))
      } catch (e) { list.replaceChildren(P.errorState(e.message)) }
    }

    content.replaceChildren(bar, wrap)
    wrap.append(list, detail)
    load()
  },

  // ---- Audit log ----
  //
  // audit_logs was written from day one and had no reader. An audit log nobody
  // can read is storage, not accountability.

  /**
   * The audit trail.
   *
   * It filtered by subject type and printed the `after` object as raw JSON —
   * the least useful of the three things somebody arrives knowing, and a
   * format that says what a value became without ever saying what it was.
   * "Who did this", "what happened to this thing" and "what happened around
   * the time it broke" were all unanswerable here.
   *
   * A row now reads as a sentence and opens into the actual change.
   */
  AUDIT_WINDOWS: [['', 'Any time'], ['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days']],

  async renderAudit (content) {
    const state = { subjectType: '', action: '', actor: '', days: '', offset: 0 }
    const PAGE = 50
    const rows = U.el('div', { class: 'audit-rows' })
    const pager = U.el('div', { class: 'admin-pager' })
    let actionOptions = [['', 'Any action']]

    const pick = (value, options, onchange) => U.el('select', {
      class: 'select',
      onchange: e => { onchange(e.target.value); state.offset = 0; load() }
    }, options.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === value })))

    const actorInput = U.el('input', {
      class: 'input',
      placeholder: 'Ki csinálta…',
      style: 'max-width:12rem;',
      oninput: U.debounce(e => { state.actor = e.target.value.trim(); state.offset = 0; load() })
    })

    const bar = U.el('div', { class: 'admin-toolbar' })

    const paintBar = () => bar.replaceChildren(
      pick(state.subjectType, [['', 'Everything'], ['user', 'Users'], ['role', 'Roles'], ['anime', 'Anime'],
        ['episode', 'Episodes'], ['config', 'Config'], ['webhook', 'Webhooks'], ['theme', 'Themes'],
        ['metadata_run', 'Metadata runs']], v => { state.subjectType = v }),
      // Built from what this instance has actually recorded, so it cannot
      // drift from the set of actions the server writes.
      pick(state.action, actionOptions, v => { state.action = v }),
      pick(state.days, this.AUDIT_WINDOWS, v => { state.days = v }),
      actorInput
    )

    const load = async () => {
      rows.replaceChildren(P.spinner())
      pager.replaceChildren()
      try {
        const since = state.days
          ? new Date(Date.now() - Number(state.days) * 86400000).toISOString()
          : undefined
        const { data, total, actions } = await YumeAPI.admin.audit({
          subjectType: state.subjectType,
          action: state.action,
          actor: state.actor,
          since,
          limit: PAGE,
          offset: state.offset
        })

        if (actions && actionOptions.length === 1) {
          actionOptions = [['', 'Any action'], ...actions.map(a => [a.action, `${a.action} (${a.n})`])]
          paintBar()
        }

        rows.replaceChildren()
        if (!data.length) {
          rows.append(P.emptyState('Ehhez nincs bejegyzés.'))
          return
        }
        for (const r of data) rows.append(this.auditRow(r))

        if (Number(total) > PAGE) {
          const to = Math.min(state.offset + data.length, Number(total))
          pager.replaceChildren(
            U.el('button', {
              class: 'btn btn-sm btn-ghost',
              disabled: state.offset === 0,
              onclick: () => { state.offset = Math.max(0, state.offset - PAGE); load() }
            }, [document.createTextNode('← Újabb')]),
            U.el('span', { class: 'admin-pager-label', text: `${state.offset + 1}–${to} of ${total}` }),
            U.el('button', {
              class: 'btn btn-sm btn-ghost',
              disabled: to >= Number(total),
              onclick: () => { state.offset += PAGE; load() }
            }, [document.createTextNode('Régebbi →')])
          )
        }
      } catch (e) { rows.replaceChildren(P.errorState(e.message)) }
    }

    paintBar()
    content.replaceChildren(bar, rows, pager)
    load()
  },

  /**
   * One recorded change.
   *
   * The summary is the fields that moved, not the whole object: `before` and
   * `after` hold only what changed, so listing the keys and their two values
   * is the entire content of the record in a form somebody can read.
   */
  auditRow (r) {
    const before = r.before && typeof r.before === 'object' ? r.before : {}
    const after = r.after && typeof r.after === 'object' ? r.after : {}
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]

    const show = v => {
      if (v === undefined) return '—'
      if (v === null) return 'null'
      return typeof v === 'string' ? v : JSON.stringify(v)
    }

    // A key whose value moved is drawn as a change. Everything else — a key
    // present on one side only, or one carried on both without changing — is
    // context the action recorded, and is drawn as a plain line. Rendering
    // those as "— → demo" invents a transition that never happened; dropping
    // them loses which role a grant was about, since only `granted` moves.
    const line = k => {
      const had = Object.prototype.hasOwnProperty.call(before, k)
      const has = Object.prototype.hasOwnProperty.call(after, k)
      if (!had || !has || show(before[k]) === show(after[k])) {
        const value = show(has ? after[k] : before[k])
        return U.el('div', { class: 'audit-diff-row audit-diff-note' }, [
          U.el('span', { class: 'audit-diff-key', text: k }),
          U.el('span', { class: 'audit-diff-after', text: value, title: value })
        ])
      }
      return U.el('div', { class: 'audit-diff-row' }, [
        U.el('span', { class: 'audit-diff-key', text: k }),
        U.el('span', { class: 'audit-diff-before', text: show(before[k]), title: show(before[k]) }),
        U.el('span', { class: 'audit-diff-arrow', text: '→' }),
        U.el('span', { class: 'audit-diff-after', text: show(after[k]), title: show(after[k]) })
      ])
    }

    const lines = keys.map(line).filter(Boolean)
    const diff = lines.length ? U.el('div', { class: 'audit-diff' }, lines) : null

    const head = U.el('div', { class: 'audit-row-head' }, [
      U.el('span', { class: 'audit-action', text: r.action }),
      U.el('span', { class: 'audit-subject', text: r.subject_type }),
      U.el('span', { class: 'audit-actor', text: r.actor ?? (r.actor_type === 'system' ? 'system' : 'deleted account') }),
      U.el('time', { class: 'audit-when', text: U.relTime(r.created_at), title: new Date(r.created_at).toLocaleString() })
    ])

    // The id is what links a row to the thing it happened to, and it is the
    // one field somebody copies out of this screen.
    const subject = r.subject_id
      ? U.el('button', {
        class: 'audit-subject-id',
        type: 'button',
        title: 'Az alany azonosítójának másolása',
        onclick: () => {
          navigator.clipboard?.writeText(String(r.subject_id))
            .then(() => U.toast('Az alany azonosítója a vágólapon'))
            .catch(() => U.toast('A másolás nem sikerült', 'error'))
        }
      }, [document.createTextNode(String(r.subject_id).slice(0, 8) + '…')])
      : null

    return U.el('div', { class: 'audit-row' }, [head, subject, diff])
  },

  // ---- Roles & permissions (fine-grained RBAC) ----
  async renderRoles (content) {
    let rolesRes, catRes
    try {
      [rolesRes, catRes] = await Promise.all([YumeAPI.admin.roles(), YumeAPI.admin.permissionCatalog()])
    } catch (e) {
      content.replaceChildren(P.errorState('A szerepkörök betöltése nem sikerült: ' + e.message))
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
          U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-1) 0 0;', text: isAdmin ? 'Az admin szerepkörnél mindig minden jogosultság megvan.' : `${total} jogosultságból ${state.granted.size} megadva` })
        ]),
        U.el('input', { class: 'input', placeholder: 'Jogosultságok szűrése…', value: state.filter, oninput: e => { state.filter = e.target.value.toLowerCase(); renderList() } })
      ])
      panel.append(head)

      const liveTotal = catalog.filter(p => p.status === 'active').length
      panel.append(U.el('p', { class: 'perm-legend' }, [
        U.el('span', { class: 'perm-badge perm-badge-live', text: 'LIVE' }),
        document.createTextNode(` — ${liveTotal} jogosultságot érvényesít ma útvonal · `),
        U.el('span', { class: 'perm-badge perm-badge-planned', text: 'tervezett' }),
        document.createTextNode(` — ${total - liveTotal} későbbi modulokhoz van katalogizálva.`)
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
              U.el('span', { class: 'perm-group-title', text: this.PERM_GROUPS[group] ?? group }),
              liveInGroup ? U.el('span', { class: 'perm-live-count', title: `${liveInGroup} jogosultságot érvényesít ma útvonal`, text: `${liveInGroup} él` }) : null,
              U.el('span', { class: 'perm-group-count', text: `${grantedInGroup}/${visible.length}` }),
              isAdmin ? null : U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk(visible, grantedInGroup < visible.length) }, [document.createTextNode(grantedInGroup < visible.length ? 'Mindet megadom' : 'Mindet elveszem')])
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
                    ? U.el('span', { class: 'perm-badge perm-badge-live', title: 'Ma már útvonal érvényesíti', text: 'LIVE' })
                    : U.el('span', { class: 'perm-badge perm-badge-planned', title: 'Egy későbbi modulhoz katalogizálva', text: 'planned' })
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
  /**
   * Emergency controls.
   *
   * The levers an operator pulls when something is going wrong, so the screen
   * is built around two things: saying plainly what is currently held back,
   * and making each pull deliberate.
   *
   * Every control names the file that enforces it. That line is not decoration
   * — this platform has shipped switches that switched nothing, and a control
   * that cannot say where it bites is the next one.
   */
  // ---- látogatottság -------------------------------------------------------
  //
  // Öt kérdés, egy képernyőn, füleken. Nem öt sáv-bejegyzés: mindegyik
  // ugyanarról szól (kik jártak itt és mit csináltak), és öt külön bejegyzés a
  // rálban abból öt különálló dolgot csinálna.
  //
  // Az időtartomány a fejlécben áll, és MINDEN fülre érvényes. Ez azért
  // fontos, mert a leggyakoribb félreolvasás az, amikor a bal oldali szám 7
  // napra, a jobb oldali 30-ra vonatkozik, és senki nem veszi észre.

  ANALYTICS_TABS: [
    ['visitors', 'Látogatók'],
    ['anime', 'Címek'],
    ['search', 'Keresés'],
    ['users', 'Fiókok'],
    ['devices', 'Eszközök'],
    ['performance', 'Teljesítmény']
  ],

  ANALYTICS_RANGES: [
    ['today', 'Ma'], ['yesterday', 'Tegnap'], ['7d', '7 nap'],
    ['30d', '30 nap'], ['90d', '90 nap'], ['365d', 'Egy év']
  ],

  async renderAnalytics (content) {
    const state = {
      tab: this._analyticsTab ?? 'visitors',
      range: this._analyticsRange ?? '7d'
    }

    const draw = async () => {
      this._analyticsTab = state.tab
      this._analyticsRange = state.range
      content.replaceChildren(P.spinner())

      // Fejlécvezérlők: a tartomány egyszer, mindenre.
      if (this._headActions) {
        this._headActions.replaceChildren(
          U.el('div', { class: 'dash-ranges' }, this.ANALYTICS_RANGES.map(([value, label]) =>
            U.el('button', {
              class: 'dash-range' + (state.range === value ? ' active' : ''),
              type: 'button',
              onclick: () => { state.range = value; draw() }
            }, [document.createTextNode(label)])))
        )
      }

      const tabs = U.el('div', { class: 'report-tabs', style: 'margin-bottom:var(--space-4);' },
        this.ANALYTICS_TABS.map(([value, label]) =>
          U.el('button', {
            class: 'report-tab' + (state.tab === value ? ' on' : ''),
            type: 'button',
            onclick: () => { state.tab = value; draw() }
          }, [document.createTextNode(label)])))

      const body = U.el('div')
      content.replaceChildren(tabs, body)
      body.replaceChildren(P.spinner())

      try {
        await this['analytics' + state.tab[0].toUpperCase() + state.tab.slice(1)](body, state.range)
      } catch (e) {
        body.replaceChildren(P.errorState('A kimutatás betöltése nem sikerült: ' + e.message))
      }
    }

    await draw()
  },

  /** Egy szám és az előző, azonos hosszú időszak ugyanaz a száma. */
  analyticsKpi (label, value, previous, { tone = 'blue', icon = '<circle cx="12" cy="12" r="10"/>', suffix = '' } = {}) {
    const now = Number(value) || 0
    const before = Number(previous)
    // Nincs összehasonlítás ≠ nulla változás. Egy friss telepítésen az előző
    // időszak nem „lapos", hanem nem létezik, és ezt ki is írjuk.
    const known = Number.isFinite(before) && before > 0
    const delta = known ? Math.round(((now - before) / before) * 100) : null
    const dir = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
    return U.el('div', { class: 'dash-kpi' }, [
      U.el('span', { class: 'dash-kpi-icon tone-' + tone }, [U.svg(icon, 17)]),
      U.el('div', { class: 'dash-kpi-body' }, [
        U.el('div', { class: 'dash-kpi-value', text: now.toLocaleString(I18n.locale()) + suffix }),
        U.el('div', { class: 'dash-kpi-label', text: label }),
        U.el('div', { class: 'dash-kpi-delta dash-kpi-' + dir }, [
          U.el('span', { class: 'dash-kpi-arrow', text: delta == null ? '—' : (delta > 0 ? '+' : '') + delta + '%' }),
          U.el('span', { class: 'dash-kpi-compare', text: delta == null ? 'nincs mihez mérni' : 'az előző időszakhoz' })
        ])
      ])
    ])
  },

  /** Rövid idő emberi alakban: 0:00-s másodperceket senki nem olvas. */
  analyticsDuration (seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0))
    if (s < 60) return s + ' mp'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} p ${String(s % 60).padStart(2, '0')} mp`
    return `${Math.floor(m / 60)} ó ${String(m % 60).padStart(2, '0')} p`
  },

  /** Egy egyszerű táblázat — érték, szám, arány. */
  analyticsTable (rows, { head = ['', ''], empty = 'Nincs adat.' } = {}) {
    if (!rows.length) return P.emptyState(empty)
    const total = rows.reduce((n, r) => n + (Number(r[1]) || 0), 0) || 1
    const wrap = U.el('div', { class: 'meta-rows' })
    for (const [label, value, extra] of rows) {
      const pct = Math.round((Number(value) || 0) / total * 100)
      wrap.append(U.el('div', { class: 'meta-row backup-row' }, [
        U.el('div', { class: 'meta-row-main' }, [
          U.el('div', { class: 'meta-row-title', text: String(label) }),
          // A sáv a sor alatt: egy arány számként nehezebben olvasható, mint
          // hosszként, és a kettő együtt a legjobb.
          U.el('div', { style: 'height:3px;border-radius:2px;margin-top:6px;background:var(--accent);opacity:.65;width:' + Math.max(2, pct) + '%;' })
        ]),
        U.el('div', { style: 'text-align:right;white-space:nowrap;' }, [
          U.el('div', { style: 'font-variant-numeric:tabular-nums;font-weight:700;', text: Number(value).toLocaleString(I18n.locale()) }),
          U.el('div', { class: 'meta-row-sub', text: extra != null ? String(extra) : pct + '%' })
        ])
      ]))
    }
    return U.el('div', {}, [U.el('div', { class: 'dash-panel-subhead', text: head[0] }), wrap])
  },

  async analyticsVisitors (body, range) {
    const [data, live] = await Promise.all([
      YumeAPI.admin.analytics.visitors(range),
      YumeAPI.admin.analytics.realtime().catch(() => null)
    ])
    const t = data.totals ?? {}
    const p = data.previous ?? {}
    body.replaceChildren()

    if (live) {
      body.append(U.el('div', { class: 'callout', style: 'margin-bottom:var(--space-4);' }, [
        U.el('strong', { text: `${live.live?.online ?? 0} látogató van most itt` }),
        document.createTextNode(
          ` — ebből ${live.live?.signed_in ?? 0} bejelentkezve, ${live.live?.page_views_5m ?? 0} oldalletöltés az elmúlt öt percben.` +
          (live.api?.samples ? ` Az API válaszideje p95 ${live.api.p95_ms} ms.` : ''))
      ]))
    }

    const kpis = U.el('div', { class: 'dash-kpis' }, [
      this.analyticsKpi('Munkamenet', t.sessions, p.sessions, { tone: 'blue', icon: '<path d="M3 12h18"/><path d="M12 3v18"/>' }),
      this.analyticsKpi('Oldalletöltés', t.page_views, p.page_views, { tone: 'violet', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/>' }),
      this.analyticsKpi('Napi átlag látogató', t.avg_daily_visitors, p.avg_daily_visitors, { tone: 'green', icon: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/>' }),
      this.analyticsKpi('Regisztráció', t.registrations, p.registrations, { tone: 'amber', icon: '<path d="M12 5v14"/><path d="M5 12h14"/>' })
    ])
    body.append(kpis)

    // Az egyedi látogató nem adható össze napokon át, és ezt ki kell mondani,
    // különben a „napi átlag" úgy olvasódik, mintha összeg volna.
    body.append(U.el('p', {
      class: 'list-row-sub',
      style: 'margin:0 0 var(--space-4);',
      text:
      'Az egyedi látogatók száma naponta értendő: ugyanaz az ember két napon két látogató, mert a látogatói kulcs naponta cserélődik. ' +
      'Ez szándékos — napokon átívelő követés nélkül a „visszatérő" csak a bejelentkezetteknél pontos.'
    }))

    const days = data.days ?? []
    if (days.length > 1) {
      const labels = days.map(d => this.dayLabel(d.day))
      body.append(this.dashPanel({
        title: 'Forgalom',
        sub: 'Munkamenetek és oldalletöltések naponta',
        body: Charts.lines([
          { name: 'Munkamenet', values: days.map(d => Number(d.sessions)), color: 'var(--accent)' },
          { name: 'Oldalletöltés', values: days.map(d => Number(d.page_views)), color: 'var(--blue-400)' }
        ], { labels, label: 'Napi forgalom', height: 190 })
      }))
    }

    const lower = U.el('div', { class: 'dash-lower' })
    lower.append(this.dashPanel({
      title: 'Mi történt',
      sub: 'Az időszak alatt',
      body: U.el('div', {}, [
        this.analyticsTable([
          ['Belépés', t.logins, null],
          ['Sikertelen belépés', t.failed_logins, null],
          ['Keresés', t.searches, null],
          ['Találat nélküli keresés', t.zero_result_searches, null],
          ['Elindított epizód', t.episode_starts, null],
          ['Befejezett epizód', t.episode_completions, null],
          ['Hiba', t.errors, null]
        ], { head: ['Események'] }),
        U.el('p', {
          class: 'list-row-sub',
          style: 'margin-top:var(--space-3);',
          text:
          `Átlagos látogatáshossz: ${this.analyticsDuration(t.avg_duration_sec)} · ` +
          `összes nézett idő: ${this.analyticsDuration(t.watch_seconds)}`
        })
      ])
    }))
    body.append(lower)
  },

  async analyticsAnime (body, range) {
    const data = await YumeAPI.admin.analytics.anime(range, 50)
    body.replaceChildren()
    if (!data.data?.length) {
      body.append(P.emptyState('Ebben az időszakban egyetlen címhez sem érkezett megtekintés. ' +
        'A napi összesítő óránként frissül — ha most kapcsoltad be a mérést, ez holnap lesz beszédes.'))
      return
    }
    const rows = U.el('div', { class: 'meta-rows' })
    for (const a of data.data) {
      rows.append(U.el('div', { class: 'meta-row backup-row' }, [
        U.el('div', { class: 'meta-row-main' }, [
          U.el('div', { class: 'meta-row-title', text: a.title }),
          U.el('div', {
            class: 'meta-row-sub',
            text:
            `${Number(a.unique_viewers ?? 0).toLocaleString(I18n.locale())} egyedi néző · ` +
            `${Number(a.episode_starts ?? 0)} indítás · ${Number(a.episode_completions ?? 0)} befejezés` +
            (a.completion_pct != null ? ` (${a.completion_pct}%)` : '') +
            ` · ${this.analyticsDuration(a.watch_seconds)} nézve`
          })
        ]),
        U.el('div', { style: 'text-align:right;' }, [
          U.el('div', { style: 'font-variant-numeric:tabular-nums;font-weight:700;', text: Number(a.views ?? 0).toLocaleString(I18n.locale()) }),
          U.el('div', { class: 'meta-row-sub', text: 'megtekintés' })
        ])
      ]))
    }
    body.append(rows)
  },

  async analyticsSearch (body, range) {
    const data = await YumeAPI.admin.analytics.search(range)
    body.replaceChildren()
    const lower = U.el('div', { class: 'dash-lower' })

    lower.append(this.dashPanel({
      title: 'Amire kerestek',
      sub: 'A leggyakoribb kifejezések',
      body: this.analyticsTable(
        (data.top ?? []).slice(0, 20).map(r => [r.term, r.searches, `${r.avg_results ?? 0} találat · ${r.clicks ?? 0} kattintás`]),
        { head: ['Kifejezés'], empty: 'Ebben az időszakban nem kerestek semmire.' })
    }))

    // Ez a leghasznosabb keresési kimutatás: minden sor egy hiányzó cím vagy
    // egy rossz írásmód, amire VAN kereslet.
    lower.append(this.dashPanel({
      title: 'Amire nem volt találat',
      sub: 'Minden sor egy hiányzó cím vagy egy rossz írásmód',
      body: this.analyticsTable(
        (data.zero ?? []).slice(0, 20).map(r => [r.term, r.searches, null]),
        { head: ['Kifejezés'], empty: 'Minden keresés talált valamit.' })
    }))
    body.append(lower)

    const daily = data.daily ?? []
    if (daily.length > 1) {
      body.append(this.dashPanel({
        title: 'Keresések naponta',
        sub: 'Összes és találat nélküli',
        body: Charts.lines([
          { name: 'Keresés', values: daily.map(d => Number(d.searches)), color: 'var(--accent)' },
          { name: 'Találat nélkül', values: daily.map(d => Number(d.zero_result_searches)), color: 'var(--danger)' }
        ], { labels: daily.map(d => this.dayLabel(d.day)), label: 'Keresések', height: 170 })
      }))
    }
  },

  async analyticsUsers (body, range) {
    const data = await YumeAPI.admin.analytics.users(range)
    const t = data.totals ?? {}
    body.replaceChildren()

    body.append(U.el('div', { class: 'dash-kpis' }, [
      this.analyticsKpi('Összes fiók', t.total, null, { tone: 'blue', icon: '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/>' }),
      this.analyticsKpi('Új az időszakban', t.new_in_window, null, { tone: 'green', icon: '<path d="M12 5v14"/><path d="M5 12h14"/>' }),
      this.analyticsKpi('Aktív 30 napban', t.active_30d, t.active_7d, { tone: 'violet', icon: '<circle cx="12" cy="12" r="10"/>' }),
      this.analyticsKpi('Korlátozott', t.restricted, null, { tone: 'amber', icon: '<path d="M12 9v4"/><path d="M12 17h.01"/>' })
    ]))

    // A „30 napban aktív" mellé a 7 napos kerül összehasonlításnak, és ez
    // NEM időbeli változás — ezért ki is írjuk, mert a kártya alatt álló
    // százalék máskülönben trendnek olvasódna.
    body.append(U.el('p', {
      class: 'list-row-sub',
      style: 'margin:0 0 var(--space-4);',
      text:
      `Az elmúlt 7 napban ${t.active_7d ?? 0} fiók lépett be, 30 napban ${t.active_30d ?? 0}. ` +
      `Törölt fiók: ${t.deleted ?? 0}.`
    }))

    const daily = data.daily ?? []
    if (daily.length > 1) {
      body.append(this.dashPanel({
        title: 'Regisztráció és belépés',
        sub: 'Naponta',
        body: Charts.lines([
          { name: 'Regisztráció', values: daily.map(d => Number(d.registrations)), color: 'var(--green-400)' },
          { name: 'Belépés', values: daily.map(d => Number(d.logins)), color: 'var(--accent)' },
          { name: 'Sikertelen belépés', values: daily.map(d => Number(d.failed_logins)), color: 'var(--danger)' }
        ], { labels: daily.map(d => this.dayLabel(d.day)), label: 'Fiókaktivitás', height: 190 })
      }))
    }

    const byDim = dim => (data.devices ?? []).filter(r => r.dimension === dim).map(r => [r.value, r.sessions, null])
    const lower = U.el('div', { class: 'dash-lower' })
    for (const [dim, title] of [['device', 'Eszköz'], ['browser', 'Böngésző'], ['os', 'Operációs rendszer']]) {
      lower.append(this.dashPanel({
        title,
        sub: 'Bejelentkezett és névtelen munkamenetek együtt',
        body: this.analyticsTable(byDim(dim), { head: [title], empty: 'Még nincs mérés.' })
      }))
    }
    body.append(lower)
  },

  async analyticsDevices (body, range) {
    const [device, browser, os, referrer, entry] = await Promise.all([
      YumeAPI.admin.analytics.breakdown('device', range),
      YumeAPI.admin.analytics.breakdown('browser', range),
      YumeAPI.admin.analytics.breakdown('os', range),
      YumeAPI.admin.analytics.breakdown('referrer', range),
      YumeAPI.admin.analytics.breakdown('entry_route', range)
    ])
    body.replaceChildren()
    const lower = U.el('div', { class: 'dash-lower' })
    const panel = (title, sub, data, empty) => this.dashPanel({
      title,
      sub,
      body: this.analyticsTable((data.data ?? []).map(r => [r.value, r.sessions, null]), { head: [title], empty })
    })
    lower.append(panel('Eszköz', 'Munkamenetek eszközosztályonként', device, 'Még nincs mérés.'))
    lower.append(panel('Böngésző', 'Amit valóban használnak', browser, 'Még nincs mérés.'))
    lower.append(panel('Operációs rendszer', '', os, 'Még nincs mérés.'))
    lower.append(panel('Honnan jönnek', 'A hivatkozó gazdagépe, útvonal nélkül', referrer, 'Még nincs mérés.'))
    lower.append(panel('Belépő oldal', 'Ahol a látogatás kezdődött', entry, 'Még nincs mérés.'))
    body.append(lower)
    body.append(U.el('p', {
      class: 'list-row-sub',
      text:
      'A hivatkozóból csak a gazdagépet tároljuk, az útvonalat nem: egy teljes hivatkozó URL keresőkifejezést vagy magánoldal címét is tartalmazhatja.'
    }))
  },

  async analyticsPerformance (body, range) {
    const data = await YumeAPI.admin.analytics.performance(range)
    body.replaceChildren()
    const lower = U.el('div', { class: 'dash-lower' })
    lower.append(this.dashPanel({
      title: 'Mérőszámok',
      sub: 'p95 szerint rendezve',
      body: this.analyticsTable(
        (data.byMetric ?? []).map(m => [m.metric, m.p95, `p50 ${m.p50} ms · p99 ${m.p99} ms · ${m.samples} minta`]),
        { head: ['Mérőszám'], empty: 'Nincs mérés ebben az időszakban.' })
    }))
    lower.append(this.dashPanel({
      title: 'A leglassabb végpontok',
      sub: 'p95, legalább hat mintából',
      body: this.analyticsTable(
        (data.worstRoutes ?? []).map(r => [r.route, r.p95, `${r.samples} minta`]),
        { head: ['Végpont'], empty: 'Nincs végpontonkénti mérés.' })
    }))
    body.append(lower)
  },

  // ---- mentések ------------------------------------------------------------

  /**
   * A mentés kezelése.
   *
   * Az API nem látja a mentések kötetét, és nem is kell látnia: ezek a gombok
   * kérést írnak egy táblába, amit a mentőkonténer ciklusa vesz fel. A válasz
   * ugyanezen a csatornán jön vissza — állapot és a futás naplójának a vége.
   *
   * Ezért frissül magától, amíg fut valami: a kérés nem ebben a kérésben
   * teljesül.
   */
  async renderBackups (content) {
    if (this._backupTimer) { clearTimeout(this._backupTimer); this._backupTimer = null }

    const load = async () => {
      let data
      try {
        data = await YumeAPI.admin.backups()
      } catch (e) {
        content.replaceChildren(P.errorState('A mentések betöltése nem sikerült: ' + e.message))
        return
      }
      content.replaceChildren()
      const { backups = [], requests = [], schedule = {}, offsite, readOnly, busy } = data

      // ---- ütemezés ----
      content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;display:flex;align-items:center;gap:var(--space-4);' }, [
        U.el('div', { style: 'flex-grow:1;' }, [
          U.el('h3', { style: 'margin:0;', text: 'Éjszakai mentés' }),
          U.el('p', {
            style: 'margin:var(--space-1) 0 0;',
            text: schedule.enabled
              ? `Bekapcsolva — minden nap ${schedule.hourUtc}:00 UTC, ${schedule.keepDays} napig megtartva. Minden mentés vissza is áll egy eldobható adatbázisba, különben csak tipp lenne.`
              : 'Kikapcsolva. Amíg így áll, csak az készül, amit innen kérsz.'
          }),
          offsite
            ? null
            : U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-2) 0 0;', text: 'A mentések ezen a gépen élnek. Egy lemezhiba egyszerre viszi az adatbázist és a mentéseit — a másolás máshová a telepítés dolga (BACKUP_SYNC_CMD).' })
        ]),
        U.el('label', { class: 'switch' }, [
          U.el('input', {
            type: 'checkbox',
            ...(schedule.enabled ? { checked: '' } : {}),
            onchange: async e => {
              const enabled = e.target.checked
              const reason = window.prompt(enabled ? 'Miért kapcsolod be?' : 'Miért kapcsolod ki az éjszakai mentést?', '')
              if (!reason || !reason.trim()) { e.target.checked = !enabled; return }
              try {
                await YumeAPI.admin.backupSchedule({ enabled, reason: reason.trim() })
                U.toast(enabled ? 'Éjszakai mentés bekapcsolva' : 'Éjszakai mentés kikapcsolva')
                load()
              } catch (err) { U.toast(err.message, 'error'); e.target.checked = !enabled }
            }
          }),
          U.el('span', { class: 'slider' })
        ])
      ]))

      // ---- most ----
      content.append(U.el('div', { style: 'display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin:var(--space-4) 0;' }, [
        U.el('button', {
          class: 'btn btn-primary btn-sm',
          ...(busy ? { disabled: '' } : {}),
          onclick: async () => {
            const reason = window.prompt('Miért készül most mentés?', 'kézi mentés')
            if (!reason || !reason.trim()) return
            try {
              await YumeAPI.admin.backupNow(reason.trim())
              U.toast('Mentés elindítva')
              load()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('Mentés most')]),
        busy
          ? U.el('span', { class: 'list-row-sub', text: `Fut: ${busy.kind} (#${busy.id}) — a lista magától frissül.` })
          : null
      ]))

      // ---- a legutóbbi kérések ----
      if (requests.length) {
        content.append(U.el('h3', { class: 'detail-section-title', text: 'Legutóbbi kérések' }))
        const rows = U.el('div', { class: 'meta-rows' })
        for (const r of requests.slice(0, 5)) {
          const tone = r.status === 'done' ? 'badge-ok' : r.status === 'failed' ? 'badge-danger' : 'badge-info'
          rows.append(U.el('div', { class: 'meta-row backup-row' }, [
            U.el('div', { class: 'meta-row-main' }, [
              U.el('div', { class: 'meta-row-title', text: `${this.BACKUP_KINDS[r.kind] ?? r.kind}${r.filename ? ' — ' + r.filename : ''}` }),
              U.el('div', { class: 'meta-row-sub', text: `${r.reason}${r.requested_by ? ' · ' + r.requested_by : ''} · ${U.relTime(new Date(r.created_at))}` }),
              r.log
                ? U.el('details', { style: 'margin-top:var(--space-1);' }, [
                  U.el('summary', { class: 'meta-row-sub', text: 'napló' }),
                  U.el('pre', { class: 'meta-row-sub', style: 'white-space:pre-wrap;margin:var(--space-1) 0 0;', text: r.log })
                ])
                : null
            ]),
            U.el('span', { class: 'badge ' + tone, text: this.BACKUP_STATUS[r.status] ?? r.status })
          ]))
        }
        content.append(rows)
      }

      // ---- a mentések ----
      content.append(U.el('h3', { class: 'detail-section-title', text: `Mentések (${backups.length})` }))
      if (!backups.length) {
        content.append(P.emptyState('Még nincs mentés. A „Mentés most" gombbal készíthetsz egyet.'))
      }
      const list = U.el('div', { class: 'meta-rows' })
      for (const b of backups) {
        list.append(U.el('div', { class: 'meta-row backup-row' }, [
          U.el('div', { class: 'meta-row-main' }, [
            U.el('div', { class: 'meta-row-title', text: b.filename }),
            U.el('div', {
              class: 'meta-row-sub',
              text: `${(Number(b.bytes) / 1048576).toFixed(1)} MB · ${new Date(b.taken_at).toLocaleString(I18n.locale())}` +
                (b.verified ? ` · ellenőrizve: ${b.verify_detail ?? ''}` : ' · nem ellenőrzött ezen a leltáron')
            })
          ]),
          U.el('div', { class: 'backup-row-actions' }, [
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              ...(busy ? { disabled: '' } : {}),
              title: 'Visszaállítás egy eldobható adatbázisba — megmondja, jó-e, anélkül hogy bármit kockáztatna',
              onclick: async () => {
                const reason = window.prompt('Miért ellenőrzöd?', 'ellenőrzés')
                if (!reason || !reason.trim()) return
                try {
                  await YumeAPI.admin.backupVerify({ filename: b.filename, reason: reason.trim() })
                  U.toast('Ellenőrzés elindítva')
                  load()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('Ellenőrzés')]),
            U.el('button', {
              class: 'btn btn-danger btn-sm',
              ...(busy ? { disabled: '' } : {}),
              onclick: () => this.restoreDialog(b, readOnly, load)
            }, [document.createTextNode('Visszaállítás')])
          ])
        ]))
      }
      content.append(list)

      // Amíg fut valami, magától frissül. Nem WebSocket: egy mentés percekig
      // tart, és egy nyitott csatorna ehhez sok.
      if (busy) this._backupTimer = setTimeout(() => { if (content.isConnected) load() }, 4000)
    }

    await load()
  },

  BACKUP_KINDS: { backup: 'Mentés', verify: 'Ellenőrzés', restore: 'Visszaállítás' },
  BACKUP_STATUS: { pending: 'várakozik', running: 'fut', done: 'kész', failed: 'elhasalt' },

  /**
   * A visszaállítás ablaka.
   *
   * Két feltétel, és egyik sem formalitás: a példánynak csak olvasható módban
   * kell lennie (visszaállítás közben érkező írás elvész), és a fájlnevet be
   * kell gépelni. Egy legördülőből kiválasztott visszaállítás az a
   * visszaállítás, ami véletlenül történik.
   */
  restoreDialog (backup, readOnly, reload) {
    const confirm = U.el('input', { class: 'input', style: 'width:100%;', placeholder: backup.filename })
    const reason = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Miért állítasz vissza?' })

    const modal = C.modalShell('Visszaállítás — ' + backup.filename, [
      U.el('div', { class: 'callout callout-warn' }, [
        U.el('strong', { text: 'Ez felülírja az éles adatbázist. ' }),
        document.createTextNode(
          'Minden, ami a mentés óta történt — fiókok, könyvtárak, hozzászólások, haladás — eltűnik. ' +
          'A művelet nem vonható vissza, hacsak nincs róla frissebb mentés.')
      ]),
      readOnly
        ? null
        : U.el('div', { class: 'callout' }, [
          U.el('strong', { text: 'Előbb a csak olvasható mód. ' }),
          document.createTextNode('A Biztonság alatt kapcsold be — visszaállítás közben érkező írás vagy elvész, vagy egy félig visszaállított adatbázisba megy, és a kettő közül utólag nem lehet megmondani, melyik történt.')
        ]),
      U.el('div', { class: 'filter-group' }, [
        U.el('label', { text: 'Gépeld be a fájl nevét a megerősítéshez' }), confirm
      ]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Indoklás' }), reason])
    ], async () => {
      if (!readOnly) return U.toast('Előbb kapcsold be a csak olvasható módot', 'error')
      // (a jóváhagyó gomb felirata lent áll át)
      if (confirm.value.trim() !== backup.filename) return U.toast('A fájlnév nem egyezik', 'error')
      if (!reason.value.trim()) return U.toast('Az indoklás kötelező', 'error')
      try {
        await YumeAPI.admin.backupRestore({
          filename: backup.filename, confirm: confirm.value.trim(), reason: reason.value.trim()
        })
        U.toast('Visszaállítás elindítva')
        modal.close()
        reload()
      } catch (e) { U.toast(e.message, 'error') }
    })

    // A közös űrlapablak jóváhagyó gombja „Mentés". Ezen a képernyőn az a szó
    // már foglalt — ott van minden soron, és pont az ellenkezőjét jelenti.
    const submit = modal.querySelector('.btn-primary')
    if (submit) {
      submit.textContent = 'Visszaállítás indítása'
      submit.classList.remove('btn-primary')
      submit.classList.add('btn-danger')
    }
    return modal
  },

  async renderSecurity (content) {
    const load = async () => {
      content.replaceChildren(P.spinner())
      try {
        // The posture is a separate request and must not be able to take the
        // controls down with it: an operator reaching this page mid-incident
        // needs the levers whether or not a check can run.
        const [{ controls, context, engaged, rateLimits }, posture] = await Promise.all([
          YumeAPI.admin.security(),
          YumeAPI.admin.posture().catch(e => ({ error: e }))
        ])
        const stack = AP.stack([])
        content.replaceChildren(stack)

        /*
         * Mi van MOST — a lap legelső eleme.
         *
         * Aki ezt a képernyőt incidens közben nyitja meg, annak először azt
         * kell megtudnia, mi van már bekapcsolva, mielőtt bármit
         * bekapcsolna. Eddig ez egy színes doboz volt; most egy mondat és
         * annyi címke, ahány vezérlő él.
         */
        stack.append(AP.card({
          cls: 'ap-status',
          body: [
            U.el('div', { class: 'ap-row-title' }, [
              document.createTextNode(engaged.length ? 'Vezérlő bekapcsolva' : 'Normál működés'),
              ...(engaged.length
                ? engaged.map(k => AP.tag(controls.find(c => c.key === k)?.label ?? k, 'warn'))
                : [AP.tag('semmi nincs visszatartva', 'ok')])
            ]),
            U.el('div', {
              class: 'ap-row-meta',
              text: `${context?.sessions ?? 0} élő munkamenet · ${context?.hooks ?? 0} bekapcsolt webhook · ` +
                `${context?.runs ?? 0} futó metaadat-passz`
            })
          ]
        }))

        stack.append(this.postureBlock(posture))

        stack.append(AP.section('Vezérlők', {
          note: 'Mindegyik azonnal hat, és mindegyik indoklást kér'
        }))
        for (const c of controls) stack.append(this.securityControl(c, load))

        stack.append(this.rateLimitCard(rateLimits ?? [], load))
        stack.append(this.revokeAllCard(load))
      } catch (e) {
        content.replaceChildren(P.errorState(e.message))
      }
    }
    await load()
  },

  /**
   * A sebességkorlátok, szerkeszthetően.
   *
   * Eddig környezeti változók voltak: az átállításuk újraindítást jelentett —
   * és az az egyetlen pillanat, amikor egy korlátot állítani kell, az az,
   * amikor épp folyik valami. Egy roham közepén, vagy épp fordítva: amikor
   * egy közös cím mögül érkező csoportot zártunk ki.
   *
   * A mentés azonnal hat, nem a gyorsítótár lejártakor. Az indoklás kötelező,
   * mint a vészkapcsolóknál — egy szám, aminek nincs története, egy hónap
   * múlva megmagyarázhatatlan.
   */
  rateLimitCard (rows, reload) {
    const inputs = new Map()
    const box = U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
      U.el('h3', { style: 'margin:0;', text: 'Sebességkorlátok' }),
      U.el('p', {
        class: 'list-row-sub',
        style: 'margin:var(--space-1) 0 var(--space-3);max-width:44rem;',
        text: 'Hány kérést enged egy cím az adott időablakban. A mentés azonnal érvényes, újraindítás nélkül. Az alapérték a telepítésé; ami attól eltér, azt „egyedi" jelöli.'
      })
    ])

    for (const row of rows) {
      const max = U.el('input', { class: 'input', type: 'number', min: '1', step: '1', style: 'width:7rem;', value: String(row.max) })
      const win = U.el('input', { class: 'input', type: 'number', min: '1', step: '1', style: 'width:7rem;', value: String(row.windowSeconds) })
      inputs.set(row.key, { max, win })
      box.append(U.el('div', { class: 'meta-row' }, [
        U.el('div', { class: 'meta-row-main' }, [
          U.el('div', { class: 'meta-row-title', text: row.label ?? row.key }),
          U.el('div', {
            class: 'meta-row-sub',
            text: row.custom
              ? `egyedi · alapérték ${row.defaultMax} / ${row.defaultWindowSeconds} mp`
              : `alapérték (${row.defaultMax} / ${row.defaultWindowSeconds} mp)`
          })
        ]),
        U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);' }, [
          max, U.el('span', { class: 'list-row-sub', text: 'kérés /' }), win, U.el('span', { class: 'list-row-sub', text: 'mp' })
        ])
      ]))
    }

    const reason = U.el('input', { class: 'input', style: 'flex-grow:1;min-width:14rem;', placeholder: 'Miért változik? (kötelező)' })
    box.append(U.el('div', { style: 'display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-3);' }, [
      reason,
      U.el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: async e => {
          const limits = {}
          for (const [key, { max, win }] of inputs) {
            const m = Number(max.value)
            const w = Number(win.value)
            if (!Number.isInteger(m) || m < 1 || !Number.isInteger(w) || w < 1) {
              return U.toast('Minden mező egész szám legyen, legalább 1', 'error')
            }
            limits[key] = { max: m, windowSeconds: w }
          }
          if (!reason.value.trim()) return U.toast('Az indoklás kötelező', 'error')
          e.target.disabled = true
          try {
            await YumeAPI.admin.setRateLimits({ limits, reason: reason.value.trim() })
            U.toast('Sebességkorlátok mentve')
            reload()
          } catch (err) {
            U.toast(err.message, 'error')
          } finally {
            e.target.disabled = false
          }
        }
      }, [document.createTextNode('Mentés')])
    ]))
    return box
  },

  /**
   * What the instance's own checks found.
   *
   * The score is arithmetic — passing weight over applicable weight — and
   * every row says what it inspected, so a reader can go and look at the same
   * thing instead of trusting a colour. That is the whole difference between
   * this and a number somebody made up.
   */
  /** A verdikt magyarul. Az API angol kulcsot ad; a képernyőn nem angol. */
  VERDICT: {
    pass: ['rendben', 'ok'],
    warn: ['figyelmeztetés', 'warn'],
    fail: ['hibás', 'bad'],
    unknown: ['nem tudjuk', 'bad'],
    skipped: ['nem alkalmazható', '']
  },

  /**
   * A biztonsági állapot.
   *
   * A pontszám önmagában a legmagabiztosabb hazugság, amit egy panel mondhat:
   * az operátor elolvassa, hogy 94, és abbahagyja a nézelődést. Ezért a szám
   * mellett mindig ott áll, MIBŐL jött, és minden ellenőrzés kiírja, mit
   * nézett meg — hogy utána lehessen nézni ugyanazt.
   */
  postureBlock (posture) {
    if (posture?.error) {
      return AP.stack([AP.section('Állapot'), C.errorState(posture.error)])
    }
    const { checks = [], summary = {}, generatedAt } = posture ?? {}

    const counts = [
      summary.pass ? AP.tag(`${summary.pass} rendben`, 'ok') : null,
      summary.warn ? AP.tag(`${summary.warn} figyelmeztetés`, 'warn') : null,
      summary.fail ? AP.tag(`${summary.fail} hibás`, 'bad') : null,
      summary.unknown ? AP.tag(`${summary.unknown} nem tudjuk`, 'bad') : null,
      summary.skipped ? AP.tag(`${summary.skipped} nem alkalmazható`) : null
    ].filter(Boolean)

    const head = AP.card({
      body: [
        U.el('div', { class: 'ap-posture' }, [
          U.el('div', { class: 'ap-posture-score' }, [
            U.el('div', { class: 'ap-stat-value', text: summary.score === null ? '—' : `${summary.score}%` }),
            U.el('div', { class: 'ap-stat-label', text: 'biztonsági pontszám' })
          ]),
          U.el('div', { class: 'ap-posture-side' }, [
            U.el('div', { class: 'ap-posture-counts' }, counts),
            U.el('p', {
              class: 'ap-note',
              text: `A teljesített súly az alkalmazható súlyhoz mérve, ${checks.length} ellenőrzésen. ` +
                'Ami itt nem értelmezhető, az nem számít bele — se fel, se le.'
            })
          ])
        ])
      ]
    })

    // Csoportonként, és a csoporton belül a baj elöl: ezért nyitja meg valaki
    // ezt a lapot.
    const order = { fail: 0, unknown: 1, warn: 2, pass: 3, skipped: 4 }
    const sorted = [...checks].sort((a, b) =>
      a.group.localeCompare(b.group) || (order[a.verdict] - order[b.verdict]))

    const rows = []
    let group = null
    for (const check of sorted) {
      if (check.group !== group) {
        group = check.group
        rows.push(AP.section(group))
      }
      const [word, tone] = this.VERDICT[check.verdict] ?? [check.verdict, '']
      rows.push(AP.row({
        lead: U.el('span', { class: 'ap-stat-dot ' + (tone || '') }),
        title: check.title,
        tags: [AP.tag(word, tone)],
        meta: [check.found, check.remedy].filter(Boolean).join(' — '),
        trail: [U.el('code', { class: 'ap-row-value', text: check.looksAt, title: check.looksAt })]
      }))
    }

    return AP.stack([
      AP.section('Állapot', {
        note: generatedAt ? 'Számolva ' + U.relTime(new Date(generatedAt)) : undefined
      }),
      head,
      ...rows
    ])
  },

  securityControl (c, reload) {
    const toggle = U.el('button', {
      class: 'btn btn-sm ' + (c.engaged ? 'btn-primary' : 'btn-secondary'),
      onclick: async () => {
        const next = !c.value
        // A reason, always. These are the changes somebody asks about
        // afterwards, and an audit row saying only what changed answers half
        // the question.
        const reason = window.prompt(
          `${next === c.safe ? 'Release' : 'Engage'} "${c.label}" — why?`,
          next === c.safe ? 'Incident resolved' : '')
        if (!reason || reason.trim().length < 3) return
        try {
          await YumeAPI.admin.setControl(c.key, next, reason.trim())
          U.toast(`${c.label}: ${next === c.safe ? 'released' : 'engaged'}`)
          reload()
        } catch (e) { U.toast(e.message, 'error') }
      }
    }, [document.createTextNode(c.engaged ? 'Release' : 'Engage')])

    return U.el('div', { class: 'sec-control' + (c.engaged ? ' on' : '') }, [
      U.el('div', { class: 'sec-control-main' }, [
        U.el('div', { class: 'sec-control-head' }, [
          U.el('span', { class: 'sec-control-label', text: c.label }),
          U.el('span', { class: 'badge' + (c.engaged ? ' badge-bad' : ''), text: c.engaged ? 'engaged' : 'normal' })
        ]),
        U.el('p', { class: 'sec-control-desc', text: c.description }),
        U.el('code', { class: 'sec-control-where', text: c.enforcedBy, title: c.enforcedBy })
      ]),
      toggle
    ])
  },

  /**
   * Signing everybody out.
   *
   * An action, not a switch, and the only thing on this screen that cannot be
   * undone — so it asks twice, and the second time it asks the operator to
   * type the words rather than hit Enter on a prompt they have stopped
   * reading.
   */
  revokeAllCard (reload) {
    return U.el('div', { class: 'sec-control sec-danger' }, [
      U.el('div', { class: 'sec-control-main' }, [
        U.el('div', { class: 'sec-control-head' }, [
          U.el('span', { class: 'sec-control-label', text: 'Minden munkamenet érvénytelenítése' }),
          U.el('span', { class: 'badge badge-bad', text: 'visszavonhatatlan' })
        ]),
        U.el('p', {
          class: 'sec-control-desc',
          text: 'Minden fiókot kilépet minden eszközről, a tiédet is. Kiszivárgott tokenhez vagy aláírókulcshoz, amiben már nem bízol.'
        }),
        U.el('code', {
          class: 'sec-control-where',
          text: 'sessions revoked and every token_version bumped in one transaction'
        })
      ]),
      U.el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: async () => {
          const reason = window.prompt('Miért jelentkeztetsz ki mindenkit minden eszközről?')
          if (!reason || reason.trim().length < 3) return
          const typed = window.prompt('Ez téged is kijelentkeztet. Írd be: VISSZAVONOM')
          if (typed !== 'VISSZAVONOM') { U.toast('Megszakítva'); return }
          try {
            const { revoked } = await YumeAPI.admin.revokeAllSessions(reason.trim())
            U.toast(`${revoked} sessions revoked — signing you out`)
            reload()
          } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode('Mind érvénytelenítése')])
    ])
  },

  async renderConfig (content) {
    let data
    try {
      data = await YumeAPI.admin.config()
    } catch (e) {
      content.replaceChildren(P.errorState('A beállítások betöltése nem sikerült: ' + e.message))
      return
    }
    content.replaceChildren()

    const settings = data.settings ?? {}
    const applyLive = async () => { await refreshChrome() }

    // If the panel itself has been switched off, say so here rather than
    // letting it be a mystery. The reader is standing inside a room whose door
    // is shut: they can still see it because they hold `settings.system`, and
    // nobody else on the team can.
    const adminFlag = (data.flags ?? []).find(f => f.key === 'page.admin')
    if (adminFlag && !adminFlag.enabled) {
      content.append(U.el('div', { class: 'callout callout-warn' }, [
        U.el('strong', { text: 'Az adminfelület ki van kapcsolva. ' }),
        document.createTextNode(
          'Te azért látod, mert nálad van a settings.system jog — rajtatok kívül senki. Mindenki más, ' +
          'a moderátorokat és a szerkesztőket is beleértve, üres oldalt kap ezen a címen. Az alábbi ' +
          '„Oldalak" résznél kapcsold vissza az „Admin"-t.')
      ]))
    }

    // ---------- global settings ----------
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Általános' }))

    const boolSetting = (key, title, desc) => {
      const on = settings[key] === true
      return U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:var(--space-4);' }, [
        U.el('div', { style: 'flex-grow:1;' }, [U.el('h3', { style: 'margin:0;', text: title }), U.el('p', { style: 'margin:var(--space-1) 0 0;', text: desc })]),
        U.el('label', { class: 'switch' }, [
          U.el('input', {
            type: 'checkbox',
            ...(on ? { checked: '' } : {}),
            onchange: async e => {
              try { await YumeAPI.admin.setSetting(key, e.target.checked); settings[key] = e.target.checked; U.toast('Mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error'); e.target.checked = on }
            }
          }),
          U.el('span', { class: 'slider' })
        ])
      ])
    }
    content.append(
      boolSetting('require_login', 'Belépés kötelező az egész oldalon', 'Minden lap bejelentkezési képernyő mögé kerül (a Beállítások elérhető marad).'),
      boolSetting('registration_open', 'Nyitott regisztráció', 'Bárki létrehozhat új fiókot.')
    )

    const textSetting = (key, title, desc) => U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: title }), U.el('p', { text: desc }),
      U.el('input', {
        class: 'input',
        style: 'min-width:20rem;',
        'aria-label': title,
        value: settings[key] ?? '',
        onchange: async e => {
          try { await YumeAPI.admin.setSetting(key, e.target.value); U.toast('Mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
        }
      })
    ])
    content.append(
      textSetting('site_name', 'Az oldal neve', 'A menü logója mellett és a böngészőfülön jelenik meg.'),
      textSetting('tagline', 'Mottó', 'Rövid leírás, ami több helyen felbukkan.')
    )

    // ---------- nyelv ----------
    // Két külön kérdés, ezért két vezérlő: mi az alapértelmezés, és van-e
    // egyáltalán mit választani. A váltás kikapcsolva nem elrejtés — az
    // onboarding nyelvi lépése és a beállítások nyelvsora is eltűnik, és a
    // /v1/config ugyanezt mondja.
    const langSelect = P.select(
      [['hu', 'Magyar'], ['en', 'English']],
      {
        value: settings.default_language ?? 'hu',
        'aria-label': 'Alapértelmezett nyelv',
        onchange: async e => {
          try { await YumeAPI.admin.setSetting('default_language', e.target.value); U.toast('Alapértelmezett nyelv mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
        }
      }
    )
    content.append(U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:var(--space-4);' }, [
      U.el('div', { style: 'flex-grow:1;' }, [
        U.el('h3', { style: 'margin:0;', text: 'Alapértelmezett nyelv' }),
        U.el('p', { style: 'margin:var(--space-1) 0 0;', text: 'Ezt kapja, aki még nem választott. A böngésző nyelve nem dönt helyette.' })
      ]),
      langSelect
    ]))
    content.append(boolSetting(
      'language_switching',
      'Nyelvváltás engedélyezése',
      'Kikapcsolva mindenki az alapértelmezett nyelvet kapja, és a nyelvválasztó eltűnik az onboardingból és a beállításokból.'
    ))

    // ---------- feature flags ----------
    const flags = data.flags ?? []
    const groups = { page: 'Oldalak', feature: 'Funkciók' }
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

    // Every control in this row is *about a named flag*, and the name is on
    // the row rather than on the control — so a screen reader announced
    // "edit text" twenty-three times on this page with nothing to tell them
    // apart. The label goes on each control.
    const permInput = U.el('input', {
      class: 'input flag-perm' + (state.access === 'permission' ? '' : ' hidden'),
      style: 'min-width:11rem;',
      placeholder: 'jogosultság azonosítója',
      'aria-label': `${f.label}: szükséges jogosultság`,
      value: state.permission ?? ''
    })

    /*
     * Save, and on refusal put the control back where it was.
     *
     * Without the revert the panel showed a state the server never accepted:
     * the switch sat in its new position, the toast scrolled away, and the
     * next reload quietly undid it. In read-only mode — where every write
     * outside this section answers 503 — that turned a whole screen of
     * settings into theatre. `undo` restores exactly the control that was
     * touched; the caller knows which one that is and the save does not.
     */
    const save = async (patch, undo) => {
      try {
        await YumeAPI.admin.setFlag(f.key, patch)
        U.toast(`${f.label} frissítve`)
        await applyLive()
      } catch (e) {
        U.toast(e.message, 'error')
        undo?.()
      }
    }

    const accessSel = U.el('select', {
      class: 'select flag-access',
      'aria-label': `${f.label}: hozzáférés`,
      onchange: async e => {
        const was = state.access
        state.access = e.target.value
        permInput.classList.toggle('hidden', state.access !== 'permission')
        await save(
          { access: state.access, requiredPermission: state.access === 'permission' ? (permInput.value.trim() || 'analytics.view') : null },
          () => {
            state.access = was
            e.target.value = was
            permInput.classList.toggle('hidden', was !== 'permission')
          }
        )
        if (state.access === 'permission' && !permInput.value.trim()) permInput.value = 'analytics.view'
      }
    }, [['public', 'Nyilvános'], ['auth', 'Belépés kell'], ['permission', 'Jogosultsághoz kötött']].map(([v, l]) =>
      U.el('option', { value: v, text: l, ...(state.access === v ? { selected: '' } : {}) })))

    permInput.addEventListener('change', () => {
      const was = state.permission ?? ''
      state.permission = permInput.value.trim() || null
      save({ requiredPermission: state.permission }, () => { state.permission = was || null; permInput.value = was })
    })

    const box = U.el('input', {
      type: 'checkbox',
      'aria-label': `${f.label}: bekapcsolva`,
      ...(f.enabled ? { checked: '' } : {}),
      onchange: e => save({ enabled: e.target.checked }, () => { e.target.checked = !e.target.checked })
    })
    const toggle = U.el('label', { class: 'switch' }, [box, U.el('span', { class: 'slider' })])

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
  VIS_BADGE: { public: ['Nyilvános', 'vis-public'], unlisted: ['Listázatlan', 'vis-unlisted'], hidden: ['Rejtett', 'vis-hidden'] },
  FORMATS: ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'],
  STATUSES: ['NOT_YET_RELEASED', 'RELEASING', 'FINISHED', 'CANCELLED', 'HIATUS'],
  SEASONS: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],

  // =========================================================================
  // Translations — writing the Hungarian catalogue text
  // =========================================================================
  //
  // The catalogue holds 25,703 English synopses and Hungarian ones only exist
  // once somebody writes them. Translating all of it is not going to happen;
  // translating what people actually open is a week of work and covers most of
  // what anyone reads. So the queue is ordered by popularity and the editor
  // works down it — that ordering is the feature, not a detail of the list.
  //
  // Source text sits beside the field being written. Translating from memory
  // of what the English said is how a description ends up describing a
  // different show.

  async renderTranslations (content) {
    const layout = U.el('div', { class: 'cat-layout' })
    const listCol = U.el('div', { class: 'cat-list-col' })
    const editCol = U.el('div', { class: 'cat-edit-col' })
    layout.append(listCol, editCol)
    content.replaceChildren(layout)

    const state = { offset: 0, publishedOnly: true, selected: null }
    const listBox = U.el('div', { class: 'cat-list' })
    const progressBox = U.el('div', { class: 'tr-progress' })

    const toolbar = U.el('div', { class: 'cat-toolbar' }, [
      U.el('label', { class: 'tr-toggle' }, [
        U.el('input', {
          type: 'checkbox',
          checked: '',
          onchange: e => { state.publishedOnly = e.target.checked; state.offset = 0; loadList() }
        }),
        U.el('span', { text: 'Csak a publikáltak' })
      ])
    ])
    listCol.append(progressBox, toolbar, listBox)
    editCol.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-6);', text: 'Válassz egy címet balról, és írd meg hozzá a magyar szöveget.' }))

    const loadProgress = async () => {
      try {
        const p = await YumeAPI.admin.translations.progress()
        const done = p.translated ?? 0
        const target = p.published ?? 0
        const pct = target ? Math.round((done / target) * 100) : 0
        progressBox.replaceChildren(
          U.el('div', { class: 'tr-progress-bar' }, [U.el('span', { style: `width:${pct}%;` })]),
          U.el('div', {
            class: 'tr-progress-text',
            // Measured against published titles, not the whole catalogue: a
            // hidden entry nobody can open is not work anyone is waiting on.
            text: `${target.toLocaleString(I18n.locale())} publikált címből ${done.toLocaleString(I18n.locale())} kapott magyar leírást (${pct}%)`
          }),
          (p.drafts ?? 0) > 0
            ? U.el('div', { class: 'tr-progress-drafts', text: `${p.drafts} átnézetlen gépi piszkozat — jóváhagyásig a látogatók nem látják` })
            : null
        )
      } catch (e) {
        progressBox.replaceChildren(U.el('div', { class: 'tr-progress-text', text: 'A haladás nem tölthető be.' }))
      }
    }

    const loadList = async () => {
      listBox.replaceChildren(P.spinner())
      try {
        const { data, total } = await YumeAPI.admin.translations.queue({
          limit: 30, offset: state.offset, publishedOnly: state.publishedOnly
        })
        listBox.replaceChildren(
          U.el('div', { class: 'cat-count', text: `${total.toLocaleString(I18n.locale())} címhez hiányzik a magyar leírás` })
        )
        if (!data.length) {
          listBox.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Ebben a szűrőben nincs több.' }))
          return
        }
        for (const row of data) listBox.append(rowNode(row))
        if (total > state.offset + data.length) {
          listBox.append(U.el('button', {
            class: 'btn btn-ghost btn-sm',
            style: 'width:100%;margin-top:var(--space-2);',
            onclick: () => { state.offset += 30; loadList() }
          }, [document.createTextNode('Következő 30')]))
        }
      } catch (e) {
        listBox.replaceChildren(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'A sor betöltése nem sikerült: ' + e.message }))
      }
    }

    const rowNode = row => {
      const node = U.el('button', {
        class: 'cat-row' + (state.selected === row.id ? ' active' : ''),
        onclick: () => { state.selected = row.id; openEditor(row); loadList() }
      }, [
        U.el('div', { class: 'cat-row-main' }, [
          U.el('div', { class: 'cat-row-title', text: row.canonical_title }),
          U.el('div', { class: 'cat-row-sub', text: `${(row.popularity ?? 0).toLocaleString(I18n.locale())} · ${row.visibility}` })
        ]),
        // Which half is missing, so a half-done entry is visible as half-done
        // rather than looking identical to an untouched one.
        U.el('div', { class: 'tr-flags' }, [
          U.el('span', { class: 'tr-flag' + (row.has_title ? ' on' : ''), title: 'Cím', text: 'T' }),
          U.el('span', { class: 'tr-flag' + (row.has_synopsis ? ' on' : ''), title: 'Leírás', text: 'D' })
        ])
      ])
      return node
    }

    const openEditor = async row => {
      editCol.replaceChildren(P.spinner())
      let payload
      try {
        payload = await YumeAPI.admin.translations.get(row.id)
      } catch (e) {
        editCol.replaceChildren(U.el('div', { class: 'empty-state', style: 'padding:var(--space-6);', text: 'Nem sikerült betölteni: ' + e.message }))
        return
      }

      const existing = (payload.translations ?? []).find(t => t.language === 'hu') ?? {}
      const titleInput = U.el('input', { class: 'input', maxlength: '500', value: existing.title ?? '', placeholder: payload.source.canonical_title })
      const synopsisInput = U.el('textarea', { class: 'input', rows: '10', maxlength: '8000', placeholder: 'Magyar leírás…' })
      synopsisInput.value = existing.synopsis ?? ''

      const save = U.el('button', { class: 'btn btn-primary btn-sm' }, [document.createTextNode('Magyar szöveg mentése')])
      save.addEventListener('click', async () => {
        save.disabled = true
        try {
          await YumeAPI.admin.translations.put(row.id, 'hu', {
            title: titleInput.value.trim() || null,
            synopsis: synopsisInput.value.trim() || null
          })
          U.toast('Mentve')
          loadProgress()
          loadList()
        } catch (e) {
          U.toast('A mentés nem sikerült: ' + e.message, 'error')
        } finally {
          save.disabled = false
        }
      })

      const remove = existing.title || existing.synopsis
        ? U.el('button', { class: 'btn btn-ghost btn-sm' }, [document.createTextNode('Fordítás törlése')])
        : null
      remove?.addEventListener('click', async () => {
        if (!window.confirm('Törlöd ennek a címnek a magyar szövegét?')) return
        try {
          await YumeAPI.admin.translations.remove(row.id, 'hu')
          U.toast('Törölve')
          openEditor(row)
          loadProgress()
          loadList()
        } catch (e) {
          U.toast('A törlés nem sikerült: ' + e.message, 'error')
        }
      })

      editCol.replaceChildren(U.el('div', { class: 'tr-editor' }, [
        U.el('h3', { class: 'tr-editor-title', text: payload.source.canonical_title }),

        U.el('div', { class: 'tr-field' }, [
          U.el('label', { text: 'Magyar cím' }),
          U.el('p', { class: 'tr-hint', text: 'Leave empty to keep the original title. Most shows are known by their romaji name — only translate a title that genuinely has a Hungarian one.' }),
          titleInput
        ]),

        U.el('div', { class: 'tr-field' }, [
          U.el('label', { text: 'Magyar leírás' }),
          synopsisInput
        ]),

        // The English beside the field, not behind a tab.
        U.el('details', { class: 'tr-source', open: '' }, [
          U.el('summary', { text: 'Eredeti leírás' }),
          U.el('p', { class: 'tr-source-text', text: U.plainDesc(payload.source.synopsis) || '(none)' })
        ]),

        U.el('div', { class: 'tr-actions' }, [save, remove]),

        existing.updated_at
          ? U.el('div', { class: 'tr-meta', text: `Last edited ${U.relTime(existing.updated_at)} · ${existing.source}${existing.approved ? '' : ' · unapproved draft'}` })
          : null
      ]))
    }

    loadProgress()
    loadList()
  },

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
      U.el('input', { class: 'input', placeholder: 'Keresés a katalógusban…', oninput: U.debounce(e => { state.q = e.target.value.trim(); loadList() }) }),
      U.el('select', { class: 'select', 'aria-label': 'Szűrés láthatóság szerint', onchange: e => { state.visibility = e.target.value; loadList() } },
        [['', 'All visibility'], ['public', 'Public'], ['unlisted', 'Unlisted'], ['hidden', 'Hidden']].map(([v, l]) =>
          U.el('option', { value: v, text: l }))),
      can('anime.create') ? U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => openEditor(null) }, [document.createTextNode('+ Új anime')]) : null,
      can('anime.merge') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.selected = null; this.renderCatDuplicates(editCol, can, () => { loadList(); this.renderCatDuplicates(editCol, can, loadList) }) } }, [document.createTextNode('Duplikátumok')]) : null,
      // Az importált katalógus minden epizódja rejtett — ez az oszlop
      // alapértelmezése, nem döntés. 32 000 címet senki nem publikál kézzel,
      // és addig minden részletoldalon az áll, hogy nincs epizódadat.
      can('episode.edit')
        ? U.el('button', {
          class: 'btn btn-ghost btn-sm',
          title: 'Shifttel megnyomva visszarejti őket',
          onclick: e => publishAll(e.shiftKey ? 'hidden' : 'public')
        }, [document.createTextNode('Epizódok publikálása…')])
        : null
    ])

    /**
     * Az egész katalógus epizódjainak publikálása.
     *
     * Nem kérdez rá kétszer, de megmondja előre, hány sort érint, és a
     * visszavonás ugyanitt van egy gombnyomásra ('hidden'), mert ez egy
     * kapcsoló, nem egy törlés.
     */
    const publishAll = async (visibility) => {
      const ok = window.confirm(visibility === 'public'
        ? 'Az összes publikus cím epizódja láthatóvá válik a látogatók számára.\n\n' +
          'Ez csak az epizódsorokat érinti (cím, leírás, kép, dátum) — videóforrást ' +
          'nem tesz elérhetővé, azokat külön kapcsoló engedi.\n\n' +
          'Visszavonható: ugyanez a gomb Shifttel megnyomva visszarejti őket.'
        : 'Az összes epizód visszakerül rejtettbe. A részletoldalakon ismét az ' +
          'fog állni, hogy nincs epizódadat.')
      if (!ok) return
      try {
        const res = await YumeAPI.admin.catalogue.episodeVisibilityAll({ visibility })
        const verb = visibility === 'public' ? 'publikálva' : 'elrejtve'
        U.toast(res.changed ? `${res.changed.toLocaleString(I18n.locale())} epizód ${verb}` : 'Nem volt mit változtatni')
      } catch (e) { U.toast(e.message, 'error') }
    }
    listCol.append(toolbar, listBox)

    const loadList = async () => {
      listBox.replaceChildren(P.spinner())
      try {
        const { data, total } = await YumeAPI.admin.catalogue.list({ q: state.q, visibility: state.visibility, limit: 40 })
        listBox.replaceChildren()
        listBox.append(U.el('div', { class: 'cat-count', text: `${total.toLocaleString()} entries` }))
        if (!data.length) { listBox.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Nincs találat.' })); return }
        for (const a of data) listBox.append(this.catRow(a, state, openEditor))
      } catch (e) {
        listBox.replaceChildren(P.errorState(e.message))
      }
    }

    // ---- editor (null = create) ----
    const openEditor = async (anime) => {
      editCol.replaceChildren(P.spinner())
      let full = anime
      if (anime?.id) { try { full = await YumeAPI.admin.catalogue.get(anime.id) } catch (e) { editCol.replaceChildren(P.errorState(e.message)); return } }
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
      U.el('p', { text: 'Válassz egy animét szerkesztésre, vagy hozz létre újat.' })
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
        U.el('div', { class: 'cat-field-label', text: 'Láthatóság' }),
        U.el('p', { class: 'cat-vis-hint', text: 'A rejtett mindenhonnan eltűnik, a részletoldaláról is. A listázatlan csak közvetlen hivatkozással érhető el.' })
      ]),
      select('visibility', ['public', 'unlisted', 'hidden'])
    ]))

    form.append(U.el('div', { class: 'cat-grid' }, [
      field('Cím', input('canonical_title', { placeholder: 'Kanonikus cím' })),
      field('Formátum', select('format', this.FORMATS)),
      field('Állapot', select('status', this.STATUSES)),
      field('Évad', select('season', this.SEASONS, true)),
      field('Évad éve', input('season_year', { type: 'number', min: 1900, max: 2100 })),
      field('Epizódok (tervezett)', input('episode_count', { type: 'number', min: 0 })),
      field('Epizódhossz (perc)', input('episode_duration', { type: 'number', min: 0 })),
      field('Forrásanyag', input('source_material', { placeholder: 'MANGA, LIGHT_NOVEL…' }))
    ]))
    form.append(field('Synopsis', U.el('textarea', { class: 'input', rows: 4, ...(editable ? {} : { disabled: '' }), oninput: e => { draft.synopsis = e.target.value } }, [document.createTextNode(draft.synopsis)])))
    form.append(U.el('label', { class: 'cat-check' }, [
      U.el('input', { type: 'checkbox', ...(draft.is_adult ? { checked: '' } : {}), ...(editable ? {} : { disabled: '' }), onchange: e => { draft.is_adult = e.target.checked } }),
      U.el('span', { text: 'Felnőtt (NSFW) tartalom' })
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
          if (!draft.canonical_title.trim()) return U.toast('A cím kötelező', 'error')
          try {
            if (isNew) { const c = await YumeAPI.admin.catalogue.create(payload()); U.toast('Anime létrehozva'); onSaved?.(); anime = c } else { await YumeAPI.admin.catalogue.update(anime.id, payload()); U.toast('Mentve'); onSaved?.() }
          } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode(isNew ? 'Create anime' : 'Save changes')]))
      if (!isNew && can('anime.delete')) {
        actions.append(U.el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            if (!confirm(`Delete "${anime.canonical_title}" and all its episodes? This cannot be undone.`)) return
            try { await YumeAPI.admin.catalogue.remove(anime.id); U.toast('Törölve'); onDeleted?.() } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('Törlés')]))
      }
      form.append(actions)
    } else {
      form.append(U.el('div', { class: 'callout', text: 'A katalógushoz csak olvasási jogod van.' }))
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
    wrap.append(U.el('h3', { class: 'detail-section-title', style: 'margin:0 0 var(--space-2);', text: 'Metaadatforrások' }))
    wrap.append(U.el('p', { class: 'cat-vis-hint', text: 'A locked field was set by hand and is never overwritten by the AniList importer. Release it to let automatic updates resume.' }))

    const table = U.el('div', { class: 'prov-table' })
    for (const field of fields) {
      const src = sources[field]
      const isLocked = locked.includes(field)
      table.append(U.el('div', { class: 'prov-row' }, [
        U.el('code', { class: 'prov-field', text: field }),
        U.el('span', { class: 'prov-source', text: src ? [src.provider, src.at ? U.relTime(new Date(src.at)) : null].filter(Boolean).join(' · ') : 'unknown' }),
        isLocked
          ? U.el('span', { class: 'vis-badge vis-hidden', text: 'zárolva' })
          : U.el('span', { class: 'prov-auto', text: 'automatikus' }),
        isLocked && can('anime.edit')
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async e => {
              e.target.disabled = true
              try { await YumeAPI.admin.catalogue.unlock(anime.id, [field]); U.toast(`"${field}" released to the importer`); onSaved?.() } catch (err) { U.toast(err.message, 'error'); e.target.disabled = false }
            }
          }, [document.createTextNode('Kiadás')])
          : null
      ]))
    }
    wrap.append(table)
    form.append(wrap)
  },

  // Duplicate scan. Read-only by design: it proposes pairs and a human with
  // anime.merge confirms each one, because a merge cannot be undone.
  //
  // Two scans, and which one runs is the operator's choice. Identical titles
  // are the default: five times as many pairs and it returns immediately. The
  // similar-title scan compares every title against every other in its year
  // and format, which is a minute of database time on this catalogue — a
  // reasonable thing to ask for and an unreasonable thing to be given for
  // opening a tab.
  async renderCatDuplicates (host, can, reload, mode = 'exact') {
    host.replaceChildren(P.spinner())
    try {
      const { data } = await YumeAPI.admin.catalogue.duplicates({ mode })
      host.replaceChildren()
      const consequence = 'Merging moves titles, synonyms, genres, tags, external ids and library entries onto the entry you keep, then deletes the other one. This cannot be undone.'
      host.append(U.el('p', {
        class: 'cat-vis-hint',
        text: (mode === 'exact'
          ? 'Entries whose titles are identical, whatever year or format each one claims. '
          : 'Entries with near-identical titles in the same year and format. ') + consequence
      }))
      host.append(U.el('div', { class: 'admin-toolbar' }, [
        U.el('button', {
          class: 'btn btn-sm' + (mode === 'exact' ? ' btn-primary' : ''),
          type: 'button',
          onclick: () => this.renderCatDuplicates(host, can, reload, 'exact')
        }, [document.createTextNode('Azonos címek')]),
        U.el('button', {
          class: 'btn btn-sm' + (mode === 'similar' ? ' btn-primary' : ''),
          type: 'button',
          title: 'Minden címet összevet minden mással az évén és formátumán belül — ez nagyjából egy perc',
          onclick: () => this.renderCatDuplicates(host, can, reload, 'similar')
        }, [document.createTextNode('Hasonló címek (lassú)')])
      ]))
      if (!data.length) { host.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Nem találtam valószínű duplikátumot.' })); return }
      for (const d of data) {
        const keep = (winner, loser, title) => can('anime.merge')
          ? U.el('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              if (!confirm(`Keep "${title}" and merge the other entry into it? This cannot be undone.`)) return
              try { await YumeAPI.admin.catalogue.merge(winner, loser); U.toast('Összevonva'); reload() } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Ez maradjon')])
          : null
        host.append(U.el('div', { class: 'dup-pair' }, [
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.a_title }), keep(d.a_id, d.b_id, d.a_title)]),
          U.el('div', { class: 'dup-meta', text: `${(Number(d.similarity) * 100).toFixed(0)}% · ${d.season_year ?? '—'} · ${d.format ?? '—'}` }),
          U.el('div', { class: 'dup-side' }, [U.el('div', { class: 'dup-title', text: d.b_title }), keep(d.b_id, d.a_id, d.b_title)])
        ]))
      }
    } catch (e) {
      host.replaceChildren(P.errorState(e.message))
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
      if (range.trim() && !match) return U.toast('Adj meg egy számot vagy tartományt, például 1-6', 'error')
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
      U.el('h3', { class: 'detail-section-title', style: 'margin:0;', text: 'Epizódok' }),
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('public') }, [document.createTextNode('Publikálás…')]) : null,
      can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk('hidden') }, [document.createTextNode('Visszavonás…')]) : null,
      can('episode.create') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, null, () => load()) }, [document.createTextNode('+ Epizód hozzáadása')]) : null
    ]))
    form.append(wrap)

    const load = async () => {
      wrap.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.catalogue.episodes(anime.id)
        wrap.replaceChildren()
        if (!data.length) { wrap.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Még nincs epizód.' })); return }

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
            // Published with nowhere to play from is the state worth shouting
            // about: from a viewer's side it is a broken link, and from here
            // it is invisible unless the row says so.
            ep.visibility === 'public' && !ep.source_count
              ? U.el('span', { class: 'cat-badge cat-badge-warn', title: 'Ez az epizód publikálva van, de nincs hozzá engedélyezett forrás.', text: 'nincs forrás' })
              : null,
            can('episode.edit')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm',
                title: 'Innen játszik le ez az epizód',
                onclick: () => this.sourcesModal(anime, ep, () => load())
              }, [document.createTextNode(`Sources${ep.source_total ? ` (${ep.source_count}/${ep.source_total})` : ''}`)])
              : null,
            can('episode.edit') ? U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.episodeModal(anime, ep, () => load()) }, [document.createTextNode('Szerkesztés')]) : null,
            can('episode.delete')
              ? U.el('button', {
                class: 'btn btn-ghost btn-sm cat-ep-del',
                onclick: async () => {
                  if (!confirm(`Delete episode ${ep.number}?`)) return
                  try { await YumeAPI.admin.catalogue.removeEpisode(ep.id); U.toast('Epizód törölve'); load() } catch (e) { U.toast(e.message, 'error') }
                }
              }, [document.createTextNode('✕')])
              : null
          ]))
        }
      } catch (e) { wrap.replaceChildren(P.errorState(e.message)) }
    }
    load()
  },

  /**
   * Where one episode plays from.
   *
   * `video_sources` has been in the schema since the beginning and nothing
   * ever wrote to it — it was built for an extension to fill. This is the
   * operator's side of it: any provider, in the order they choose, and a
   * switch that takes a dead link out of playback without losing the record
   * of which episode it belonged to.
   *
   * The platform stores references, never media.
   */
  SOURCE_KINDS: [
    ['http', 'Direct / HLS — an .mp4 or .m3u8 URL'],
    ['embed', 'Embed — a provider\u2019s player page'],
    ['torrent', 'Torrent — magnet link or info hash'],
    ['nzb', 'NZB']
  ],

  sourcesModal (anime, ep, onDone) {
    const list = U.el('div', { class: 'src-list' })
    const draft = { kind: 'http', ref: '', provider: '', resolution: '', variant: '', priority: '' }

    const field = (label, node) => U.el('label', { class: 'cat-field' }, [
      U.el('span', { class: 'cat-field-label', text: label }), node
    ])
    const select = (key, options) => U.el('select', {
      class: 'select',
      onchange: e => { draft[key] = e.target.value }
    }, options.map(([value, text]) => U.el('option', { value, text })))

    const refInput = U.el('input', {
      class: 'input',
      placeholder: 'https://…',
      oninput: e => { draft.ref = e.target.value }
    })

    const load = async () => {
      list.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.catalogue.sources(ep.id)
        list.replaceChildren()
        if (!data.length) {
          list.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Még nincs forrás — ez az epizód nem játszható le.' }))
          return
        }
        for (const src of data) {
          list.append(U.el('div', { class: 'src-row' + (src.enabled ? '' : ' src-row-off') }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: src.provider || src.title || 'Unnamed source' }),
              // The reference itself, truncated by CSS rather than by JS: an
              // operator checking a link needs to see enough of it to
              // recognise it, and how much fits is the column's business.
              U.el('div', { class: 'src-ref', title: src.ref, text: src.ref })
            ]),
            U.el('span', { class: 'src-tag', text: [src.kind, src.resolution ? src.resolution + 'p' : null, src.variant].filter(Boolean).join(' · ') }),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              title: src.enabled ? 'Take this source out of playback' : 'Put it back into playback',
              onclick: async () => {
                try {
                  await YumeAPI.admin.catalogue.updateSource(src.id, { enabled: !src.enabled })
                  await load()
                  onDone?.()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode(src.enabled ? 'Disable' : 'Enable')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                if (!confirm('Törlöd ezt a forrást?')) return
                try {
                  await YumeAPI.admin.catalogue.removeSource(src.id)
                  await load()
                  onDone?.()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
      } catch (e) {
        list.replaceChildren(P.errorState(e.message))
      }
    }

    // ---- skip intervals & subtitle tracks ----
    //
    // Same modal, because they answer the same question — what does this
    // episode need to play well — and splitting them across three screens
    // would mean three round trips to fix one episode.
    const extras = U.el('div')
    const loadExtras = async () => {
      extras.replaceChildren(P.spinner())
      try {
        const [{ data: skips }, { data: subs }] = await Promise.all([
          YumeAPI.admin.catalogue.skips(ep.id),
          YumeAPI.admin.catalogue.subtitles(ep.id)
        ])
        extras.replaceChildren()

        extras.append(U.el('h4', { class: 'src-add-title', text: 'Átugorható szakaszok' }))
        const skipList = U.el('div', { class: 'src-list' })
        if (!skips.length) {
          skipList.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-2);', text: 'Nincs — a lejátszó az AniSkipre támaszkodik.' }))
        }
        for (const seg of skips) {
          skipList.append(U.el('div', { class: 'src-row' }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: seg.kind }),
              U.el('div', { class: 'src-ref', text: `${this.clock(seg.start_sec)} → ${this.clock(seg.end_sec)}` })
            ]),
            U.el('span', { class: 'src-tag', text: seg.submitted_by ?? '' }),
            U.el('span', {}),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                try { await YumeAPI.admin.catalogue.removeSkip(seg.id); await loadExtras() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
        extras.append(skipList)

        const skipDraft = { kind: 'intro', start: '', end: '' }
        extras.append(U.el('div', { class: 'src-add-grid' }, [
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Típus' }),
            U.el('select', { class: 'select', onchange: e => { skipDraft.kind = e.target.value } },
              ['intro', 'outro', 'recap', 'preview'].map(k => U.el('option', { value: k, text: k })))
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Kezdet (mp)' }),
            U.el('input', { class: 'input', type: 'number', step: '0.1', min: '0', oninput: e => { skipDraft.start = e.target.value } })
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Vége (mp)' }),
            U.el('input', { class: 'input', type: 'number', step: '0.1', min: '0', oninput: e => { skipDraft.end = e.target.value } })
          ]),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            style: 'align-self:end;',
            onclick: async () => {
              try {
                await YumeAPI.admin.catalogue.addSkip(ep.id, {
                  kind: skipDraft.kind, start: Number(skipDraft.start), end: Number(skipDraft.end)
                })
                await loadExtras()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Szakasz hozzáadása')])
        ]))

        extras.append(U.el('h4', { class: 'src-add-title', text: 'Feliratsávok' }))
        const subList = U.el('div', { class: 'src-list' })
        if (!subs.length) {
          subList.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-2);', text: 'Itt nincs ilyen.' }))
        }
        for (const track of subs) {
          subList.append(U.el('div', { class: 'src-row' }, [
            U.el('div', { class: 'src-main' }, [
              U.el('div', { class: 'src-provider', text: `${String(track.language).toUpperCase()} · ${track.format}` }),
              U.el('div', { class: 'src-ref', title: track.url ?? track.object_key, text: track.url ?? track.object_key })
            ]),
            U.el('span', { class: 'src-tag', text: track.kind }),
            U.el('span', {}),
            U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                try { await YumeAPI.admin.catalogue.removeSubtitle(track.id); await loadExtras() } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('✕')])
          ]))
        }
        extras.append(subList)

        const subDraft = { language: '', format: 'vtt', url: '' }
        extras.append(U.el('div', { class: 'src-add-grid' }, [
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Nyelv' }),
            U.el('input', { class: 'input', placeholder: 'hu', oninput: e => { subDraft.language = e.target.value } })
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Formátum' }),
            U.el('select', { class: 'select', onchange: e => { subDraft.format = e.target.value } },
              ['vtt', 'srt', 'ass'].map(f => U.el('option', { value: f, text: f })))
          ]),
          U.el('label', { class: 'cat-field' }, [
            U.el('span', { class: 'cat-field-label', text: 'Cím (URL)' }),
            U.el('input', { class: 'input', placeholder: 'https://…', oninput: e => { subDraft.url = e.target.value } })
          ]),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            style: 'align-self:end;',
            onclick: async () => {
              try {
                await YumeAPI.admin.catalogue.addSubtitle(ep.id, subDraft)
                await loadExtras()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Sáv hozzáadása')])
        ]))
      } catch (e) {
        extras.replaceChildren(P.errorState(e.message))
      }
    }

    const backdrop = C.modalShell(`Playback — ${anime.canonical_title}, episode ${Number(ep.number)}`, [
      list,
      U.el('h4', { class: 'src-add-title', text: 'Forrás hozzáadása' }),
      field('Típus', select('kind', this.SOURCE_KINDS)),
      field('Hivatkozás', refInput),
      U.el('div', { class: 'src-add-grid' }, [
        field('Szolgáltató', U.el('input', { class: 'input', placeholder: 'A látogatóknak látszik', oninput: e => { draft.provider = e.target.value } })),
        field('Felbontás', select('resolution', [['', '—'], ['2160', '2160p'], ['1080', '1080p'], ['720', '720p'], ['540', '540p'], ['480', '480p']])),
        field('Hang', select('variant', [['', '—'], ['sub', 'Feliratos'], ['dub', 'Szinkronos'], ['raw', 'Nyers']])),
        field('Prioritás', U.el('input', { class: 'input', type: 'number', placeholder: '0', oninput: e => { draft.priority = e.target.value } }))
      ]),
      U.el('p', { class: 'src-note', text: 'Az alacsonyabb prioritás kerül előbb sorra. A rendszer csak a hivatkozást tárolja — a videót soha.' }),
      extras
    ], async () => {
      if (!draft.ref.trim()) { U.toast('A hivatkozás kötelező', 'error'); return }
      try {
        await YumeAPI.admin.catalogue.addSource(ep.id, {
          kind: draft.kind,
          ref: draft.ref.trim(),
          ...(draft.provider.trim() ? { provider: draft.provider.trim() } : {}),
          ...(draft.resolution ? { resolution: draft.resolution } : {}),
          ...(draft.variant ? { variant: draft.variant } : {}),
          ...(draft.priority !== '' ? { priority: Number(draft.priority) } : {})
        })
        U.toast('Forrás hozzáadva')
        draft.ref = ''
        refInput.value = ''
        await load()
        onDone?.()
      } catch (e) { U.toast(e.message, 'error') }
    })
    load()
    loadExtras()
    return backdrop
  },

  /** Seconds → m:ss, for an interval an operator reads off a player. */
  clock (seconds) {
    const total = Math.round(Number(seconds) || 0)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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
      labelled('Title', inp('title', { placeholder: 'Epizódcím (nem kötelező)' })),
      labelled('Air date', inp('air_date', { type: 'date' })),
      labelled('Duration (min)', inp('duration', { type: 'number', min: 0 })),
      labelled('Synopsis', U.el('textarea', { class: 'input', rows: 3, oninput: e => { d.synopsis = e.target.value } }, [document.createTextNode(d.synopsis)])),
      U.el('div', { style: 'display:flex;gap:var(--space-4);' }, [check('is_filler', 'Filler'), check('is_recap', 'Recap')])
    ], async () => {
      if (d.number === '' || isNaN(Number(d.number))) return U.toast('Érvényes epizódszám kell', 'error')
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
        U.toast(isNew ? 'Episode added' : 'Episode updated'); backdrop.close(); onDone?.()
      } catch (e) { U.toast(e.message, 'error') }
    })
  },

  // ---- Infrastructure: VPS health & service status ----
  LEVEL_DOT: { green: '🟢', yellow: '🟡', red: '🔴', not_configured: '⚪' },
  LEVEL_WORD: { green: 'Rendben', yellow: 'Figyelmeztetés', red: 'Kritikus', not_configured: 'Nincs beállítva' },

  /*
   * A szonda saját magyarázata.
   *
   * A kiszolgáló angolul adja vissza (`probes.ts`), és ez helyes is: az API
   * válasza nem felület. A fordítás itt történik, ahol a szöveg képernyőre
   * kerül — amit nem ismerünk, azt változatlanul kiírjuk, mert egy ismeretlen
   * hibaüzenet angolul is több, mint semmi.
   */
  PROBE_DETAIL: {
    'not configured': 'nincs beállítva',
    'unexpected PING reply': 'váratlan PING-válasz',
    'cluster red': 'a fürt piros',
    'cluster yellow': 'a fürt sárga',
    'no metrics collected yet': 'még nincs mérés'
  },

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

  // ---- themes ----
  //
  // A theme used to be an extension: a package in a store, sandboxed in a
  // worker, asked over a message channel for a list of colours. That is a lot
  // of machinery for twelve hex values, and it meant an operator could not put
  // their own palette in front of their own viewers without publishing one.

  async renderThemes (content) {
    const load = async () => {
      content.replaceChildren(P.spinner())
      try {
        const { data } = await YumeAPI.admin.themes.list()
        this.paintThemes(content, data, load)
      } catch (e) {
        content.replaceChildren(P.errorState('A témák betöltése nem sikerült: ' + e.message))
      }
    }
    await load()
  },

  paintThemes (content, themes, reload) {
    content.replaceChildren()
    content.append(U.el('p', { class: 'meta-note', text: 'The default is what a viewer who has never chosen sees. Changing it does not repaint anyone who has picked their own — that is their choice.' }))

    const grid = U.el('div', { class: 'theme-admin-grid' })
    for (const theme of themes) {
      const card = U.el('div', { class: 'theme-admin-card' + (theme.enabled ? '' : ' theme-admin-off') }, [
        U.el('div', { class: 'theme-admin-head' }, [
          U.el('span', { class: 'theme-admin-swatch', style: `background:${theme.accent ?? 'var(--accent)'};` }),
          U.el('div', { class: 'theme-admin-name' }, [
            U.el('div', { class: 'theme-admin-title', text: theme.name }),
            U.el('div', { class: 'theme-admin-slug', text: `${theme.slug} · ${theme.base}${theme.accent ? '' : ' · stylesheet accent'}` })
          ]),
          theme.is_default ? U.el('span', { class: 'cat-badge cat-badge-default', text: 'alapértelmezett' }) : null,
          theme.built_in ? U.el('span', { class: 'cat-badge', title: 'A telepítés része; átszínezhető és kikapcsolható, de nem törölhető.', text: 'beépített' }) : null
        ]),
        U.el('div', { class: 'theme-admin-actions' }, [
          // An accent is a colour, so the control is a colour picker: typing
          // a hex value by hand is how a theme ends up one character wrong.
          U.el('input', {
            type: 'color',
            class: 'theme-color-input theme-admin-picker',
            value: U.toHex(theme.accent) ?? '#f43f6e',
            title: 'Átszínezés',
            onchange: async e => {
              try {
                await YumeAPI.admin.themes.update(theme.id, { accent: e.target.value })
                U.toast(`${theme.name} recoloured`)
                await reload()
              } catch (err) { U.toast(err.message, 'error') }
            }
          }),
          theme.is_default
            ? null
            : U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                try {
                  await YumeAPI.admin.themes.update(theme.id, { isDefault: true })
                  U.toast(`${theme.name} is now the default`)
                  await reload()
                } catch (err) { U.toast(err.message, 'error') }
              }
            }, [document.createTextNode('Legyen az alapértelmezett')]),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              try {
                await YumeAPI.admin.themes.update(theme.id, { enabled: !theme.enabled })
                await reload()
              } catch (err) { U.toast(err.message, 'error') }
            }
          }, [document.createTextNode(theme.enabled ? 'Disable' : 'Enable')]),
          theme.built_in
            ? null
            : U.el('button', {
              class: 'btn btn-ghost btn-sm cat-ep-del',
              onclick: async () => {
                if (!confirm(`Delete the "${theme.name}" theme?`)) return
                try {
                  await YumeAPI.admin.themes.remove(theme.id)
                  U.toast('Téma törölve')
                  await reload()
                } catch (err) { U.toast(err.message, 'error') }
              }
            }, [document.createTextNode('✕')])
        ])
      ])
      grid.append(card)
    }
    content.append(grid)

    // ---- add one ----
    const draft = { slug: '', name: '', base: 'dark', accent: '#7c5cff' }
    let slugInput
    const field = (label, node) => U.el('label', { class: 'cat-field' }, [
      U.el('span', { class: 'cat-field-label', text: label }), node
    ])
    content.append(
      U.el('h3', { class: 'detail-section-title', text: 'Téma hozzáadása' }),
      U.el('div', { class: 'src-add-grid' }, [
        field('Név', U.el('input', {
          class: 'input',
          placeholder: 'A látogatóknak látszik',
          oninput: e => {
            draft.name = e.target.value
            // The slug follows the name until somebody edits it themselves:
            // it is an identifier, and asking for one is asking a viewer-facing
            // question about a machine-facing field.
            if (!draft.slugTouched) {
              draft.slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
              slugInput.value = draft.slug
            }
          }
        })),
        field('Azonosító', slugInput = U.el('input', {
          class: 'input',
          placeholder: 'my-theme',
          oninput: e => { draft.slugTouched = true; draft.slug = e.target.value }
        })),
        field('Alap', U.el('select', {
          class: 'select',
          onchange: e => { draft.base = e.target.value }
        }, [U.el('option', { value: 'dark', text: 'Sötét' }), U.el('option', { value: 'light', text: 'Világos' })])),
        field('Kiemelőszín', U.el('input', {
          class: 'theme-color-input',
          type: 'color',
          value: '#7c5cff',
          oninput: e => { draft.accent = e.target.value }
        }))
      ]),
      U.el('div', { class: 'admin-toolbar' }, [
        U.el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!draft.name.trim() || !draft.slug.trim()) { U.toast('A név és az azonosító kötelező', 'error'); return }
            try {
              await YumeAPI.admin.themes.create({
                slug: draft.slug.trim(), name: draft.name.trim(), base: draft.base, accent: draft.accent
              })
              U.toast('Téma hozzáadva')
              await reload()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [U.el('span', { text: 'Téma hozzáadása' })])
      ])
    )
  },

  // ---- metadata synchronisation ----
  //
  // Both AniList passes used to live in `scripts/import-anilist.ts`: an
  // operator with SSH ran one and watched it print. Nothing recorded that it
  // had happened, so "is the catalogue current?" had no answer, and an
  // operator without a terminal had no way to ask for one at all.

  METADATA_BARS: [
    ['mapped', 'Leképezve AniListre', 'Leképezés nélkül nincs honnan letölteni.'],
    ['withSynopsis', 'Van leírása', 'Ezt az alap passz tölti.'],
    ['withCover', 'Van borítója', 'Szintén az alap passz.'],
    ['withCast', 'Van szereplőgárdája', 'A mély passz — szereplők és szinkronhangok.'],
    ['withRelations', 'Vannak kapcsolódó címei', 'Folytatások, előzmények, mellékszálak.']
  ],

  /**
   * What is behind the gap, rather than how big it is.
   *
   * The bars above say how many titles have a description. They never said
   * anything about the ones that do not, and those are three different
   * situations with three different answers — one of which is "nothing, this
   * is finished". Reported as counts rather than as bars because they are not
   * shares of the catalogue and drawing them as one would invite adding them
   * up, which is wrong: a title can be in more than one.
   */
  METADATA_GAPS: [
    ['unreachable', 'Még nem elérhető',
      'Csak MAL-azonosítójuk van, így a feltöltő sosem talált rájuk. Egy alap futás ma már előbb megkeresi az AniList-azonosítót.'],
    ['neverAttempted', 'Még nem próbáltuk',
      'Le van képezve, üres, és még egyetlen futás sem ért el hozzájuk. Ez elvégzendő munka.'],
    ['noSynopsisUpstream', 'A forrásnál sincs',
      'Megpróbáltuk, és az AniListen sincs leírás. Nem ennek a láncnak a hiányossága — nincs mit letölteni.'],
    ['withoutEpisodes', 'Egyáltalán nincs epizódja',
      'Nincs epizódsor, tehát a részletoldalon nincs lista, és a lejátszónak sincs mit megnyitnia. Egy részük még nem indult el.']
  ],

  async renderMetadata (content) {
    const state = { timer: null }

    const load = async () => {
      // Stop polling once the admin has navigated away, the same way the
      // infrastructure section does.
      if (!document.body.contains(content)) { clearInterval(state.timer); return }
      try {
        const [data, conflicts] = await Promise.all([
          YumeAPI.admin.metadata.status(),
          YumeAPI.admin.metadata.conflicts()
        ])
        this.paintMetadata(content, data, conflicts, load)
      } catch (e) {
        content.replaceChildren(P.errorState('A metaadat-állapot betöltése nem sikerült: ' + e.message))
        clearInterval(state.timer)
      }
    }

    await load()
    // A run reports every couple of seconds; polling faster than it writes
    // would only cost queries.
    state.timer = setInterval(load, 5_000)
  },

  paintMetadata (content, data, conflicts, reload) {
    const cov = data.coverage ?? {}
    const total = cov.total || 0
    content.replaceChildren()

    // ---- coverage ----
    const bars = U.el('div', { class: 'meta-bars' })
    for (const [key, label, hint] of this.METADATA_BARS) {
      const n = cov[key] ?? 0
      const pct = total ? Math.round(n / total * 100) : 0
      bars.append(U.el('div', { class: 'meta-bar' }, [
        U.el('div', { class: 'meta-bar-head' }, [
          U.el('span', { class: 'meta-bar-label', text: label }),
          U.el('span', { class: 'meta-bar-value', text: `${n.toLocaleString()} / ${total.toLocaleString()} (${pct}%)` })
        ]),
        U.el('div', { class: 'meta-bar-track' }, [U.el('div', { class: 'meta-bar-fill', style: `width:${pct}%;` })]),
        U.el('div', { class: 'meta-bar-hint', text: hint })
      ]))
    }
    content.append(U.el('h3', { class: 'detail-section-title', text: 'Lefedettség' }), bars)

    // ---- what the gap is made of ----
    const gaps = U.el('div', { class: 'meta-gaps' })
    for (const [key, label, hint] of this.METADATA_GAPS) {
      const n = cov[key]
      if (n === undefined) continue // an older server that does not report it
      gaps.append(U.el('div', { class: 'meta-gap' }, [
        U.el('b', { class: 'meta-gap-value', text: Number(n).toLocaleString() }),
        U.el('span', { class: 'meta-gap-label', text: label }),
        U.el('span', { class: 'meta-gap-hint', text: hint })
      ]))
    }
    if (gaps.children.length) {
      content.append(U.el('h3', { class: 'detail-section-title', text: 'Mi hiányzik, és miért' }), gaps)
    }

    // ---- start a run ----
    const active = data.active
    const kind = U.el('select', { class: 'select' }, [
      U.el('option', { value: 'basic', text: 'Alap — leírás, borító, pontszám, műfajok' }),
      U.el('option', { value: 'deep', text: 'Mély — szereplők, stáb, kapcsolódó címek' }),
      // ani.zip rather than AniList, so it is the one pass that does not wait
      // on AniList's rate limit — about five minutes for the catalogue.
      U.el('option', { value: 'artwork', text: 'Grafika — logók, háttérképek, külső azonosítók, magyar címek' })
    ])
    const scope = U.el('select', { class: 'select' }, [
      U.el('option', { value: 'missing', text: 'Csak ami hiányzik' }),
      U.el('option', { value: 'all', text: 'Minden (újraletöltés)' })
    ])
    const limit = U.el('input', { class: 'input', type: 'number', min: '1', placeholder: 'Korlát (nem kötelező)', style: 'max-width:11rem;' })

    const start = U.el('button', {
      class: 'btn btn-primary',
      // One run at a time is enforced by the database, not merely by this
      // button — AniList's rate limit is the reason, and a disabled button is
      // not a rate limiter.
      ...(active ? { disabled: true } : {}),
      onclick: async () => {
        start.disabled = true
        try {
          await YumeAPI.admin.metadata.start({
            kind: kind.value,
            scope: scope.value,
            ...(limit.value ? { limit: Number(limit.value) } : {})
          })
          U.toast('Szinkron sorba állítva')
          await reload()
        } catch (e) {
          U.toast(e.message, 'error')
          start.disabled = false
        }
      }
    }, [U.el('span', { text: 'Szinkron indítása' })])

    content.append(
      U.el('h3', { class: 'detail-section-title', text: 'Szinkron futtatása' }),
      U.el('p', { class: 'meta-note', text: 'Requests are paced to stay inside AniList\u2019s published rate limit, so a full pass takes a while: minutes for the basic pass, hours for the deep one. Only one run at a time.' }),
      U.el('div', { class: 'admin-toolbar' }, [kind, scope, limit, start])
    )

    // ---- the run in flight ----
    if (active) {
      const pct = active.total ? Math.round(active.processed / active.total * 100) : 0
      content.append(U.el('div', { class: 'meta-active' }, [
        U.el('div', { class: 'meta-active-head' }, [
          U.el('span', { class: 'meta-active-title', text: `${active.kind === 'deep' ? 'Deep' : 'Basic'} sync — ${active.status}` }),
          U.el('button', {
            class: 'btn btn-danger',
            onclick: async () => {
              try {
                await YumeAPI.admin.metadata.cancel(active.id)
                // Cooperative, not immediate: the pass stops at its next batch
                // boundary, and saying so is the difference between a button
                // that looks broken and one that is honest.
                U.toast('A jelenlegi köteg után leáll')
                await reload()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [U.el('span', { text: 'Mégse' })])
        ]),
        U.el('div', { class: 'meta-bar-track' }, [U.el('div', { class: 'meta-bar-fill', style: `width:${pct}%;` })]),
        U.el('div', { class: 'meta-bar-hint', text: `${active.processed.toLocaleString()} / ${active.total.toLocaleString()} — ${this.metadataCounts(active)}` })
      ]))
    }

    // ---- history ----
    content.append(U.el('h3', { class: 'detail-section-title', text: 'Korábbi futások' }))
    if (!data.runs?.length) {
      content.append(P.emptyState('Innen még nem futott szinkron.'))
    } else {
      const rows = U.el('div', { class: 'meta-rows' })
      for (const r of data.runs) {
        rows.append(U.el('div', { class: 'meta-row' }, [
          U.el('div', { class: 'meta-row-main' }, [
            U.el('div', { class: 'meta-row-title', text: `${r.kind} · ${r.scope}${r.max_items ? ` · limit ${r.max_items}` : ''}` }),
            U.el('div', { class: 'meta-row-sub', text: this.metadataCounts(r) })
          ]),
          U.el('span', { class: 'meta-status meta-status-' + r.status, text: r.status }),
          U.el('div', { class: 'meta-row-sub', text: (r.started_by ?? 'system') + ' · ' + U.relTime(r.created_at) }),
          // The failure message, when there is one. It is the whole reason to
          // keep a history rather than only a "last run" line.
          r.error ? U.el('div', { class: 'meta-row-error', text: r.error }) : null
        ]))
      }
      content.append(rows)
    }

    // ---- id collisions ----
    //
    // Not errors: AniList splits a show into separate entries far more readily
    // than MyAnimeList does, so two AniList ids sharing one MAL id is the
    // normal shape of a multi-season show. They are shown because the same
    // pairs are where real duplicates in our own catalogue surface.
    // A lista százban maximálva jön; a darabszám a teljes hátralék. A kettő
    // összekeverése azt írta ki, hogy 100 ütközés vár, amikor 679.
    const rows = conflicts?.data ?? []
    const waiting = conflicts?.total ?? rows.length
    content.append(U.el('h3', {
      class: 'detail-section-title',
      text: waiting > rows.length
        ? `Unresolved id collisions (${rows.length} shown of ${waiting})`
        : `Unresolved id collisions (${waiting})`
    }))
    if (!rows.length) {
      content.append(P.emptyState('Nincs, amire nézni kellene.'))
      return
    }
    content.append(U.el('p', { class: 'meta-note', text: 'An importer could not attach one of these ids because another anime already held it. Most are legitimate season splits; the rest are duplicates worth merging.' }))
    const list = U.el('div', { class: 'meta-rows' })
    for (const c of rows) {
      list.append(U.el('div', { class: 'meta-row' }, [
        U.el('div', { class: 'meta-row-main' }, [
          U.el('div', { class: 'meta-row-title', text: `${c.provider}:${c.external_id}` }),
          U.el('div', { class: 'meta-row-sub', text: `${c.anime_title} — already held by ${c.holder_title ?? '(deleted)'}` })
        ]),
        U.el('span', { class: 'meta-row-sub', text: c.seen_count > 1 ? `seen ${c.seen_count}×` : '' }),
        U.el('button', {
          class: 'btn',
          onclick: async () => {
            try {
              await YumeAPI.admin.metadata.resolveConflict(c.id, 'reviewed in the panel')
              await reload()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [U.el('span', { text: 'Megnézettnek jelöl' })])
      ]))
    }
    content.append(list)
  },

  /** The per-kind tallies a run collected, as one readable line. */
  metadataCounts (run) {
    const counts = run.counts ?? {}
    const parts = Object.entries(counts)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${v.toLocaleString()} ${k}`)
    return parts.length ? parts.join(' · ') : 'nothing yet'
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
        content.replaceChildren(P.errorState('A figyelés betöltése nem sikerült: ' + e.message))
        return
      }
      this.paintMonitoring(content, data, state)
    }

    await load()
    state.timer = setInterval(load, 30_000)
  },

  /**
   * Az Infrastruktúra képernyő.
   *
   * Ez volt a panel legzsúfoltabb lapja: tizenegy különböző
   * betűméret–vastagság páros egyetlen képernyőn, mert öt saját
   * komponenscsalád (`mon-card`, `mon-service`, `mon-dep`, `mon-alert`,
   * `mon-trend`) élt egymás mellett, mindegyik a maga méreteivel.
   *
   * Most öt szakasz, mind ugyanabból a készletből: állapot, mérőszámok,
   * szolgáltatások, függőségek, riasztások. A sorrend nem véletlen — ez az a
   * sorrend, ahogy egy incidensben végigmegy rajta az ember: „baj van?",
   * „mi fogyott el?", „mi nem válaszol?", „az mit visz magával?", „mióta?".
   */
  paintMonitoring (content, data, state) {
    const m = data.metrics ?? {}
    const value = key => m[key]?.value ?? null
    const level = key => m[key]?.level ?? null
    // A kiszolgáló zöld/sárga/piros szavakat ad; a készlet ok/warn/bad pöttyöt.
    const tone = lvl => ({ green: 'ok', yellow: 'warn', red: 'bad' })[lvl] ?? null

    const pct = v => v === null ? '—' : v.toFixed(1) + '%'
    const ms = v => v === null ? '—' : Math.round(v) + ' ms'

    const stack = AP.stack([])
    content.replaceChildren(stack)

    // ---- 1. baj van? ----
    const overall = tone(data.level)
    stack.append(AP.card({
      cls: 'ap-status',
      body: [
        U.el('div', { class: 'ap-row', style: 'border:none;background:none;padding:0;' }, [
          U.el('div', { class: 'ap-row-body' }, [
            U.el('div', { class: 'ap-row-title' }, [
              document.createTextNode(this.LEVEL_WORD[data.level] ?? 'Ismeretlen'),
              AP.tag(data.stale ? 'elavult mérés' : 'élő', data.stale ? 'warn' : overall ?? 'info')
            ]),
            U.el('div', {
              class: 'ap-row-meta',
              text: data.stale
                ? 'Nincs friss minta — a figyelő feladat megállt. A lenti értékek elavultak lehetnek.'
                : `Utolsó mérés ${data.collectedAt ? U.relTime(new Date(data.collectedAt)) : 'soha'}.`
            })
          ])
        ])
      ]
    }))

    // ---- 2. mi fogyott el? ----
    stack.append(AP.section('Erőforrások', { note: 'A gép állapota a legutóbbi mintavételkor' }))
    stack.append(AP.grid([
      AP.stat({
        label: 'Processzor',
        value: pct(value('cpu.usage_pct')),
        meta: `terhelés ${(value('cpu.load1') ?? 0).toFixed(2)} · ${(value('cpu.load_per_core') ?? 0).toFixed(2)}/mag`,
        tone: tone(level('cpu.usage_pct'))
      }),
      AP.stat({
        label: 'Memória',
        value: pct(value('mem.used_pct')),
        meta: `${this.fmtBytes(value('mem.used_bytes'))} / ${this.fmtBytes(value('mem.total_bytes'))}`,
        tone: tone(level('mem.used_pct'))
      }),
      AP.stat({
        label: 'Lemez',
        value: pct(value('disk.used_pct')),
        meta: `${this.fmtBytes(value('disk.used_bytes'))} / ${this.fmtBytes(value('disk.total_bytes'))}`,
        tone: tone(level('disk.used_pct'))
      }),
      AP.stat({
        label: 'Lapozófájl',
        value: value('swap.used_pct') === null ? '—' : pct(value('swap.used_pct')),
        // Nulla lapozófájl-használat a jó állapot, és ezt ki is mondjuk: egy
        // „0.0%" magában úgy néz ki, mintha hiányozna valami.
        meta: value('swap.used_pct') === 0 ? 'nincs használatban — így a jó' : 'a beállított méretből',
        tone: tone(level('swap.used_pct'))
      }),
      AP.stat({
        label: 'Hálózat',
        value: this.fmtBps(value('net.rx_bps')),
        meta: `↓ ${this.fmtBps(value('net.rx_bps'))} · ↑ ${this.fmtBps(value('net.tx_bps'))}`,
        tone: tone(level('net.drop_pct'))
      }),
      AP.stat({
        label: 'Hálózati késleltetés',
        value: ms(value('net.latency_ms')),
        meta: 'TCP-kapcsolat körbefordulása',
        tone: tone(level('net.latency_ms'))
      }),
      AP.stat({
        label: 'API-késleltetés',
        value: ms(value('api.latency_ms')),
        meta: 'a /v1/health saját mérése',
        tone: tone(level('api.latency_ms'))
      }),
      AP.stat({
        label: 'Adatbázis-késleltetés',
        value: ms(value('db.latency_ms')),
        meta: 'egy SELECT 1 körbefordulása',
        tone: tone(level('db.latency_ms'))
      }),
      AP.stat({
        label: 'Lemez I/O',
        value: this.fmtBps((value('disk.read_bps') ?? 0) + (value('disk.write_bps') ?? 0)),
        meta: `${Math.round(value('disk.iops') ?? 0)} IOPS · várakozás ${ms(value('disk.await_ms'))}`,
        tone: tone(level('disk.await_ms'))
      }),
      AP.stat({
        label: 'Feladatsor',
        value: String(Math.round(value('queue.pending') ?? 0)),
        meta: `${Math.round(value('queue.dead') ?? 0)} elhasalt feladat`,
        tone: tone(level('queue.pending'))
      }),
      AP.stat({
        label: 'Üzemidő',
        value: this.fmtUptime(value('host.uptime_sec')),
        meta: 'az utolsó újraindítás óta'
      })
    ], { col: '13.5rem', stats: true }))

    // ---- 3. mi nem válaszol? ----
    stack.append(AP.section('Szolgáltatások', { note: 'Amit a kiszolgáló percenként megkérdez' }))
    stack.append(AP.list((data.services ?? []).map(svc => AP.row({
      lead: U.el('span', { class: 'ap-stat-dot ' + (tone(svc.status) ?? '') }),
      title: svc.service,
      meta: (svc.detail && (this.PROBE_DETAIL[svc.detail] ?? svc.detail)) ?? this.LEVEL_WORD[svc.status] ?? svc.status,
      value: svc.latency_ms === null || svc.latency_ms === undefined ? null : Math.round(svc.latency_ms) + ' ms'
    }))))

    // ---- 4. az mit visz magával? ----
    stack.append(AP.section('Függőségek', { note: 'Mi áll meg, ha egy szolgáltatás elesik' }))
    const statusOf = Object.fromEntries((data.services ?? []).map(svc => [svc.service, svc.status]))
    stack.append(AP.grid((data.dependencies ?? []).map(dep => {
      const st = statusOf[dep.service] ?? 'not_configured'
      return AP.card({
        title: dep.service,
        actions: [
          AP.tag(dep.required ? 'kötelező' : 'választható', dep.required ? 'accent' : ''),
          AP.tag(this.LEVEL_WORD[st] ?? st, tone(st) ?? '')
        ],
        body: [U.el('ul', { class: 'ap-bullets' }, dep.provides.map(what => U.el('li', { text: what })))]
      })
    }), { col: '18rem' }))

    // ---- 5. mióta? ----
    const alertsBox = U.el('div', { class: 'ap-stack' })
    stack.append(alertsBox)
    YumeAPI.admin.monitoring.alerts().then(({ active, history }) => {
      alertsBox.replaceChildren(AP.section('Riasztások', {
        note: 'Egy küszöb átlépése önmagában még nem riasztás — tartósnak kell lennie'
      }))
      if (!active.length) {
        alertsBox.append(AP.empty(
          'Most semmi nem szól',
          history.length
            ? 'Volt már riasztás ezen a példányon; a legutóbbiak lent.'
            : 'Eddig egyetlen riasztás sem futott le.'))
      }
      for (const a of active) {
        alertsBox.append(AP.row({
          lead: U.el('span', { class: 'ap-stat-dot ' + (a.severity === 'critical' ? 'bad' : 'warn') }),
          title: a.subject,
          tags: [AP.tag(a.severity === 'critical' ? 'kritikus' : 'figyelmeztetés', a.severity === 'critical' ? 'bad' : 'warn')],
          meta: [
            a.value !== null && a.value !== undefined ? `mért érték ${Number(a.value).toFixed(1)}` : null,
            a.threshold !== null && a.threshold !== undefined ? `küszöb ${Number(a.threshold)}` : null,
            a.detail
          ].filter(Boolean).join(' · ') || undefined,
          value: U.relTime(new Date(a.started_at)) + ' óta'
        }))
      }
      const resolved = history.filter(h => h.status === 'resolved').slice(0, 5)
      if (resolved.length) {
        alertsBox.append(AP.section('Nemrég megoldva'))
        alertsBox.append(AP.list(resolved.map(h => AP.row({
          title: h.subject,
          value: h.resolved_at ? U.relTime(new Date(h.resolved_at)) : ''
        }))))
      }
    }).catch(() => alertsBox.replaceChildren())

    // ---- komponensek és diagnosztika ----
    const compBox = U.el('div')
    stack.append(compBox)
    this.renderComponents(compBox)

    const diagBox = U.el('div')
    stack.append(diagBox)
    this.renderDiagnostics(diagBox)

    // ---- 24 óra ----
    stack.append(AP.section('Utolsó 24 óra', { note: 'Óránkénti összesítőből' }))
    const trends = AP.grid([], { col: '16rem' })
    stack.append(trends)
    for (const [metric, label, max] of [
      ['cpu.usage_pct', 'Processzor %', 100],
      ['mem.used_pct', 'Memória %', 100],
      ['api.latency_ms', 'API-késleltetés (ms)', null],
      ['db.latency_ms', 'Adatbázis-késleltetés (ms)', null]
    ]) {
      const box = AP.card({ title: label, body: [P.spinner()] })
      trends.append(box)
      YumeAPI.admin.monitoring.history(metric, 24).then(res => {
        const values = (res.points ?? []).map(point => point.value)
        box.replaceChildren(...AP.card({
          title: label,
          body: [values.length
            ? Charts.sparkline(values, { label, max })
            : U.el('div', { class: 'ap-stat-meta', text: 'még nincs mérés' })]
        }).childNodes)
      }).catch(() => {
        box.replaceChildren(...AP.card({
          title: label,
          body: [U.el('div', { class: 'ap-stat-meta', text: 'nem elérhető' })]
        }).childNodes)
      })
    }
  },

  // ---- components: what the platform is made of, and what breaks with what ----

  COMPONENT_DOT: { operational: '🟢', degraded: '🟡', down: '🔴', unknown: '⚪' },

  /**
   * The dependency graph, laid out by depth.
   *
   * Columns are "how far from the foundation": the database sits alone on the
   * left, everything that stands on it in the next column, and so on. That is
   * the shape an operator needs when several rows are red — it says which one
   * to fix first, because fixing anything to its right will not help.
   *
   * Every card says what its status was measured from. A component that
   * cannot be measured says `unknown`, and the page says so rather than
   * rounding it up to green.
   */
  async renderComponents (box) {
    box.replaceChildren(
      U.el('h2', { class: 'detail-section-title', text: 'Komponensek és függőségi gráf' }),
      P.spinner()
    )
    let data
    try {
      data = await YumeAPI.admin.monitoring.components()
    } catch (e) {
      box.replaceChildren(U.el('h2', { class: 'detail-section-title', text: 'Komponensek és függőségi gráf' }), C.errorState(e))
      return
    }

    const { components = [], summary = {} } = data
    const byId = new Map(components.map(c => [c.id, c]))

    // Depth = longest path to something with no dependencies. Longest rather
    // than shortest so a component always sits to the right of everything it
    // needs, however many ways there are to reach it.
    const depthOf = (id, seen = new Set()) => {
      if (seen.has(id)) return 0 // a cycle would otherwise never terminate
      seen.add(id)
      const deps = byId.get(id)?.dependsOn ?? []
      return deps.length ? 1 + Math.max(...deps.map(d => depthOf(d, new Set(seen)))) : 0
    }

    const columns = []
    for (const c of components) {
      const d = depthOf(c.id)
      ;(columns[d] ??= []).push(c)
    }

    box.replaceChildren(U.el('h2', { class: 'detail-section-title', text: 'Komponensek és függőségi gráf' }))
    box.append(U.el('div', { class: 'comp-summary' }, [
      U.el('span', { class: 'tone-green', text: `${summary.operational ?? 0} operational` }),
      summary.degraded ? U.el('span', { class: 'tone-amber', text: `${summary.degraded} degraded` }) : null,
      summary.down ? U.el('span', { class: 'tone-red', text: `${summary.down} down` }) : null,
      summary.unknown ? U.el('span', { text: `${summary.unknown} not measurable` }) : null
    ]))

    const graph = U.el('div', { class: 'comp-graph' })
    columns.forEach((column, depth) => {
      graph.append(U.el('div', { class: 'comp-column' }, [
        U.el('div', {
          class: 'comp-column-label',
          text: depth === 0 ? 'Foundation' : `Depends on ${depth} layer${depth === 1 ? '' : 's'}`
        }),
        ...column.map(c => this.componentCard(c, byId))
      ]))
    })
    box.append(graph)
  },

  componentCard (c, byId) {
    const name = id => byId.get(id)?.name ?? id
    return U.el('div', { class: 'comp-card s-' + c.status }, [
      U.el('div', { class: 'comp-card-head' }, [
        U.el('span', { class: 'comp-dot', text: this.COMPONENT_DOT[c.status] ?? '⚪' }),
        U.el('span', { class: 'comp-name', text: c.name }),
        U.el('code', { class: 'comp-id', text: c.id, title: `errors from here are coded ${c.errorPrefix}-<status>` })
      ]),
      U.el('div', { class: 'comp-detail', text: c.detail }),
      c.dependsOn.length
        ? U.el('div', { class: 'comp-edge', text: '↳ needs ' + c.dependsOn.map(name).join(', ') })
        : null,
      // The two lines that make the graph worth drawing rather than listing.
      c.failingDependencies.length
        ? U.el('div', { class: 'comp-edge comp-blocked', text: '⚠ blocked by ' + c.failingDependencies.map(name).join(', ') })
        : null,
      c.affects.length
        ? U.el('div', { class: 'comp-edge comp-blast', text: '→ would affect ' + c.affects.map(name).join(', ') })
        : null,
      U.el('code', { class: 'comp-measured', text: c.measuredBy, title: c.measuredBy })
    ])
  },

  // ---- diagnostics: admin-triggered, bounded benchmarks ----
  DIAG_LABEL: { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' },

  async renderDiagnostics (box) {
    box.replaceChildren(U.el('h2', { class: 'detail-section-title', text: 'Diagnosztika' }))

    const output = U.el('div', { class: 'mon-diag-output' })
    const runBtn = U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => run() }, [document.createTextNode('Diagnosztika futtatása')])
    box.append(U.el('div', { class: 'mon-diag-head' }, [
      U.el('p', { class: 'mon-diag-note', text: 'Kontrollált mérések rögzített idő-, memória- és lemezkerettel. A workerben futnak, soha nem a kérés útvonalán.' }),
      runBtn
    ]), output)

    const paint = report => {
      output.replaceChildren()
      if (!report) { output.append(U.el('div', { class: 'mon-trend-empty', text: 'Még nem futott diagnosztika.' })); return }
      if (report.status === 'running') { output.append(P.spinner()); return }
      if (report.status === 'failed') {
        output.append(P.errorState(report.error || 'The diagnostic run failed.'))
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
        output.replaceChildren(U.el('div', { class: 'callout', text: 'Még sorban áll — fut a worker? A diagnosztika a worker folyamatában fut.' }))
        runBtn.disabled = false; runBtn.textContent = 'Run diagnostic'
        return
      }
      setTimeout(() => poll(id, attempt + 1), 3000)
    }

    const run = async () => {
      runBtn.disabled = true
      runBtn.textContent = 'Running…'
      output.replaceChildren(P.spinner())
      try {
        const { id } = await YumeAPI.admin.monitoring.runDiagnostic()
        poll(id)
      } catch (e) {
        output.replaceChildren(P.errorState(e.message))
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

  // ---- overview ----
  //
  // The old one was ten bare numbers, a bar list and five error titles. It
  // answered "how many" and nothing else — not whether a number was moving,
  // not what happened recently, not whether the machine underneath was well.
  //
  // Everything drawn here is measured. Where a comparison exists the server
  // computed it against a real earlier value; where one does not — pending
  // jobs, dead jobs — the card says so rather than showing a percentage
  // somebody would act on. A dashboard that invents a trend is worse than one
  // that omits it, because it gets believed.

  KPI_ART: {
    users: ['blue', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'],
    users_new: ['green', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>'],
    active: ['teal', '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'],
    anime: ['rose', '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'],
    episodes: ['violet', '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>'],
    playable: ['green', '<polygon points="6 3 20 12 6 21 6 3"/>'],
    comments: ['blue', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'],
    reports: ['amber', '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>'],
    watched: ['violet', '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/>'],
    finished: ['green', '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'],
    jobs_pending: ['amber', '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'],
    jobs_dead: ['red', '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>']
  },

  /** How often the screen refreshes itself while it is open. */
  DASH_REFRESH_MS: 60_000,

  async renderOverview (content) {
    const state = {
      days: Number(window.localStorage?.getItem('yume-admin-days')) || 7,
      timer: null,
      updatedAt: null
    }

    const load = async () => {
      // Stop once the admin has navigated away, the same way the other live
      // sections do.
      if (!document.body.contains(content)) { clearInterval(state.timer); return }
      try {
        // The health panel needs a permission this section does not: an
        // analyst can see the dashboard without being able to see the VPS.
        // So it is fetched separately and its absence is not an error.
        const [data, health] = await Promise.all([
          YumeAPI.admin.dashboard(state.days),
          YumeAPI.admin.monitoring.current().catch(() => null)
        ])
        state.updatedAt = new Date()
        this.paintOverview(content, data, health, state, load)
      } catch (e) {
        content.replaceChildren(P.errorState('Az áttekintés betöltése nem sikerült: ' + e.message))
        clearInterval(state.timer)
      }
    }

    await load()
    state.timer = setInterval(load, this.DASH_REFRESH_MS)
  },

  paintOverview (content, data, health, state, reload) {
    content.replaceChildren()

    // ---- heading controls: the window everything is measured over ----
    if (this._headActions) {
      const chip = days => U.el('button', {
        class: 'dash-range' + (state.days === days ? ' active' : ''),
        type: 'button',
        onclick: () => {
          state.days = days
          try { window.localStorage?.setItem('yume-admin-days', String(days)) } catch (e) { /* private mode */ }
          reload()
        }
      }, [document.createTextNode(days + 'd')])

      const span = U.el('span', { class: 'dash-daterange' }, [
        U.svg('<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>', 14),
        U.el('span', { text: `${this.dayLabel(data.range.from)} – ${this.dayLabel(data.range.to)}` })
      ])

      this._headActions.replaceChildren(
        span,
        U.el('div', { class: 'dash-ranges' }, [chip(7), chip(14), chip(30)]),
        U.el('span', {
          class: 'dash-live',
          title: `${Math.round(this.DASH_REFRESH_MS / 1000)} másodpercenként frissül`
        }, [
          U.el('span', { class: 'dash-live-dot' }),
          document.createTextNode(state.updatedAt ? 'Frissítve ' + U.relTime(state.updatedAt) : 'Élő')
        ])
      )
    }

    // ---- the numbers ----
    /*
     * A mérőszámok.
     *
     * Ikon nélkül. Eddig minden kártya bal szélén ült egy színes ikoncsempe,
     * és tizenkét kártyánál tizenkét csempe többet mondott magáról, mint a
     * számokról — miközben egyik sem árult el semmit, amit a címke ne
     * mondana el pontosabban.
     */
    content.append(AP.grid(data.kpis.map(kpi => U.el('div', { class: 'ap-card' }, [
      U.el('div', { class: 'ap-stat' }, [
        U.el('div', { class: 'ap-stat-label', text: kpi.label }),
        U.el('div', { class: 'ap-stat-value', text: this.kpiValue(kpi) }),
        this.kpiDelta(kpi)
      ])
    ])), { col: '13.5rem' }))

    // ---- what moved ----
    content.append(AP.section('Mi mozdult', { note: 'Napi bontásban, a fenti időszakra' }))

    const labels = data.series.users.map(row => this.dayLabel(row.day))
    const charts = U.el('div', { class: 'dash-charts' })

    charts.append(this.dashPanel({
      title: 'Felhasználói aktivitás',
      sub: 'Napi belépések',
      body: Charts.lines(
        [{ name: 'Aktív', values: data.series.users.map(r => Number(r.active)), color: 'var(--accent)' }],
        { labels, label: 'Napi aktív felhasználók', height: 190 }
      )
    }))

    const contentSeries = [
      { name: 'Anime', values: data.series.content.map(r => Number(r.anime)), color: 'var(--accent)' },
      { name: 'Epizód', values: data.series.content.map(r => Number(r.episodes)), color: 'var(--blue-400)' },
      { name: 'Hozzászólás', values: data.series.content.map(r => Number(r.comments)), color: 'var(--green-400)' }
    ]
    charts.append(this.dashPanel({
      title: 'Tartalmi aktivitás',
      sub: 'Naponta hozzáadott sorok',
      legend: contentSeries,
      body: Charts.lines(contentSeries, { labels, label: 'Naponta hozzáadott tartalom', height: 190, area: false })
    }))

    if (health) charts.append(this.healthPanel(health))
    content.append(charts)

    // ---- what is happening ----
    content.append(AP.section('Mi kér figyelmet', { note: 'Hibák, friss műveletek, háttérfeladatok' }))

    const lower = U.el('div', { class: 'dash-lower' })
    lower.append(this.errorPanel(data, reload))
    lower.append(this.activityPanel(data.activity))
    lower.append(this.jobPanel(data.jobs))
    content.append(lower)

    if (data.trending?.length) {
      const max = Number(data.trending[0].trending) || 1
      content.append(this.dashPanel({
        title: 'Most felkapott',
        sub: 'A statisztikai worker által számolt felkapottsági pontszám szerint',
        body: U.el('div', { class: 'genre-bars' }, data.trending.map(t => U.el('div', { class: 'genre-bar' }, [
          U.el('span', { class: 'genre-name', text: t.canonical_title, title: t.canonical_title }),
          U.el('div', { class: 'genre-track' }, [
            U.el('div', { class: 'genre-fill', style: `width:${Number(t.trending) / max * 100}%;` })
          ]),
          U.el('span', { class: 'genre-count', text: String(t.trending) })
        ])))
      }))
    }
  },

  /** A titled card. Every panel on this screen is one, so they line up. */
  dashPanel ({ title, sub, body, action = null, badge = null, legend = null, wide = false }) {
    return U.el('div', { class: 'dash-panel' + (wide ? ' dash-panel-wide' : '') }, [
      U.el('div', { class: 'dash-panel-head' }, [
        U.el('div', { class: 'dash-panel-titles' }, [
          U.el('div', { class: 'dash-panel-title', text: title }),
          sub ? U.el('div', { class: 'dash-panel-sub', text: sub }) : null
        ]),
        badge,
        legend
          ? U.el('div', { class: 'dash-legend' }, legend.map(line => U.el('span', { class: 'dash-legend-item' }, [
            U.el('span', { class: 'dash-legend-dot', style: `background:${line.color};` }),
            document.createTextNode(line.name)
          ])))
          : null,
        action
      ]),
      body
    ])
  },

  kpiValue (kpi) {
    if (kpi.unit === 'hours') return Number(kpi.value).toLocaleString() + 'h'
    return Number(kpi.value).toLocaleString()
  },

  /**
   * The comparison line under a number.
   *
   * Four different things can be true and they read differently: it moved by a
   * percentage, it appeared from nothing, it is unchanged, or there is nothing
   * to compare against. The last one is the important one — it is what stops
   * the card claiming a trend the server never measured.
   */
  kpiDelta (kpi) {
    if (kpi.compare === null) {
      return U.el('div', { class: 'ap-stat-delta flat', text: 'jelenlegi állás' })
    }
    if (kpi.delta === null) {
      // Az előző időszakban nulla volt, most nem: a százalék végtelen lenne.
      return U.el('div', { class: 'ap-stat-delta up', text: `új — ${kpi.compare} alatt egy sem` })
    }
    const dir = kpi.delta > 0 ? 'up' : kpi.delta < 0 ? 'down' : 'flat'
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
    return U.el('div', { class: 'ap-stat-delta ' + dir }, [
      U.el('span', { text: `${arrow} ${Math.abs(kpi.delta)}%` }),
      U.el('span', { class: 'ap-stat-delta-note', text: kpi.compare + ' alatt' })
    ])
  },

  dayLabel (day) {
    const date = new Date(day)
    // A böngésző nyelve helyett a felületé: a panel magyar, a hónapnevek is
    // azok legyenek.
    return date.toLocaleDateString(I18n.locale(), { month: 'short', day: 'numeric' })
  },

  // ---- system health ----

  /** The metrics worth a line on the overview, in the order they matter. */
  HEALTH_ROWS: [
    ['db.latency_ms', 'Adatbázis', 'egy SELECT 1 körbefordulása', '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'],
    ['api.latency_ms', 'API', 'a /v1/health saját mérése', '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
    ['cpu.usage_pct', 'Processzor', 'tartós terhelés', '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'],
    ['mem.used_pct', 'Memória', 'a MemAvailable alapján', '<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M7 8V6M12 8V6M17 8V6"/>'],
    ['disk.used_pct', 'Lemez', 'a fájlrendszerből használt', '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11"/><path d="M6 16h.01"/>'],
    ['queue.pending', 'Feladatsor', 'futtatható feladatok', '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'],
    ['queue.dead', 'Elhasalt feladatok', 'elfogytak a próbálkozásaik', '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>']
  ],

  /** The icon for a probed service, by what it is. */
  SERVICE_ICON: {
    postgres: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    api: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    worker: '<circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v10M4.2 4.2l4.3 4.3m7 7 4.3 4.3M1 12h6m6 0h10M4.2 19.8l4.3-4.3m7-7 4.3-4.3"/>',
    redis: '<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M7 8V6M12 8V6M17 8V6"/>',
    caddy: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>'
  },

  healthPanel (health) {
    const metrics = health.metrics ?? {}
    const rows = U.el('div', { class: 'dash-health' })

    for (const [key, label, sub, icon] of this.HEALTH_ROWS) {
      const metric = metrics[key]
      if (!metric) continue
      rows.append(U.el('div', { class: 'dash-health-row' }, [
        U.el('span', { class: 'dash-health-icon' }, [U.svg(icon, 14)]),
        U.el('div', { class: 'dash-health-main' }, [
          U.el('div', { class: 'dash-health-label', text: label }),
          U.el('div', { class: 'dash-health-sub', text: sub })
        ]),
        U.el('span', { class: 'dash-health-value', text: this.healthValue(metric) }),
        U.el('span', { class: 'dash-dot dash-dot-' + (metric.level ?? 'green') })
      ]))
    }

    // The services the monitor probes. A number being fine while a service is
    // down is exactly the case a metrics-only panel misses.
    //
    // Deployments that were never configured are left out: this platform ships
    // with optional dependencies it does not use, and four rows of "not
    // configured" push the ones that matter off the panel. The Infrastructure
    // section lists every probe, configured or not.
    for (const service of (health.services ?? []).filter(s => s.status !== 'not_configured')) {
      rows.append(U.el('div', { class: 'dash-health-row' }, [
        U.el('span', { class: 'dash-health-icon' }, [
          U.svg(this.SERVICE_ICON[service.service] ?? '<circle cx="12" cy="12" r="9"/>', 14)
        ]),
        U.el('div', { class: 'dash-health-main' }, [
          U.el('div', { class: 'dash-health-label', text: service.service }),
          U.el('div', { class: 'dash-health-sub', text: (service.detail && (this.PROBE_DETAIL[service.detail] ?? service.detail)) || 'válaszol' })
        ]),
        U.el('span', {
          class: 'dash-health-value',
          text: service.latency_ms === null || service.latency_ms === undefined ? '—' : Math.round(service.latency_ms) + 'ms'
        }),
        U.el('span', { class: 'dash-dot dash-dot-' + (service.status ?? 'green') })
      ]))
    }

    // Stale readings are not healthy readings. The server already answers red
    // when the collector has stopped; this says why, because a red panel full
    // of green numbers is otherwise unreadable.
    const note = health.stale
      ? U.el('div', {
        class: 'dash-health-stale',
        text: health.collectedAt
          ? 'Utolsó mérés ' + U.relTime(new Date(health.collectedAt)) + ' — a figyelő feladat valószínűleg áll.'
          : 'Egyetlen mérés sincs — a figyelő feladat még sosem futott le.'
      })
      : null

    return this.dashPanel({
      title: 'Rendszerállapot',
      sub: 'Minden mérőszám legfrissebb értéke',
      badge: AP.tag(
        health.stale ? 'elavult' : this.LEVEL_WORD[health.level] ?? 'ismeretlen',
        health.stale ? 'warn' : ({ green: 'ok', yellow: 'warn', red: 'bad' })[health.level] ?? ''
      ),
      body: rows.childElementCount
        ? U.el('div', {}, [note, rows])
        : U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Még nincs mérőszám — a figyelő worker percenként írja őket.' })
    })
  },

  /** A metric's own unit decides how it reads. */
  healthValue (metric) {
    const value = Number(metric.value)
    if (!Number.isFinite(value)) return '—'
    if (metric.unit === 'pct') return Math.round(value) + '%'
    if (metric.unit === 'ms') return Math.round(value) + 'ms'
    if (metric.unit === 'ratio') return value.toFixed(2)
    return value.toLocaleString()
  },

  // ---- error groups ----

  errorPanel (data, reload) {
    const groups = data.errorGroups ?? []
    const table = U.el('div', { class: 'dash-table' })

    if (!groups.length) {
      table.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Semmi nem hibás. 🎉' }))
    } else {
      table.append(U.el('div', { class: 'dash-thead' }, [
        U.el('span', { text: 'Hiba' }),
        U.el('span', { text: 'Darab' }),
        U.el('span', { text: 'Utoljára' }),
        U.el('span', { text: 'Súlyosság' }),
        U.el('span', { text: '' })
      ]))
    }

    for (const err of groups) {
      // Severity is derived from how often it happens, because that is what
      // the table actually knows. Nothing here is a label somebody typed.
      const count = Number(err.event_count)
      const severity = count >= 50 ? 'high' : count >= 10 ? 'medium' : 'low'
      table.append(U.el('div', { class: 'dash-trow' }, [
        U.el('div', { class: 'dash-row-main' }, [
          U.el('div', { class: 'dash-row-title', title: err.title, text: err.title }),
          U.el('div', { class: 'dash-row-sub', text: 'először ' + U.relTime(new Date(err.first_seen)) })
        ]),
        U.el('span', { class: 'dash-count', text: count.toLocaleString() }),
        U.el('span', { class: 'dash-row-when', text: U.relTime(new Date(err.last_seen)) }),
        U.el('span', { class: 'dash-sev dash-sev-' + severity, text: severity }),
        // Resolving from here is the whole reason to show the list on the
        // overview: the alternative is reading it, going to another section
        // and finding it again.
        err.id
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm',
            title: 'Csoport lezárása',
            onclick: async e => {
              e.currentTarget.disabled = true
              try {
                await YumeAPI.admin.setErrorStatus(err.id, 'resolved')
                U.toast('Lezárva')
                await reload()
              } catch (error) {
                U.toast(error.message, 'error')
                e.currentTarget.disabled = false
              }
            }
          }, [document.createTextNode('Lezárás')])
          : U.el('span', {})
      ]))
    }

    return this.dashPanel({
      title: 'Hibacsoportok',
      sub: 'Nyitott hibák, a legfrissebb elöl',
      badge: groups.length ? U.el('span', { class: 'dash-badge dash-badge-warn', text: String(groups.length) }) : null,
      action: U.el('button', {
        class: 'dash-link',
        type: 'button',
        onclick: () => this.goto('errors')
      }, [document.createTextNode('Mind megtekintése')]),
      body: table
    })
  },

  // ---- recent activity ----

  ACTIVITY_GLYPH: {
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    text: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    slider: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/>',
    hook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
    sync: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><path d="M21 3v6h-6"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h2a4 4 0 0 0 4-4 10 10 0 0 0-10-11"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7"/><circle cx="12" cy="12" r="3"/>'
  },

  ACTIVITY_ART: {
    'user.status': ['blue', 'Fiók állapota megváltozott', 'user'],
    'role.permission.grant': ['violet', 'Jogosultság megadva', 'shield'],
    'role.permission.revoke': ['amber', 'Jogosultság elvéve', 'shield'],
    'anime.create': ['green', 'Anime létrehozva', 'book'],
    'anime.edit': ['blue', 'Anime szerkesztve', 'book'],
    'anime.delete': ['red', 'Anime törölve', 'book'],
    'anime.merge': ['amber', 'Anime összevonva', 'book'],
    'anime.visibility': ['teal', 'Anime láthatósága megváltozott', 'eye'],
    'episode.create': ['green', 'Epizód létrehozva', 'play'],
    'episode.edit': ['blue', 'Epizód szerkesztve', 'play'],
    'episode.delete': ['red', 'Epizód törölve', 'play'],
    'episode.visibility': ['teal', 'Epizódok publikálva', 'eye'],
    'episode.source.add': ['green', 'Forrás felvéve', 'link'],
    'episode.source.edit': ['blue', 'Forrás szerkesztve', 'link'],
    'episode.source.remove': ['red', 'Forrás eltávolítva', 'link'],
    'anime.translation.create': ['violet', 'Fordítás megírva', 'text'],
    'anime.translation.update': ['violet', 'Fordítás szerkesztve', 'text'],
    'config.flag': ['amber', 'Kapcsoló átállítva', 'slider'],
    'config.setting': ['amber', 'Beállítás megváltozott', 'slider'],
    'webhook.create': ['teal', 'Webhook létrehozva', 'hook'],
    'webhook.update': ['teal', 'Webhook frissítve', 'hook'],
    'webhook.delete': ['red', 'Webhook törölve', 'hook'],
    'metadata.sync': ['violet', 'Metaadat-szinkron indult', 'sync'],
    'theme.create': ['rose', 'Téma létrehozva', 'palette'],
    'theme.update': ['rose', 'Téma frissítve', 'palette'],
    'theme.delete': ['red', 'Téma törölve', 'palette'],
    // Ezek a naplóban szerepelnek, de a térképből kimaradtak, tehát a
    // nyers azonosítójukkal jelentek meg („user.role.grant"). A napló
    // olvasásának az a fele, ami nem kereséshez kell, mondatokból áll.
    'user.role.grant': ['violet', 'Szerepkör megadva', 'shield'],
    'user.role.revoke': ['amber', 'Szerepkör elvéve', 'shield'],
    'user.role.bootstrap': ['violet', 'Első fiók adminná téve', 'shield'],
    'user.sessions.revoke': ['amber', 'Munkamenetek érvénytelenítve', 'user'],
    'user.deleted': ['red', 'Fiók törölve', 'user'],
    'episode.visibility.all': ['teal', 'Epizódok publikálva az egész katalóguson', 'eye'],
    'backup.request': ['violet', 'Mentési kérés', 'shield']
  },

  activityPanel (activity) {
    const rows = U.el('div', { class: 'dash-feed' })
    if (!activity.length) {
      rows.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-3);', text: 'Az elmúlt 30 napban nincs bejegyzés.' }))
    }
    for (const item of activity) {
      const [tone, label, glyph] = this.ACTIVITY_ART[item.action] ?? ['blue', item.action, 'shield']
      rows.append(U.el('div', { class: 'dash-feed-row' }, [
        U.el('span', { class: 'dash-feed-dot tone-' + tone }, [
          U.svg(this.ACTIVITY_GLYPH[glyph] ?? this.ACTIVITY_GLYPH.shield, 13)
        ]),
        U.el('div', { class: 'dash-feed-main' }, [
          U.el('div', { class: 'dash-feed-title', text: label }),
          U.el('div', { class: 'dash-feed-sub', text: this.activityDetail(item) })
        ]),
        U.el('span', { class: 'dash-feed-when', text: U.relTime(new Date(item.created_at)) })
      ]))
    }
    return this.dashPanel({
      title: 'Legutóbbi események',
      sub: 'A naplóból',
      action: U.el('button', {
        class: 'dash-link',
        type: 'button',
        onclick: () => this.goto('audit-log')
      }, [document.createTextNode('Mind megtekintése')]),
      body: rows
    })
  },

  /**
   * The one line under an activity row.
   *
   * `after` holds what changed, and what is worth saying differs per action —
   * so the few interesting keys are named and everything else falls back to
   * who did it, which is always true.
   */
  activityDetail (item) {
    const after = item.after ?? {}
    const detail = after.title ?? after.slug ?? after.name ?? after.key ?? after.username ?? after.kind ?? null
    const actor = item.actor ?? 'system'
    return detail ? `${detail} · ${actor}` : actor
  },

  // ---- job queue ----

  jobPanel (jobs) {
    const done = Number(jobs.completed ?? 0)
    const failed = Number(jobs.failed ?? 0)
    const pending = Number(jobs.pending ?? 0)
    const dead = Number(jobs.dead ?? 0)
    const running = Number(jobs.running ?? 0)

    const slices = [
      { label: 'Completed', value: done, color: 'var(--green-400)' },
      { label: 'Pending', value: pending, color: 'var(--accent)' },
      { label: 'Elhasalt', value: failed, color: 'var(--danger)' }
    ].filter(slice => slice.value > 0)

    const ring = U.el('div', { class: 'dash-ring' }, [
      slices.length ? Charts.donut(slices, { label: 'Feladatsor', size: 132, legend: false }) : null,
      U.el('div', { class: 'dash-ring-centre' }, [
        U.el('div', { class: 'dash-ring-value', text: String(running) }),
        U.el('div', { class: 'dash-ring-label', text: 'fut' })
      ])
    ])

    const legend = U.el('div', { class: 'dash-joblegend' }, [
      ['Completed', done, 'var(--green-400)'],
      ['Pending', pending, 'var(--accent)'],
      ['Elhasalt', failed, 'var(--danger)'],
      ['Dead', dead, 'var(--fg-faint)']
    ].map(([label, value, colour]) => U.el('div', { class: 'dash-joblegend-row' }, [
      U.el('span', { class: 'dash-legend-dot', style: `background:${colour};` }),
      U.el('span', { class: 'dash-joblegend-label', text: label }),
      U.el('span', { class: 'dash-joblegend-value', text: value.toLocaleString() })
    ])))

    const recent = U.el('div', { class: 'dash-rows' })
    for (const job of jobs.recent ?? []) {
      const status = job.done_at
        ? 'done'
        : job.attempts >= job.max_attempts ? 'dead' : job.locked_at ? 'running' : 'pending'
      recent.append(U.el('div', { class: 'dash-row' }, [
        U.el('div', { class: 'dash-row-main' }, [
          U.el('div', { class: 'dash-row-title', text: job.queue }),
          U.el('div', {
            class: 'dash-row-sub',
            text: job.last_error || `attempt ${job.attempts} of ${job.max_attempts}`
          })
        ]),
        U.el('span', { class: 'dash-job dash-job-' + status, text: status }),
        U.el('span', {
          class: 'dash-row-when',
          text: U.relTime(new Date(job.done_at ?? job.locked_at ?? job.created_at))
        })
      ]))
    }

    return this.dashPanel({
      title: 'Feladatsor',
      sub: 'Background work, all time',
      badge: U.el('span', {
        class: 'dash-badge dash-badge-' + (dead ? 'crit' : failed ? 'warn' : 'ok'),
        text: dead ? 'halott feladatok' : failed ? 'van hibája' : 'rendben'
      }),
      body: U.el('div', {}, [
        U.el('div', { class: 'dash-jobtop' }, [ring, legend]),
        U.el('div', { class: 'dash-panel-subhead', text: 'Legutóbbi feladatok' }),
        recent
      ])
    })
  },

  /** Move to another section from a link inside a panel. */
  // ---- Audit status: what the last code audit found ----
  //
  // Not the audit *log* in Insight — that is what people did, this is what is
  // wrong with the software. The two names collided all the way down: the
  // section key, the client method and the route (YUME-AUDIT-0013).
  //
  // Everything on this screen comes from docs/audit-2026-09.json by way of
  // GET /v1/admin/audit/report. Nothing is hardcoded, including the counts:
  // the summary block recounts the findings it was given rather than trusting
  // the file's own `summary`, so a report whose header disagrees with its body
  // shows the disagreement instead of hiding it.

  AUDIT_SEVERITIES: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
  AUDIT_CATEGORIES: ['security', 'functional', 'database', 'frontend'],
  AUDIT_RANK: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
  AUDIT_EFFORT: { S: 'Small', M: 'Medium', L: 'Large' },

  /** One severity chip. The word is always present: the colour is a second signal, never the only one. */
  auditSeverityBadge (severity) {
    return U.el('span', {
      class: `vis-badge sev-badge sev-${String(severity).toLowerCase()}`,
      text: String(severity)
    })
  },

  auditStatusBadge (status) {
    return U.el('span', {
      class: `vis-badge aud-status aud-status-${String(status)}`,
      text: String(status)
    })
  },

  /**
   * The header: when the audit ran, on what, and whether that is still true.
   *
   * The staleness line has three states rather than two. An image built
   * without a stamped commit cannot know what it is running, and "we could not
   * check" must not render as silence — silence reads as "current", which is
   * the one thing this page must never imply without knowing it.
   */
  auditHeader (report, source, running) {
    const when = new Date(report.generatedAt)
    const shortSha = sha => String(sha).slice(0, 7)

    const facts = U.el('div', { class: 'aud-facts' }, [
      U.el('div', { class: 'aud-fact' }, [
        U.el('span', { class: 'aud-fact-label', text: 'Audit lefutott' }),
        U.el('span', { class: 'aud-fact-value', text: Number.isNaN(+when) ? String(report.generatedAt) : when.toLocaleString() }),
        U.el('span', { class: 'aud-fact-note', text: Number.isNaN(+when) ? '' : U.relTime(when) })
      ]),
      U.el('div', { class: 'aud-fact' }, [
        U.el('span', { class: 'aud-fact-label', text: 'Commit' }),
        U.el('span', { class: 'aud-fact-value aud-sha', text: shortSha(report.commit) }),
        U.el('span', { class: 'aud-fact-note', text: source?.path ?? '' })
      ]),
      U.el('div', { class: 'aud-fact' }, [
        U.el('span', { class: 'aud-fact-label', text: 'Fut' }),
        U.el('span', {
          class: 'aud-fact-value aud-sha',
          text: running?.commit ? shortSha(running.commit) : 'unknown'
        }),
        U.el('span', {
          class: 'aud-fact-note',
          text: running?.commit ? '' : 'SOURCE_COMMIT is not set on this build'
        })
      ])
    ])

    const head = U.el('div', { class: 'aud-head' }, [facts])

    if (running?.stale === true) {
      head.append(U.el('div', { class: 'aud-warn aud-warn-stale' }, [
        U.svg('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0"/>', 15),
        U.el('span', {
          text: `The code has changed since this audit ran — it describes ${shortSha(report.commit)}, ` +
                `and ${shortSha(running.commit)} is running. Findings may be fixed, moved, or new.`
        })
      ]))
    } else if (running?.stale === null || running?.stale === undefined) {
      head.append(U.el('div', { class: 'aud-warn aud-warn-unknown' }, [
        U.svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>', 15),
        U.el('span', {
          text: 'Whether the running code still matches this audit could not be checked: ' +
                'this build carries no commit stamp. Build with --build-arg GIT_COMMIT=$(git rev-parse HEAD) to get the check.'
        })
      ]))
    }

    return head
  },

  /**
   * The counts.
   *
   * No score. A single number over findings of different kinds invents a
   * precision nobody measured, and the obvious formula — weight the
   * severities, divide by something — answers a question nobody asked. What is
   * shown instead is the one ratio that means exactly what it says, with the
   * sentence that says it directly underneath.
   */
  auditSummary (findings) {
    const bySeverity = Object.fromEntries(this.AUDIT_SEVERITIES.map(s => [s, 0]))
    let open = 0
    let fixed = 0
    let wontfix = 0
    for (const f of findings) {
      if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++
      if (f.status === 'fixed') fixed++
      else if (f.status === 'wontfix') wontfix++
      else open++
    }

    const cards = U.el('div', { class: 'aud-counts' })
    for (const severity of this.AUDIT_SEVERITIES) {
      cards.append(U.el('div', { class: `aud-count sev-${severity.toLowerCase()}` }, [
        U.el('b', { text: String(bySeverity[severity]) }),
        U.el('span', { text: severity })
      ]))
    }

    const total = findings.length
    const share = total ? Math.round(fixed / total * 100) : 0
    const meter = U.el('div', { class: 'aud-ratio' }, [
      U.el('div', { class: 'aud-ratio-line' }, [
        U.el('b', { text: `${fixed} of ${total}` }),
        U.el('span', { text: ` findings recorded as fixed (${share}%)` })
      ]),
      U.el('div', {
        class: 'aud-ratio-track',
        role: 'img',
        'aria-label': `${fixed} of ${total} findings recorded as fixed`
      }, [
        U.el('div', { class: 'aud-ratio-fill', style: `width:${share}%;` })
      ]),
      // Said plainly, because a bar without this sentence gets read as a grade.
      U.el('p', {
        class: 'aud-ratio-caption',
        text: 'This measures how much of the audit has been worked through — nothing else. ' +
              'It is not a security score, and it does not weigh a CRITICAL against a LOW.'
      }),
      U.el('div', { class: 'aud-ratio-split' }, [
        U.el('span', { text: `${open} open` }),
        U.el('span', { text: `${fixed} fixed` }),
        ...(wontfix ? [U.el('span', { text: `${wontfix} won't fix` })] : [])
      ])
    ])

    return U.el('div', { class: 'aud-summary' }, [cards, meter])
  },

  /** One finding: the line always shown, and the detail behind it. */
  auditFindingRow (finding) {
    const summary = U.el('summary', { class: 'aud-row-head' }, [
      U.el('span', { class: 'aud-id', text: finding.id }),
      this.auditSeverityBadge(finding.severity),
      U.el('span', { class: 'aud-row-title', text: finding.title }),
      U.el('span', { class: 'aud-file', text: `${finding.file}:${finding.line}` }),
      U.el('span', { class: 'aud-category', text: finding.category }),
      this.auditStatusBadge(finding.status)
    ])

    const field = (label, value) => U.el('div', { class: 'aud-field' }, [
      U.el('span', { class: 'aud-field-label', text: label }),
      U.el('p', { class: 'aud-field-value', text: value })
    ])

    return U.el('details', { class: 'aud-row' }, [
      summary,
      U.el('div', { class: 'aud-row-body' }, [
        field('Hatás', finding.impact),
        field('Javasolt javítás', finding.suggestedFix),
        U.el('div', { class: 'aud-field' }, [
          U.el('span', { class: 'aud-field-label', text: 'Becsült munka' }),
          U.el('p', { class: 'aud-field-value', text: `${this.AUDIT_EFFORT[finding.effort] ?? finding.effort} (${finding.effort})` })
        ])
      ])
    ])
  },

  /** The skeleton, shaped like what is coming, so the layout does not jump. */
  auditSkeleton () {
    const bar = (cls) => U.el('div', { class: `skeleton aud-skel ${cls}` })
    const wrap = U.el('div', { class: 'aud-loading', 'aria-busy': 'true', 'aria-label': 'Az auditjelentés betöltése' })
    wrap.append(U.el('div', { class: 'aud-head' }, [
      U.el('div', { class: 'aud-facts' }, [bar('aud-skel-fact'), bar('aud-skel-fact'), bar('aud-skel-fact')])
    ]))
    wrap.append(U.el('div', { class: 'aud-counts' }, [bar('aud-skel-count'), bar('aud-skel-count'), bar('aud-skel-count'), bar('aud-skel-count')]))
    for (let i = 0; i < 6; i++) wrap.append(bar('aud-skel-row'))
    return wrap
  },

  async renderAuditStatus (content) {
    const state = { severity: '', category: '', status: 'open', q: '', sort: 'severity' }

    content.replaceChildren(this.auditSkeleton())

    let payload
    try {
      payload = await YumeAPI.admin.auditReport()
    } catch (e) {
      // The three failures this route can produce are different problems with
      // different answers, and the reader is told which one they have. A page
      // about what is wrong with the software must never answer "nothing" when
      // what it means is "I could not read the file".
      const detail = e?.status === 503
        ? 'No audit report has been generated for this build, so there is nothing to show. This is not a clean result.'
        : e?.status === 500
          ? 'The audit report exists but could not be read, so its findings are unknown. This is not a clean result.'
          : null
      const box = U.el('div', { class: 'aud-fail' }, [
        C.errorState(e, () => this.renderAuditStatus(content))
      ])
      if (detail) box.prepend(U.el('p', { class: 'aud-fail-note', text: detail }))
      content.replaceChildren(box)
      return
    }

    const { report, source, running } = payload
    const findings = Array.isArray(report?.findings) ? report.findings : []

    const list = U.el('div', { class: 'aud-list' })
    const countLine = U.el('p', { class: 'aud-showing' })

    const matches = f => {
      if (state.severity && f.severity !== state.severity) return false
      if (state.category && f.category !== state.category) return false
      if (state.status && f.status !== state.status) return false
      if (state.q) {
        const needle = state.q.toLowerCase()
        const hay = `${f.title} ${f.file} ${f.id}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    }

    const paintList = () => {
      const shown = findings.filter(matches).sort((a, b) => (
        state.sort === 'id'
          ? String(a.id).localeCompare(String(b.id))
          : (this.AUDIT_RANK[a.severity] ?? 9) - (this.AUDIT_RANK[b.severity] ?? 9) ||
            String(a.id).localeCompare(String(b.id))
      ))

      list.replaceChildren()
      if (!shown.length) {
        // The empty state says when the audit ran, because "no findings" is
        // only good news if it is recent — and an empty *filter* is not the
        // same news as an empty *audit*.
        const ran = new Date(report.generatedAt)
        const filtered = findings.length > 0
        list.append(U.el('div', { class: 'empty-state' }, [
          U.el('div', { text: filtered ? 'No findings match these filters' : 'No open findings' }),
          U.el('div', {
            class: 'aud-empty-sub',
            text: filtered
              ? `${findings.length} findings in this report, none of them matching. The audit ran ${Number.isNaN(+ran) ? 'at an unreadable time' : U.relTime(ran)}.`
              : `The audit ran ${Number.isNaN(+ran) ? 'at an unreadable time' : U.relTime(ran)}, on ${String(report.commit).slice(0, 7)}.`
          })
        ]))
      } else {
        for (const f of shown) list.append(this.auditFindingRow(f))
      }
      countLine.textContent = `Showing ${shown.length} of ${findings.length} findings`
    }

    const pick = (value, options, onchange) => U.el('select', {
      class: 'select',
      onchange: e => { onchange(e.target.value); paintList() }
    }, options.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === value })))

    const bar = U.el('div', { class: 'admin-toolbar' }, [
      pick(state.status, [['open', 'Nyitott'], ['fixed', 'Javítva'], ['wontfix', 'Nem javítjuk'], ['', 'Bármilyen állapot']],
        v => { state.status = v }),
      pick(state.severity, [['', 'Bármilyen súlyosság'], ...this.AUDIT_SEVERITIES.map(s => [s, s])],
        v => { state.severity = v }),
      pick(state.category, [['', 'Bármilyen kategória'], ...this.AUDIT_CATEGORIES.map(c => [c, c])],
        v => { state.category = v }),
      pick(state.sort, [['severity', 'Sort: severity'], ['id', 'Sort: identifier']],
        v => { state.sort = v }),
      U.el('input', {
        class: 'input',
        type: 'search',
        placeholder: 'Cím vagy fájl…',
        'aria-label': 'Keresés cím vagy fájl szerint',
        style: 'max-width:14rem;',
        oninput: U.debounce(e => { state.q = e.target.value.trim(); paintList() })
      })
    ])

    content.replaceChildren(
      this.auditHeader(report, source, running),
      // Counted from the findings, not read from report.summary: a header that
      // disagrees with its own body should be visible, not authoritative.
      this.auditSummary(findings),
      bar,
      countLine,
      list
    )
    paintList()
  },

  goto (key) {
    window.location.hash = `#/admin?s=${key}`
    navigate()
  },

  /**
   * Accounts.
   *
   * This was a search box and a list of names with Suspend and Ban beside
   * each. Everything else an operator needs — is this account new, does it
   * have a role, has anybody acted on it before, how much of the site has it
   * actually used — was recorded and unreachable, so the answer to every real
   * question was a database query.
   *
   * Now the row carries the shape of the account and the panel behind it
   * carries the rest, including the two things that could not be done at all:
   * giving somebody a role, and signing them out without banning them.
   */
  USER_SORTS: [['newest', 'Legújabb elöl'], ['oldest', 'Legrégebbi elöl'], ['active', 'Nemrég aktív'], ['name', 'Név A–Z']],

  async renderUsers (content, state = {}) {
    const q = { query: '', status: '', role: '', sort: 'newest', offset: 0, ...state }
    const PAGE = 50

    const input = U.el('input', {
      class: 'input search-input-big',
      placeholder: 'Keresés felhasználónévre vagy e-mailre…',
      value: q.query,
      oninput: U.debounce(e => this.renderUsers(content, { ...q, query: e.target.value.trim(), offset: 0 }))
    })

    // `label` is not optional in practice: a filter select with no name
    // announces as "combo box" and there are three of them side by side.
    const pick = (value, options, onchange, label) => U.el('select', {
      class: 'select',
      ...(label ? { 'aria-label': label } : {}),
      onchange: e => onchange(e.target.value)
    }, options.map(([v, l]) => U.el('option', { value: v, text: l, selected: v === value })))

    try {
      const [{ data, totals }, roleList] = await Promise.all([
        YumeAPI.admin.users({ ...q, limit: PAGE }),
        // Only to populate the filter; a failure here must not take the list
        // with it, so the filter degrades to "any role" instead.
        YumeAPI.admin.roles().then(r => r.data ?? r.roles ?? []).catch(() => [])
      ])

      input.classList.add('ap-toolbar-grow')
      const bar = AP.toolbar([
        input,
        pick(q.status, [['', 'Bármilyen állapot'], ['active', 'Aktív'], ['suspended', 'Felfüggesztve'], ['banned', 'Kitiltva']],
          v => this.renderUsers(content, { ...q, status: v, offset: 0 }), 'Szűrés állapot szerint'),
        pick(q.role, [['', 'Bármilyen szerepkör'], ...roleList.map(r => [r.slug, r.name ?? r.slug])],
          v => this.renderUsers(content, { ...q, role: v, offset: 0 }), 'Szűrés szerepkör szerint'),
        pick(q.sort, this.USER_SORTS, v => this.renderUsers(content, { ...q, sort: v, offset: 0 }), 'Rendezés')
      ])

      // The counts are of the filtered set, not the whole table, so they say
      // what the filter actually selected rather than repeating a constant.
      /*
       * A számok szűrőként is működnek.
       *
       * Eddig négy színes felirat volt, amit el lehetett olvasni és semmi
       * többet. Egy operátor viszont, aki meglátja, hogy „2 felfüggesztve",
       * pont azt a kettőt akarja megnézni — és ehhez eddig le kellett húznia
       * a legördülőt. Ugyanaz a szám, egy kattintással.
       */
      const tally = AP.tabs([
        ['', 'Mind', totals?.total ?? 0],
        ['active', 'Aktív', totals?.active ?? 0],
        ['suspended', 'Felfüggesztve', totals?.suspended ?? 0],
        ['banned', 'Kitiltva', totals?.banned ?? 0]
      ], q.status, value => this.renderUsers(content, { ...q, status: value, offset: 0 }))

      const list = AP.list(data.map(user => this.userRow(user, content, q)))
      content.replaceChildren(AP.stack([bar, tally, list]))
      if (q.query) input.focus()

      if (!data.length) {
        content.append(AP.empty(
          'Nincs ilyen fiók',
          q.query || q.status || q.role
            ? 'A szűrők együtt semmit nem engedtek át. Vegyél le valamelyiket.'
            : 'Ezen a példányon még nincs egyetlen fiók sem.'))
      }

      const total = Number(totals?.total ?? 0)
      if (total > PAGE) {
        const from = q.offset + 1
        const to = Math.min(q.offset + data.length, total)
        content.append(U.el('div', { class: 'admin-pager' }, [
          U.el('button', {
            class: 'btn btn-sm btn-ghost',
            disabled: q.offset === 0,
            onclick: () => this.renderUsers(content, { ...q, offset: Math.max(0, q.offset - PAGE) })
          }, [document.createTextNode('← Előző')]),
          U.el('span', { class: 'admin-pager-label', text: `${from}–${to} / ${total}` }),
          U.el('button', {
            class: 'btn btn-sm btn-ghost',
            disabled: to >= total,
            onclick: () => this.renderUsers(content, { ...q, offset: q.offset + PAGE })
          }, [document.createTextNode('Következő →')])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  /** A fiók állapota magyarul. Az adatbázisban angol kulcs, a képernyőn nem. */
  USER_STATUS: { active: 'aktív', suspended: 'felfüggesztve', banned: 'kitiltva', deleted: 'törölve' },

  /** One account in the list: identity, shape, and the way into the detail. */
  userRow (user, content, q) {
    const roles = (user.roles ?? []).filter(r => r !== 'user')

    // Facts, not decoration: each one is a reason to open the account or to
    // leave it alone.
    const facts = []
    if (roles.length) facts.push(roles.join(', '))
    facts.push(`regisztrált: ${U.airDate(user.created_at)}`)
    if (user.last_login_at) facts.push(`belépett ${U.relTime(new Date(user.last_login_at))}`)
    else facts.push('még sosem lépett be')
    // Magyarban a szám után egyes szám áll: „3 munkamenet", nem „3 munkamenetek".
    if (user.active_sessions > 0) facts.push(`${user.active_sessions} munkamenet`)
    if (user.comments > 0) facts.push(`${user.comments} hozzászólás`)
    if (!user.email_verified_at) facts.push('nincs megerősítve az e-mail')

    const open = () => this.userPanel(user.id, () => this.renderUsers(content, q))

    /*
     * A sor EGÉSZE nyitja meg a fiókot, és gomb, nem div: így billentyűzettel
     * is elérhető, nem csak egérrel. Eddig egy `onclick`-es div volt, mellette
     * egy „Kezelés" gombbal, ami ugyanoda vitt — a gomb csak megismételte a
     * sort, telefonon viszont elvette a szélesség harmadát, és a mellette lévő
     * szöveg szavanként tördelődött.
     */
    return AP.row({
      title: user.username,
      tags: [
        AP.tag(this.USER_STATUS[user.status] ?? user.status,
          user.status === 'active' ? 'ok' : user.status === 'banned' ? 'bad' : 'warn'),
        user.reports_against > 0 ? AP.tag(`${user.reports_against} bejelentés`, 'bad') : null
      ].filter(Boolean),
      meta: facts.join(' · '),
      onclick: open
    })
  },

  /**
   * One account, in full.
   *
   * Opened as a modal rather than a route because it is a place you look and
   * then leave, and losing the list's filters and page on the way back would
   * make triaging a queue of accounts painful.
   */
  async userPanel (id, reload) {
    const body = U.el('div', { class: 'user-panel' }, [P.spinner()])
    C.modalPanel('Account', [body])

    const load = async () => {
      try {
        const d = await YumeAPI.admin.user(id)
        body.replaceChildren(...this.userPanelBody(d, { reload, refresh: load }))
      } catch (e) {
        body.replaceChildren(P.errorState(e.message))
      }
    }
    await load()
  },

  userPanelBody (d, { reload, refresh }) {
    const a = d.account
    const held = new Set((d.roles ?? []).map(r => r.slug))

    const ask = (question, preset = '') => {
      const reason = window.prompt(question, preset)
      return reason && reason.trim().length >= 3 ? reason.trim() : null
    }

    const run = async (fn, ok) => {
      try { await fn(); U.toast(ok); await refresh(); reload?.() } catch (e) { U.toast(e.message, 'error') }
    }

    // ---- identity ----
    const head = U.el('div', { class: 'user-panel-head' }, [
      U.el('div', { class: 'user-panel-name' }, [
        U.el('h3', { text: a.username }),
        U.el('span', { class: 'badge' + (a.status === 'active' ? '' : a.status === 'banned' ? ' badge-bad' : ' badge-theme'), text: this.USER_STATUS[a.status] ?? a.status })
      ]),
      U.el('div', { class: 'user-panel-sub', text: a.email })
    ])

    // ---- the numbers ----
    const hours = Math.round(Number(d.activity?.watched_sec ?? 0) / 360) / 10
    const stat = (label, value, sub) => U.el('div', { class: 'user-stat' }, [
      U.el('div', { class: 'user-stat-value', text: String(value) }),
      U.el('div', { class: 'user-stat-label', text: label }),
      sub ? U.el('div', { class: 'user-stat-sub', text: sub }) : null
    ])

    const stats = U.el('div', { class: 'user-stats' }, [
      stat('Profiles', d.profiles?.length ?? 0),
      stat('Episodes finished', d.activity?.episodes_finished ?? 0),
      stat('Hours watched', hours),
      stat('Comments', d.activity?.comments ?? 0),
      stat('Reports filed', d.activity?.reports_filed ?? 0),
      stat('Reports against', d.activity?.reports_against ?? 0),
      stat('Sessions', d.sessions?.active ?? 0, `${d.sessions?.total ?? 0} ever · ${d.sessions?.devices ?? 0} devices`)
    ])

    // ---- account facts ----
    const fact = (label, value) => U.el('div', { class: 'user-fact' }, [
      U.el('span', { class: 'user-fact-label', text: label }),
      U.el('span', { class: 'user-fact-value', text: value })
    ])
    const facts = U.el('div', { class: 'user-facts' }, [
      fact('Joined', new Date(a.created_at).toLocaleString()),
      fact('Last sign-in', a.last_login_at ? new Date(a.last_login_at).toLocaleString() : 'never'),
      fact('Last watched', d.activity?.last_watched_at ? U.relTime(new Date(d.activity.last_watched_at)) : 'never'),
      fact('Email verified', a.email_verified_at ? new Date(a.email_verified_at).toLocaleDateString() : 'no'),
      fact('Password set', a.has_password ? 'yes' : 'no (external sign-in only)'),
      fact('Two-factor', a.mfa_enabled ? 'enabled' : 'off')
    ])

    // ---- roles: the thing that could not be done at all ----
    const roleBox = U.el('div', { class: 'user-roles' }, (d.allRoles ?? []).map(role => {
      const on = held.has(role.slug)
      return U.el('button', {
        class: 'user-role' + (on ? ' on' : ''),
        type: 'button',
        title: on ? `Revoke ${role.slug}` : `Grant ${role.slug}`,
        onclick: () => {
          const reason = ask(`${on ? 'Revoke' : 'Grant'} "${role.slug}" ${on ? 'from' : 'to'} ${a.username} — why?`)
          if (!reason) return
          run(() => YumeAPI.admin.setUserRole(a.id, role.slug, !on, reason),
            `${a.username}: ${role.slug} ${on ? 'revoked' : 'granted'}`)
        }
      }, [
        U.el('span', { class: 'user-role-dot' }),
        document.createTextNode(role.name ?? role.slug)
      ])
    }))

    // ---- actions ----
    const act = (label, cls, fn) => U.el('button', { class: 'btn btn-sm ' + cls, onclick: fn }, [document.createTextNode(label)])
    const status = (next, label) => act(label, next === 'active' ? 'btn-secondary' : 'btn-ghost', () => {
      const reason = ask(`Reason for "${label}" on ${a.username}:`)
      if (!reason) return
      run(() => YumeAPI.admin.setUserStatus(a.id, next, reason), `${a.username}: ${label}`)
    })

    const actions = U.el('div', { class: 'user-actions' }, [
      ...(a.status === 'active' ? [status('suspended', 'Felfüggesztés'), status('banned', 'Kitiltás')] : [status('active', 'Visszaállítás')]),
      // Not a punishment and not visible as one: the proportionate answer to a
      // shared password, which previously had no answer but a ban.
      act('Kijelentkeztetés mindenhonnan', 'btn-ghost', () => {
        const reason = ask(`Miért jelentkezteted ki ${a.username} minden munkamenetét?`, 'A jelszava kikerülhetett')
        if (!reason) return
        run(() => YumeAPI.admin.revokeUserSessions(a.id, reason), `${a.username}: kijelentkeztetve`)
      })
    ])

    // ---- history ----
    const historyRows = (d.moderation ?? []).map(m => U.el('div', { class: 'user-history-row' }, [
      U.el('span', { class: 'user-history-action', text: m.action }),
      U.el('span', { class: 'user-history-reason', text: m.reason, title: m.reason }),
      U.el('span', { class: 'user-history-by', text: m.moderator ?? 'system' }),
      U.el('time', { class: 'user-history-when', text: U.relTime(new Date(m.created_at)), title: new Date(m.created_at).toLocaleString() })
    ]))

    // Role grants and sign-outs live here rather than in the moderation
    // history: that table's vocabulary is disciplinary, and a promotion is not
    // a punishment. Both are still questions somebody asks of an account, so
    // both are on the same screen.
    const auditRows = (d.audit ?? []).map(a2 => {
      const after = a2.after && Object.keys(a2.after).length ? JSON.stringify(a2.after) : ''
      return U.el('div', { class: 'user-history-row' }, [
        U.el('span', { class: 'user-history-action', text: a2.action }),
        U.el('span', { class: 'user-history-reason', text: after, title: after }),
        U.el('span', { class: 'user-history-by', text: a2.actor ?? 'system' }),
        U.el('time', { class: 'user-history-when', text: U.relTime(new Date(a2.created_at)), title: new Date(a2.created_at).toLocaleString() })
      ])
    })

    const securityRows = (d.security ?? []).map(e => U.el('div', { class: 'user-history-row' }, [
      U.el('span', { class: 'user-history-action', text: e.event }),
      U.el('span', { class: 'user-history-reason', text: `${e.n}×` }),
      U.el('span', { class: 'user-history-by', text: '' }),
      U.el('time', { class: 'user-history-when', text: U.relTime(new Date(e.last_at)), title: new Date(e.last_at).toLocaleString() })
    ]))

    const section = (title, rows, empty) => U.el('div', { class: 'user-section' }, [
      U.el('h4', { class: 'user-section-title', text: title }),
      rows.length ? U.el('div', { class: 'user-history' }, rows) : U.el('div', { class: 'user-section-empty', text: empty })
    ])

    return [
      head,
      stats,
      facts,
      U.el('div', { class: 'user-section' }, [
        U.el('h4', { class: 'user-section-title', text: 'Szerepkörök' }),
        roleBox,
        U.el('p', { class: 'user-section-note', text: 'Egy szerepkör minden jogosultságát átadja. Az utolsó adminisztrátortól nem lehet elvenni.' })
      ]),
      U.el('div', { class: 'user-section' }, [
        U.el('h4', { class: 'user-section-title', text: 'Műveletek' }),
        actions
      ]),
      section('Moderációs előzmény', historyRows, 'Ezzel a fiókkal még soha nem történt semmi.'),
      section('Adminisztratív változások', auditRows, 'Nem kapott szerepkört, és nem jelentkeztették ki.'),
      section('Belépési események', securityRows, 'Nincs rögzített belépési tevékenység.'),
      this.accountActivitySection(a.id)
    ]
  },

  /**
   * Tevékenység, munkamenetek, eszközök — külön jogosultsággal, külön kéréssel.
   *
   * Nem a felhasználói panel fő lekérdezésébe húzva, két okból:
   *
   *   * ehhez MÁS jogosultság kell (`analytics.accounts`), mint a fiók
   *     kezeléséhez. Aki moderál, attól még nem feltétlenül nézheti végig
   *     valakinek az idővonalát;
   *   * ha nincs jogosultság, a végpont nem létezik (404), és akkor ez a
   *     szakasz egyszerűen eltűnik — nem üres dobozként áll ott azzal, hogy
   *     „nincs jogod".
   */
  accountActivitySection (userId) {
    const box = U.el('div', { class: 'user-section' }, [
      U.el('h4', { class: 'user-section-title', text: 'Tevékenység és eszközök' }),
      U.el('div', { class: 'user-section-empty', text: 'Betöltés…' })
    ])

    YumeAPI.admin.analytics.account(userId, { limit: 40 }).then(data => {
      box.replaceChildren(U.el('h4', { class: 'user-section-title', text: 'Tevékenység és eszközök' }))

      const w = data.watch ?? {}
      box.append(U.el('p', {
        class: 'user-section-note',
        text:
        `${w.episodes_started ?? 0} elindított epizód · ${w.episodes_finished ?? 0} befejezett · ` +
        `${this.analyticsDuration(w.watch_seconds)} nézve · ${w.favorites ?? 0} kedvenc · ` +
        `${w.library_entries ?? 0} könyvtári bejegyzés · ${w.comments ?? 0} hozzászólás`
      }))

      const rows = (data.events ?? []).map(e => U.el('div', { class: 'user-history-row' }, [
        // A hivatkozási szám az, amit egy bejelentésben idézni lehet.
        U.el('span', { class: 'user-history-action', text: e.reference }),
        U.el('span', {
          class: 'user-history-reason',
          text: e.result === 'success' ? '' : e.result,
          title: JSON.stringify(e.metadata ?? {})
        }),
        U.el('span', { class: 'user-history-by', text: e.event }),
        U.el('time', {
          class: 'user-history-when',
          text: U.relTime(new Date(e.created_at)),
          title: new Date(e.created_at).toLocaleString(I18n.locale())
        })
      ]))
      box.append(rows.length
        ? U.el('div', { class: 'user-history' }, rows)
        : U.el('div', { class: 'user-section-empty', text: 'Nincs rögzített esemény. A fiókesemények naplózása 2026 szeptemberében indult.' }))

      const devices = (data.devices ?? []).map(dv => U.el('div', { class: 'user-history-row' }, [
        U.el('span', { class: 'user-history-action', text: dv.platform }),
        U.el('span', { class: 'user-history-reason', text: dv.name ?? '' }),
        U.el('span', { class: 'user-history-by', text: '' }),
        U.el('time', { class: 'user-history-when', text: U.relTime(new Date(dv.last_seen_at)) })
      ]))
      if (devices.length) {
        box.append(U.el('h4', { class: 'user-section-title', style: 'margin-top:var(--space-4);', text: 'Eszközök' }))
        box.append(U.el('div', { class: 'user-history' }, devices))
      }

      const sessions = (data.sessions ?? []).slice(0, 10).map(se => U.el('div', { class: 'user-history-row' }, [
        U.el('span', { class: 'user-history-action', text: se.active ? 'élő' : 'lezárt' }),
        U.el('span', { class: 'user-history-reason', text: se.device_name ?? se.platform ?? '' }),
        U.el('span', { class: 'user-history-by', text: '' }),
        U.el('time', {
          class: 'user-history-when',
          text: U.relTime(new Date(se.created_at)),
          title: new Date(se.created_at).toLocaleString(I18n.locale())
        })
      ]))
      if (sessions.length) {
        box.append(U.el('h4', { class: 'user-section-title', style: 'margin-top:var(--space-4);', text: 'Munkamenetek' }))
        box.append(U.el('div', { class: 'user-history' }, sessions))
      }
    }).catch(() => {
      // Nincs jogosultság (404), vagy a végpont nem elérhető — a szakasz
      // eltűnik. Egy „nincs jogod" doboz nem információ, csak hely.
      box.remove()
    })

    return box
  },

  /**
   * The moderation queue.
   *
   * It showed the open reports and nothing else: no way to see what had been
   * decided, no way to see who decided it, and no context beyond the report
   * itself. A first report from somebody who has never filed one reads very
   * differently from the ninth from a reporter whose last eight were
   * dismissed, and that difference decides most of these.
   */
  REPORT_TABS: [['open', 'Nyitott'], ['reviewing', 'Vizsgálat alatt'], ['resolved', 'Lezárva'], ['dismissed', 'Elutasítva'], ['all', 'Mind']],

  async renderReports (content, state = {}) {
    const q = { status: 'open', subjectType: '', offset: 0, ...state }
    const PAGE = 50

    try {
      const { data, totals } = await YumeAPI.admin.reports({ ...q, limit: PAGE })

      const tabs = U.el('div', { class: 'report-tabs' }, this.REPORT_TABS.map(([value, label]) => {
        const count = value === 'all' ? totals?.total : totals?.[value]
        return U.el('button', {
          class: 'report-tab' + (q.status === value ? ' on' : ''),
          type: 'button',
          onclick: () => this.renderReports(content, { ...q, status: value, offset: 0 })
        }, [
          document.createTextNode(label),
          U.el('span', { class: 'report-tab-count', text: String(count ?? 0) })
        ])
      }))

      const kinds = U.el('select', {
        class: 'select',
        onchange: e => this.renderReports(content, { ...q, subjectType: e.target.value, offset: 0 })
      }, [['', 'Bármilyen típus'], ['comment', 'Hozzászólások'], ['review', 'Értékelések'], ['post', 'Bejegyzések'], ['user', 'Felhasználók']]
        .map(([v, l]) => U.el('option', { value: v, text: l, selected: v === q.subjectType })))

      content.replaceChildren(U.el('div', { class: 'admin-toolbar' }, [tabs, kinds]))

      if (!data.length) {
        content.append(U.el('div', {
          class: 'empty-state',
          text: q.status === 'open' ? 'Moderation queue is empty. ✨' : 'Nothing here.'
        }))
        return
      }

      for (const report of data) content.append(this.reportCard(report, content, q))

      const total = Number(q.status === 'all' ? totals?.total : totals?.[q.status]) || data.length
      if (total > PAGE) {
        const to = Math.min(q.offset + data.length, total)
        content.append(U.el('div', { class: 'admin-pager' }, [
          U.el('button', {
            class: 'btn btn-sm btn-ghost',
            disabled: q.offset === 0,
            onclick: () => this.renderReports(content, { ...q, offset: Math.max(0, q.offset - PAGE) })
          }, [document.createTextNode('← Előző')]),
          U.el('span', { class: 'admin-pager-label', text: `${q.offset + 1}–${to} of ${total}` }),
          U.el('button', {
            class: 'btn btn-sm btn-ghost',
            disabled: to >= total,
            onclick: () => this.renderReports(content, { ...q, offset: q.offset + PAGE })
          }, [document.createTextNode('Következő →')])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  reportCard (report, content, q) {
    const act = (action, label, primary = false) => U.el('button', {
      class: 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'),
      onclick: async () => {
        const reason = window.prompt(`Reason (${label}):`, action === 'dismiss' ? 'Not a violation' : '')
        if (!reason || reason.trim().length < 3) return
        try {
          await YumeAPI.admin.resolveReport(report.id, action, reason.trim())
          U.toast(`Report ${label.toLowerCase()}ed`)
          this.renderReports(content, q)
        } catch (e) { U.toast(e.message, 'error') }
      }
    }, [document.createTextNode(label)])

    // What the reporter's record says. Shown only when there is a record to
    // speak of: "1 report filed" on a first-time reporter is noise.
    const filed = Number(report.reporter_total ?? 0)
    const dismissed = Number(report.reporter_dismissed ?? 0)
    const marks = []
    if (filed > 1) marks.push(`${filed} filed`)
    if (dismissed > 0) marks.push(`${dismissed} dismissed`)
    if (Number(report.subject_reports ?? 0) > 1) marks.push(`reported ${report.subject_reports}×`)

    const resolved = report.status !== 'open' && report.status !== 'reviewing'

    return U.el('div', { class: 'report-card' }, [
      U.el('div', { class: 'report-head' }, [
        U.el('span', { class: 'report-reason', text: String(report.reason).toUpperCase() }),
        U.el('span', { class: 'badge badge-outline', text: report.subject_type }),
        U.el('span', { class: 'report-by', text: `by ${report.reporter}` }),
        ...marks.map(m => U.el('span', { class: 'report-mark', text: m })),
        U.el('time', {
          class: 'report-when',
          text: U.relTime(new Date(report.created_at)),
          title: new Date(report.created_at).toLocaleString()
        })
      ]),
      report.excerpt ? U.el('div', { class: 'report-excerpt', text: report.excerpt }) : null,
      report.details ? U.el('div', { class: 'report-details', text: report.details }) : null,
      resolved
        // The decision, and who made it. Absent before, which made a resolved
        // report indistinguishable from one nobody had looked at.
        ? U.el('div', { class: 'report-outcome' }, [
          U.el('span', { class: 'badge' + (report.status === 'resolved' ? '' : ' badge-outline'), text: report.status }),
          U.el('span', {
            class: 'report-outcome-by',
            text: `${report.resolver ?? 'unknown'}${report.resolved_at ? ' · ' + U.relTime(new Date(report.resolved_at)) : ''}`
          })
        ])
        : U.el('div', { class: 'report-actions' }, [
          ...(report.subject_type in { comment: 1, post: 1, review: 1 } ? [act('hide', 'Hide', true)] : []),
          act('dismiss', 'Dismiss')
        ])
    ])
  },

  // ---- webhooks ----

  EVENT_LABELS: {
    'user.registered': 'Új regisztráció',
    'user.moderated': 'Felhasználó felfüggesztve / kitiltva / visszaállítva',
    'user.deleted': 'Fiók törölte magát',
    'user.roles.changed': 'Szerepkör adva vagy elvéve',
    'user.password_reset_requested': 'Jelszó-visszaállítás kérve',
    'catalogue.changed': 'Anime vagy epizód változott',
    'config.changed': 'Beállítás vagy kapcsoló változott',
    'monitor.alert': 'Egy mérőszám vagy szolgáltatás riaszt',
    'monitor.recovered': 'Egy mérőszám vagy szolgáltatás rendbe jött',
    'comment.created': 'Új hozzászólás',
    'report.created': 'Bejelentés érkezett',
    'report.resolved': 'Bejelentés lezárva',
    'w2g.room_created': 'Közös nézés szoba nyílt',
    'stats.daily': 'Napi statisztika',
    'stats.trending': 'Felkapottak frissültek',
    'catalogue.imported': 'Katalógus-import lefutott',
    'metadata.synced': 'Metaadat-szinkron lefutott',
    'job.failed': 'Háttérfeladat elhasalt',
    'webhook.test': 'Kézi teszt'
  },

  // ---- announcements -------------------------------------------------------

  /**
   * Site-wide messages: what is live, what has not opened yet, what has closed.
   *
   * Sorted by the window rather than by creation, and each row says which of
   * the three states it is in — an operator's first question about a message
   * is always "is anybody seeing this right now".
   */
  async renderAnnouncements (content) {
    try {
      const { data } = await YumeAPI.admin.allAnnouncements()
      content.replaceChildren()

      content.append(U.el('div', { class: 'adm-head-row' }, [
        U.el('p', {
          class: 'list-row-sub',
          style: 'max-width:42rem;',
          text: 'Egy üzenet, amit mindenki lát, amíg nyitva az ablaka. Aki bezárja, annak nem jön vissza — profilonként, nem fiókonként.'
        }),
        P.button('+ Új hír', { variant: 'primary', size: 'sm', onclick: () => this.announcementForm(content, null) })
      ]))

      if (!data.length) {
        content.append(P.emptyState('Még nincs hír. Az elsővel tudsz szólni mindenkinek egyszerre.', {
          action: P.button('+ Új hír', { variant: 'secondary', onclick: () => this.announcementForm(content, null) })
        }))
        return
      }

      const now = Date.now()
      for (const a of data) {
        const starts = new Date(a.starts_at).getTime()
        const ends = a.ends_at ? new Date(a.ends_at).getTime() : null
        const state = starts > now
          ? { label: 'Ütemezve', variant: 'info' }
          : (ends && ends <= now)
              ? { label: 'Lejárt', variant: null }
              : { label: 'Él', variant: 'ok' }

        content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
          U.el('div', { class: 'adm-ann-head' }, [
            P.badge(state.label, { variant: state.variant }),
            U.el('h3', { style: 'margin:0;', text: a.title }),
            P.badge(a.audience, { variant: 'outline' })
          ]),
          U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;white-space:pre-wrap;', text: a.body.slice(0, 240) + (a.body.length > 240 ? '…' : '') }),
          U.el('p', { class: 'list-row-sub', text: this.announcementWindow(a) }),
          U.el('div', { class: 'adm-ann-actions' }, [
            P.button('Szerkesztés', { variant: 'ghost', size: 'sm', onclick: () => this.announcementForm(content, a) }),
            P.button('Törlés', {
              variant: 'danger',
              size: 'sm',
              onclick: async () => {
                if (!window.confirm(`Törlöd ezt: „${a.title}"?`)) return
                await YumeAPI.admin.deleteAnnouncement(a.id)
                U.toast('Hír törölve')
                this.renderAnnouncements(content)
              }
            })
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  /** "2026. 09. 14. óta, határozatlan ideig" — the window in one readable line. */
  announcementWindow (a) {
    const fmt = iso => new Date(iso).toLocaleString(I18n.locale(), { dateStyle: 'medium', timeStyle: 'short' })
    return a.ends_at ? `${fmt(a.starts_at)} — ${fmt(a.ends_at)}` : `${fmt(a.starts_at)} óta, határozatlan ideig`
  },

  /**
   * Write or edit one.
   *
   * `datetime-local` wants a value with no zone and the API speaks ISO, so the
   * two conversions are here rather than spread across the callers.
   */
  announcementForm (content, existing) {
    const toLocal = iso => {
      if (!iso) return ''
      const d = new Date(iso)
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    }
    const toISO = local => (local ? new Date(local).toISOString() : null)

    const title = P.input({ value: existing?.title ?? '', placeholder: 'Rövid cím', maxlength: 200 })
    const body = P.textarea({ placeholder: 'Amit el akarsz mondani. Üres sor választ el két bekezdést.', maxlength: 8000 })
    body.value = existing?.body ?? ''
    const linkLabel = P.input({ value: existing?.link_label ?? '', placeholder: 'pl. Mi változott?', maxlength: 60 })
    const linkUrl = P.input({ value: existing?.link_url ?? '', placeholder: 'https://…', type: 'url' })
    const audience = P.select(
      [['everyone', 'Mindenki'], ['members', 'Belépett tagok'], ['staff', 'Csak a stáb']],
      { value: existing?.audience ?? 'members' }
    )
    const startsAt = P.input({ type: 'datetime-local', value: toLocal(existing?.starts_at) })
    const endsAt = P.input({ type: 'datetime-local', value: toLocal(existing?.ends_at) })

    const error = U.el('p', { class: 'field-error', hidden: true })

    const save = P.button(existing ? 'Mentés' : 'Közzététel', {
      variant: 'primary',
      onclick: async () => {
        error.hidden = true
        // Both or neither: a label with no link is a dead button, and a link
        // with no label has nothing to put on it. The database says so too.
        if (Boolean(linkUrl.value.trim()) !== Boolean(linkLabel.value.trim())) {
          error.textContent = 'A gomb feliratát és a linket együtt kell megadni — vagy egyiket sem.'
          error.hidden = false
          return
        }
        const payload = {
          title: title.value.trim(),
          body: body.value.trim(),
          audience: audience.value,
          linkUrl: linkUrl.value.trim() || null,
          linkLabel: linkLabel.value.trim() || null,
          startsAt: toISO(startsAt.value),
          endsAt: toISO(endsAt.value)
        }
        try {
          if (existing) await YumeAPI.admin.updateAnnouncement(existing.id, payload)
          else await YumeAPI.admin.createAnnouncement(payload)
          U.toast(existing ? 'Hír frissítve' : 'Hír közzétéve')
          backdrop.remove()
          this.renderAnnouncements(content)
        } catch (e) {
          error.textContent = e.message
          error.hidden = false
        }
      }
    })

    const backdrop = P.dialog(existing ? 'Hír szerkesztése' : 'Új hír', [
      U.el('div', { class: 'adm-ann-form' }, [
        P.field('Cím', title),
        P.field('Szöveg', body),
        P.field('Kinek', audience, { hint: 'A „Mindenki" a kijelentkezett látogatókat is jelentené — amíg az oldal privát, ők nem látják.' }),
        P.field('Gomb felirata', linkLabel),
        P.field('Gomb linkje', linkUrl),
        P.field('Mikortól', startsAt, { hint: 'Üresen: azonnal.' }),
        P.field('Meddig', endsAt, { hint: 'Üresen: határozatlan ideig.' }),
        error
      ])
    ], { actions: [P.button('Mégse', { variant: 'ghost', onclick: () => backdrop.remove() }), save], onClose: () => backdrop.remove() })

    document.body.append(backdrop)
    title.focus()
  },

  // ---- fejlesztési napló ---------------------------------------------------

  /**
   * A kiadások szerkesztője.
   *
   * A napló adatbázisból jön, és eddig csak API-n át lehetett írni — vagyis
   * curl-lel vagy migrációval. Egy napló, amihez fejlesztő kell, nem napló,
   * hanem forráskód: a következő sort úgyis akkor írja meg valaki, amikor
   * eszébe jut, nem amikor éppen van nála terminál.
   *
   * Saját jogosultsága van (`changelog.manage`), és nem az admin
   * szerepkörnél ül: aki a naplót írja, annak nem kell tudnia kitiltani
   * senkit.
   */
  CHANGELOG_STATUS: [['planned', 'Tervezett'], ['in_progress', 'Folyamatban'], ['released', 'Kiadva']],
  CHANGELOG_KINDS: [['added', 'Új'], ['changed', 'Változott'], ['fixed', 'Javítva'], ['removed', 'Eltávolítva'], ['security', 'Biztonság']],

  async renderChangelog (content) {
    let data
    try {
      ({ data } = await YumeAPI.changelog.all())
    } catch (e) {
      content.replaceChildren(P.errorState('A napló betöltése nem sikerült: ' + e.message))
      return
    }
    content.replaceChildren()

    content.append(U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-4);margin-bottom:var(--space-4);' }, [
      U.el('p', { class: 'list-row-sub', style: 'max-width:44rem;', text: 'A látogatók a Fejlesztési napló oldalon ezt látják. A nem publikus kiadás itt szerkeszthető, de kifelé nem jelenik meg — ide való minden, ami még nem tartozik senkire.' }),
      U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.changelogForm(content, null) }, [document.createTextNode('+ Új kiadás')])
    ]))

    if (!data.length) {
      content.append(P.emptyState('Még nincs kiadás. Az elsővel kezdődik a napló.'))
      return
    }

    for (const release of data) {
      const statusLabel = (this.CHANGELOG_STATUS.find(([v]) => v === release.status) ?? [])[1] ?? release.status
      const lines = release.entries ?? []
      content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
        U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;' }, [
          U.el('code', { style: 'font-weight:800;', text: release.version }),
          U.el('h3', { style: 'margin:0;', text: release.title }),
          U.el('span', { class: 'ext-type-chip', text: statusLabel }),
          release.is_public ? null : U.el('span', { class: 'badge', style: 'background:var(--bg-sunken);', text: 'nem publikus' }),
          U.el('span', { class: 'list-row-sub', text: `${lines.length} sor` }),
          release.released_on ? U.el('span', { class: 'list-row-sub', text: new Date(release.released_on).toLocaleDateString(I18n.locale()) }) : null
        ]),
        release.summary ? U.el('div', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;', text: release.summary }) : null,
        U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2);' }, [
          U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => this.changelogForm(content, release) }, [document.createTextNode('Szerkesztés')]),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              try {
                await YumeAPI.changelog.update(release.id, { isPublic: !release.is_public })
                U.toast(release.is_public ? 'Kifelé elrejtve' : 'Publikálva')
                this.renderChangelog(content)
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode(release.is_public ? 'Elrejtés' : 'Publikálás')]),
          U.el('button', {
            class: 'btn btn-sm',
            style: 'background:var(--danger);color:white;',
            onclick: async () => {
              if (!window.confirm(`Törlöd a(z) ${release.version} kiadást a soraival együtt?`)) return
              try {
                await YumeAPI.changelog.remove(release.id)
                U.toast('Kiadás törölve')
                this.renderChangelog(content)
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Törlés')])
        ])
      ]))
    }
  },

  /**
   * Egy kiadás űrlapja, a soraival együtt.
   *
   * A sorok a kiadással egy mentésben mennek: a szerver az egész listát
   * cseréli, mert egy részleges egyesítéshez azonosítók kellenének, amiket a
   * szerkesztő nem követ. Fél kiadás rosszabb, mint semmi — egy verziócím,
   * ami alatt nincs semmi.
   */
  changelogForm (content, release) {
    const isEdit = !!release
    const version = U.el('input', { class: 'input', style: 'width:100%;', placeholder: '0.8.1', value: release?.version ?? '' })
    if (isEdit) version.disabled = true // a verzió a kulcs; átnevezni új kiadás
    const title = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Rövid cím', value: release?.title ?? '' })
    const summary = U.el('textarea', { class: 'input', style: 'width:100%;min-height:5rem;', placeholder: 'Egy-két mondat arról, miről szól ez a kiadás' })
    summary.value = release?.summary ?? ''
    const status = U.el('select', { class: 'select' }, this.CHANGELOG_STATUS.map(([v, l]) =>
      U.el('option', { value: v, text: l, ...((release?.status ?? 'planned') === v ? { selected: '' } : {}) })))
    const releasedOn = U.el('input', {
      class: 'input',
      type: 'date',
      value: release?.released_on ? String(release.released_on).slice(0, 10) : ''
    })
    const isPublic = U.el('input', { type: 'checkbox', ...((release?.is_public ?? true) ? { checked: '' } : {}) })

    // ---- sorok ----
    const rows = U.el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-2);' })
    const addRow = (kind = 'added', body = '') => {
      const kindSel = U.el('select', { class: 'select', style: 'flex-shrink:0;' }, this.CHANGELOG_KINDS.map(([v, l]) =>
        U.el('option', { value: v, text: l, ...(kind === v ? { selected: '' } : {}) })))
      const text = U.el('input', { class: 'input', style: 'flex-grow:1;', placeholder: 'Mi történt, egy mondatban', value: body })
      const row = U.el('div', { class: 'cl-row', style: 'display:flex;gap:var(--space-2);align-items:center;' }, [
        kindSel,
        text,
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          title: 'Sor törlése',
          onclick: () => row.remove()
        }, [document.createTextNode('×')])
      ])
      rows.append(row)
    }
    for (const entry of release?.entries ?? []) addRow(entry.kind, entry.body)
    if (!rows.childElementCount) addRow()

    const field = (label, node) => U.el('div', { class: 'filter-group' }, [U.el('label', { text: label }), node])

    const modal = C.modalShell(isEdit ? `${release.version} szerkesztése` : 'Új kiadás', [
      field('Verzió', version),
      field('Cím', title),
      field('Összefoglaló', summary),
      U.el('div', { style: 'display:flex;gap:var(--space-3);flex-wrap:wrap;' }, [
        field('Állapot', status),
        field('Kiadás dátuma', releasedOn)
      ]),
      U.el('label', { style: 'display:flex;align-items:center;gap:var(--space-2);cursor:pointer;' }, [
        isPublic, U.el('span', { text: 'Látszik a látogatóknak' })
      ]),
      U.el('div', {}, [
        U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2);' }, [
          U.el('label', { class: 'filter-group', style: 'display:block;margin:0;', text: 'Sorok' }),
          U.el('button', { class: 'section-more', type: 'button', onclick: () => addRow() }, [document.createTextNode('+ Sor')])
        ]),
        rows
      ])
    ], async () => {
      const entries = [...rows.querySelectorAll('.cl-row')]
        .map(row => ({ kind: row.querySelector('select').value, body: row.querySelector('input').value.trim() }))
        .filter(entry => entry.body)

      const body = {
        title: title.value.trim(),
        summary: summary.value.trim(),
        status: status.value,
        isPublic: isPublic.checked,
        entries
      }
      // Üres dátumot nem küldünk: a séma dátumformátumot vár, és az üres
      // sztring nem az. „Nincs még kiadva" a hiánya, nem egy üres string.
      if (releasedOn.value) body.releasedOn = releasedOn.value
      if (!body.title) return U.toast('A cím kötelező', 'error')
      if (!isEdit && !version.value.trim()) return U.toast('A verzió kötelező', 'error')

      try {
        if (isEdit) await YumeAPI.changelog.update(release.id, body)
        else await YumeAPI.changelog.create({ version: version.value.trim(), ...body })
        U.toast(isEdit ? 'Kiadás frissítve' : 'Kiadás létrehozva')
        modal.close()
        this.renderChangelog(content)
      } catch (e) { U.toast(e.message, 'error') }
    })
  },

  async renderWebhooks (content) {
    try {
      const [{ events }, { data }] = await Promise.all([
        YumeAPI.admin.webhookEvents(),
        YumeAPI.admin.webhooks()
      ])
      content.replaceChildren()

      content.append(U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-4);margin-bottom:var(--space-4);' }, [
        U.el('p', { class: 'list-row-sub', style: 'max-width:40rem;', text: 'A kimenő webhookok azokra az eseményekre szólalnak meg, amikre feliratkoztatod őket. A Discord-végpont beágyazott kártyát kap, az általános végpont aláírt JSON-t.' }),
        U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.webhookForm(content, events, null) }, [document.createTextNode('+ Új webhook')])
      ]))

      if (!data.length) {
        content.append(P.emptyState('Még nincs webhook. Az elsővel kezdenek megérkezni az események.'))
        return
      }

      for (const hook of data) {
        const healthy = hook.enabled && hook.failure_count === 0
        content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
          U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;' }, [
            U.el('span', { style: `width:.6rem;height:.6rem;border-radius:var(--radius-full);background:${healthy ? 'var(--ok)' : hook.enabled ? 'var(--status-paused)' : 'var(--fg-faint)'};` }),
            U.el('h3', { style: 'margin:0;', text: hook.name }),
            U.el('span', { class: 'ext-type-chip', text: hook.format }),
            U.el('span', { class: 'list-row-sub', text: `${hook.events.length} esemény • ${hook.delivery_count} kézbesítés` }),
            hook.last_error ? U.el('span', { class: 'badge', style: 'background:var(--danger);color:white;', text: 'utolsó hiba: ' + hook.last_error }) : null
          ]),
          U.el('div', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;word-break:break-all;', text: hook.url.replace(/\/[^/]+$/, '/•••') }),
          U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2);' }, [
            U.el('button', {
              class: 'btn btn-secondary btn-sm',
              onclick: async e => {
                e.target.disabled = true
                try { await YumeAPI.admin.testWebhook(hook.id); U.toast('Teszt kézbesítve ✓') } catch (err) { U.toast('A teszt nem sikerült: ' + err.message, 'error') } finally { e.target.disabled = false }
              }
            }, [document.createTextNode('Teszt küldése')]),
            // A kézbesítési napló végpontja (és a kliens metódusa) megvolt, és
            // semmi nem használta. „Megkapta-e a bot, és ha nem, miért" — ez a
            // kérdés, amit egy webhook után az ember feltesz, és eddig csak az
            // utolsó hiba egyetlen sora válaszolt rá.
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: e => this.webhookDeliveries(e.target.closest('.setting-card'), hook)
            }, [document.createTextNode('Kézbesítések')]),
            U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.webhookForm(content, events, hook) }, [document.createTextNode('Szerkesztés')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                await YumeAPI.admin.updateWebhook(hook.id, { enabled: !hook.enabled })
                this.renderWebhooks(content)
              }
            }, [document.createTextNode(hook.enabled ? 'Kikapcsolás' : 'Bekapcsolás')]),
            U.el('button', {
              class: 'btn btn-sm',
              style: 'background:var(--danger);color:white;',
              onclick: async () => {
                if (!window.confirm(`Törlöd a(z) „${hook.name}" webhookot?`)) return
                await YumeAPI.admin.deleteWebhook(hook.id)
                U.toast('Webhook törölve')
                this.renderWebhooks(content)
              }
            }, [document.createTextNode('Törlés')])
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  /**
   * A webhook utolsó huszonöt kézbesítése.
   *
   * Egy webhook után egyetlen kérdés van: megkapta-e a bot, és ha nem, miért.
   * Eddig erre az utolsó hiba egyetlen sora válaszolt, a napló pedig — ami a
   * szerveren megvolt, és a kliensben is volt rá metódus — sehol nem látszott.
   *
   * A kártyán belül nyílik, nem külön ablakban: a kérdés ahhoz a webhookhoz
   * tartozik, és egy modális elfedné a mellette lévő állapotjelzőt.
   */
  async webhookDeliveries (card, hook) {
    const existing = card?.querySelector('.wh-deliveries')
    if (existing) { existing.remove(); return }
    if (!card) return

    const box = U.el('div', { class: 'wh-deliveries', style: 'margin-top:var(--space-3);' }, [P.spinner()])
    card.append(box)
    try {
      const { data } = await YumeAPI.admin.webhookDeliveries(hook.id)
      if (!data.length) {
        box.replaceChildren(P.emptyState('Ez a webhook még nem küldött semmit.'))
        return
      }
      const rows = data.map(d => {
        const ok = d.status_code >= 200 && d.status_code < 300
        return U.el('div', { class: 'meta-row' }, [
          U.el('div', { class: 'meta-row-main' }, [
            U.el('div', { class: 'meta-row-title', text: this.EVENT_LABELS[d.event] ?? d.event }),
            U.el('div', { class: 'meta-row-sub', text: d.error ?? U.relTime(new Date(d.created_at)) })
          ]),
          U.el('span', { class: 'meta-row-sub', text: d.duration_ms != null ? `${d.duration_ms} ms` : '' }),
          U.el('span', {
            class: 'badge',
            style: `background:${ok ? 'var(--ok)' : 'var(--danger)'};color:white;`,
            text: d.status_code ? String(d.status_code) : 'nincs válasz'
          })
        ])
      })
      box.replaceChildren(
        U.el('div', { class: 'list-row-sub', style: 'margin-bottom:var(--space-2);', text: `Az utolsó ${data.length} kézbesítés, legújabb elöl` }),
        U.el('div', { class: 'meta-rows' }, rows)
      )
    } catch (e) {
      box.replaceChildren(P.errorState(e.message))
    }
  },

  webhookForm (content, events, hook) {
    const isEdit = !!hook
    const name = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Név', value: hook?.name ?? '' })
    const url = U.el('input', { class: 'input', type: 'url', style: 'width:100%;', placeholder: 'https://discord.com/api/webhooks/…', value: hook?.url ?? '' })
    const format = U.el('select', { class: 'select' }, [
      U.el('option', { value: 'discord', text: 'Discord (beágyazott kártya)', ...(hook?.format !== 'json' ? { selected: '' } : {}) }),
      U.el('option', { value: 'json', text: 'Általános JSON (HMAC-aláírt)', ...(hook?.format === 'json' ? { selected: '' } : {}) })
    ])

    /*
     * Az aláíró titok.
     *
     * A szerver mindig is elfogadta, és a JSON-kézbesítés ezzel írja alá a
     * csomagot — a fogadó ebből tudja, hogy tőlünk jött, és nem bárkitől, aki
     * ismeri a webhook címét. A felületen viszont nem volt hozzá mező, tehát
     * az egész aláírás elérhetetlen maradt.
     *
     * A meglévő értéket nem tudjuk visszaírni ide: a lista sosem adja vissza a
     * titkot (helyesen). Az üres mező ezért „ne változtass"-t jelent, nem
     * „töröld" — a mentés csak akkor küldi, ha írtak bele.
     */
    const secret = U.el('input', {
      class: 'input',
      type: 'password',
      style: 'width:100%;',
      autocomplete: 'new-password',
      placeholder: isEdit ? 'Változatlan marad, ha üresen hagyod' : 'Nem kötelező'
    })
    const secretHint = U.el('p', {
      class: 'list-row-sub',
      style: 'margin:var(--space-1) 0 0;',
      text: 'Csak az általános JSON-hoz: ezzel írjuk alá a csomagot (X-Yume-Signature), és a fogadó ebből tudja, hogy tőlünk jött. A Discord nem használja.'
    })

    const subscribed = new Set(hook?.events ?? events) // new hooks default to all events
    const checkboxes = events.map(ev => {
      const cb = U.el('input', { type: 'checkbox', value: ev, ...(subscribed.has(ev) ? { checked: '' } : {}) })
      return U.el('label', { style: 'display:flex;gap:var(--space-2);align-items:center;font-size:var(--text-xs);padding:var(--space-1) 0;cursor:pointer;' }, [
        cb, U.el('span', {}, [document.createTextNode(this.EVENT_LABELS[ev] ?? ev), U.el('code', { style: 'color:var(--fg-faint);margin-left:var(--space-2);font-family:var(--font-mono);font-size:var(--text-xs);', text: ev })])
      ])
    })
    const eventGrid = U.el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:var(--space-1) var(--space-3);margin-top:var(--space-2);' }, checkboxes)

    const toggleAll = on => checkboxes.forEach(l => { l.querySelector('input').checked = on })

    const modal = C.modalShell(isEdit ? 'Webhook szerkesztése' : 'Új webhook', [
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Név' }), name]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Cím (URL)' }), url]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Formátum' }), format]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Aláíró titok' }), secret, secretHint]),
      U.el('div', {}, [
        U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
          U.el('label', { class: 'filter-group', style: 'display:block;', text: 'Események' }),
          U.el('div', {}, [
            U.el('button', { class: 'section-more', style: 'margin-right:var(--space-3);', onclick: () => toggleAll(true) }, [document.createTextNode('Mind')]),
            U.el('button', { class: 'section-more', onclick: () => toggleAll(false) }, [document.createTextNode('Egyik sem')])
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
      // Üres mező = ne változtass. A titkot sosem olvassuk vissza, tehát egy
      // üres érték elküldve azt törölné, amit az operátor nem is látott.
      if (secret.value.trim()) body.secret = secret.value.trim()
      if (!body.name || !body.url) return U.toast('A név és a cím kötelező', 'error')
      try {
        if (isEdit) await YumeAPI.admin.updateWebhook(hook.id, body)
        else await YumeAPI.admin.createWebhook(body)
        U.toast(isEdit ? 'Webhook frissítve' : 'Webhook létrehozva')
        modal.close()
        this.renderWebhooks(content)
      } catch (e) { U.toast(e.message, 'error') }
    })
  }
}
