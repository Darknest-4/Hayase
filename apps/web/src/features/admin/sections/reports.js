/* global document, window */
// Admin — Bejelentések.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('reports')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
  }
}
