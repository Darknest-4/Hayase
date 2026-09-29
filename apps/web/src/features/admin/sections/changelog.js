/* global document, window */
// Admin — Fejlesztési napló.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('changelog')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
  // ---- fejlesztési napló ---------------------------------------------------

  /**
   * A kiadások szerkesztője.
   *
   * A napló adatbázisból jön, és eddig csak API-n át lehetett írni — vagyis
   * curl-lel vagy migrációval. Egy napló, amihez fejlesztő kell, nem napló,
   * hanem forráskód: a következő sort úgyis akkor írja meg valaki, amikor
   * eszébe jut, nem amikor éppen van nála terminál.
   *
   * Saját jogosultsága van (`changelog.manage`), és nem az admin
   * szerepkörnél ül: aki a naplót írja, annak nem kell tudnia kitiltani
   * senkit.
   */
  CHANGELOG_STATUS: [['planned', 'Tervezett'], ['in_progress', 'Folyamatban'], ['released', 'Kiadva']],
  CHANGELOG_KINDS: [['added', 'Új'], ['changed', 'Változott'], ['fixed', 'Javítva'], ['removed', 'Eltávolítva'], ['security', 'Biztonság']],

  async renderChangelog (content) {
    let data
    try {
      ({ data } = await YumeAPI.changelog.all())
    } catch (e) {
      content.replaceChildren(P.errorState('A napló betöltése nem sikerült: ' + e.message))
      return
    }
    content.replaceChildren()

    content.append(U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-4);margin-bottom:var(--space-4);' }, [
      U.el('p', { class: 'list-row-sub', style: 'max-width:44rem;', text: 'A látogatók a Fejlesztési napló oldalon ezt látják. A nem publikus kiadás itt szerkeszthető, de kifelé nem jelenik meg — ide való minden, ami még nem tartozik senkire.' }),
      U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.changelogForm(content, null) }, [document.createTextNode('+ Új kiadás')])
    ]))

    if (!data.length) {
      content.append(P.emptyState('Még nincs kiadás. Az elsővel kezdődik a napló.'))
      return
    }

    for (const release of data) {
      const statusLabel = (this.CHANGELOG_STATUS.find(([v]) => v === release.status) ?? [])[1] ?? release.status
      const lines = release.entries ?? []
      content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
        U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;' }, [
          U.el('code', { style: 'font-weight:800;', text: release.version }),
          U.el('h3', { style: 'margin:0;', text: release.title }),
          U.el('span', { class: 'ext-type-chip', text: statusLabel }),
          release.is_public ? null : U.el('span', { class: 'badge', style: 'background:var(--bg-sunken);', text: 'nem publikus' }),
          U.el('span', { class: 'list-row-sub', text: `${lines.length} sor` }),
          release.released_on ? U.el('span', { class: 'list-row-sub', text: new Date(release.released_on).toLocaleDateString(I18n.locale()) }) : null
        ]),
        release.summary ? U.el('div', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;', text: release.summary }) : null,
        U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2);' }, [
          U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => this.changelogForm(content, release) }, [document.createTextNode('Szerkesztés')]),
          U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              try {
                await YumeAPI.changelog.update(release.id, { isPublic: !release.is_public })
                U.toast(release.is_public ? 'Kifelé elrejtve' : 'Publikálva')
                this.renderChangelog(content)
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode(release.is_public ? 'Elrejtés' : 'Publikálás')]),
          U.el('button', {
            class: 'btn btn-sm',
            style: 'background:var(--danger);color:white;',
            onclick: async () => {
              if (!window.confirm(`Törlöd a(z) ${release.version} kiadást a soraival együtt?`)) return
              try {
                await YumeAPI.changelog.remove(release.id)
                U.toast('Kiadás törölve')
                this.renderChangelog(content)
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Törlés')])
        ])
      ]))
    }
  },

  /**
   * Egy kiadás űrlapja, a soraival együtt.
   *
   * A sorok a kiadással egy mentésben mennek: a szerver az egész listát
   * cseréli, mert egy részleges egyesítéshez azonosítók kellenének, amiket a
   * szerkesztő nem követ. Fél kiadás rosszabb, mint semmi — egy verziócím,
   * ami alatt nincs semmi.
   */
  changelogForm (content, release) {
    const isEdit = !!release
    const version = U.el('input', { class: 'input', style: 'width:100%;', placeholder: '0.8.1', value: release?.version ?? '' })
    if (isEdit) version.disabled = true // a verzió a kulcs; átnevezni új kiadás
    const title = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Rövid cím', value: release?.title ?? '' })
    const summary = U.el('textarea', { class: 'input', style: 'width:100%;min-height:5rem;', placeholder: 'Egy-két mondat arról, miről szól ez a kiadás' })
    summary.value = release?.summary ?? ''
    const status = U.el('select', { class: 'select' }, this.CHANGELOG_STATUS.map(([v, l]) =>
      U.el('option', { value: v, text: l, ...((release?.status ?? 'planned') === v ? { selected: '' } : {}) })))
    const releasedOn = U.el('input', {
      class: 'input',
      type: 'date',
      value: release?.released_on ? String(release.released_on).slice(0, 10) : ''
    })
    const isPublic = U.el('input', { type: 'checkbox', ...((release?.is_public ?? true) ? { checked: '' } : {}) })

    // ---- sorok ----
    const rows = U.el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-2);' })
    const addRow = (kind = 'added', body = '') => {
      const kindSel = U.el('select', { class: 'select', style: 'flex-shrink:0;' }, this.CHANGELOG_KINDS.map(([v, l]) =>
        U.el('option', { value: v, text: l, ...(kind === v ? { selected: '' } : {}) })))
      const text = U.el('input', { class: 'input', style: 'flex-grow:1;', placeholder: 'Mi történt, egy mondatban', value: body })
      const row = U.el('div', { class: 'cl-row', style: 'display:flex;gap:var(--space-2);align-items:center;' }, [
        kindSel,
        text,
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          title: 'Sor törlése',
          onclick: () => row.remove()
        }, [document.createTextNode('×')])
      ])
      rows.append(row)
    }
    for (const entry of release?.entries ?? []) addRow(entry.kind, entry.body)
    if (!rows.childElementCount) addRow()

    const field = (label, node) => U.el('div', { class: 'filter-group' }, [U.el('label', { text: label }), node])

    const modal = AdminModals.modalShell(isEdit ? `${release.version} szerkesztése` : 'Új kiadás', [
      field('Verzió', version),
      field('Cím', title),
      field('Összefoglaló', summary),
      U.el('div', { style: 'display:flex;gap:var(--space-3);flex-wrap:wrap;' }, [
        field('Állapot', status),
        field('Kiadás dátuma', releasedOn)
      ]),
      U.el('label', { style: 'display:flex;align-items:center;gap:var(--space-2);cursor:pointer;' }, [
        isPublic, U.el('span', { text: 'Látszik a látogatóknak' })
      ]),
      U.el('div', {}, [
        U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2);' }, [
          U.el('label', { class: 'filter-group', style: 'display:block;margin:0;', text: 'Sorok' }),
          U.el('button', { class: 'section-more', type: 'button', onclick: () => addRow() }, [document.createTextNode('+ Sor')])
        ]),
        rows
      ])
    ], async () => {
      const entries = [...rows.querySelectorAll('.cl-row')]
        .map(row => ({ kind: row.querySelector('select').value, body: row.querySelector('input').value.trim() }))
        .filter(entry => entry.body)

      const body = {
        title: title.value.trim(),
        summary: summary.value.trim(),
        status: status.value,
        isPublic: isPublic.checked,
        entries
      }
      // Üres dátumot nem küldünk: a séma dátumformátumot vár, és az üres
      // sztring nem az. „Nincs még kiadva" a hiánya, nem egy üres string.
      if (releasedOn.value) body.releasedOn = releasedOn.value
      if (!body.title) return U.toast('A cím kötelező', 'error')
      if (!isEdit && !version.value.trim()) return U.toast('A verzió kötelező', 'error')

      try {
        if (isEdit) await YumeAPI.changelog.update(release.id, body)
        else await YumeAPI.changelog.create({ version: version.value.trim(), ...body })
        U.toast(isEdit ? 'Kiadás frissítve' : 'Kiadás létrehozva')
        modal.close()
        this.renderChangelog(content)
      } catch (e) { U.toast(e.message, 'error') }
    })
  }
}
