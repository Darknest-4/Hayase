/* global document, window */
// Admin — Áttekintés.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('overview')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { navigate } from '../../../shared/lib/shell.js'
import { Charts } from '../../../shared/ui/charts.js'
import { AP } from '../../../shared/ui/admin-ui.js'
import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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

  // ---- system health ----

  /** The metrics worth a line on the overview, in the order they matter. */
  HEALTH_ROWS: [
    ['db.latency_ms', 'Adatbázis', 'egy SELECT 1 körbefordulása', '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>'],
    ['api.latency_ms', 'API', 'a /v1/health saját mérése', '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
    ['cpu.usage_pct', 'Processzor', 'tartós terhelés', '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'],
    ['mem.used_pct', 'Memória', 'a MemAvailable alapján', '<rect x="3" y="8" width="18" height="10" rx="2"/><path d="M7 8V6M12 8V6M17 8V6"/>'],
    ['disk.used_pct', 'Lemez', 'a fájlrendszerből használt', '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11"/><path d="M6 16h.01"/>'],
    ['queue.pending', 'Feladatsor', 'futtatható feladatok', '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>'],
    ['queue.dead', 'Elhasalt feladatok', 'elfogytak a próbálkozásaik', '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'],
    ['backup.age_hours', 'Utolsó mentés', 'ellenőrizve, visszaállítható', '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>']
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
    // Óra helyett nap, ha már napokban mérhető: „73ó" senkinek nem mond
    // semmit, „3 napja" igen.
    if (metric.unit === 'hours') return value < 48 ? Math.round(value) + 'ó' : Math.round(value / 24) + ' nap'
    return value.toLocaleString(I18n.locale())
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

  goto (key) {
    window.location.hash = `#/admin?s=${key}`
    navigate()
  }
}
