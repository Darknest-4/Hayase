/*
 * A tartós üzenetek nézete — a teljes kezelés.
 *
 * EZ A FELÜLET LÉNYEGE. A YUME adminfelületéről ez a rész IDEKERÜLT, mert a
 * Discord-vezérlés saját címen él; ott csak a webhookok maradtak, amik a
 * YUME saját kimenő értesítései.
 *
 * Amit tud: létrehozás, szerkesztés, törlés, azonnali frissítés, újra
 * kiküldés, előnézet és előzmény. Előtte a csatorna ellenőrzése — mert a
 * jogosultsági hiba különben csak percekkel később, egy senki által nem
 * nézett `failure_count`-ban derülne ki.
 */

import { Api } from './api.js'
import { el, ido, panel, sorok, toast } from './dom.js'
import { ESEMENY, KONFIG_MEZOK, UZENET_TIPUS } from './views.js'

function dialog (cim, torzs, gombok) {
  const panelEl = el('div', { class: 'dialog' }, [
    el('div', { class: 'dialog-head' }, [el('span', { text: cim })]),
    el('div', { class: 'dialog-body' }, [torzs]),
    el('div', { class: 'dialog-foot' }, gombok)
  ])
  const hatter = el('div', { class: 'modal-backdrop' }, [panelEl])
  hatter.addEventListener('click', e => { if (e.target === hatter) hatter.remove() })
  hatter.addEventListener('keydown', e => { if (e.key === 'Escape') hatter.remove() })
  document.body.append(hatter)
  return hatter
}

function mezo (cimke, vezerlo, sugo) {
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: cimke }),
    vezerlo,
    sugo ? el('p', { class: 'field-hint', text: sugo }) : null
  ])
}

export async function messages (guildId, ujra) {
  const [status, lista] = await Promise.all([Api.status(), Api.messages(guildId)])
  const rows = lista.data ?? []
  const wrap = el('div')

  const ujGomb = el('button', { class: 'btn btn-primary btn-sm' }, ['+ Új üzenet'])
  ujGomb.addEventListener('click', () => urlap(guildId, null, ujra))

  wrap.append(el('div', {
    style: 'display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap;margin-bottom:var(--space-4);'
  }, [
    el('p', {
      class: 'list-row-sub',
      style: 'margin:0;max-width:44rem;',
      text: 'Egy üzenet, ami frissül — nem szaporodik. A bot ugyanazt az üzenetet szerkeszti újra, és ha a tartalom ' +
        'nem változott, meg sem szólítja a Discordot.'
    }),
    ujGomb
  ]))

  if (!status.configured) {
    wrap.append(el('p', {
      class: 'list-row-sub',
      style: 'margin-bottom:var(--space-3);',
      text: 'Nincs bot token: az üzenetek felvehetők és szerkeszthetők, de nem mennek ki.'
    }))
  }

  const fut = async (fn, gomb) => {
    if (gomb) gomb.disabled = true
    try { await fn() } catch (e) { toast(e.message, 'error') } finally {
      if (gomb) gomb.disabled = false
      await ujra()
    }
  }

  wrap.append(panel('Tartós üzenetek', rows.length + ' darab',
    sorok(rows.map(row => {
      const allapot = row.failureCount > 0
        ? ['bad', `${row.failureCount} sikertelen kísérlet`]
        : row.messageId ? ['ok', 'kint van'] : ['warn', 'még nem ment ki']

      const muveletek = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;' })

      const gomb = (cimke, osztaly, fn) => {
        const b = el('button', { class: 'btn btn-sm ' + osztaly }, [cimke])
        b.addEventListener('click', () => fut(fn, b))
        return b
      }

      if (status.configured) {
        muveletek.append(gomb('Frissítés most', 'btn-secondary', async () => {
          const r = await Api.resync(guildId, row.id)
          toast('Eredmény: ' + r.outcome)
        }))
        muveletek.append(gomb('Újra kiküldés', 'btn-ghost', async () => {
          if (!window.confirm('A jelenlegi üzenet törlődik, és új megy a csatorna aljára. Folytatod?')) return
          const r = await Api.recreate(guildId, row.id)
          toast(r.removedOld === false
            ? `Új üzenet kiment (${r.outcome}) — a régit nem sikerült törölni.`
            : `Új üzenet kiment: ${r.outcome}`)
        }))
      }
      muveletek.append(gomb('Előnézet', 'btn-ghost', async () => {
        const r = await Api.preview(guildId, row.id)
        elonezet(row, r)
      }))
      muveletek.append(gomb('Előzmény', 'btn-ghost', async () => { await elozmeny(guildId, row) }))
      muveletek.append(gomb('Szerkesztés', 'btn-ghost', async () => { urlap(guildId, row, ujra) }))
      muveletek.append(gomb(row.enabled ? 'Letiltás' : 'Engedélyezés', 'btn-secondary',
        async () => { await Api.updateMessage(guildId, row.id, { enabled: !row.enabled }) }))
      muveletek.append(gomb('Törlés', 'btn-ghost', async () => {
        // A DISCORD-ÜZENET MARAD — a kiszolgáló sem törli. Ezt ki is mondjuk.
        if (!window.confirm('Törlöd ezt a nyilvántartást? A már kiküldött Discord-üzenet a csatornában marad.')) return
        await Api.removeMessage(guildId, row.id)
        toast('Törölve.', 'success')
      }))

      return {
        label: UZENET_TIPUS[row.messageType] ?? row.messageType,
        tone: allapot[0],
        extra: row.enabled ? null : 'letiltva',
        detail: [
          allapot[1],
          '#' + row.channelId,
          row.lastSuccessAt ? 'utoljára sikeres: ' + ido(row.lastSuccessAt) : 'még nem volt sikeres',
          row.lastError ? 'hiba: ' + row.lastError : null
        ].filter(Boolean).join(' · '),
        action: muveletek
      }
    }), 'Ebben a szerverben még nincs tartós üzenet. Az „+ Új üzenet" gombbal vehetsz fel egyet.')))

  return wrap
}

/**
 * ÚJ ÜZENET ÉS SZERKESZTÉS.
 *
 * A TÍPUS SZERKESZTÉSKOR NEM VÁLTOZTATHATÓ, mert a kiszolgáló sem engedi: a
 * típus dönti el, mi van az üzenetben, és egy kint lévő üzenet típusát átírni
 * annyi lenne, mint kicserélni a tartalmát a csatornában.
 */
function urlap (guildId, letezo, ujra) {
  const csatorna = el('input', {
    class: 'input',
    type: 'text',
    inputmode: 'numeric',
    placeholder: '123456789012345678',
    value: letezo?.channelId ?? ''
  })
  const tipus = el('select', { class: 'input' },
    Object.entries(UZENET_TIPUS).map(([value, label]) =>
      el('option', { value, selected: letezo?.messageType === value }, [label])))
  if (letezo) tipus.disabled = true

  const bekapcsolva = el('input', { type: 'checkbox' })
  bekapcsolva.checked = letezo ? letezo.enabled : true

  const konfigDoboz = el('div')
  const konfigMezok = new Map()
  const konfigRajzol = () => {
    konfigMezok.clear()
    konfigDoboz.replaceChildren(...(KONFIG_MEZOK[tipus.value] ?? []).map(([kulcs, cimke, alap, hatar]) => {
      const input = el('input', {
        class: 'input',
        type: 'number',
        min: '1',
        value: String(letezo?.configuration?.[kulcs] ?? alap)
      })
      konfigMezok.set(kulcs, input)
      return mezo(cimke, input, hatar)
    }))
  }
  tipus.addEventListener('change', konfigRajzol)
  konfigRajzol()

  const hiba = el('div', { class: 'form-error', hidden: true })
  const diagSor = el('div', { class: 'meta-row-sub', style: 'margin-top:var(--space-2);' })

  const ellenoriz = el('button', { class: 'btn btn-ghost btn-sm' }, ['Csatorna ellenőrzése'])
  ellenoriz.addEventListener('click', async () => {
    diagSor.textContent = 'Ellenőrzés…'
    try {
      const r = await Api.diagnose(guildId, csatorna.value.trim())
      diagSor.textContent = r.ok
        ? '✅ A bot tud ide írni.' + (r.reason ? ` (${r.reason})` : '')
        : `⚠️ Nem tud ide írni${r.missing?.length ? ' — hiányzik: ' + r.missing.join(', ') : ''}${r.reason ? ` (${r.reason})` : ''}`
    } catch (e) {
      diagSor.textContent = 'Az ellenőrzés nem sikerült: ' + e.message
    }
  })

  const megse = el('button', { class: 'btn btn-ghost' }, ['Mégse'])
  const ment = el('button', { class: 'btn btn-primary' }, [letezo ? 'Mentés' : 'Létrehozás'])

  const hatter = dialog(letezo ? 'Tartós üzenet szerkesztése' : 'Új tartós üzenet',
    el('div', { style: 'display:flex;flex-direction:column;gap:var(--space-3);' }, [
      mezo('Típus', tipus, letezo ? 'A típus nem változtatható — ehhez új üzenet kell.' : null),
      mezo('Csatorna azonosítója', csatorna, 'Fejlesztői mód → jobb gomb a csatornán → Azonosító másolása.'),
      el('div', {}, [ellenoriz, diagSor]),
      konfigDoboz,
      mezo('Bekapcsolva', bekapcsolva, 'Kikapcsolva nem frissül, és a kint lévő üzenet marad, ahogy van.'),
      hiba
    ]), [megse, ment])

  megse.addEventListener('click', () => hatter.remove())

  ment.addEventListener('click', async () => {
    hiba.hidden = true
    const channelId = csatorna.value.trim()
    if (!/^\d{17,20}$/.test(channelId)) {
      hiba.textContent = 'A csatorna azonosítója 17–20 számjegy. A Discordban: jobb gomb a csatornán → Azonosító másolása.'
      hiba.hidden = false
      return
    }
    const configuration = {}
    for (const [kulcs, input] of konfigMezok) {
      const n = Number(input.value)
      if (Number.isFinite(n) && n > 0) configuration[kulcs] = n
    }
    try {
      if (letezo) {
        await Api.updateMessage(guildId, letezo.id, { channelId, configuration, enabled: bekapcsolva.checked })
      } else {
        await Api.createMessage(guildId, { channelId, messageType: tipus.value, configuration, enabled: bekapcsolva.checked })
      }
      hatter.remove()
      toast(letezo ? 'Mentve.' : 'Létrehozva — a következő körben megy ki.', 'success')
      await ujra()
    } catch (e) {
      // A 409 a leggyakoribb elutasítás: egy guildben egy típusból egy AKTÍV
      // üzenet lehet. Ezt mondjuk is, nem a nyers hibát.
      hiba.textContent = e.status === 409
        ? 'Ebben a szerverben már van ilyen típusú aktív üzenet. Módosítsd azt, vagy tiltsd le előbb.'
        : e.message
      hiba.hidden = false
    }
  })

  csatorna.focus()
}

/** Az előnézet — ami KIMENNE, nem ami kiment. */
function elonezet (row, result) {
  const embed = result?.payload?.embeds?.[0] ?? {}
  const bezar = el('button', { class: 'btn btn-secondary' }, ['Bezárás'])
  const hatter = dialog(UZENET_TIPUS[row.messageType] ?? row.messageType,
    el('div', {}, [
      el('p', { class: 'list-row-sub', text: 'Ez NEM ment ki — így nézne ki a következő frissítés után.' }),
      el('div', { class: 'setting-card', style: 'max-width:none;' }, [
        el('h3', { style: 'margin:0 0 var(--space-2);', text: embed.title ?? '(nincs cím)' }),
        embed.description ? el('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;', text: embed.description }) : null,
        embed.fields?.length
          ? el('div', { class: 'meta-rows', style: 'margin-top:var(--space-2);' }, embed.fields.map(f =>
            el('div', { class: 'meta-row' }, [
              el('div', { class: 'meta-row-main' }, [el('div', { text: f.name })]),
              el('div', { text: String(f.value) })
            ])))
          : null,
        embed.footer?.text
          ? el('div', { class: 'meta-row-sub', style: 'margin-top:var(--space-2);white-space:normal;', text: embed.footer.text })
          : null
      ])
    ]), [bezar])
  bezar.addEventListener('click', () => hatter.remove())
}

/**
 * AZ ELŐZMÉNY — „mikor ment, mikor nem, és miért".
 *
 * A `skipped` sorok itt a legfontosabbak, pedig azok tűnnek a
 * legunalmasabbnak: azok mutatják, hogy a tartalom nem változott, tehát a bot
 * NEM küldött felesleges kérést.
 */
async function elozmeny (guildId, row) {
  const torzs = el('div', { text: 'Betöltés…' })
  const bezar = el('button', { class: 'btn btn-secondary' }, ['Bezárás'])
  const hatter = dialog('Előzmények — ' + (UZENET_TIPUS[row.messageType] ?? row.messageType), torzs, [bezar])
  bezar.addEventListener('click', () => hatter.remove())

  try {
    const d = await Api.history(guildId, row.id)
    torzs.replaceChildren(sorok((d.data ?? []).map(e => ({
      label: ESEMENY[e.event] ?? e.event,
      tone: e.event === 'failed' ? 'bad' : e.event === 'skipped' ? 'ok' : '',
      detail: [ido(e.at), e.duration_ms != null ? e.duration_ms + ' ms' : null, e.detail].filter(Boolean).join(' · ')
    })), 'Erről az üzenetről még nincs bejegyzés.'))
  } catch (e) {
    torzs.replaceChildren(el('p', { class: 'form-error', text: 'Az előzmények nem tölthetők be: ' + e.message }))
  }
}
