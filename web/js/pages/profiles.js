/* global window, document, U, Store */
// "Who's watching" — Netflix-style profile picker + manager. Each profile
// has its own library, history, favourites, continue-watching and settings
// (namespaced in Store). Switching reloads the app for the new profile.

const PageProfiles = {
  AVATARS: ['🦊', '🐱', '🐼', '🐧', '🦉', '🐙', '🐢', '🦄', '🌸', '⭐', '🍜', '🎮'],

  render (root, params) {
    Store.ensureProfiles()
    const managing = params.get('manage') === '1'

    const wrap = U.el('div', { class: 'profiles-screen' })
    root.append(wrap)

    wrap.append(U.el('h1', { class: 'profiles-title', text: managing ? 'Manage profiles' : "Who's watching?" }))

    const grid = U.el('div', { class: 'profiles-grid' })
    wrap.append(grid)

    const render = () => {
      grid.replaceChildren()
      const profiles = Store.profiles()
      const activeId = Store.activeProfileId()

      for (const p of profiles) {
        const tile = U.el('button', {
          class: 'profile-tile' + (p.id === activeId ? ' active' : ''),
          onclick: () => {
            if (managing) return this.editProfile(p, render)
            Store.setActiveProfile(p.id)
            window.location.hash = '#/home'
            window.location.reload()
          }
        }, [
          U.el('div', { class: 'profile-avatar-big' }, [
            document.createTextNode(p.avatar ?? p.name.slice(0, 1).toUpperCase())
          ]),
          U.el('div', { class: 'profile-tile-name', text: p.name }),
          p.kids ? U.el('span', { class: 'badge badge-outline', text: 'KIDS' }) : null,
          managing ? U.el('div', { class: 'profile-tile-edit', text: '✎ Edit' }) : null
        ])
        grid.append(tile)
      }

      if (profiles.length < 6) {
        grid.append(U.el('button', {
          class: 'profile-tile profile-add',
          onclick: () => this.editProfile(null, render)
        }, [
          U.el('div', { class: 'profile-avatar-big profile-avatar-add', text: '+' }),
          U.el('div', { class: 'profile-tile-name', text: 'Add profile' })
        ]))
      }
    }
    render()

    wrap.append(U.el('div', { style: 'margin-top:2rem;' }, [
      managing
        ? U.el('a', { class: 'btn btn-primary', href: '#/profiles' }, [document.createTextNode('Done')])
        : U.el('a', { class: 'btn btn-secondary', href: '#/profiles?manage=1' }, [document.createTextNode('Manage profiles')])
    ]))
  },

  editProfile (profile, done) {
    const isNew = !profile
    const name = U.el('input', { class: 'input', style: 'width:100%;', maxlength: '50', placeholder: 'Profile name', value: profile?.name ?? '' })

    let chosenAvatar = profile?.avatar ?? this.AVATARS[0]
    const avatarGrid = U.el('div', { class: 'avatar-picker' }, this.AVATARS.map(a => {
      const btn = U.el('button', { class: 'avatar-opt' + (a === chosenAvatar ? ' active' : ''), text: a, onclick: () => {
        chosenAvatar = a
        avatarGrid.querySelectorAll('.avatar-opt').forEach(x => x.classList.toggle('active', x.textContent === a))
      } })
      return btn
    }))

    const kids = U.el('input', { type: 'checkbox', ...(profile?.kids ? { checked: '' } : {}) })
    const nsfw = U.el('input', { type: 'checkbox', ...(profile?.nsfw ? { checked: '' } : {}) })

    const fields = [
      U.el('div', { class: 'filter-group' }, [U.el('label', { text: 'Name' }), name]),
      U.el('div', {}, [U.el('label', { class: 'filter-group', style: 'display:block;margin-bottom:.4rem;', text: 'Avatar' }), avatarGrid]),
      U.el('label', { style: 'display:flex;gap:.5rem;align-items:center;font-size:.85rem;cursor:pointer;' }, [kids, document.createTextNode('Kids profile (hide mature content)')]),
      U.el('label', { style: 'display:flex;gap:.5rem;align-items:center;font-size:.85rem;cursor:pointer;' }, [nsfw, document.createTextNode('Allow adult (18+) content')])
    ]

    if (!isNew && Store.profiles().length > 1) {
      fields.push(U.el('button', {
        class: 'btn btn-sm', style: 'background:var(--danger);color:white;align-self:flex-start;',
        onclick: () => {
          if (!window.confirm(`Delete profile "${profile.name}" and all its data?`)) return
          Store.deleteProfile(profile.id)
          U.toast('Profile deleted')
          modal.remove()
          done()
        }
      }, [document.createTextNode('Delete profile')]))
    }

    const modal = window.C.modalShell(isNew ? 'Add profile' : 'Edit profile', fields, () => {
      const patch = { name: name.value.trim() || 'Profile', avatar: chosenAvatar, kids: kids.checked, nsfw: nsfw.checked }
      if (isNew) Store.createProfile(patch)
      else Store.updateProfile(profile.id, patch)
      U.toast(isNew ? 'Profile created' : 'Profile updated')
      modal.remove()
      done()
    })
  }
}

window.PageProfiles = PageProfiles
