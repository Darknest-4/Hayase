/* global document */
// Admin — Forrásszolgáltatók.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('providers')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { AP } from '../../../shared/ui/admin-ui.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  /**
   * A forrásszolgáltatók.
   *
   * MIT LÁT ITT AZ ÜZEMELTETŐ, ÉS MIÉRT ÉPP EZT:
   *
   *   * a KIKAPCSOLTAKAT IS. Egy kikapcsolt szolgáltató eltüntetése a
   *     listából pont azt a kapcsolót venné el, amivel vissza lehetne
   *     kapcsolni;
   *   * az EGÉSZSÉGET a kapcsoló mellett. „Kikapcsoljam?" és „magától
   *     kiesett?" két különböző helyzet, és ugyanaz a tünet — ha a kettő nem
   *     egy képernyőn van, az ember azt kapcsolja ki, ami csak épp lassú volt;
   *   * a SORRENDET, mert a lánc ezen halad, és a legelső szolgáltató dönti
   *     el, mit lát a néző a legtöbbször.
   */
  async renderProviders (content) {
    const rajzol = async () => {
      content.replaceChildren(AP.stack([AP.note('Betöltés…')]))
      let data
      try {
        ({ data } = await YumeAPI.admin.providers())
      } catch (error) {
        content.replaceChildren(AP.empty('A szolgáltatók nem kérhetők le', error.message))
        return
      }

      content.replaceChildren()
      content.append(U.el('p', {
        class: 'list-row-sub',
        style: 'max-width:46rem;margin:0 0 var(--space-4);',
        text: 'A lejátszás ezen a láncon halad, fentről lefelé. Az első, ami forrást ad, nyer. ' +
              'Egy megszűnt szolgáltató eltávolításához elég kikapcsolni: a lánc átlép rajta, és a lejátszó nem tud róla.'
      }))

      if (!data.length) {
        content.append(P.emptyState('Nincs bekötött szolgáltató.'))
        return
      }

      for (const sz of data) {
        const allapot = sz.health?.state ?? 'up'
        // A szín a TÉNYLEGES helyzetet mondja: a kikapcsolt szürke (döntés),
        // a kiesett piros (baj), a félig nyitott sárga (próbálkozunk).
        const szin = !sz.enabled
          ? 'var(--fg-faint)'
          : allapot === 'down' ? 'var(--danger)' : allapot === 'half-open' ? 'var(--status-paused)' : 'var(--ok)'
        const allapotSzo = !sz.enabled
          ? 'kikapcsolva'
          : allapot === 'down' ? 'kiesett' : allapot === 'half-open' ? 'próbálkozunk' : 'működik'

        const kartya = U.el('div', { class: 'setting-card', style: 'max-width:none;' })

        kartya.append(U.el('div', { style: 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap;' }, [
          U.el('span', { style: `width:.6rem;height:.6rem;border-radius:var(--radius-full);background:${szin};flex:0 0 auto;` }),
          U.el('h3', { style: 'margin:0;', text: sz.label || sz.slug }),
          U.el('span', { class: 'ext-type-chip', text: sz.slug }),
          U.el('span', { class: 'list-row-sub', text: `${allapotSzo} • sorrend: ${sz.priority}` })
        ]))

        // A MÉRT ADAT, nem szöveg: sikerek, hibák, utolsó válaszidő.
        const h = sz.health ?? {}
        const reszletek = [
          h.successes ? `${h.successes} sikeres feloldás` : null,
          h.failures ? `${h.failures} hiba` : null,
          h.lastLatencyMs != null ? `utolsó válasz: ${h.lastLatencyMs} ms` : null,
          h.retryAt ? `újra: ${new Date(h.retryAt).toLocaleTimeString('hu-HU')}` : null
        ].filter(Boolean)
        if (reszletek.length) {
          kartya.append(U.el('div', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;', text: reszletek.join(' • ') }))
        }
        if (h.lastError) {
          kartya.append(U.el('div', {
            class: 'list-row-sub',
            style: 'margin:var(--space-2) 0;color:var(--danger);word-break:break-word;',
            text: 'utolsó hiba: ' + h.lastError
          }))
        }

        const sor = U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-top:var(--space-3);' })

        const kapcsolo = U.el('button', {
          class: sz.enabled ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'
        }, [document.createTextNode(sz.enabled ? 'Kikapcsolás' : 'Bekapcsolás')])
        kapcsolo.addEventListener('click', async () => {
          kapcsolo.disabled = true
          try {
            await YumeAPI.admin.updateProvider(sz.slug, { enabled: !sz.enabled })
            U.toast(sz.enabled ? 'Kikapcsolva' : 'Bekapcsolva')
            await rajzol()
          } catch (error) {
            U.toast('Nem sikerült: ' + error.message, 'error')
            kapcsolo.disabled = false
          }
        })
        sor.append(kapcsolo)

        /*
         * A SORREND SZÁMMAL, nem nyilakkal. Egy nyíl azt sugallná, hogy a
         * szolgáltatók egy zárt listát alkotnak; a prioritás viszont
         * önmagában áll, és két szolgáltatónak lehet ugyanaz.
         */
        const prio = U.el('input', {
          class: 'input',
          type: 'number',
          min: '0',
          max: '1000',
          value: String(sz.priority),
          style: 'width:6rem;',
          'aria-label': `${sz.label || sz.slug} sorrendje`
        })
        const ment = U.el('button', { class: 'btn btn-ghost btn-sm' }, [document.createTextNode('Sorrend mentése')])
        ment.addEventListener('click', async () => {
          const ertek = Number(prio.value)
          if (!Number.isInteger(ertek) || ertek < 0 || ertek > 1000) {
            U.toast('A sorrend 0 és 1000 közötti egész szám', 'error')
            return
          }
          ment.disabled = true
          try {
            await YumeAPI.admin.updateProvider(sz.slug, { priority: ertek })
            U.toast('Mentve')
            await rajzol()
          } catch (error) {
            U.toast('Nem sikerült: ' + error.message, 'error')
            ment.disabled = false
          }
        })
        /*
         * A MEZŐNEK LÁTHATÓ FELIRATA IS VAN, nem csak `aria-label`-je.
         * Két gomb között egy puszta számdoboz nem mondja meg, mi az — és a
         * felolvasónak szánt felirat annak nem segít, aki látja a képernyőt.
         */
        sor.append(
          U.el('label', { style: 'display:flex;align-items:center;gap:var(--space-2);' }, [
            U.el('span', { class: 'list-row-sub', text: 'Sorrend' }),
            prio
          ]),
          ment
        )

        /*
         * „MIÓTA ROMLIK?" — erre egy pillanatnyi állapot nem válasz. Az
         * idővonal az állapotváltozásokat mutatja, nem minden kérést.
         */
        const naplo = U.el('div', { style: 'margin-top:var(--space-3);' })
        const naploGomb = U.el('button', { class: 'btn btn-ghost btn-sm' }, [document.createTextNode('Előzmények')])
        naploGomb.addEventListener('click', async () => {
          naploGomb.disabled = true
          try {
            const { data: esemenyek } = await YumeAPI.admin.providerEvents(sz.slug, 20)
            naplo.replaceChildren(esemenyek.length
              ? AP.list(esemenyek.map(e => AP.row({
                title: e.event === 'down' ? 'kiesett' : e.event === 'up' ? 'helyreállt' : e.event,
                meta: [new Date(e.at).toLocaleString('hu-HU'), e.detail].filter(Boolean).join(' — ')
              })))
              : AP.note('Még nincs esemény — ez a szolgáltató eddig nem romlott el.'))
          } catch (error) {
            naplo.replaceChildren(AP.note('Az előzmények nem kérhetők le: ' + error.message))
          } finally {
            naploGomb.disabled = false
          }
        })
        sor.append(naploGomb)

        kartya.append(sor, naplo)
        content.append(kartya)
      }
    }

    await rajzol()
  }
}
