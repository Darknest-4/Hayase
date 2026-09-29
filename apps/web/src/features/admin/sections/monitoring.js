/* global document */
// Admin — Infrastruktúra.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('monitoring')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { Charts } from '../../../shared/ui/charts.js'
import { AP } from '../../../shared/ui/admin-ui.js'
import { C } from '../../../shared/ui/components.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
      }),
      /*
       * A legutóbbi ELLENŐRZÖTT mentés kora.
       *
       * A mentés volt az egyetlen rendszer, aminek a leállását semmi nem
       * vette észre. Itt van, a többi mérőszám mellett, ugyanazzal a
       * küszöbbel és ugyanazzal a riasztással — mert egy mentés, amiről nem
       * tudjuk, hogy elkészült-e, nem mentés.
       */
      AP.stat({
        label: 'Utolsó mentés',
        value: value('backup.age_hours') === null
          ? '—'
          : value('backup.age_hours') < 48
            ? Math.round(value('backup.age_hours')) + ' órája'
            : Math.round(value('backup.age_hours') / 24) + ' napja',
        meta: value('backup.age_hours') === null
          ? 'még nincs ellenőrzött mentés'
          : 'ellenőrizve, visszaállítható',
        tone: tone(level('backup.age_hours'))
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
  }
}
