/* global window */
// Community — three ways of talking, on one page.
//
//   Feed   what people are saying under the anime themselves
//   Forum  boards anyone can start, with topics and posts
//   Chat   public rooms, live
//
// Which tab is open is in the URL, not in a variable: `#/community?tab=forum`.
// That is what makes a link to a thread a link to a thread, and what makes the
// back button walk out of one.

import { navigate } from '../shared/lib/shell.js'
import { C } from '../shared/ui/components.js'
import { featureOn, permissionsHeld } from '../shared/lib/site-config.js'
import { Chat } from '../features/chat/chat.js'
import { Forum } from '../features/forum/forum.js'
import { T } from '../shared/i18n/i18n.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'

const TABS = [
  { key: 'feed', label: 'Feed', flag: null },
  { key: 'forum', label: 'Forum', flag: 'forum' },
  { key: 'chat', label: 'Live chat', flag: 'chat' }
]

export const PageCommunity = {
  async render (root, params) {
    // Whatever the last tab left open, close. A socket outliving its tab is
    // how a page ends up with four of them.
    Chat.close()

    root.append(C.spotlight(T('Community'), { subtitle: T('Boards, rooms and everything people are saying') }))
    const pad = U.el('div', { class: 'page-pad', style: 'max-width:60rem;' })
    root.append(pad)

    if (!await YumeAPI.available()) {
      pad.append(U.el('div', {
        class: 'callout',
        html: `
        <b>Community is a platform feature.</b><br>
        No Yume API reachable at <code>${YumeAPI.base()}</code> — start the backend or set
        your server in <a href="#/settings" style="text-decoration:underline">Settings</a>.`
      }))
      return
    }

    // A tab whose feature is switched off is not drawn at all, rather than
    // drawn and then answering 404 when opened.
    const available = TABS.filter(tab => !tab.flag || featureOn(tab.flag))
    const asked = params.get('tab') ?? 'feed'
    const active = available.some(tab => tab.key === asked) ? asked : 'feed'

    const rail = U.el('div', { class: 'tabs' })
    for (const tab of available) {
      rail.append(U.el('a', {
        class: 'tab' + (tab.key === active ? ' active' : ''),
        href: `#/community?tab=${tab.key}`
      }, [U.el('span', { text: T(tab.label) })]))
    }
    pad.append(rail)

    const panel = U.el('div', { class: 'community-panel' })
    pad.append(panel)

    if (!YumeAPI.user() && active !== 'feed') {
      panel.append(C.authCard(() => { navigate() }))
    }

    const perms = permissionsHeld()
    if (active === 'forum') return await Forum.render(panel, params, perms)
    if (active === 'chat') return await Chat.render(panel, params, perms)
    return await this._feed(panel)
  },

  async _feed (panel) {
    const feed = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    panel.append(U.el('h2', { class: 'detail-section-title', text: T('Recent discussion') }), feed)

    try {
      const { data } = await YumeAPI.recentComments()
      feed.replaceChildren()
      if (!data.length) {
        feed.append(U.el('div', { class: 'empty-state', text: T('No discussion yet — be the first: open any anime and leave a comment.') }))
        return
      }
      for (const comment of data) {
        const target = comment.anilist_id ? `#/anime/${comment.anilist_id}` : null
        feed.append(U.el('div', {
          class: 'comment' + (target ? ' comment-link' : ''),
          onclick: target ? () => { window.location.hash = target } : null
        }, [
          U.el('div', { class: 'comment-head' }, [
            C.avatar(comment),
            U.el('span', { class: 'comment-author', text: comment.author }),
            comment.anime_title ? U.el('span', { class: 'comment-context', text: T('on ') + comment.anime_title }) : null,
            U.el('span', { class: 'comment-time', text: U.relTime(new Date(comment.created_at)) })
          ]),
          C.commentBody(comment)
        ]))
      }
    } catch (e) {
      feed.replaceChildren(C.errorState(e, () => { navigate() }))
    }
  }
}
