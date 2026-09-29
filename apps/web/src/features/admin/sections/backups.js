/* global document, window */
// Admin — Mentések.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('backups')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
  // ---- mentések ------------------------------------------------------------

  /**
   * A mentés kezelése.
   *
   * Az API nem látja a mentések kötetét, és nem is kell látnia: ezek a gombok
   * kérést írnak egy táblába, amit a mentőkonténer ciklusa vesz fel. A válasz
   * ugyanezen a csatornán jön vissza — állapot és a futás naplójának a vége.
   *
   * Ezért frissül magától, amíg fut valami: a kérés nem ebben a kérésben
   * teljesül.
   */
  async renderBackups (content) {
    if (this._backupTimer) { clearTimeout(this._backupTimer); this._backupTimer = null }

    const load = async () => {
      let data
      try {
        data = await YumeAPI.admin.backups()
      } catch (e) {
        content.replaceChildren(P.errorState('A mentések betöltése nem sikerült: ' + e.message))
        return
      }
      content.replaceChildren()
      const { backups = [], requests = [], schedule = {}, offsite, readOnly, busy } = data

      // ---- ütemezés ----
      content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;display:flex;align-items:center;gap:var(--space-4);' }, [
        U.el('div', { style: 'flex-grow:1;' }, [
          U.el('h3', { style: 'margin:0;', text: 'Éjszakai mentés' }),
          U.el('p', {
            style: 'margin:var(--space-1) 0 0;',
            text: schedule.enabled
              ? `Bekapcsolva — minden nap ${schedule.hourUtc}:00 UTC, ${schedule.keepDays} napig megtartva. Minden mentés vissza is áll egy eldobható adatbázisba, különben csak tipp lenne.`
              : 'Kikapcsolva. Amíg így áll, csak az készül, amit innen kérsz.'
          }),
          offsite
            ? null
            : U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-2) 0 0;', text: 'A mentések ezen a gépen élnek. Egy lemezhiba egyszerre viszi az adatbázist és a mentéseit — a másolás máshová a telepítés dolga (BACKUP_SYNC_CMD).' })
        ]),
        U.el('label', { class: 'switch' }, [
          U.el('input', {
            type: 'checkbox',
            ...(schedule.enabled ? { checked: '' } : {}),
            onchange: async e => {
              const enabled = e.target.checked
              const reason = window.prompt(enabled ? 'Miért kapcsolod be?' : 'Miért kapcsolod ki az éjszakai mentést?', '')
              if (!reason || !reason.trim()) { e.target.checked = !enabled; return }
              try {
                await YumeAPI.admin.backupSchedule({ enabled, reason: reason.trim() })
                U.toast(enabled ? 'Éjszakai mentés bekapcsolva' : 'Éjszakai mentés kikapcsolva')
                load()
              } catch (err) { U.toast(err.message, 'error'); e.target.checked = !enabled }
            }
          }),
          U.el('span', { class: 'slider' })
        ])
      ]))

      // ---- most ----
      content.append(U.el('div', { style: 'display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin:var(--space-4) 0;' }, [
        U.el('button', {
          class: 'btn btn-primary btn-sm',
          ...(busy ? { disabled: '' } : {}),
          onclick: async () => {
            const reason = window.prompt('Miért készül most mentés?', 'kézi mentés')
            if (!reason || !reason.trim()) return
            try {
              await YumeAPI.admin.backupNow(reason.trim())
              U.toast('Mentés elindítva')
              load()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode('Mentés most')]),
        busy
          ? U.el('span', { class: 'list-row-sub', text: `Fut: ${busy.kind} (#${busy.id}) — a lista magától frissül.` })
          : null
      ]))

      // ---- a legutóbbi kérések ----
      if (requests.length) {
        content.append(U.el('h3', { class: 'detail-section-title', text: 'Legutóbbi kérések' }))
        const rows = U.el('div', { class: 'meta-rows' })
        for (const r of requests.slice(0, 5)) {
          const tone = r.status === 'done' ? 'badge-ok' : r.status === 'failed' ? 'badge-danger' : 'badge-info'
          rows.append(U.el('div', { class: 'meta-row backup-row' }, [
            U.el('div', { class: 'meta-row-main' }, [
              U.el('div', { class: 'meta-row-title', text: `${this.BACKUP_KINDS[r.kind] ?? r.kind}${r.filename ? ' — ' + r.filename : ''}` }),
              U.el('div', { class: 'meta-row-sub', text: `${r.reason}${r.requested_by ? ' · ' + r.requested_by : ''} · ${U.relTime(new Date(r.created_at))}` }),
              r.log
                ? U.el('details', { style: 'margin-top:var(--space-1);' }, [
                  U.el('summary', { class: 'meta-row-sub', text: 'napló' }),
                  U.el('pre', { class: 'meta-row-sub', style: 'white-space:pre-wrap;margin:var(--space-1) 0 0;', text: r.log })
                ])
                : null
            ]),
            U.el('span', { class: 'badge ' + tone, text: this.BACKUP_STATUS[r.status] ?? r.status })
          ]))
        }
        content.append(rows)
      }

      // ---- a mentések ----
      content.append(U.el('h3', { class: 'detail-section-title', text: `Mentések (${backups.length})` }))
      if (!backups.length) {
        content.append(P.emptyState('Még nincs mentés. A „Mentés most" gombbal készíthetsz egyet.'))
      }
      const list = U.el('div', { class: 'meta-rows' })
      for (const b of backups) {
        list.append(U.el('div', { class: 'meta-row backup-row' }, [
          U.el('div', { class: 'meta-row-main' }, [
            U.el('div', { class: 'meta-row-title', text: b.filename }),
            U.el('div', {
              class: 'meta-row-sub',
              text: `${(Number(b.bytes) / 1048576).toFixed(1)} MB · ${new Date(b.taken_at).toLocaleString(I18n.locale())}` +
                (b.verified ? ` · ellenőrizve: ${b.verify_detail ?? ''}` : ' · nem ellenőrzött ezen a leltáron')
            })
          ]),
          U.el('div', { class: 'backup-row-actions' }, [
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              ...(busy ? { disabled: '' } : {}),
              title: 'Visszaállítás egy eldobható adatbázisba — megmondja, jó-e, anélkül hogy bármit kockáztatna',
              onclick: async () => {
                const reason = window.prompt('Miért ellenőrzöd?', 'ellenőrzés')
                if (!reason || !reason.trim()) return
                try {
                  await YumeAPI.admin.backupVerify({ filename: b.filename, reason: reason.trim() })
                  U.toast('Ellenőrzés elindítva')
                  load()
                } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('Ellenőrzés')]),
            U.el('button', {
              class: 'btn btn-danger btn-sm',
              ...(busy ? { disabled: '' } : {}),
              onclick: () => this.restoreDialog(b, readOnly, load)
            }, [document.createTextNode('Visszaállítás')])
          ])
        ]))
      }
      content.append(list)

      // Amíg fut valami, magától frissül. Nem WebSocket: egy mentés percekig
      // tart, és egy nyitott csatorna ehhez sok.
      if (busy) this._backupTimer = setTimeout(() => { if (content.isConnected) load() }, 4000)
    }

    await load()
  },

  BACKUP_KINDS: { backup: 'Mentés', verify: 'Ellenőrzés', restore: 'Visszaállítás' },
  BACKUP_STATUS: { pending: 'várakozik', running: 'fut', done: 'kész', failed: 'elhasalt' },

  /**
   * A visszaállítás ablaka.
   *
   * Két feltétel, és egyik sem formalitás: a példánynak csak olvasható módban
   * kell lennie (visszaállítás közben érkező írás elvész), és a fájlnevet be
   * kell gépelni. Egy legördülőből kiválasztott visszaállítás az a
   * visszaállítás, ami véletlenül történik.
   */
  restoreDialog (backup, readOnly, reload) {
    const confirm = U.el('input', { class: 'input', style: 'width:100%;', placeholder: backup.filename })
    const reason = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Miért állítasz vissza?' })

    const modal = AdminModals.modalShell('Visszaállítás — ' + backup.filename, [
      U.el('div', { class: 'callout callout-warn' }, [
        U.el('strong', { text: 'Ez felülírja az éles adatbázist. ' }),
        document.createTextNode(
          'Minden, ami a mentés óta történt — fiókok, könyvtárak, hozzászólások, haladás — eltűnik. ' +
          'A művelet nem vonható vissza, hacsak nincs róla frissebb mentés.')
      ]),
      readOnly
        ? null
        : U.el('div', { class: 'callout' }, [
          U.el('strong', { text: 'Előbb a csak olvasható mód. ' }),
          document.createTextNode('A Biztonság alatt kapcsold be — visszaállítás közben érkező írás vagy elvész, vagy egy félig visszaállított adatbázisba megy, és a kettő közül utólag nem lehet megmondani, melyik történt.')
        ]),
      U.el('div', { class: 'filter-group' }, [
        U.el('label', { text: 'Gépeld be a fájl nevét a megerősítéshez' }), confirm
      ]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Indoklás' }), reason])
    ], async () => {
      if (!readOnly) return U.toast('Előbb kapcsold be a csak olvasható módot', 'error')
      // (a jóváhagyó gomb felirata lent áll át)
      if (confirm.value.trim() !== backup.filename) return U.toast('A fájlnév nem egyezik', 'error')
      if (!reason.value.trim()) return U.toast('Az indoklás kötelező', 'error')
      try {
        await YumeAPI.admin.backupRestore({
          filename: backup.filename, confirm: confirm.value.trim(), reason: reason.value.trim()
        })
        U.toast('Visszaállítás elindítva')
        modal.close()
        reload()
      } catch (e) { U.toast(e.message, 'error') }
    })

    // A közös űrlapablak jóváhagyó gombja „Mentés". Ezen a képernyőn az a szó
    // már foglalt — ott van minden soron, és pont az ellenkezőjét jelenti.
    const submit = modal.querySelector('.btn-primary')
    if (submit) {
      submit.textContent = 'Visszaállítás indítása'
      submit.classList.remove('btn-primary')
      submit.classList.add('btn-danger')
    }
    return modal
  }
}
