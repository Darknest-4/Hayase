/* global document */
// Admin — Metaadatok.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('metadata')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
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
  }
}
