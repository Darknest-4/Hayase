/* global document */
// Admin — Szerepkörök.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('roles')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { P } from '../../../shared/ui/primitives.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

export default {
  /**
   * A jogosultságok csoportjai.
   *
   * A csoport neve az adatbázisban azonosító (`permissions.group`), és a
   * szűrés is arra megy — ezért nem ott fordítjuk, hanem itt, megjelenítéskor.
   * Ami nincs a térképen, az a saját nevén jelenik meg: egy új csoport nem
   * tűnik el attól, hogy még nincs magyar neve.
   */
  PERM_GROUPS: {
    admin: 'Adminisztráció',
    ai: 'Mesterséges intelligencia',
    analytics: 'Statisztika',
    anime: 'Anime',
    catalogue: 'Katalógus',
    community: 'Közösség',
    developer: 'Fejlesztői',
    gamification: 'Játékosítás',
    library: 'Könyvtár',
    moderation: 'Moderálás',
    security: 'Biztonság',
    streaming: 'Lejátszás',
    system: 'Rendszer',
    users: 'Felhasználók'
  },

  // ---- Roles & permissions (fine-grained RBAC) ----
  async renderRoles (content) {
    let rolesRes, catRes
    try {
      [rolesRes, catRes] = await Promise.all([YumeAPI.admin.roles(), YumeAPI.admin.permissionCatalog()])
    } catch (e) {
      content.replaceChildren(P.errorState('A szerepkörök betöltése nem sikerült: ' + e.message))
      return
    }
    content.replaceChildren()

    const roles = rolesRes.data
    const catalog = catRes.data
    const total = catalog.length
    const groups = {}
    for (const p of catalog) (groups[p.group] ??= []).push(p)

    /*
     * Alapból csak az ÉLŐ jogosultságok látszanak.
     *
     * A katalógusban 365 sor van, és ebből 325 olyan modulokhoz tartozik,
     * amik nem léteznek — angol leírással, mert sosem került képernyőre.
     * Aki szerepkört állít, a negyven valódit keresi; a másik
     * háromszázhuszonöt között kell hozzá görgetnie. Egy kapcsolóval
     * előhozhatók, mert a katalógus maga nem hazugság: azok tényleg
     * tervezett jogosultságok.
     */
    const state = { role: roles[0], granted: new Set(roles[0].permissions), filter: '', showPlanned: false }

    const layout = U.el('div', { class: 'roles-layout' })
    content.append(layout)

    // ---- role rail ----
    const rail = U.el('div', { class: 'roles-rail' })
    const countLabel = {}
    for (const r of roles) {
      const cnt = U.el('span', { class: 'role-count' })
      countLabel[r.slug] = cnt
      rail.append(U.el('button', {
        class: 'role-item' + (r.slug === state.role.slug ? ' active' : ''),
        dataset: { slug: r.slug },
        onclick: () => {
          state.role = r
          state.granted = new Set(r.permissions)
          rail.querySelectorAll('.role-item').forEach(b => b.classList.toggle('active', b.dataset.slug === r.slug))
          renderPanel()
        }
      }, [
        U.el('div', { class: 'role-name', text: r.name }),
        U.el('div', { class: 'role-sub' }, [
          U.el('code', { text: r.slug }),
          // Magyarban a szám után egyes szám áll: „3 fiók", nem „3 fiókok".
          document.createTextNode(` · ${r.user_count} fiók`)
        ]),
        cnt
      ]))
    }
    layout.append(rail)

    // ---- permission panel ----
    const panel = U.el('div', { class: 'roles-panel' })
    layout.append(panel)

    const updateCounts = () => {
      for (const r of roles) {
        const n = r.slug === state.role.slug ? state.granted.size : r.permissions.length
        countLabel[r.slug].textContent = `${r.slug === 'admin' ? total : n}/${total}`
      }
    }

    const renderPanel = () => {
      panel.replaceChildren()
      const isAdmin = state.role.slug === 'admin'
      const has = slug => isAdmin || state.granted.has(slug)

      const head = U.el('div', { class: 'roles-panel-head' }, [
        U.el('div', {}, [
          U.el('h3', { style: 'margin:0;', text: state.role.name }),
          U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-1) 0 0;', text: isAdmin ? 'Az admin szerepkörnél mindig minden jogosultság megvan.' : `${total} jogosultságból ${state.granted.size} megadva` })
        ]),
        U.el('input', { class: 'input', placeholder: 'Jogosultságok szűrése…', value: state.filter, oninput: e => { state.filter = e.target.value.toLowerCase(); renderList() } })
      ])
      panel.append(head)

      const liveTotal = catalog.filter(p => p.status === 'active').length
      panel.append(U.el('div', { class: 'perm-legend' }, [
        U.el('span', {
          class: 'ap-note',
          text: `${liveTotal} jogosultságot érvényesít ma egy útvonal. ` +
            `További ${total - liveTotal} későbbi modulokhoz van katalogizálva — ezek ma semmit nem kapcsolnak.`
        }),
        U.el('label', { class: 'perm-toggle' }, [
          U.el('input', {
            type: 'checkbox',
            ...(state.showPlanned ? { checked: '' } : {}),
            onchange: e => { state.showPlanned = e.target.checked; renderList() }
          }),
          U.el('span', { text: 'a tervezettek is' })
        ])
      ]))

      const listWrap = U.el('div', { class: 'perm-groups' })
      panel.append(listWrap)

      const renderList = () => {
        listWrap.replaceChildren()
        for (const [group, perms] of Object.entries(groups)) {
          const visible = perms.filter(p =>
            (state.showPlanned || p.status === 'active') &&
            (!state.filter || p.slug.includes(state.filter) || p.description.toLowerCase().includes(state.filter)))
          if (!visible.length) continue
          const grantedInGroup = visible.filter(p => has(p.slug)).length
          const liveInGroup = visible.filter(p => p.status === 'active').length
          const groupBox = U.el('div', { class: 'perm-group' }, [
            U.el('div', { class: 'perm-group-head' }, [
              U.el('span', { class: 'perm-group-title', text: this.PERM_GROUPS[group] ?? group }),
              liveInGroup ? U.el('span', { class: 'perm-live-count', title: `${liveInGroup} jogosultságot érvényesít ma útvonal`, text: `${liveInGroup} él` }) : null,
              U.el('span', { class: 'perm-group-count', text: `${grantedInGroup}/${visible.length}` }),
              isAdmin ? null : U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => bulk(visible, grantedInGroup < visible.length) }, [document.createTextNode(grantedInGroup < visible.length ? 'Mindet megadom' : 'Mindet elveszem')])
            ])
          ])
          for (const p of visible) {
            const cb = U.el('input', {
              type: 'checkbox',
              ...(has(p.slug) ? { checked: '' } : {}),
              ...(isAdmin ? { disabled: '' } : {}),
              onchange: e => toggle(p.slug, e.target.checked, e.target)
            })
            groupBox.append(U.el('label', { class: 'perm-row' + (p.status === 'active' ? ' perm-active' : '') }, [
              cb,
              U.el('div', { class: 'perm-info' }, [
                U.el('div', { class: 'perm-slug-row' }, [
                  U.el('code', { class: 'perm-slug', text: p.slug }),
                  p.status === 'active'
                    ? U.el('span', { class: 'perm-badge perm-badge-live', title: 'Ma már útvonal érvényesíti', text: 'él' })
                    : U.el('span', { class: 'perm-badge perm-badge-planned', title: 'Egy későbbi modulhoz katalogizálva', text: 'tervezett' })
                ]),
                U.el('span', { class: 'perm-desc', text: p.description })
              ])
            ]))
          }
          listWrap.append(groupBox)
        }
      }

      const toggle = async (slug, granted, el) => {
        try {
          await YumeAPI.admin.setRolePermission(state.role.id, slug, granted)
          if (granted) state.granted.add(slug); else state.granted.delete(slug)
          // keep the source role object in sync so counts persist across switches
          state.role.permissions = [...state.granted]
          updateCounts()
          head.querySelector('.list-row-sub').textContent = `${total} jogosultságból ${state.granted.size} megadva`
          renderList()
        } catch (err) { U.toast(err.message, 'error'); if (el) el.checked = !granted }
      }

      const bulk = async (perms, grant) => {
        for (const p of perms) {
          if (grant === has(p.slug)) continue
          try { await YumeAPI.admin.setRolePermission(state.role.id, p.slug, grant); grant ? state.granted.add(p.slug) : state.granted.delete(p.slug) } catch (e) { /* skip */ }
        }
        state.role.permissions = [...state.granted]
        updateCounts(); renderList()
        head.querySelector('.list-row-sub').textContent = `${state.granted.size} of ${total} permissions granted`
        U.toast(grant ? 'Granted group' : 'Revoked group')
      }

      renderList()
    }

    updateCounts()
    renderPanel()
  }
}
