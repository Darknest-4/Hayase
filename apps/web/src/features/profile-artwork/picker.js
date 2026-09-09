/* global document, window */
// Choosing a profile picture and a banner from the catalogue.
//
// The grid opens on the viewer's own library rather than on the platform's most
// popular titles: the shows somebody watched are the ones they want on their
// profile, and their own shelf is a better first screen than a chart. Typing
// searches everything.
//
// The client never sends an image address. It sends the title, and the server
// resolves the picture — otherwise a profile picture would be an arbitrary URL
// that every visitor's browser fetches, which is a tracking pixel with extra
// steps.

import { C } from '../../shared/ui/components.js'
import { T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

/** How long to wait after the last keystroke before searching. */
const TYPING_PAUSE_MS = 300

export const ArtworkPicker = {
  /**
   * @param kind    'avatar' or 'banner'
   * @param profile the account's current profile row, for the preview
   * @param onSaved called with the updated profile row
   */
  open (kind, profile, onSaved) {
    document.getElementById('artwork-picker')?.remove()

    const isAvatar = kind === 'avatar'
    const backdrop = U.el('div', { class: 'modal-backdrop', id: 'artwork-picker' })
    const close = () => backdrop.remove()

    const grid = U.el('div', { class: 'artwork-grid' }, [U.el('div', { class: 'spinner' })])
    const note = U.el('p', { class: 'artwork-note' })

    const search = U.el('input', {
      class: 'input',
      type: 'search',
      placeholder: T('Search the catalogue…'),
      autocomplete: 'off'
    })

    let timer = null
    let generation = 0
    const load = async q => {
      const attempt = ++generation
      grid.replaceChildren(U.el('div', { class: 'spinner' }))
      let result
      try {
        result = await YumeAPI.profile.artwork({ kind, q })
      } catch (e) {
        if (attempt !== generation) return
        grid.replaceChildren(U.el('div', { class: 'error-state', text: e.message }))
        return
      }
      // A slower earlier search must not overwrite a faster later one.
      if (attempt !== generation) return

      grid.replaceChildren()
      note.textContent = {
        library: T('From your library. Type to search everything.'),
        search: T('Search results'),
        popular: T('Popular right now. Type to search everything.')
      }[result.source] ?? ''

      if (!result.data.length) {
        grid.append(U.el('div', { class: 'empty-state', text: T('Nothing matched.') }))
        return
      }

      for (const item of result.data) {
        grid.append(U.el('button', {
          class: 'artwork-tile' + (item.id === profile?.[`${kind}_anime_id`] ? ' active' : ''),
          title: item.title,
          onclick: async event => {
            const button = event.currentTarget
            button.disabled = true
            try {
              const updated = await YumeAPI.profile.update(
                isAvatar ? { avatarAnimeId: item.id } : { bannerAnimeId: item.id }
              )
              U.toast(isAvatar ? T('Profile picture updated') : T('Banner updated'))
              onSaved?.(updated)
              close()
            } catch (e) {
              U.toast(e.message, 'error')
              button.disabled = false
            }
          }
        }, [
          U.el('img', { src: item.image, alt: item.title, loading: 'lazy' }),
          U.el('span', { class: 'artwork-tile-title', text: item.title })
        ]))
      }
    }

    search.addEventListener('input', () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => load(search.value.trim() || undefined), TYPING_PAUSE_MS)
    })

    backdrop.append(U.el('div', {
      class: 'modal artwork-modal',
      onclick: event => event.stopPropagation()
    }, [
      U.el('div', { class: 'modal-head' }, [
        U.el('h2', { text: isAvatar ? T('Choose a profile picture') : T('Choose a banner') }),
        U.el('button', { class: 'icon-btn', title: T('Close'), onclick: close }, [document.createTextNode('×')])
      ]),
      search,
      note,
      grid,
      U.el('div', { class: 'modal-foot' }, [
        U.el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: async () => {
            try {
              const updated = await YumeAPI.profile.update(isAvatar ? { avatarAnimeId: null } : { bannerAnimeId: null })
              U.toast(isAvatar ? T('Profile picture removed') : T('Banner removed'))
              onSaved?.(updated)
              close()
            } catch (e) { U.toast(e.message, 'error') }
          }
        }, [document.createTextNode(isAvatar ? T('Remove picture') : T('Remove banner'))])
      ])
    ]))

    backdrop.addEventListener('click', close)
    document.addEventListener('keydown', function escape (event) {
      if (event.key !== 'Escape') return
      close()
      document.removeEventListener('keydown', escape)
    })

    document.body.append(backdrop)
    search.focus()
    load()
  },

  /**
   * The pair of cards the Settings screen shows: what is chosen now, and a way
   * to change it. Returned rather than appended so the caller places it.
   */
  cards (profile, onSaved) {
    const wrap = U.el('div', { class: 'artwork-cards' })

    const redraw = next => {
      wrap.replaceChildren(
        this._card('avatar', next, onSaved, redraw),
        this._card('banner', next, onSaved, redraw)
      )
    }
    redraw(profile)
    return wrap
  },

  _card (kind, profile, onSaved, redraw) {
    const isAvatar = kind === 'avatar'
    const image = isAvatar ? profile?.avatar_key : profile?.banner_key
    const from = isAvatar ? profile?.avatar_from : profile?.banner_from

    const preview = isAvatar
      ? C.avatar({ name: profile?.display_name, avatar_key: image }, { size: 'lg' })
      : U.el('div', {
        class: 'artwork-banner-preview',
        style: image ? `background-image:url("${image}")` : null
      }, [image ? null : U.el('span', { text: T('No banner yet') })])

    return U.el('div', { class: 'setting-card artwork-card' }, [
      U.el('h3', { text: isAvatar ? T('Profile picture') : T('Profile banner') }),
      U.el('p', {
        text: isAvatar
          ? T('Pick any title from the catalogue. Its cover becomes your picture.')
          : T('The widest artwork we hold for a title, across the top of your profile.')
      }),
      preview,
      from ? U.el('p', { class: 'artwork-from', text: T('From: ') + from }) : null,
      U.el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: () => this.open(kind, profile, updated => { onSaved?.(updated); redraw(updated) })
      }, [document.createTextNode(image ? T('Change') : T('Choose'))])
    ])
  }
}
