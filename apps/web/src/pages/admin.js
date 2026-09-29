/* global document, history, window */

import { site } from '../shared/lib/site-config.js'
import { C } from '../shared/ui/components.js'
import { I18n } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { ADMIN_GROUPS, ADMIN_SECTIONS } from '../shared/lib/admin-sections.js'
import '../shared/api/yume-admin.js'

/**
 * Szakasz → a modulja. A szakaszok kódja csak megnyitáskor töltődik le; lásd
 * `loadSection`. A kulcsok az ADMIN_SECTIONS kulcsai (shared/lib/admin-sections.js).
 */
const SECTION_MODULES = {
  roles: () => import('../features/admin/sections/roles.js'),
  errors: () => import('../features/admin/sections/errors.js'),
  'audit-log': () => import('../features/admin/sections/audit-log.js'),
  analytics: () => import('../features/admin/sections/analytics.js'),
  edge: () => import('../features/admin/sections/edge.js'),
  backups: () => import('../features/admin/sections/backups.js'),
  maintenance: () => import('../features/admin/sections/maintenance.js'),
  security: () => import('../features/admin/sections/security.js'),
  config: () => import('../features/admin/sections/config.js'),
  catalogue: () => import('../features/admin/sections/catalogue.js'),
  translations: () => import('../features/admin/sections/translations.js'),
  monitoring: () => import('../features/admin/sections/monitoring.js'),
  themes: () => import('../features/admin/sections/themes.js'),
  metadata: () => import('../features/admin/sections/metadata.js'),
  overview: () => import('../features/admin/sections/overview.js'),
  audit: () => import('../features/admin/sections/audit.js'),
  users: () => import('../features/admin/sections/users.js'),
  reports: () => import('../features/admin/sections/reports.js'),
  webhooks: () => import('../features/admin/sections/webhooks.js'),
  announcements: () => import('../features/admin/sections/announcements.js'),
  changelog: () => import('../features/admin/sections/changelog.js'),
  providers: () => import('../features/admin/sections/providers.js')
}

export const PageAdmin = {
  /**
   * The admin surface, grouped.
   *
   * A flat list of eight was already at the point where finding something
   * meant reading all of it, and two more were waiting to be added. The groups
   * are how the work actually divides: what is happening right now, who is
   * doing it, what they are doing it to, and how the machine underneath is.
   */

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
  GROUPS: ADMIN_GROUPS,

  SECTIONS: ADMIN_SECTIONS,

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
      /*
       * MINDEN SZEKCIÓ SAJÁT TARTÓT KAP — és ez a javítás lényege.
       *
       * Korábban minden renderelő UGYANAZT a `body` elemet kapta, és csak a
       * tartalmát cserélte. Három szekció — Áttekintés, Metaadatok,
       * Infrastruktúra — viszont `setInterval`-lal frissíti magát, és így
       * védekezik:
       *
       *     if (!document.body.contains(content)) { clearInterval(...); return }
       *
       * Ez az őr azt feltételezi, hogy a tartó a navigációkor KIKERÜL a
       * dokumentumból. A `body` viszont sosem került ki — csak a gyerekei
       * cserélődtek —, tehát a feltétel SOHA nem lett igaz. Az időzítő ment
       * tovább, és öt, harminc, illetve `DASH_REFRESH_MS` másodpercenként
       * rárajzolta a régi szekció felületét arra, amit az üzemeltető épp
       * nézett. Pontosan ez volt a bejelentett hiba: „egy idő után visszajön
       * a kezdőlap UI-ja". A lap frissítése azért segített, mert az időzítőt
       * is eldobta — az első visszalátogatásig.
       *
       * Egy friss tartóval a csere valódi leválasztás: a régi elem kikerül a
       * dokumentumból, az őr a következő ébredésekor igazzá válik, és az
       * időzítő leállítja magát. A három szekció kódjához nem kell nyúlni —
       * a feltevésük innentől igaz.
       */
      const pane = U.el('div', { class: 'admin-pane' }, [P.spinner()])
      body.replaceChildren(pane)
      // A szakasz kódja csak most töltődik le (loadSection); addig a tartó
      // pörgettyűt mutat. Ha a letöltés elbukik (hálózat, vagy egy régi lap egy
      // új telepítés után), a tartó ezt mondja ki, újrapróbálással — nem pörög
      // örökké.
      this.loadSection(s.key)
        .then(() => this[s.render](pane))
        .catch(error => pane.replaceChildren(C.errorState(error, () => select(s))))
    }
    select(state.section)
  },

  /** Rövid idő emberi alakban: 0:00-s másodperceket senki nem olvas. */
  analyticsDuration (seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0))
    if (s < 60) return s + ' mp'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} p ${String(s % 60).padStart(2, '0')} mp`
    return `${Math.floor(m / 60)} ó ${String(m % 60).padStart(2, '0')} p`
  },
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

  dayLabel (day) {
    const date = new Date(day)
    // A böngésző nyelve helyett a felületé: a panel magyar, a hónapnevek is
    // azok legyenek.
    return date.toLocaleDateString(I18n.locale(), { month: 'short', day: 'numeric' })
  },

  /**
   * Egy szakasz kódja — csak amikor valaki megnyitja.
   *
   * A panel 6700 sora eddig egyben töltődött, akármelyik szakaszra jött az
   * admin. A szakaszok metódusai most a saját moduljukban vannak
   * (features/admin/sections/), és megnyitáskor ide olvadnak be: a `this`
   * mindenhol a PageAdmin marad, a közös segédek innen érhetők el.
   */
  async loadSection (key) {
    if (this._sections.has(key)) return
    const load = SECTION_MODULES[key]
    if (!load) return
    Object.assign(this, (await load()).default)
    this._sections.add(key)
  },

  /** A már beolvasztott szakaszok. */
  _sections: new Set()
}
