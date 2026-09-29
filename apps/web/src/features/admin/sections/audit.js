// Admin — Kódaudit.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('audit')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { C } from '../../../shared/ui/components.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
  }
}
