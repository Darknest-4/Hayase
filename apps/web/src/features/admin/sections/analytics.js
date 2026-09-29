/* global document */
// Admin — Látogatottság.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('analytics')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { Charts } from '../../../shared/ui/charts.js'
import { AP } from '../../../shared/ui/admin-ui.js'
import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
    ['overview', 'Áttekintés'],
    ['visitors', 'Látogatók'],
    ['anime', 'Címek'],
    ['search', 'Keresés'],
    ['users', 'Fiókok'],
    ['devices', 'Eszközök'],
    ['performance', 'Teljesítmény'],
    ['providers', 'Szolgáltatók'],
    ['health', 'Rendszer'],
    ['timeseries', 'Idősor'],
    ['quality', 'Adatminőség']
  ],

  ANALYTICS_RANGES: [
    ['today', 'Ma'], ['yesterday', 'Tegnap'], ['7d', '7 nap'],
    ['30d', '30 nap'], ['90d', '90 nap'], ['365d', 'Egy év']
  ],

  async renderAnalytics (content) {
    const state = {
      tab: this._analyticsTab ?? 'overview',
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
  /**
   * @param display ha meg van adva, EZ jelenik meg a szám helyett.
   *
   * MIÉRT KELL. A `Number(value) || 0` egy „—" jelet NULLÁRA alakít, és a
   * kártya „0"-t ír ki. Egy hibaaránynál ez a legrosszabb lehetséges
   * hazugság: a „0%" azt állítja, hogy mérünk és minden rendben, pedig
   * nincs adat. Mérve: ha a megszakító minden szolgáltatót kizárt, minden
   * kísérlet `skipped`, és a kártya „0%"-ot mutatott.
   */
  analyticsKpi (label, value, previous, { tone = 'blue', icon = '<circle cx="12" cy="12" r="10"/>', suffix = '', display = null } = {}) {
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
        U.el('div', {
          class: 'dash-kpi-value',
          text: display != null ? String(display) : now.toLocaleString(I18n.locale()) + suffix
        }),
        U.el('div', { class: 'dash-kpi-label', text: label }),
        U.el('div', { class: 'dash-kpi-delta dash-kpi-' + dir }, [
          U.el('span', { class: 'dash-kpi-arrow', text: delta == null ? '—' : (delta > 0 ? '+' : '') + delta + '%' }),
          U.el('span', { class: 'dash-kpi-compare', text: delta == null ? 'nincs mihez mérni' : 'az előző időszakhoz' })
        ])
      ])
    ])
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

  /**
   * Állapotlista — címke, állapotjelölő, és egy tördelhető részletsor.
   *
   * MIÉRT NEM AZ `analyticsTable`. Az rangsorol: számot vár, és abból
   * százalékos sávot rajzol. Egy komponens állapotának nincs ilyen száma, és
   * egy szolgáltató kimenet-bontásának sincs. A kettőt egy sablonba
   * kényszerítve `NaN` lett belőle a panelen.
   *
   * A RÉSZLETSOR TÖRDELHETŐ. A rangsoros lista jobb oszlopa `nowrap`, és egy
   * hosszabb felsorolás ott szétfeszíti a sort — mérve, 390 képpontos
   * telefonon 623 képpontig ért.
   */
  statusList (items, empty = 'Nincs adat.') {
    if (!items.length) return P.emptyState(empty)
    const wrap = U.el('div', { class: 'meta-rows' })
    for (const item of items) {
      wrap.append(U.el('div', { class: 'meta-row backup-row', style: 'align-items:flex-start;' }, [
        U.el('div', { class: 'meta-row-main', style: 'min-width:0;' }, [
          AP.tag(item.label, item.tone ?? ''),
          U.el('div', {
            class: 'meta-row-sub',
            style: 'margin-top:4px;white-space:normal;overflow-wrap:anywhere;',
            text: item.detail ?? ''
          })
        ])
      ]))
    }
    return wrap
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

    /*
     * A KERESÉS → MEGNYITÁS ARÁNYA. Ez az egyetlen szám, ami megmondja, hogy
     * a keresés MŰKÖDIK-E: nem az számít, hányan kerestek, hanem hogy hányan
     * találták meg, amit kerestek.
     *
     * NULLA KERESÉSNÉL NINCS ARÁNY, nem nulla százalék — és ha a mérés az
     * időszak után indult, azt is kiírjuk. Egy régi időszakban a nulla nem
     * azt jelenti, hogy senki nem kattintott, hanem hogy akkor még nem
     * mértük.
     */
    const konv = data.conversion ?? {}
    body.append(U.el('div', { class: 'dash-cards' }, [
      this.analyticsKpi('Keresés', konv.searches ?? 0, null,
        { tone: 'blue', icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>' }),
      this.analyticsKpi('Találatra kattintás', konv.opens ?? 0, null,
        { tone: 'green', icon: '<path d="m9 11 3 3 8-8"/>' }),
      this.analyticsKpi('Megtalálási arány', konv.rate ?? 0, null, {
        tone: konv.rate == null ? 'amber' : konv.rate < 30 ? 'red' : 'green',
        suffix: '%',
        ...(konv.rate == null ? { display: 'nincs adat' } : {}),
        icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>'
      })
    ]))

    if (!konv.since) {
      body.append(U.el('p', {
        class: 'list-row-sub',
        style: 'margin:0 0 var(--space-4);max-width:44rem;',
        text: 'A találatra kattintást még nem mértük egyszer sem. Az első kattintással indul — visszamenőleg nincs adat.'
      }))
    } else {
      body.append(U.el('p', {
        class: 'list-row-sub',
        style: 'margin:0 0 var(--space-4);max-width:44rem;',
        text: `A találatra kattintás mérése ${konv.since} óta tart. Az ennél korábbi időszakokban a nulla nem azt ` +
          'jelenti, hogy senki nem kattintott, hanem hogy akkor még nem mértük.'
      }))
    }

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

  /**
   * A szolgáltatólánc.
   *
   * A SORREND AZ, AHOGY EGY ÜZEMELTETŐ VÉGIGMEGY RAJTA: „mennyire rossz?",
   * „melyik szolgáltatónál?", „mikor romlott el?". Ezért van elöl a hibaarány,
   * utána a szolgáltatónkénti bontás, és leghátul az eseménynapló.
   */
  /**
   * ÁTTEKINTÉS — az első fül, mert ezért nyitja meg valaki a panelt.
   *
   * Nem új mérés: a meglévő összesítőkből áll össze, EGY kérésben. A
   * részletezés a többi fülön marad; ide az kerül, amiből egy pillantás
   * alatt eldönthető, hogy minden rendben van-e.
   *
   * A „MIÓTA MÉRÜNK" SOR NEM DÍSZ. Egy éves nézet nem azért üres, mert
   * elromlott valami, hanem mert a gyűjtés szeptemberben indult. Enélkül a
   * panel minden hosszú tartományon hibásnak látszik.
   */
  async analyticsOverview (body, range) {
    const d = await YumeAPI.admin.analytics.summary(range)
    body.replaceChildren()

    const p = d.period ?? {}
    const elozo = d.previous ?? {}
    const kat = d.catalogue ?? {}

    body.append(U.el('div', { class: 'dash-cards' }, [
      this.analyticsKpi('Munkamenet', p.sessions, elozo.sessions,
        { tone: 'blue', icon: '<path d="M4 12h16"/><path d="M12 4v16"/>' }),
      this.analyticsKpi('Oldalletöltés', p.page_views, elozo.page_views,
        { tone: 'blue', icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' }),
      this.analyticsKpi('Regisztráció', p.registrations, elozo.registrations,
        { tone: 'green', icon: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/>' }),
      this.analyticsKpi('Epizód indítás', p.episode_starts, null,
        { tone: 'amber', icon: '<path d="m5 3 14 9-14 9V3z"/>' })
    ]))

    /*
     * A KATALÓGUS SZÁMAI KÜLÖN SORBAN, és NINCS mellettük „az előző
     * időszakhoz" nyíl. Ezek ÁLLAPOTOK, nem időszaki mérőszámok: harmincezer
     * anime nem „több, mint múlt héten" — egyszerűen ennyi van.
     */
    body.append(U.el('div', { class: 'dash-cards' }, [
      this.analyticsKpi('Anime', kat.anime, null, { tone: 'blue', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/>' }),
      this.analyticsKpi('Epizód', kat.episodes, null, { tone: 'blue', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' }),
      this.analyticsKpi('Felhasználó', kat.users, null, { tone: 'green', icon: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/>' }),
      this.analyticsKpi('Új fiók (30 nap)', kat.new_users, null, { tone: 'amber', icon: '<path d="M12 5v14M5 12h14"/>' })
    ]))

    const cov = d.coverage ?? {}
    body.append(U.el('p', {
      class: 'list-row-sub',
      style: 'margin:var(--space-2) 0 var(--space-4);',
      text: cov.since
        ? `Az adatgyűjtés ${cov.since} óta tart — összesen ${cov.days} nap. ` +
          'Az ennél hosszabb tartományok ugyanezt az időszakot mutatják, nem hiányzó adatot.'
        : 'Még nincs egyetlen összesített nap sem. A panel az első összesítés után mutat számokat.'
    }))

    const also = U.el('div', { class: 'dash-lower' })

    const top = d.topAnime ?? []
    also.append(this.dashPanel({
      title: 'Legnézettebb címek',
      sub: 'ebben az időszakban',
      body: this.analyticsTable(top.map(t => [t.title, String(t.views)]),
        { head: ['Cím', 'Megtekintés'], empty: 'Ebben az időszakban egyetlen címnél sem mértünk megtekintést.' })
    }))

    const sz = d.providers ?? {}
    const szKerdezve = Number(sz.attempts) || 0
    const szHiba = Number(sz.failures) || 0
    const svc = d.services ?? {}
    also.append(this.dashPanel({
      title: 'A rendszer állapota',
      sub: 'szolgáltatók és komponensek',
      body: this.statusList([
        {
          label: 'Forrásszolgáltatók',
          tone: szKerdezve === 0 ? '' : szHiba > 0 ? 'warn' : 'ok',
          detail: szKerdezve === 0
            ? 'ebben az időszakban egyetlen kérés sem futott'
            : `${sz.providers} szolgáltató · ${szKerdezve} kérés · ${szHiba} hiba`
        },
        {
          label: 'Komponensek',
          tone: Number(svc.problem) > 0 ? 'bad' : 'ok',
          detail: `${svc.green ?? 0} rendben · ${svc.problem ?? 0} hibás · ${svc.off ?? 0} nincs bekapcsolva`
        },
        {
          label: 'Hibák a naplóban',
          tone: Number(p.errors) > 0 ? 'warn' : 'ok',
          detail: `${p.errors ?? 0} hiba · ${p.days_with_data ?? 0} nap adata`
        }
      ], 'Nincs állapotadat.')
    }))
    body.append(also)
  },

  /** Az idősor fül mérőszámai. A kulcs a végpont fehérlistájával egyezik. */
  TIMESERIES_METRICS: [
    ['sessions', 'Munkamenet'], ['visitors', 'Látogató'], ['page_views', 'Oldalletöltés'],
    ['registrations', 'Regisztráció'], ['logins', 'Belépés'], ['searches', 'Keresés'],
    ['episode_starts', 'Epizód indítás'], ['episode_completions', 'Epizód befejezés'],
    ['watch_seconds', 'Nézett másodperc'], ['errors', 'Hiba'],
    ['zero_result_searches', 'Nulla találatú keresés']
  ],

  /** Amelyik mérőszám csak napi bontásban létezik — a végpont ugyanezt mondja. */
  TIMESERIES_DAY_ONLY: ['errors', 'zero_result_searches'],

  TIMESERIES_GRANULARITY: [['day', 'Napi'], ['week', 'Heti'], ['month', 'Havi']],

  /**
   * IDŐSOR — egy mérőszám, szabadon választott bontásban.
   *
   * A HETI ÉS HAVI NEM A NAPI SOROK ÖSSZEGE a felületen: külön összesítőből
   * jön (`analytics_periods`). Ennek egy látható következménye van, és ezt ki
   * is írjuk: a heti „látogató" a napi egyediek ÖSSZEGE, nem heti egyedi
   * látogató — a napi sóval képzett kulcsból az utóbbi nem áll elő.
   *
   * A BEFEJEZETLEN IDŐSZAK MEG VAN JELÖLVE. Egy folyamatban lévő hét
   * oszlopa különben mindig „visszaesésnek" látszana.
   */
  async analyticsTimeseries (body, range) {
    const state = {
      metric: this._tsMetric ?? 'sessions',
      granularity: this._tsGranularity ?? 'day'
    }

    const rajzol = async () => {
      this._tsMetric = state.metric
      this._tsGranularity = state.granularity
      body.replaceChildren(P.spinner())

      // A csak-napi mérőszámok nem kérhetők heti bontásban; a végpont 400-at
      // adna. A felület ezt előre tudja, és nem küld olyan kérést.
      if (state.granularity !== 'day' && this.TIMESERIES_DAY_ONLY.includes(state.metric)) {
        state.granularity = 'day'
      }

      const valaszto = (ertekek, aktiv, onValt) =>
        U.el('div', { class: 'dash-ranges' }, ertekek.map(([value, label]) =>
          U.el('button', {
            class: 'dash-range' + (aktiv === value ? ' active' : ''),
            type: 'button',
            onclick: () => onValt(value)
          }, [document.createTextNode(label)])))

      let d
      try {
        d = await YumeAPI.admin.analytics.timeseries(range, state.metric, state.granularity)
      } catch (e) {
        body.replaceChildren(P.errorState('Az idősor betöltése nem sikerült: ' + e.message))
        return
      }

      const sorok = d.data ?? []
      const vezerlok = U.el('div', { style: 'display:flex;gap:var(--space-3);flex-wrap:wrap;margin-bottom:var(--space-4);' }, [
        valaszto(this.TIMESERIES_METRICS, state.metric, v => { state.metric = v; rajzol() }),
        valaszto(
          this.TIMESERIES_GRANULARITY.filter(([g]) => g === 'day' || !this.TIMESERIES_DAY_ONLY.includes(state.metric)),
          state.granularity, v => { state.granularity = v; rajzol() })
      ])

      body.replaceChildren(vezerlok)

      if (!sorok.length) {
        body.append(P.emptyState('Ebben a tartományban nincs összesített adat.'))
        return
      }

      const ertekek = sorok.map(r => Number(r.value) || 0)
      const cimkek = sorok.map(r => state.granularity === 'day' ? this.dayLabel(r.at) : r.at)

      body.append(this.dashPanel({
        title: d.label ?? state.metric,
        sub: (this.TIMESERIES_GRANULARITY.find(([g]) => g === state.granularity) ?? [])[1] + ' bontás',
        wide: true,
        body: Charts.lines([{ name: d.label ?? state.metric, values: ertekek, color: 'var(--accent)' }],
          { labels: cimkek, label: 'Idősor', height: 210 })
      }))

      const osszeg = ertekek.reduce((a, b) => a + b, 0)
      const atlag = Math.round(osszeg / ertekek.length)
      body.append(U.el('div', { class: 'dash-cards' }, [
        this.analyticsKpi('Összesen', osszeg, null, { tone: 'blue', icon: '<path d="M4 12h16"/>' }),
        this.analyticsKpi('Átlag / időszak', atlag, null, { tone: 'blue', icon: '<path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/>' }),
        this.analyticsKpi('Csúcs', Math.max(...ertekek), null, { tone: 'amber', icon: '<path d="m3 17 6-6 4 4 8-8"/>' })
      ]))

      // A RÉSZLETES SOROK — a grafikon melletti szám, mert egy görbéről nem
      // lehet leolvasni, hogy kedden pontosan mennyi volt.
      body.append(this.dashPanel({
        title: 'Számokban',
        sub: state.granularity === 'day' ? 'naponként' : 'időszakonként',
        wide: true,
        body: this.analyticsTable(
          sorok.slice().reverse().map(r => [
            state.granularity === 'day' ? r.at : r.at + (r.complete === false ? ' (folyamatban)' : ''),
            String(Number(r.value) || 0),
            r.days_counted != null ? `${r.days_counted} nap` : ''
          ]),
          { head: ['Időszak', 'Érték'], empty: 'Nincs adat.' })
      }))

      if (state.granularity !== 'day' && state.metric === 'visitors') {
        body.append(U.el('p', {
          class: 'list-row-sub',
          style: 'margin-top:var(--space-3);',
          text: 'Heti és havi bontásban ez a napi EGYEDI látogatók összege, nem heti egyedi látogató: ' +
            'a látogatói kulcs naponta cserélődik, tehát aki két napon itt járt, ebben kettő. ' +
            'Napokon átívelően csak a bejelentkezett felhasználók számolhatók pontosan.'
        }))
      }
    }

    await rajzol()
  },

  /**
   * ADATMINŐSÉG — ez a fül a panel őszintesége.
   *
   * Minden más nézet számokat mutat; ez azt mutatja meg, mennyit érnek.
   * Három kérdésre válaszol: mióta van adat, van-e lyuk az összesítőben, és
   * meddig őrizzük a nyers sorokat. A harmadik azért fontos, mert a
   * megőrzési idő letelte után bizonyos számok már nem számolhatók újra.
   */
  async analyticsQuality (body) {
    const d = await YumeAPI.admin.analytics.dataQuality()
    body.replaceChildren()

    const forrasok = d.sources ?? []
    const ures = forrasok.filter(f => f.rows === 0)
    const lyukak = d.gaps ?? []

    body.append(U.el('div', { class: 'dash-cards' }, [
      this.analyticsKpi('Adatforrás', forrasok.length, null,
        { tone: 'blue', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/>' }),
      this.analyticsKpi('Üres forrás', ures.length, null, {
        tone: ures.length > 0 ? 'amber' : 'green',
        icon: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'
      }),
      this.analyticsKpi('Hiányzó nap (30)', lyukak.length, null, {
        tone: lyukak.length > 0 ? 'red' : 'green',
        icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'
      }),
      this.analyticsKpi('Utolsó összesítés', 0, null, {
        tone: d.lastRollupAt ? 'green' : 'red',
        display: d.lastRollupAt ? new Date(d.lastRollupAt).toLocaleString('hu-HU') : 'soha',
        icon: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'
      })
    ]))

    /*
     * A LYUKAK KÜLÖN PANELBEN, és a hiányzó nap NEM ugyanaz, mint a nulla
     * forgalmú nap: az elsőnél nem futott le az összesítő, a másodiknál
     * lefutott, és nulla volt az eredmény. A panel csak az elsőt sorolja fel.
     */
    if (lyukak.length) {
      body.append(this.dashPanel({
        title: 'Hiányzó napok',
        sub: 'ezekre a napokra nincs összesítő sor',
        wide: true,
        body: U.el('div', {}, [
          U.el('p', {
            class: 'list-row-sub',
            text: 'Ez nem „nulla forgalmú nap": arra is van sor, nullákkal. Ezekre a napokra az ' +
              'összesítő nem futott le — leállt worker, vagy a rendszer akkor még nem gyűjtött.'
          }),
          U.el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--space-2);margin-top:var(--space-3);' },
            lyukak.map(nap => AP.tag(nap, 'warn')))
        ])
      }))
    }

    body.append(this.dashPanel({
      title: 'Adatforrások',
      sub: 'mit gyűjtünk, mióta, és meddig őrizzük',
      wide: true,
      body: this.statusList(forrasok.map(f => ({
        label: f.label,
        tone: f.rows === 0 ? 'warn' : 'ok',
        detail: [
          f.rows === 0 ? 'nincs egyetlen sor sem' : `${Number(f.rows).toLocaleString(I18n.locale())} sor`,
          f.firstAt ? `${String(f.firstAt).slice(0, 10)} — ${String(f.lastAt).slice(0, 10)}` : null,
          f.retentionDays ? `${f.retentionDays} nap megőrzés` : 'összesítő, nem nyesődik',
          f.table
        ].filter(Boolean).join(' · ')
      })), 'Nincs adatforrás.')
    }))
  },

  async analyticsProviders (body, range) {
    const data = await YumeAPI.admin.analytics.providers(range)
    body.replaceChildren()

    const totals = data.totals ?? []
    if (!totals.length) {
      /*
       * ÜRES ÁLLAPOT, NEM NULLÁK. A mérés a szolgáltatói lánc első
       * használatakor indul; addig a „0% hiba" azt sugallná, hogy minden
       * rendben — pedig egyszerűen nincs adat.
       */
      body.append(P.emptyState(
        'Ebben az időszakban egyetlen szolgáltatói kérés sem futott. ' +
        'A mérés az első feloldásnál indul.'))
      return
    }

    // Összesített fejszámok. A hibaarányba SEM az `empty`, SEM a `skipped`
    // nem számít bele — lásd a végpont megjegyzését.
    const sum = (k) => totals.reduce((a, t) => a + (Number(t[k]) || 0), 0)
    const kerdezett = sum('ok') + sum('empty') + sum('errors') + sum('timeouts')
    const hibas = sum('errors') + sum('timeouts')
    const arany = kerdezett > 0 ? (hibas / kerdezett) * 100 : null

    body.append(U.el('div', { class: 'dash-cards' }, [
      this.analyticsKpi('Kérések', kerdezett, null, { tone: 'blue', icon: '<path d="M4 12h16"/><path d="M12 4v16"/>' }),
      this.analyticsKpi('Forrást adott', sum('ok'), null, { tone: 'green', icon: '<path d="M20 6 9 17l-5-5"/>' }),
      this.analyticsKpi('Hiba és időtúllépés', hibas, null, { tone: 'red', icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>' }),
      /*
       * A hibaarány NULLA KÉRDEZETT KÉRÉSNÉL nem nulla százalék, hanem
       * „nincs adat". Egy 0%-os kártya azt állítaná, hogy mérünk, és
       * minden rendben.
       */
      // EGY TIZEDES. A `toLocaleString` különben teljes pontossággal ír ki
      // (`4,278%`), ami egy arányszámnál álpontosság.
      this.analyticsKpi('Hibaarány', arany === null ? 0 : Math.round(arany * 10) / 10, null, {
        tone: arany !== null && arany > 20 ? 'red' : 'amber',
        suffix: '%',
        // Nulla KÉRDEZETT kérésnél nincs értelmezhető arány. Ilyenkor nem
        // „0%", hanem „nincs adat" — lásd `analyticsKpi` megjegyzését.
        ...(arany === null ? { display: 'nincs adat' } : {}),
        icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>'
      })
    ]))

    const lower = U.el('div', { class: 'dash-lower' })
    lower.append(this.dashPanel({
      title: 'Szolgáltatók',
      sub: 'kérésszám szerint',
      body: this.analyticsTable(
        /*
         * A KIEGÉSZÍTŐ SZÖVEG RÖVID, és ez nem stílus. Az `analyticsTable`
         * jobb oszlopa `white-space: nowrap` — mérve, egy hosszú
         * felsorolással a sor 623 képpontig ért egy 390-es telefonon, és
         * levágódott. A részletes bontás a lenti panelbe került.
         */
        totals.map(t => {
          const kerdezve = (t.ok || 0) + (t.empty || 0) + (t.errors || 0) + (t.timeouts || 0)
          const hiba = (t.errors || 0) + (t.timeouts || 0)
          const pct = kerdezve > 0 ? ((hiba / kerdezve) * 100).toFixed(1) + '%' : '—'
          return [t.slug, String(t.attempts), `${pct} hiba · ${t.latency_avg} ms`]
        }),
        { head: ['Szolgáltató', 'Kísérlet'], empty: 'Nincs mérés ebben az időszakban.' })
    }))

    /*
     * A PERCENTILISEK — és miért „≤".
     *
     * Az átlag és a csúcs együtt sem mondja meg, milyen egy szolgáltató:
     * száz kérésből kilencvenkilenc 200 ms alatt és egy tíz másodpercben
     * ugyanazt az átlagot adja, mint a mind-300-ms-körül. Az elsőt a néző
     * észre sem veszi, a másodiknál minden epizódnál vár.
     *
     * A szám VÖDRÖKBŐL jön, tehát felső korlát: „a kérések 95%-a ennyi
     * alatt volt". Egy pontosnak látszó `487 ms` itt találgatás lenne, és a
     * felirat ezért írja ki a relációjelet.
     */
    const percentilisek = (data.percentiles ?? []).filter(p => p.samples > 0)
    if (percentilisek.length) {
      lower.append(this.dashPanel({
        title: 'Válaszidő-eloszlás',
        sub: 'felső korlát, vödrökből számolva',
        body: this.statusList(percentilisek.map(p => ({
          label: p.slug,
          tone: (p.p95 ?? 0) > 5000 ? 'warn' : 'ok',
          detail: `medián ≤ ${p.p50} ms · p95 ≤ ${p.p95} ms · p99 ≤ ${p.p99} ms · ${p.samples} mérés`
        })), 'Nincs mérés ebben az időszakban.')
      }))
    }

    lower.append(this.dashPanel({
      title: 'Kimenetek',
      sub: 'szolgáltatónként, a lánc saját szótárával',
      body: this.statusList(totals.map(t => ({
        label: t.slug,
        tone: (t.errors || 0) + (t.timeouts || 0) > 0 ? 'warn' : 'ok',
        detail: `forrást adott ${t.ok} · üres ${t.empty} · hiba ${t.errors} · ` +
                `időtúllépés ${t.timeouts} · kihagyva ${t.skipped} · ` +
                `${t.sources} forrás · csúcs ${t.latency_max} ms`
      })), 'Nincs mérés ebben az időszakban.')
    }))

    /*
     * ÁLLAPOTLISTA, NEM RANGSOR — ugyanaz a hiba, mint a Rendszer fülön.
     *
     * Az `analyticsTable` számot vár a második oszlopban, és abból arányt
     * számol. Az esemény neve („down", „up") szöveg, tehát `NaN` lett belőle
     * a képernyőn. Mérve: amíg nem volt állapotváltozás, a tábla üres volt,
     * és a hiba nem látszott — az első esemény hozta elő.
     */
    lower.append(this.dashPanel({
      title: 'Állapotváltozások',
      sub: 'mikor esett le és mikor jött vissza',
      body: this.statusList((data.events ?? []).map(e => ({
        label: `${e.slug} — ${e.event}`,
        tone: /down|fail|error/i.test(String(e.event)) ? 'bad' : 'ok',
        detail: [new Date(e.at).toLocaleString('hu-HU'),
          e.latency_ms ? `${e.latency_ms} ms` : null,
          e.detail || null].filter(Boolean).join(' · ')
      })), 'Nem volt állapotváltozás ebben az időszakban.')
    }))
    body.append(lower)
  },

  /** A rendszerállapot színei. A `not_configured` SZÜRKE, nem piros. */
  HEALTH_TONES: {
    green: ['ok', 'működik'],
    degraded: ['warn', 'akadozik'],
    yellow: ['warn', 'akadozik'],
    red: ['bad', 'nem elérhető'],
    offline: ['bad', 'nem elérhető'],
    not_configured: ['', 'nincs bekapcsolva'],
    unknown: ['', 'ismeretlen']
  },

  /**
   * Komponensenkénti rendszerállapot.
   *
   * A PANEL SEMMIT NEM TALÁL KI: amit a kiszolgáló nem ellenőrzött, az
   * „ismeretlen", nem „működik". És a be nem kapcsolt komponens nem hiba —
   * ma négy ilyen van (redis, rabbitmq, opensearch, minio), és pirosra festve
   * a panel folyamatosan hibát jelezne egy működő rendszerre.
   */
  async analyticsHealth (body) {
    const data = await YumeAPI.admin.analytics.systemHealth()
    body.replaceChildren()

    const services = data.services ?? []
    const stale = new Set(data.stale ?? [])

    const sorok = services.map(s => {
      const [tone, szoveg] = this.HEALTH_TONES[s.status] ?? ['', s.status]
      const reszletek = [
        szoveg,
        s.latency_ms != null ? `${Number(s.latency_ms).toFixed(1)} ms` : null,
        s.checked_at ? `ellenőrizve ${new Date(s.checked_at).toLocaleString('hu-HU')}` : null,
        /*
         * AZ ELAVULT ELLENŐRZÉS KÜLÖN SZÓL. Egy tíz perce nem frissült sor
         * nem „zöld" — azt jelenti, hogy maga az ellenőrző nem fut. Enélkül
         * egy leállt megfigyelő a legjobb állapotnak látszik.
         */
        stale.has(s.service) ? '⚠ az ellenőrzés elavult' : null,
        s.detail || null
      ].filter(Boolean).join(' · ')
      return { label: s.service, tone, detail: reszletek }
    })

    /*
     * SAJÁT RENDERELŐ, NEM AZ `analyticsTable`.
     *
     * Az egy RANGSOROLT, SÁVOS lista: számot vár a második oszlopban, és abból
     * arányt számol. Egy állapotlistának nincs ilyen száma — mérve, ez `NaN`-t
     * és `[object HTMLSpanElement]`-et írt ki a panelre. A 16. pont ezt
     * kifejezetten tiltja, és joggal: egy `NaN` a rendszerállapotban rosszabb,
     * mint ha ott sem lenne semmi.
     */
    body.append(this.dashPanel({
      title: 'Komponensek',
      sub: `frissítve ${new Date(data.checkedAt).toLocaleTimeString('hu-HU')}`,
      wide: true,
      body: this.statusList(sorok, 'Nincs állapotadat.')
    }))
  }
}
