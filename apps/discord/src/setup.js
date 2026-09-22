/* global window */
/*
 * SETUP & AUTOMATIZÁLÁS — a vezérlőpult legveszélyesebb oldala.
 *
 * KÉT DOLGOT KELL JÓL CSINÁLNIA. Az első: soha ne mutasson sikert ott, ahol
 * részleges az eredmény. Egy zöld pipa egy félbehagyott szerver fölött
 * rosszabb, mint egy piros — az üzemeltető azt hiszi, kész, és hetekkel
 * később derül ki, hogy három csatorna hiányzik.
 *
 * A MÁSODIK: a gyári visszaállítás ne legyen egy kattintás. Két lépés,
 * szerveroldali jeggyel, és a törlendők listája ELŐRE látszik. Aki nem
 * látja, mit töröl, az nem tud érdemben megerősíteni.
 */

import { Api } from './api.js'
import { el, hianyzoForras, ido, kpi, panel, sorok, szam, toast } from './dom.js'

/** A terv műveleteinek magyar neve és színe. */
const MUVELET = {
  create: ['létrehozandó', 'warn'],
  adopt: ['örökbe fogadható', 'info'],
  update: ['módosítandó', 'warn'],
  recreate: ['újra létrehozandó', 'warn'],
  ok: ['rendben', 'ok'],
  blocked: ['nem végezhető el', 'bad']
}

/** A végrehajtás kimeneteinek magyar neve. */
const KIMENET = {
  created: ['létrehozva', 'ok'],
  adopted: ['örökbe fogadva', 'info'],
  updated: ['módosítva', 'ok'],
  recreated: ['újra létrehozva', 'ok'],
  skipped: ['kihagyva', ''],
  failed: ['sikertelen', 'bad'],
  blocked: ['nem végezhető el', 'bad']
}

const TIPUS = {
  category: 'kategória',
  channel: 'csatorna',
  role: 'rang',
  persistent_message: 'tartós üzenet'
}

function gomb (cimke, osztaly, fn) {
  const b = el('button', { class: 'btn btn-sm ' + osztaly }, [cimke])
  b.addEventListener('click', async () => {
    b.disabled = true
    try { await fn() } catch (e) { toast(e.message, 'error') } finally { b.disabled = false }
  })
  return b
}

/** Az eredmény listája — pontosan annyit mond, amennyi történt. */
function eredmenyLista (results) {
  return sorok((results ?? []).map(r => {
    const [cimke, tone] = KIMENET[r.outcome] ?? [r.outcome, '']
    return {
      label: `${TIPUS[r.type] ?? r.type}: ${r.key.replace(/^[a-z_]+:/, '')}`,
      tone,
      extra: cimke,
      detail: r.detail ?? r.reason ?? ''
    }
  }), 'Nem történt semmi.')
}

export async function setupView (guildId, ujra) {
  const d = await Api.setupStatus(guildId)
  const wrap = el('div')

  const szamok = d.counts ?? {}
  const rendben = szamok.ok ?? 0
  const teendo = (szamok.create ?? 0) + (szamok.update ?? 0) + (szamok.recreate ?? 0) + (szamok.adopt ?? 0)
  const blokkolt = szamok.blocked ?? 0

  wrap.append(el('div', { class: 'dash-cards' }, [
    kpi('Rendben', rendben, { tone: 'green', icon: '<path d="M20 6 9 17l-5-5"/>' }),
    kpi('Teendő', teendo, {
      tone: teendo > 0 ? 'amber' : 'green',
      icon: '<path d="M12 5v14M5 12h14"/>'
    }),
    kpi('Nem végezhető el', blokkolt, {
      tone: blokkolt > 0 ? 'red' : 'green',
      icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>'
    }),
    kpi('Nyilvántartva', (d.registry ?? []).length, {
      tone: 'blue',
      icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/>',
      meta: `leírás v${d.version}`
    })
  ]))

  // ---- ami útban van ----
  if ((d.missingPermissions ?? []).length) {
    wrap.append(hianyzoForras(
      'A bot jogosultságai hiányosak',
      'Ezek nélkül a setup egy része nem végezhető el. A Discordon a szerver beállításainál, ' +
      'a bot rangjánál adhatók meg.',
      d.missingPermissions))
  }

  // ---- műveletek ----
  const muveletek = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:var(--space-4);' })
  const eredmeny = el('div')

  muveletek.append(gomb('Előnézet', 'btn-secondary', async () => {
    const terv = await Api.setupPreview(guildId)
    eredmeny.replaceChildren(panel('Előnézet — ez még nem csinál semmit', `${terv.steps.length} lépés`,
      sorok(terv.steps.map(s => {
        const [cimke, tone] = MUVELET[s.action] ?? [s.action, '']
        return {
          label: `${TIPUS[s.type] ?? s.type}: ${s.name}`,
          tone,
          extra: cimke,
          detail: s.reason
        }
      }), 'Nincs lépés.')))
  }))

  muveletek.append(gomb('Setup futtatása', 'btn-primary', async () => {
    const r = await Api.setupRun(guildId)
    toast(r.status === 'ok' ? 'A setup lefutott.' : `Részleges eredmény: ${r.status}`,
      r.status === 'ok' ? 'success' : 'error')
    eredmeny.replaceChildren(panel('A futás eredménye', allapotSzoveg(r.status), eredmenyLista(r.results)))
    await ujra()
  }))

  muveletek.append(gomb('Javítás', 'btn-secondary', async () => {
    const r = await Api.setupRepair(guildId)
    const arva = r.resync?.orphaned ?? []
    toast(arva.length ? `${arva.length} eltűnt objektum pótolva.` : 'A javítás lefutott.',
      r.status === 'ok' ? 'success' : 'error')
    eredmeny.replaceChildren(panel('A javítás eredménye', allapotSzoveg(r.status), eredmenyLista(r.results)))
    await ujra()
  }))

  muveletek.append(gomb('Újraszinkronizálás', 'btn-ghost', async () => {
    const r = await Api.setupResync(guildId)
    toast(r.orphaned.length
      ? `${r.orphaned.length} objektum tűnt el a Discordból — a javítás pótolja.`
      : 'Minden nyilvántartott objektum megvan.')
    await ujra()
  }))

  muveletek.append(gomb('Parancsok feltöltése', 'btn-ghost', async () => {
    const r = await Api.registerCommands(guildId)
    toast(`${r.count} parancs feltöltve.`, 'success')
    await ujra()
  }))

  muveletek.append(gomb('Gyári visszaállítás', 'btn-ghost', async () => {
    await gyariVisszaallitas(guildId, eredmeny, ujra)
  }))

  wrap.append(muveletek, eredmeny)

  // ---- a terv ----
  wrap.append(panel('A szerver állapota', `${(d.plan ?? []).length} objektum a leírás szerint`,
    sorok((d.plan ?? []).map(s => {
      const [cimke, tone] = MUVELET[s.action] ?? [s.action, '']
      return {
        label: `${TIPUS[s.type] ?? s.type}: ${s.name}`,
        tone,
        extra: cimke,
        detail: s.reason
      }
    }), 'Nincs adat.')))

  // ---- parancsok ----
  wrap.append(panel('Slash parancsok',
    d.commands === null ? 'nem kérdezhető le' : `${d.commands.length} regisztrálva`,
    d.commands === null
      ? el('p', { class: 'list-row-sub', text: 'A parancsok nem kérdezhetők le — nincs bot token, vagy a bot nem éri el a szervert.' })
      : sorok(d.commands.map(n => ({ label: '/' + n, tone: 'ok', detail: '' })),
        'Egyetlen parancs sincs feltöltve. A „Parancsok feltöltése" gombbal tölthetők fel.')))

  // ---- futások ----
  wrap.append(panel('Futások', 'legfrissebb elöl',
    sorok((d.runs ?? []).map(r => ({
      label: r.mode,
      tone: r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'warn' : 'bad',
      extra: r.status,
      detail: [r.actor ?? 'rendszer', ido(r.started_at), osszegzes(r.summary)].filter(Boolean).join(' · ')
    })), 'Még nem futott setup.')))

  return wrap
}

function allapotSzoveg (status) {
  return status === 'ok'
    ? 'minden lépés sikerült'
    : status === 'partial'
      ? 'RÉSZLEGES — volt sikertelen lépés'
      : 'SIKERTELEN'
}

function osszegzes (summary) {
  const c = summary?.counts
  if (!c) return ''
  return Object.entries(c).map(([k, v]) => `${KIMENET[k]?.[0] ?? k}: ${v}`).join(', ')
}

/**
 * A GYÁRI VISSZAÁLLÍTÁS — két lépés, és a második is kérdez.
 *
 * Az első lépés megmutatja, MIT törölne, és kap hozzá egy szerveroldali
 * jegyet. A jegy öt percig él, egyszer használható, és a LISTÁHOZ van kötve:
 * ha közben változik a törlendők köre, a végrehajtás megáll.
 */
async function gyariVisszaallitas (guildId, doboz, ujra) {
  const elokeszites = await Api.resetPrepare(guildId)
  const torlendo = elokeszites.deletable ?? []
  const vedett = elokeszites.protected ?? []

  doboz.replaceChildren(panel('Gyári visszaállítás — előnézet',
    `${torlendo.length} objektum törlődne, ${vedett.length} védett`,
    el('div', {}, [
      el('p', {
        class: 'list-row-sub',
        style: 'margin:0 0 var(--space-3);max-width:46rem;',
        text: 'Csak azt törli, amit a YUME HOZOTT LÉTRE. Az örökbe fogadott objektumok — amiket a ' +
          'setup egy már létező, azonos nevű csatornán vagy rangon vett kezelésbe — érintetlenül maradnak.'
      }),
      sorok(torlendo.map(t => ({
        label: `${TIPUS[t.type] ?? t.type}: ${t.key.replace(/^[a-z_]+:/, '')}`,
        tone: 'bad',
        extra: 'törlődik',
        detail: t.objectId ?? 'nincs Discord-objektuma'
      })), 'Nincs mit törölni.'),
      vedett.length
        ? el('div', { style: 'margin-top:var(--space-3);' }, [
          el('p', { class: 'list-row-sub', text: 'Védett — NEM törlődik:' }),
          sorok(vedett.map(t => ({
            label: `${TIPUS[t.type] ?? t.type}: ${t.key.replace(/^[a-z_]+:/, '')}`,
            tone: 'ok',
            extra: 'védett',
            detail: 'nem a YUME hozta létre'
          })))
        ])
        : null,
      el('div', { style: 'margin-top:var(--space-4);display:flex;gap:8px;flex-wrap:wrap;' }, [
        gomb('Mégse', 'btn-ghost', async () => { doboz.replaceChildren() }),
        gomb(`Igen, töröld mind a(z) ${torlendo.length} objektumot`, 'btn-danger btn-primary', async () => {
          // A MÁSODIK KÉRDÉS. A jegy önmagában is elég volna technikailag; ez
          // az ember kedvéért van, aki véletlenül ide kattintott.
          if (!window.confirm(
            `Ez ${torlendo.length} Discord-objektumot töröl, és nem vonható vissza.\n\n` +
            'Biztosan folytatod?')) return
          const r = await Api.resetRun(guildId, elokeszites.token)
          toast(r.status === 'ok' ? 'A visszaállítás lefutott.' : `Részleges: ${r.status}`,
            r.status === 'ok' ? 'success' : 'error')
          doboz.replaceChildren(panel('A visszaállítás eredménye', allapotSzoveg(r.status), eredmenyLista(r.results)))
          await ujra()
        })
      ])
    ])))
}

// ---------------------------------------------------------------- köszöntő

export async function welcomeView (guildId, ujra) {
  const d = await Api.welcome(guildId)
  const wrap = el('div')

  const bekapcsolva = el('input', { type: 'checkbox' })
  bekapcsolva.checked = d.enabled
  const csatorna = el('input', {
    class: 'input',
    type: 'text',
    inputmode: 'numeric',
    placeholder: '123456789012345678',
    value: d.channelId ?? ''
  })
  const sablon = el('textarea', { class: 'input', rows: '8', style: 'font-family:inherit;' })
  sablon.value = d.template || d.defaultTemplate
  const rang = el('input', { class: 'input', type: 'text', placeholder: 'role:verified', value: d.roleKey ?? '' })
  const dm = el('input', { type: 'checkbox' })
  dm.checked = d.dmEnabled
  const emlit = el('input', { type: 'checkbox' })
  emlit.checked = d.mention

  const hiba = el('div', { class: 'form-error', hidden: true })
  const elonezet = el('div', { class: 'meta-row-sub', style: 'white-space:pre-wrap;margin-top:var(--space-2);' })

  const mezo = (cimke, vezerlo, sugo) => el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: cimke }),
    vezerlo,
    sugo ? el('p', { class: 'field-hint', text: sugo }) : null
  ])

  wrap.append(panel('Köszöntő', d.enabled ? 'bekapcsolva' : 'kikapcsolva', el('div', {
    style: 'display:flex;flex-direction:column;gap:var(--space-3);'
  }, [
    mezo('Bekapcsolva', bekapcsolva, 'Kikapcsolva egyetlen új tag sem kap köszöntőt.'),
    mezo('Csatorna azonosítója', csatorna, 'Fejlesztői mód → jobb gomb a csatornán → Azonosító másolása.'),
    mezo('Sablon', sablon, 'Használható változók: ' + (d.variables ?? []).map(v => `{${v}}`).join(', ')),
    mezo('Rang a belépőknek', rang, 'A YUME logikai kulcsa, például `role:verified`. Üresen: nincs rang.'),
    mezo('Privát üzenet is', dm, 'A köszöntő a tag privát üzenetében is megjelenik.'),
    mezo('Említse a tagot', emlit, 'Enélkül a tag nem kap értesítést a köszöntőről.'),
    hiba,
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
      gomb('Mentés', 'btn-primary', async () => {
        hiba.hidden = true
        try {
          await Api.saveWelcome(guildId, {
            enabled: bekapcsolva.checked,
            channelId: csatorna.value.trim() || null,
            template: sablon.value,
            roleKey: rang.value.trim() || null,
            dmEnabled: dm.checked,
            mention: emlit.checked
          })
          toast('Mentve.', 'success')
          await ujra()
        } catch (e) {
          // A SABLONHIBA SZÖVEGE AZ, AMI SEGÍT: megmondja, melyik változó
          // ismeretlen. Ezt kiírjuk, nem „valami hiba"-ként.
          hiba.textContent = e.message
          hiba.hidden = false
        }
      }),
      gomb('Előnézet', 'btn-secondary', async () => {
        const p = await Api.welcomePreview(guildId)
        elonezet.textContent = p.text
      }),
      gomb('Próbaköszöntő magamnak', 'btn-ghost', async () => {
        const r = await Api.welcomeTest(guildId)
        toast(r.outcome === 'sent' ? 'Kiment.' : `Nem ment ki: ${r.outcome}`,
          r.outcome === 'sent' ? 'success' : 'error')
      })
    ]),
    elonezet
  ])))

  const naplo = await Api.welcomeLog(guildId).catch(() => ({ data: [] }))
  wrap.append(panel('Köszöntő-napló', 'legfrissebb elöl',
    sorok((naplo.data ?? []).map(e => ({
      label: e.outcome,
      tone: e.outcome === 'sent' ? 'ok' : e.outcome === 'failed' ? 'bad' : '',
      detail: [e.discord_user_id, e.detail, ido(e.at)].filter(Boolean).join(' · ')
    })), 'Még nem történt belépés.')))

  return wrap
}

export { szam }
