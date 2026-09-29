/* global document */
// Admin — Beállítások.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('config')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { refreshChrome } from '../../../shared/lib/shell.js'
import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  async renderConfig (content) {
    let data
    try {
      data = await YumeAPI.admin.config()
    } catch (e) {
      content.replaceChildren(P.errorState('A beállítások betöltése nem sikerült: ' + e.message))
      return
    }
    content.replaceChildren()

    const settings = data.settings ?? {}
    const applyLive = async () => { await refreshChrome() }

    // If the panel itself has been switched off, say so here rather than
    // letting it be a mystery. The reader is standing inside a room whose door
    // is shut: they can still see it because they hold `settings.system`, and
    // nobody else on the team can.
    const adminFlag = (data.flags ?? []).find(f => f.key === 'page.admin')
    if (adminFlag && !adminFlag.enabled) {
      content.append(U.el('div', { class: 'callout callout-warn' }, [
        U.el('strong', { text: 'Az adminfelület ki van kapcsolva. ' }),
        document.createTextNode(
          'Te azért látod, mert nálad van a settings.system jog — rajtatok kívül senki. Mindenki más, ' +
          'a moderátorokat és a szerkesztőket is beleértve, üres oldalt kap ezen a címen. Az alábbi ' +
          '„Oldalak" résznél kapcsold vissza az „Admin"-t.')
      ]))
    }

    // ---------- global settings ----------
    content.append(U.el('h2', { class: 'detail-section-title', text: 'Általános' }))

    const boolSetting = (key, title, desc) => {
      const on = settings[key] === true
      return U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:var(--space-4);' }, [
        U.el('div', { style: 'flex-grow:1;' }, [U.el('h3', { style: 'margin:0;', text: title }), U.el('p', { style: 'margin:var(--space-1) 0 0;', text: desc })]),
        U.el('label', { class: 'switch' }, [
          U.el('input', {
            type: 'checkbox',
            ...(on ? { checked: '' } : {}),
            onchange: async e => {
              try { await YumeAPI.admin.setSetting(key, e.target.checked); settings[key] = e.target.checked; U.toast('Mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error'); e.target.checked = on }
            }
          }),
          U.el('span', { class: 'slider' })
        ])
      ])
    }
    content.append(
      boolSetting('require_login', 'Belépés kötelező az egész oldalon', 'Minden lap bejelentkezési képernyő mögé kerül (a Beállítások elérhető marad).'),
      boolSetting('registration_open', 'Nyitott regisztráció', 'Bárki létrehozhat új fiókot.')
    )

    const textSetting = (key, title, desc) => U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: title }), U.el('p', { text: desc }),
      U.el('input', {
        class: 'input',
        style: 'min-width:20rem;',
        'aria-label': title,
        value: settings[key] ?? '',
        onchange: async e => {
          try { await YumeAPI.admin.setSetting(key, e.target.value); U.toast('Mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
        }
      })
    ])
    content.append(
      textSetting('site_name', 'Az oldal neve', 'A menü logója mellett és a böngészőfülön jelenik meg.'),
      textSetting('tagline', 'Mottó', 'Rövid leírás, ami több helyen felbukkan.')
    )

    // ---------- nyelv ----------
    // Két külön kérdés, ezért két vezérlő: mi az alapértelmezés, és van-e
    // egyáltalán mit választani. A váltás kikapcsolva nem elrejtés — az
    // onboarding nyelvi lépése és a beállítások nyelvsora is eltűnik, és a
    // /v1/config ugyanezt mondja.
    const langSelect = P.select(
      [['hu', 'Magyar'], ['en', 'English']],
      {
        value: settings.default_language ?? 'hu',
        'aria-label': 'Alapértelmezett nyelv',
        onchange: async e => {
          try { await YumeAPI.admin.setSetting('default_language', e.target.value); U.toast('Alapértelmezett nyelv mentve'); await applyLive() } catch (err) { U.toast(err.message, 'error') }
        }
      }
    )
    content.append(U.el('div', { class: 'setting-card', style: 'display:flex;align-items:center;gap:var(--space-4);' }, [
      U.el('div', { style: 'flex-grow:1;' }, [
        U.el('h3', { style: 'margin:0;', text: 'Alapértelmezett nyelv' }),
        U.el('p', { style: 'margin:var(--space-1) 0 0;', text: 'Ezt kapja, aki még nem választott. A böngésző nyelve nem dönt helyette.' })
      ]),
      langSelect
    ]))
    content.append(boolSetting(
      'language_switching',
      'Nyelvváltás engedélyezése',
      'Kikapcsolva mindenki az alapértelmezett nyelvet kapja, és a nyelvválasztó eltűnik az onboardingból és a beállításokból.'
    ))

    // ---------- feature flags ----------
    const flags = data.flags ?? []
    const groups = { page: 'Oldalak', feature: 'Funkciók' }
    for (const [cat, heading] of Object.entries(groups)) {
      const rows = flags.filter(f => f.category === cat)
      if (!rows.length) continue
      content.append(U.el('h2', { class: 'detail-section-title', text: heading }))
      const table = U.el('div', { class: 'flag-list' })
      for (const f of rows) table.append(this.flagRow(f, applyLive))
      content.append(table)
    }
  },

  flagRow (f, applyLive) {
    const state = { access: f.access, permission: f.required_permission }

    // Every control in this row is *about a named flag*, and the name is on
    // the row rather than on the control — so a screen reader announced
    // "edit text" twenty-three times on this page with nothing to tell them
    // apart. The label goes on each control.
    const permInput = U.el('input', {
      class: 'input flag-perm' + (state.access === 'permission' ? '' : ' hidden'),
      style: 'min-width:11rem;',
      placeholder: 'jogosultság azonosítója',
      'aria-label': `${f.label}: szükséges jogosultság`,
      value: state.permission ?? ''
    })

    /*
     * Save, and on refusal put the control back where it was.
     *
     * Without the revert the panel showed a state the server never accepted:
     * the switch sat in its new position, the toast scrolled away, and the
     * next reload quietly undid it. In read-only mode — where every write
     * outside this section answers 503 — that turned a whole screen of
     * settings into theatre. `undo` restores exactly the control that was
     * touched; the caller knows which one that is and the save does not.
     */
    const save = async (patch, undo) => {
      try {
        await YumeAPI.admin.setFlag(f.key, patch)
        U.toast(`${f.label} frissítve`)
        await applyLive()
      } catch (e) {
        U.toast(e.message, 'error')
        undo?.()
      }
    }

    const accessSel = U.el('select', {
      class: 'select flag-access',
      'aria-label': `${f.label}: hozzáférés`,
      onchange: async e => {
        const was = state.access
        state.access = e.target.value
        permInput.classList.toggle('hidden', state.access !== 'permission')
        await save(
          { access: state.access, requiredPermission: state.access === 'permission' ? (permInput.value.trim() || 'analytics.view') : null },
          () => {
            state.access = was
            e.target.value = was
            permInput.classList.toggle('hidden', was !== 'permission')
          }
        )
        if (state.access === 'permission' && !permInput.value.trim()) permInput.value = 'analytics.view'
      }
    }, [['public', 'Nyilvános'], ['auth', 'Belépés kell'], ['permission', 'Jogosultsághoz kötött']].map(([v, l]) =>
      U.el('option', { value: v, text: l, ...(state.access === v ? { selected: '' } : {}) })))

    permInput.addEventListener('change', () => {
      const was = state.permission ?? ''
      state.permission = permInput.value.trim() || null
      save({ requiredPermission: state.permission }, () => { state.permission = was || null; permInput.value = was })
    })

    const box = U.el('input', {
      type: 'checkbox',
      'aria-label': `${f.label}: bekapcsolva`,
      ...(f.enabled ? { checked: '' } : {}),
      onchange: e => save({ enabled: e.target.checked }, () => { e.target.checked = !e.target.checked })
    })
    const toggle = U.el('label', { class: 'switch' }, [box, U.el('span', { class: 'slider' })])

    return U.el('div', { class: 'flag-row' }, [
      U.el('div', { class: 'flag-meta' }, [
        U.el('div', { class: 'flag-label', text: f.label }),
        f.description ? U.el('div', { class: 'flag-desc', text: f.description }) : null,
        U.el('code', { class: 'flag-key', text: f.key })
      ]),
      U.el('div', { class: 'flag-controls' }, [accessSel, permInput, toggle])
    ])
  }
}
