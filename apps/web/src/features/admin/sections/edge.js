/* global document, window */
// Admin — Él.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('edge')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { AP } from '../../../shared/ui/admin-ui.js'
import { I18n } from '../../../shared/i18n/i18n.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'
import { AdminModals } from '../modals.js'

export default {
  // ---- Discord --------------------------------------------------------------
  //
  // EZ A SZAKASZ ELKÖLTÖZÖTT, és nem egyszerűen törölve lett: a
  // Discord-vezérlőpult saját címen él (`discord.animehub.hu`), saját
  // felülettel (`apps/discord`).
  //
  // MIÉRT. Más a közönsége és más a jogcíme. Oda az is beléphet, akinek a
  // YUME-ban NINCS admin jogosultsága, csak a Discord-szerverén van „Szerver
  // kezelése" joga — és egy ilyen embernek nem kell, és nem is szabad látnia
  // a katalógust, a felhasználókat vagy a moderációt. Amíg ugyanabban a
  // panelben ült, a kettő nem volt szétválasztható.
  //
  // A kiszolgálóoldal változatlan: ugyanazok a `/v1/discord/...` végpontok,
  // ugyanaz a `guildAccess` kapu. Csak a felület került át.

  // ---- él -------------------------------------------------------------------
  //
  // A kockázati réteg operátori felülete. A sorrend az, ahogy egy incidensben
  // végigmegy rajta az ember: „mi ez az egész állapotban?", „mi támad?",
  // „honnan?", „mit tiltottunk ki?".
  //
  // A legfontosabb dolog ezen a képernyőn a SZÁRAZ ÜZEM jelzése. Amíg az áll,
  // a rendszer mindent kiértékel és naplóz, de semmit nem utasít vissza — és
  // ezt nem szabad félreérteni sem így, sem úgy.

  EDGE_RANGES: [['24h', '24 óra'], ['7d', '7 nap'], ['30d', '30 nap']],

  EDGE_ACTIONS: {
    monitor: ['megfigyelve', ''],
    challenge: ['ellenőrzés', 'info'],
    throttle: ['lassítva', 'warn'],
    block: ['visszautasítva', 'bad']
  },

  async renderEdge (content) {
    const state = { range: this._edgeRange ?? '24h' }

    const draw = async () => {
      this._edgeRange = state.range
      content.replaceChildren(P.spinner())

      if (this._headActions) {
        this._headActions.replaceChildren(
          U.el('div', { class: 'dash-ranges' }, this.EDGE_RANGES.map(([value, label]) =>
            U.el('button', {
              class: 'dash-range' + (state.range === value ? ' active' : ''),
              type: 'button',
              onclick: () => { state.range = value; draw() }
            }, [document.createTextNode(label)])))
        )
      }

      let data
      try {
        data = await YumeAPI.admin.edge.overview(state.range)
      } catch (e) {
        content.replaceChildren(P.errorState('Az él adatainak betöltése nem sikerült: ' + e.message))
        return
      }

      const stack = AP.stack([])
      content.replaceChildren(stack)

      // ---- 1. milyen állapotban van ----
      const { config } = data
      stack.append(AP.card({
        cls: 'ap-status',
        body: [
          U.el('div', { class: 'ap-row-title' }, [
            document.createTextNode(config.enabled ? 'Az él figyel' : 'Az él ki van kapcsolva'),
            config.enabled
              ? AP.tag(config.dryRun ? 'száraz üzem' : 'éles', config.dryRun ? 'warn' : 'ok')
              : AP.tag('kikapcsolva', 'bad')
          ]),
          U.el('div', {
            class: 'ap-row-meta',
            text: !config.enabled
              ? 'Egyetlen kérést sem vizsgál. A Beállításoknál kapcsolható vissza.'
              : config.dryRun
                ? 'Mindent kiértékel és naplóz, de SEMMIT nem utasít vissza — a kézi tiltásokat kivéve. ' +
                  'Ez az üzembe helyezés első lépése: a lenti naplóból derül ki, kit fogna meg élesben.'
                : 'Éles üzem: a küszöböt átlépő kéréseket visszautasítja, és a támadó címeket ideiglenesen kitiltja.'
          }),
          U.el('div', {
            class: 'ap-note',
            style: 'margin-top:var(--ap-2);',
            text:
            `Küszöbök — megfigyelés: ${config.thresholds.monitor}, ellenőrzés: ${config.thresholds.challenge}, ` +
            `lassítás: ${config.thresholds.throttle}, tiltás: ${config.thresholds.block}. ` +
            `Hiba esetén visszautasít: ${config.failClosed.join(', ') || 'sehol'}.`
          })
        ]
      }))

      // ---- 2. mennyi ----
      const t = data.totals ?? {}
      stack.append(AP.section('Amit az él látott', { note: this.EDGE_RANGES.find(r => r[0] === state.range)?.[1] }))
      stack.append(AP.grid([
        AP.stat({ label: 'Döntés', value: Number(t.decisions ?? 0).toLocaleString(I18n.locale()), meta: 'nem átengedett kérés' }),
        AP.stat({ label: 'Visszautasítva', value: Number(t.blocked ?? 0).toLocaleString(I18n.locale()), tone: t.blocked ? 'bad' : undefined }),
        AP.stat({ label: 'Lassítva', value: Number(t.throttled ?? 0).toLocaleString(I18n.locale()), tone: t.throttled ? 'warn' : undefined }),
        AP.stat({ label: 'Megfigyelve', value: Number(t.monitored ?? 0).toLocaleString(I18n.locale()) }),
        AP.stat({ label: 'Érintett cím', value: Number(t.addresses ?? 0).toLocaleString(I18n.locale()) })
      ], { col: '13.5rem', stats: true }))

      if (!Number(t.decisions ?? 0)) {
        stack.append(AP.empty(
          'Nem történt semmi',
          'Az él egyetlen kérést sem talált gyanúsnak ebben az időszakban. ' +
          'Ez a jó állapot — nem azt jelenti, hogy nem figyel.'))
      }

      // ---- 3. honnan ----
      if (data.topIps?.length) {
        stack.append(AP.section('Ahonnan jött', {
          note: 'A cím mellett az, amit tudunk róla — egy puszta cím nem elég egy tiltáshoz'
        }))
        stack.append(AP.list(data.topIps.map(row => {
          const tags = []
          if (row.is_tor) tags.push(AP.tag('Tor', 'bad'))
          if (row.is_vpn) tags.push(AP.tag('VPN', 'warn'))
          if (row.is_hosting) tags.push(AP.tag('adatközpont', ''))
          if (Number(row.blocks) > 0) tags.push(AP.tag(`${row.blocks} visszautasítás`, 'bad'))
          return AP.row({
            title: row.ip,
            tags,
            meta: [
              `${Number(row.hits).toLocaleString(I18n.locale())} döntés`,
              row.provider ?? null,
              row.country ?? null,
              `legrosszabb pontszám: ${row.worst_score}`,
              U.relTime(new Date(row.last_seen))
            ].filter(Boolean).join(' · '),
            trail: [U.el('button', {
              class: 'btn btn-danger btn-sm',
              onclick: () => this.edgeBanDialog(row.ip, draw)
            }, [document.createTextNode('Tiltás')])]
          })
        })))
      }

      // ---- 4. mi ----
      if (data.topRules?.length) {
        stack.append(AP.section('Mire ütközött', { note: 'WAF-szabályok találatai' }))
        stack.append(AP.list(data.topRules.map(row => AP.row({
          title: row.rule,
          value: `${Number(row.hits).toLocaleString(I18n.locale())} találat`
        }))))
      }

      // ---- 5. mit tiltottunk ----
      stack.append(AP.section('Élő tiltások', {
        note: data.bans?.length ? undefined : 'Egy sincs',
        actions: [U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => this.edgeBanDialog('', draw)
        }, [document.createTextNode('Tiltás hozzáadása')])]
      }))
      if (data.bans?.length) {
        stack.append(AP.list(data.bans.map(b => AP.row({
          title: b.subject,
          tags: [
            AP.tag(b.kind === 'network' ? 'hálózat' : b.kind, b.kind === 'network' ? 'warn' : ''),
            AP.tag(b.automatic ? 'automatikus' : 'kézi', b.automatic ? '' : 'accent'),
            b.expires_at ? AP.tag('ideiglenes', '') : AP.tag('végleges', 'bad')
          ],
          meta: [
            b.reason,
            b.expires_at ? `lejár ${U.relTime(new Date(b.expires_at))}` : null,
            b.risk_score != null ? `${b.risk_score} pont` : null
          ].filter(Boolean).join(' · '),
          trail: [U.el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: async () => {
              const reason = window.prompt('Miért oldod fel?', '')
              if (!reason || reason.trim().length < 3) return
              try {
                await YumeAPI.admin.edge.unban(b.id, reason.trim())
                U.toast('Tiltás feloldva')
                draw()
              } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode('Feloldás')])]
        }))))
      }

      // ---- 6. a legutóbbi döntések ----
      if (data.recent?.length) {
        stack.append(AP.section('Legutóbbi döntések', {
          note: 'A jelek pontszámaival — ebből derül ki, MIÉRT'
        }))
        stack.append(AP.list(data.recent.slice(0, 25).map(d => {
          const [label, tone] = this.EDGE_ACTIONS[d.action] ?? [d.action, '']
          const signals = Object.entries(d.signals ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([key, points]) => `${key} +${points}`)
            .join(', ')
          return AP.row({
            title: `${d.method} ${d.route ?? '—'}`,
            tags: [AP.tag(label, tone), d.rule ? AP.tag(d.rule, 'bad') : null].filter(Boolean),
            meta: [d.ip, `${d.score} pont`, signals].filter(Boolean).join(' · '),
            value: U.relTime(new Date(d.at))
          })
        })))
      }
    }

    await draw()
  },

  /**
   * Tiltás kiadása.
   *
   * Az indoklás kötelező, és nem formalitás: egy tiltás, aminek nincs
   * indoklása, hat hónap múlva megmagyarázhatatlan — senki nem tudja, hogy
   * feloldható-e.
   */
  edgeBanDialog (subject, reload) {
    const kind = U.el('select', { class: 'select', style: 'width:100%;' }, [
      ['ip', 'IP-cím'], ['network', 'Hálózat (CIDR)'], ['user', 'Fiók'], ['session', 'Munkamenet']
    ].map(([v, l]) => U.el('option', { value: v, text: l })))
    const target = U.el('input', { class: 'input', style: 'width:100%;', value: subject, placeholder: '203.0.113.9' })
    const reason = U.el('input', { class: 'input', style: 'width:100%;', placeholder: 'Miért tiltod?' })
    const duration = U.el('select', { class: 'select', style: 'width:100%;' }, [
      ['3600', '1 óra'], ['86400', '1 nap'], ['604800', '1 hét'], ['', 'Végleges']
    ].map(([v, l]) => U.el('option', { value: v, text: l })))

    const modal = AdminModals.modalShell('Tiltás', [
      U.el('div', { class: 'callout' }, [
        U.el('strong', { text: 'Egy hálózat mögött emberek vannak. ' }),
        document.createTextNode(
          'Egy /24 kétszázötvenhat címet fed le, és a legtöbbjük mögött olyan valaki, aki nem csinált semmit. ' +
          'A /20-nál tágabb maszkot a rendszer visszautasítja.')
      ]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Mit' }), kind]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Kit' }), target]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Meddig' }), duration]),
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Indoklás' }), reason])
    ], async () => {
      if (!target.value.trim()) return U.toast('Add meg, kit tiltasz', 'error')
      if (reason.value.trim().length < 3) return U.toast('Az indoklás kötelező', 'error')
      try {
        await YumeAPI.admin.edge.ban({
          kind: kind.value,
          subject: target.value.trim(),
          reason: reason.value.trim(),
          ...(duration.value ? { seconds: Number(duration.value) } : {})
        })
        U.toast('Tiltás kiadva')
        modal.close()
        reload()
      } catch (e) { U.toast(e.message, 'error') }
    })

    const submit = modal.querySelector('.btn-primary')
    if (submit) {
      submit.textContent = 'Tiltás kiadása'
      submit.classList.remove('btn-primary')
      submit.classList.add('btn-danger')
    }
    return modal
  }
}
