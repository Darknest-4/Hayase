/* global document */
// Az adminpanel két régi modálja: az űrlapos (`modalShell`, mentés gombbal) és
// a nézegető (`modalPanel`, táblázatokhoz). Csak a panel használja őket; 2026-09-ig
// a közös komponensek részeként minden látogatóhoz letöltődtek. Az új
// párbeszédablakok a `C.openDialog`-ra épülnek — ez a kettő a panel meglévő
// űrlapjai miatt maradt meg.

import { C } from '../../shared/ui/components.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'

export const AdminModals = {
  /**
   * A modal you read rather than fill in.
   *
   * modalShell() below always draws a Save button, because every caller it was
   * written for submits something. A panel that shows what is known about a
   * thing and acts through its own buttons has nothing to save, and a Save
   * button that does nothing is worse than no button.
   *
   * Wider than the form modal for the same reason: this holds tables.
   */
  modalPanel (title, nodes) {
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onclick: e => { if (e.target === backdrop) backdrop.close() }
    }, [
      U.el('div', { class: 'search-modal', style: 'padding:var(--space-4);max-width:52rem;width:min(52rem,calc(100vw - 2rem));' }, [
        U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-3);margin:0 0 var(--space-4);' }, [
          U.el('h3', { style: 'margin:0;font-size:var(--text-lg);font-weight:800;flex-grow:1;', text: title }),
          U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => backdrop.close() }, [document.createTextNode(T('Close'))])
        ]),
        U.el('div', { class: 'modal-panel-body', style: 'max-height:72vh;overflow-y:auto;' }, nodes)
      ])
    ])
    document.body.append(backdrop)
    backdrop.close = C.trapModal(backdrop)
    return backdrop
  },

  // generic form modal (shared by developer portal and admin webhooks)
  modalShell (title, fields, onSubmit) {
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', onclick: onSubmit }, [document.createTextNode(T('Save'))])
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onclick: e => { if (e.target === backdrop) backdrop.close() }
    }, [
      U.el('div', { class: 'search-modal', style: 'padding:var(--space-4);max-width:40rem;width:min(40rem,calc(100vw - 2rem));' }, [
        U.el('h3', { style: 'margin:0 0 var(--space-4);font-size:var(--text-lg);font-weight:800;', text: title }),
        U.el('div', {
        /*
         * `dvh`, nem `vh`.
         *
         * A `vh` a TELJES képernyőt jelenti, a böngésző címsávja alattit is —
         * telefonon tehát nagyobb, mint a látható terület. A `dvh` a ténylegesen
         * láthatót méri, és így a mezők doboza nem lóghat ki a képernyőről.
         *
         * A burkoló amúgy is görgethető (lásd `.modal-backdrop`), ez a korlát
         * csak azt akadályozza meg, hogy a gombok EGYÁLTALÁN lecsússzanak.
         */
          style: 'display:flex;flex-direction:column;gap:var(--space-3);max-height:60dvh;overflow-y:auto;'
        }, fields),
        U.el('div', { style: 'display:flex;gap:var(--space-2);margin-top:var(--space-4);' }, [
          submit,
          U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => backdrop.close() }, [document.createTextNode(T('Cancel'))])
        ])
      ])
    ])
    document.body.append(backdrop)
    // Exposed on the node because callers already hold the node and used to
    // call .remove() on it; .close() is the version that also unbinds.
    backdrop.close = C.trapModal(backdrop)
    return backdrop
  }
}
