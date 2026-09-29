/* global document, window */
// Admin — Biztonság.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('security')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { AP } from '../../../shared/ui/admin-ui.js'
import { C } from '../../../shared/ui/components.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
  }
}
