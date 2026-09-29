/* global document, window */
// Admin — Webhookok.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('webhooks')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
  // ---- webhooks ----

  EVENT_LABELS: {
    'user.registered': 'Új regisztráció',
    'user.moderated': 'Felhasználó felfüggesztve / kitiltva / visszaállítva',
    'user.deleted': 'Fiók törölte magát',
    'user.roles.changed': 'Szerepkör adva vagy elvéve',
    'user.password_reset_requested': 'Jelszó-visszaállítás kérve',
    'catalogue.changed': 'Anime vagy epizód változott',
    'config.changed': 'Beállítás vagy kapcsoló változott',
    'monitor.alert': 'Egy mérőszám vagy szolgáltatás riaszt',
    'monitor.recovered': 'Egy mérőszám vagy szolgáltatás rendbe jött',
    'comment.created': 'Új hozzászólás',
    'report.created': 'Bejelentés érkezett',
    'report.resolved': 'Bejelentés lezárva',
    'w2g.room_created': 'Közös nézés szoba nyílt',
    'stats.daily': 'Napi statisztika',
    'stats.trending': 'Felkapottak frissültek',
    'catalogue.imported': 'Katalógus-import lefutott',
    'metadata.synced': 'Metaadat-szinkron lefutott',
    'job.failed': 'Háttérfeladat elhasalt',
    'webhook.test': 'Kézi teszt'
  },

  async renderWebhooks (content) {
    try {
      const [{ events }, { data }] = await Promise.all([
        YumeAPI.admin.webhookEvents(),
        YumeAPI.admin.webhooks()
      ])
      content.replaceChildren()

      content.append(U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--space-4);margin-bottom:var(--space-4);' }, [
        U.el('p', { class: 'list-row-sub', style: 'max-width:40rem;', text: 'A kimenő webhookok azokra az eseményekre szólalnak meg, amikre feliratkoztatod őket. A Discord-végpont beágyazott kártyát kap, az általános végpont aláírt JSON-t.' }),
        U.el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.webhookForm(content, events, null) }, [document.createTextNode('+ Új webhook')])
      ]))

      if (!data.length) {
        content.append(P.emptyState('Még nincs webhook. Az elsővel kezdenek megérkezni az események.'))
        return
      }

      for (const hook of data) {
        const healthy = hook.enabled && hook.failure_count === 0
        content.append(U.el('div', { class: 'setting-card', style: 'max-width:none;' }, [
          U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;' }, [
            U.el('span', { style: `width:.6rem;height:.6rem;border-radius:var(--radius-full);background:${healthy ? 'var(--ok)' : hook.enabled ? 'var(--status-paused)' : 'var(--fg-faint)'};` }),
            U.el('h3', { style: 'margin:0;', text: hook.name }),
            U.el('span', { class: 'ext-type-chip', text: hook.format }),
            U.el('span', { class: 'list-row-sub', text: `${hook.events.length} esemény • ${hook.delivery_count} kézbesítés` }),
            hook.last_error ? U.el('span', { class: 'badge', style: 'background:var(--danger);color:white;', text: 'utolsó hiba: ' + hook.last_error }) : null
          ]),
          U.el('div', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;word-break:break-all;', text: hook.url.replace(/\/[^/]+$/, '/•••') }),
          U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-2);' }, [
            U.el('button', {
              class: 'btn btn-secondary btn-sm',
              onclick: async e => {
                e.target.disabled = true
                try { await YumeAPI.admin.testWebhook(hook.id); U.toast('Teszt kézbesítve ✓') } catch (err) { U.toast('A teszt nem sikerült: ' + err.message, 'error') } finally { e.target.disabled = false }
              }
            }, [document.createTextNode('Teszt küldése')]),
            // A kézbesítési napló végpontja (és a kliens metódusa) megvolt, és
            // semmi nem használta. „Megkapta-e a bot, és ha nem, miért" — ez a
            // kérdés, amit egy webhook után az ember feltesz, és eddig csak az
            // utolsó hiba egyetlen sora válaszolt rá.
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: e => this.webhookDeliveries(e.target.closest('.setting-card'), hook)
            }, [document.createTextNode('Kézbesítések')]),
            U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.webhookForm(content, events, hook) }, [document.createTextNode('Szerkesztés')]),
            U.el('button', {
              class: 'btn btn-ghost btn-sm',
              onclick: async () => {
                await YumeAPI.admin.updateWebhook(hook.id, { enabled: !hook.enabled })
                this.renderWebhooks(content)
              }
            }, [document.createTextNode(hook.enabled ? 'Kikapcsolás' : 'Bekapcsolás')]),
            U.el('button', {
              class: 'btn btn-sm',
              style: 'background:var(--danger);color:white;',
              onclick: async () => {
                if (!window.confirm(`Törlöd a(z) „${hook.name}" webhookot?`)) return
                await YumeAPI.admin.deleteWebhook(hook.id)
                U.toast('Webhook törölve')
                this.renderWebhooks(content)
              }
            }, [document.createTextNode('Törlés')])
          ])
        ]))
      }
    } catch (e) {
      content.replaceChildren(P.errorState(e.message))
    }
  },

  /**
   * A webhook utolsó huszonöt kézbesítése.
   *
   * Egy webhook után egyetlen kérdés van: megkapta-e a bot, és ha nem, miért.
   * Eddig erre az utolsó hiba egyetlen sora válaszolt, a napló pedig — ami a
   * szerveren megvolt, és a kliensben is volt rá metódus — sehol nem látszott.
   *
   * A kártyán belül nyílik, nem külön ablakban: a kérdés ahhoz a webhookhoz
   * tartozik, és egy modális elfedné a mellette lévő állapotjelzőt.
   */
  async webhookDeliveries (card, hook) {
    const existing = card?.querySelector('.wh-deliveries')
    if (existing) { existing.remove(); return }
    if (!card) return

    const box = U.el('div', { class: 'wh-deliveries', style: 'margin-top:var(--space-3);' }, [P.spinner()])
    card.append(box)
    try {
      const { data } = await YumeAPI.admin.webhookDeliveries(hook.id)
      if (!data.length) {
        box.replaceChildren(P.emptyState('Ez a webhook még nem küldött semmit.'))
        return
      }
      const rows = data.map(d => {
        const ok = d.status_code >= 200 && d.status_code < 300
        return U.el('div', { class: 'meta-row' }, [
          U.el('div', { class: 'meta-row-main' }, [
            U.el('div', { class: 'meta-row-title', text: this.EVENT_LABELS[d.event] ?? d.event }),
            U.el('div', { class: 'meta-row-sub', text: d.error ?? U.relTime(new Date(d.created_at)) })
          ]),
          U.el('span', { class: 'meta-row-sub', text: d.duration_ms != null ? `${d.duration_ms} ms` : '' }),
          U.el('span', {
            class: 'badge',
            style: `background:${ok ? 'var(--ok)' : 'var(--danger)'};color:white;`,
            text: d.status_code ? String(d.status_code) : 'nincs válasz'
          })
        ])
      })
      box.replaceChildren(
        U.el('div', { class: 'list-row-sub', style: 'margin-bottom:var(--space-2);', text: `Az utolsó ${data.length} kézbesítés, legújabb elöl` }),
        U.el('div', { class: 'meta-rows' }, rows)
      )
    } catch (e) {
      box.replaceChildren(P.errorState(e.message))
    }
  },

  webhookForm (content, events, hook) {
    const isEdit = !!hook
    const name = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Név', value: hook?.name ?? '' })
    const url = U.el('input', { class: 'input', type: 'url', style: 'width:100%;', placeholder: 'https://discord.com/api/webhooks/…', value: hook?.url ?? '' })
    const format = U.el('select', { class: 'select' }, [
      U.el('option', { value: 'discord', text: 'Discord (beágyazott kártya)', ...(hook?.format !== 'json' ? { selected: '' } : {}) }),
      U.el('option', { value: 'json', text: 'Általános JSON (HMAC-aláírt)', ...(hook?.format === 'json' ? { selected: '' } : {}) })
    ])

    /*
     * Az aláíró titok.
     *
     * A szerver mindig is elfogadta, és a JSON-kézbesítés ezzel írja alá a
     * csomagot — a fogadó ebből tudja, hogy tőlünk jött, és nem bárkitől, aki
     * ismeri a webhook címét. A felületen viszont nem volt hozzá mező, tehát
     * az egész aláírás elérhetetlen maradt.
     *
     * A meglévő értéket nem tudjuk visszaírni ide: a lista sosem adja vissza a
     * titkot (helyesen). Az üres mező ezért „ne változtass"-t jelent, nem
     * „töröld" — a mentés csak akkor küldi, ha írtak bele.
     */
    const secret = U.el('input', {
      class: 'input',
      type: 'password',
      style: 'width:100%;',
      autocomplete: 'new-password',
      placeholder: isEdit ? 'Változatlan marad, ha üresen hagyod' : 'Nem kötelező'
    })
    const secretHint = U.el('p', {
      class: 'list-row-sub',
      style: 'margin:var(--space-1) 0 0;',
      text: 'Csak az általános JSON-hoz: ezzel írjuk alá a csomagot (X-Yume-Signature), és a fogadó ebből tudja, hogy tőlünk jött. A Discord nem használja.'
    })

    const subscribed = new Set(hook?.events ?? events) // new hooks default to all events
    const checkboxes = events.map(ev => {
      const cb = U.el('input', { type: 'checkbox', value: ev, ...(subscribed.has(ev) ? { checked: '' } : {}) })
      return U.el('label', { style: 'display:flex;gap:var(--space-2);align-items:center;font-size:var(--text-xs);padding:var(--space-1) 0;cursor:pointer;' }, [
        cb, U.el('span', {}, [document.createTextNode(this.EVENT_LABELS[ev] ?? ev), U.el('code', { style: 'color:var(--fg-faint);margin-left:var(--space-2);font-family:var(--font-mono);font-size:var(--text-xs);', text: ev })])
      ])
    })
    const eventGrid = U.el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:var(--space-1) var(--space-3);margin-top:var(--space-2);' }, checkboxes)

    const toggleAll = on => checkboxes.forEach(l => { l.querySelector('input').checked = on })

    const modal = AdminModals.modalShell(isEdit ? 'Webhook szerkesztése' : 'Új webhook', [
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Név' }), name]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Cím (URL)' }), url]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Formátum' }), format]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Aláíró titok' }), secret, secretHint]),
      U.el('div', {}, [
        U.el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
          U.el('label', { class: 'filter-group', style: 'display:block;', text: 'Események' }),
          U.el('div', {}, [
            U.el('button', { class: 'section-more', style: 'margin-right:var(--space-3);', onclick: () => toggleAll(true) }, [document.createTextNode('Mind')]),
            U.el('button', { class: 'section-more', onclick: () => toggleAll(false) }, [document.createTextNode('Egyik sem')])
          ])
        ]),
        eventGrid
      ])
    ], async () => {
      const body = {
        name: name.value.trim(),
        url: url.value.trim(),
        format: format.value,
        events: checkboxes.filter(l => l.querySelector('input').checked).map(l => l.querySelector('input').value)
      }
      // Üres mező = ne változtass. A titkot sosem olvassuk vissza, tehát egy
      // üres érték elküldve azt törölné, amit az operátor nem is látott.
      if (secret.value.trim()) body.secret = secret.value.trim()
      if (!body.name || !body.url) return U.toast('A név és a cím kötelező', 'error')
      try {
        if (isEdit) await YumeAPI.admin.updateWebhook(hook.id, body)
        else await YumeAPI.admin.createWebhook(body)
        U.toast(isEdit ? 'Webhook frissítve' : 'Webhook létrehozva')
        modal.close()
        this.renderWebhooks(content)
      } catch (e) { U.toast(e.message, 'error') }
    })
  }
}
