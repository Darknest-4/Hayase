/* global document, navigator */
// Admin — Műveleti napló.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('audit-log')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
  }
}
