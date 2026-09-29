/* global document, window */
// Admin — Felhasználók.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('users')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { AP } from '../../../shared/ui/admin-ui.js'
import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
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
    AdminModals.modalPanel('Account', [body])

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
  }
}
