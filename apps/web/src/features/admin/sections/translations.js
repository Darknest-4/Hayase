/* global document, window */
// Admin — Fordítások.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('translations')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  // =========================================================================
  // Translations — writing the Hungarian catalogue text
  // =========================================================================
  //
  // The catalogue holds 25,703 English synopses and Hungarian ones only exist
  // once somebody writes them. Translating all of it is not going to happen;
  // translating what people actually open is a week of work and covers most of
  // what anyone reads. So the queue is ordered by popularity and the editor
  // works down it — that ordering is the feature, not a detail of the list.
  //
  // Source text sits beside the field being written. Translating from memory
  // of what the English said is how a description ends up describing a
  // different show.

  async renderTranslations (content) {
    const layout = U.el('div', { class: 'cat-layout' })
    const listCol = U.el('div', { class: 'cat-list-col' })
    const editCol = U.el('div', { class: 'cat-edit-col' })
    content.replaceChildren(layout)

    const state = { offset: 0, publishedOnly: true, selected: null }
    const listBox = U.el('div', { class: 'cat-list' })
    const progressBox = U.el('div', { class: 'tr-progress' })

    const toolbar = U.el('div', { class: 'cat-toolbar' }, [
      U.el('label', { class: 'tr-toggle' }, [
        U.el('input', {
          type: 'checkbox',
          checked: '',
          onchange: e => { state.publishedOnly = e.target.checked; state.offset = 0; loadList() }
        }),
        U.el('span', { text: 'Csak a publikáltak' })
      ])
    ])
    listCol.append(progressBox, toolbar, listBox)
    editCol.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-6);', text: 'Válassz egy címet balról, és írd meg hozzá a magyar szöveget.' }))

    const loadProgress = async () => {
      try {
        const p = await YumeAPI.admin.translations.progress()
        const done = p.translated ?? 0
        const target = p.published ?? 0
        const pct = target ? Math.round((done / target) * 100) : 0
        progressBox.replaceChildren(
          U.el('div', { class: 'tr-progress-bar' }, [U.el('span', { style: `width:${pct}%;` })]),
          U.el('div', {
            class: 'tr-progress-text',
            // Measured against published titles, not the whole catalogue: a
            // hidden entry nobody can open is not work anyone is waiting on.
            text: `${target.toLocaleString(I18n.locale())} publikált címből ${done.toLocaleString(I18n.locale())} kapott magyar leírást (${pct}%)`
          }),
          (p.drafts ?? 0) > 0
            ? U.el('div', { class: 'tr-progress-drafts', text: `${p.drafts} átnézetlen gépi piszkozat — jóváhagyásig a látogatók nem látják` })
            : null
        )
      } catch (e) {
        progressBox.replaceChildren(U.el('div', { class: 'tr-progress-text', text: 'A haladás nem tölthető be.' }))
      }
    }

    const loadList = async () => {
      listBox.replaceChildren(P.spinner())
      try {
        const { data, total } = await YumeAPI.admin.translations.queue({
          limit: 30, offset: state.offset, publishedOnly: state.publishedOnly
        })
        listBox.replaceChildren(
          U.el('div', { class: 'cat-count', text: `${total.toLocaleString(I18n.locale())} címhez hiányzik a magyar leírás` })
        )
        if (!data.length) {
          listBox.append(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'Ebben a szűrőben nincs több.' }))
          return
        }
        for (const row of data) listBox.append(rowNode(row))
        if (total > state.offset + data.length) {
          listBox.append(U.el('button', {
            class: 'btn btn-ghost btn-sm',
            style: 'width:100%;margin-top:var(--space-2);',
            onclick: () => { state.offset += 30; loadList() }
          }, [document.createTextNode('Következő 30')]))
        }
      } catch (e) {
        listBox.replaceChildren(U.el('div', { class: 'empty-state', style: 'padding:var(--space-4);', text: 'A sor betöltése nem sikerült: ' + e.message }))
      }
    }

    const rowNode = row => {
      const node = U.el('button', {
        class: 'cat-row' + (state.selected === row.id ? ' active' : ''),
        onclick: () => { state.selected = row.id; openEditor(row); loadList() }
      }, [
        U.el('div', { class: 'cat-row-main' }, [
          U.el('div', { class: 'cat-row-title', text: row.canonical_title }),
          U.el('div', { class: 'cat-row-sub', text: `${(row.popularity ?? 0).toLocaleString(I18n.locale())} · ${row.visibility}` })
        ]),
        // Which half is missing, so a half-done entry is visible as half-done
        // rather than looking identical to an untouched one.
        U.el('div', { class: 'tr-flags' }, [
          U.el('span', { class: 'tr-flag' + (row.has_title ? ' on' : ''), title: 'Cím', text: 'T' }),
          U.el('span', { class: 'tr-flag' + (row.has_synopsis ? ' on' : ''), title: 'Leírás', text: 'D' })
        ])
      ])
      return node
    }

    const openEditor = async row => {
      editCol.replaceChildren(P.spinner())
      let payload
      try {
        payload = await YumeAPI.admin.translations.get(row.id)
      } catch (e) {
        editCol.replaceChildren(U.el('div', { class: 'empty-state', style: 'padding:var(--space-6);', text: 'Nem sikerült betölteni: ' + e.message }))
        return
      }

      const existing = (payload.translations ?? []).find(t => t.language === 'hu') ?? {}
      const titleInput = U.el('input', { class: 'input', maxlength: '500', value: existing.title ?? '', placeholder: payload.source.canonical_title })
      const synopsisInput = U.el('textarea', { class: 'input', rows: '10', maxlength: '8000', placeholder: 'Magyar leírás…' })
      synopsisInput.value = existing.synopsis ?? ''

      const save = U.el('button', { class: 'btn btn-primary btn-sm' }, [document.createTextNode('Magyar szöveg mentése')])
      save.addEventListener('click', async () => {
        save.disabled = true
        try {
          await YumeAPI.admin.translations.put(row.id, 'hu', {
            title: titleInput.value.trim() || null,
            synopsis: synopsisInput.value.trim() || null
          })
          U.toast('Mentve')
          loadProgress()
          loadList()
        } catch (e) {
          U.toast('A mentés nem sikerült: ' + e.message, 'error')
        } finally {
          save.disabled = false
        }
      })

      const remove = existing.title || existing.synopsis
        ? U.el('button', { class: 'btn btn-ghost btn-sm' }, [document.createTextNode('Fordítás törlése')])
        : null
      remove?.addEventListener('click', async () => {
        if (!window.confirm('Törlöd ennek a címnek a magyar szövegét?')) return
        try {
          await YumeAPI.admin.translations.remove(row.id, 'hu')
          U.toast('Törölve')
          openEditor(row)
          loadProgress()
          loadList()
        } catch (e) {
          U.toast('A törlés nem sikerült: ' + e.message, 'error')
        }
      })

      editCol.replaceChildren(U.el('div', { class: 'tr-editor' }, [
        U.el('h3', { class: 'tr-editor-title', text: payload.source.canonical_title }),

        U.el('div', { class: 'tr-field' }, [
          U.el('label', { text: 'Magyar cím' }),
          U.el('p', { class: 'tr-hint', text: 'Leave empty to keep the original title. Most shows are known by their romaji name — only translate a title that genuinely has a Hungarian one.' }),
          titleInput
        ]),

        U.el('div', { class: 'tr-field' }, [
          U.el('label', { text: 'Magyar leírás' }),
          synopsisInput
        ]),

        // The English beside the field, not behind a tab.
        U.el('details', { class: 'tr-source', open: '' }, [
          U.el('summary', { text: 'Eredeti leírás' }),
          U.el('p', { class: 'tr-source-text', text: U.plainDesc(payload.source.synopsis) || '(none)' })
        ]),

        U.el('div', { class: 'tr-actions' }, [save, remove]),

        existing.updated_at
          ? U.el('div', { class: 'tr-meta', text: `Last edited ${U.relTime(existing.updated_at)} · ${existing.source}${existing.approved ? '' : ' · unapproved draft'}` })
          : null
      ]))
    }

    loadProgress()
    loadList()
  }
}
