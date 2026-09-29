/* global document, window */
// Admin — Hírek.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('announcements')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  // ---- announcements -------------------------------------------------------

  /**
   * Site-wide messages: what is live, what has not opened yet, what has closed.
   *
   * Sorted by the window rather than by creation, and each row says which of
   * the three states it is in — an operator's first question about a message
   * is always "is anybody seeing this right now".
   */
  async renderAnnouncements (content) {
    try {
      const { data } = await YumeAPI.admin.allAnnouncements()
      content.replaceChildren()

      content.append(U.el('div', { class: 'adm-head-row' }, [
        U.el('p', {
          class: 'list-row-sub',
          style: 'max-width:42rem;',
          text: 'Egy üzenet, amit mindenki lát, amíg nyitva az ablaka. Aki bezárja, annak nem jön vissza — profilonként, nem fiókonként.'
        }),
        P.button('+ Új hír', { variant: 'primary', size: 'sm', onclick: () => this.announcementForm(content, null) })
      ]))

      if (!data.length) {
        content.append(P.emptyState('Még nincs hír. Az elsővel tudsz szólni mindenkinek egyszerre.', {
          action: P.button('+ Új hír', { variant: 'secondary', onclick: () => this.announcementForm(content, null) })
        }))
        return
      }

      const now = Date.now()
      for (const a of data) {
        const starts = new Date(a.starts_at).getTime()
        const ends = a.ends_at ? new Date(a.ends_at).getTime() : null
        const state = starts > now
          ? { label: 'Ütemezve', variant: 'info' }
          : (ends && ends <= now)
              ? { label: 'Lejárt', variant: null }
              : { label: 'Él', variant: 'ok' }

        content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
          U.el('div', { class: 'adm-ann-head' }, [
            P.badge(state.label, { variant: state.variant }),
            U.el('h3', { style: 'margin:0;', text: a.title }),
            P.badge(a.audience, { variant: 'outline' })
          ]),
          U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;white-space:pre-wrap;', text: a.body.slice(0, 240) + (a.body.length > 240 ? '…' : '') }),
          U.el('p', { class: 'list-row-sub', text: this.announcementWindow(a) }),
          U.el('div', { class: 'adm-ann-actions' }, [
            P.button('Szerkesztés', { variant: 'ghost', size: 'sm', onclick: () => this.announcementForm(content, a) }),
            P.button('Törlés', {
              variant: 'danger',
              size: 'sm',
              onclick: async () => {
                if (!window.confirm(`Törlöd ezt: „${a.title}"?`)) return
                await YumeAPI.admin.deleteAnnouncement(a.id)
                U.toast('Hír törölve')
                this.renderAnnouncements(content)
              }
            })
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  /** "2026. 09. 14. óta, határozatlan ideig" — the window in one readable line. */
  announcementWindow (a) {
    const fmt = iso => new Date(iso).toLocaleString(I18n.locale(), { dateStyle: 'medium', timeStyle: 'short' })
    return a.ends_at ? `${fmt(a.starts_at)} — ${fmt(a.ends_at)}` : `${fmt(a.starts_at)} óta, határozatlan ideig`
  },

  /**
   * Write or edit one.
   *
   * `datetime-local` wants a value with no zone and the API speaks ISO, so the
   * two conversions are here rather than spread across the callers.
   */
  announcementForm (content, existing) {
    const toLocal = iso => {
      if (!iso) return ''
      const d = new Date(iso)
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    }
    const toISO = local => (local ? new Date(local).toISOString() : null)

    const title = P.input({ value: existing?.title ?? '', placeholder: 'Rövid cím', maxlength: 200 })
    const body = P.textarea({ placeholder: 'Amit el akarsz mondani. Üres sor választ el két bekezdést.', maxlength: 8000 })
    body.value = existing?.body ?? ''
    const linkLabel = P.input({ value: existing?.link_label ?? '', placeholder: 'pl. Mi változott?', maxlength: 60 })
    const linkUrl = P.input({ value: existing?.link_url ?? '', placeholder: 'https://…', type: 'url' })
    const audience = P.select(
      [['everyone', 'Mindenki'], ['members', 'Belépett tagok'], ['staff', 'Csak a stáb']],
      { value: existing?.audience ?? 'members' }
    )
    const startsAt = P.input({ type: 'datetime-local', value: toLocal(existing?.starts_at) })
    const endsAt = P.input({ type: 'datetime-local', value: toLocal(existing?.ends_at) })

    const error = U.el('p', { class: 'field-error', hidden: true })

    const save = P.button(existing ? 'Mentés' : 'Közzététel', {
      variant: 'primary',
      onclick: async () => {
        error.hidden = true
        // Both or neither: a label with no link is a dead button, and a link
        // with no label has nothing to put on it. The database says so too.
        if (Boolean(linkUrl.value.trim()) !== Boolean(linkLabel.value.trim())) {
          error.textContent = 'A gomb feliratát és a linket együtt kell megadni — vagy egyiket sem.'
          error.hidden = false
          return
        }
        const payload = {
          title: title.value.trim(),
          body: body.value.trim(),
          audience: audience.value,
          linkUrl: linkUrl.value.trim() || null,
          linkLabel: linkLabel.value.trim() || null,
          startsAt: toISO(startsAt.value),
          endsAt: toISO(endsAt.value)
        }
        try {
          if (existing) await YumeAPI.admin.updateAnnouncement(existing.id, payload)
          else await YumeAPI.admin.createAnnouncement(payload)
          U.toast(existing ? 'Hír frissítve' : 'Hír közzétéve')
          backdrop.remove()
          this.renderAnnouncements(content)
        } catch (e) {
          error.textContent = e.message
          error.hidden = false
        }
      }
    })

    const backdrop = P.dialog(existing ? 'Hír szerkesztése' : 'Új hír', [
      U.el('div', { class: 'adm-ann-form' }, [
        P.field('Cím', title),
        P.field('Szöveg', body),
        P.field('Kinek', audience, { hint: 'A „Mindenki" a kijelentkezett látogatókat is jelentené — amíg az oldal privát, ők nem látják.' }),
        P.field('Gomb felirata', linkLabel),
        P.field('Gomb linkje', linkUrl),
        P.field('Mikortól', startsAt, { hint: 'Üresen: azonnal.' }),
        P.field('Meddig', endsAt, { hint: 'Üresen: határozatlan ideig.' }),
        error
      ])
    ], { actions: [P.button('Mégse', { variant: 'ghost', onclick: () => backdrop.remove() }), save], onClose: () => backdrop.remove() })

    document.body.append(backdrop)
    title.focus()
  }
}
