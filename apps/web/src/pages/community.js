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
import { I18n, T } from '../shared/i18n/i18n.js'
import { P } from '../shared/ui/primitives.js'
import { U } from '../shared/lib/dom.js'
import { YumeAPI } from '../shared/api/yume.js'
import { Comments } from '../features/comments/comments.js'

const TABS = [
  { key: 'feed', label: 'Feed', flag: null },
  { key: 'forum', label: 'Forum', flag: 'forum' },
  { key: 'chat', label: 'Live chat', flag: 'chat' }
]

/**
 * A fiókkártya: belépve a név és a kijelentkezés, kijelentkezve a belépőlapra
 * visz. Csak a közösségi lap használja; 2026-09-ig a közös komponensek része
 * volt (`C.authCard`), tehát minden oldal letöltötte.
 */
function authCard (onAuthed = () => {}) {
  const wrap = U.el('div', { class: 'setting-card' })

  const render = () => {
    wrap.replaceChildren()
    const user = YumeAPI.user()

    if (user) {
      wrap.append(
        U.el('h3', { text: T('Yume account') }),
        U.el('p', { text: I18n.f(T('Signed in as {name}'), { name: user.username }) }),
        U.el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: async () => { await YumeAPI.logout(); render(); onAuthed() }
        }, [document.createTextNode(T('Sign out'))])
      )
      return
    }

    /*
     * KIJELENTKEZVE: ELKÜLDÜNK, NEM ŰRLAPOT RAJZOLUNK.
     *
     * Itt korábban egy teljes belépő űrlap állt — a HARMADIK másolat
     * ugyanabból a logikából, a felugró ablak és a kapu mellett. A
     * következménye pontosan az lett, ami a másolatoké szokott: amikor az
     * emberpróba bekerült, ebbe nem került bele, tehát a regisztráció innen
     * 403-mal hasalt volna el — ráadásul némán, mert ez a kártya a hibát egy
     * eltűnő toastban mutatta.
     *
     * Egy belépőlap van (`#/login`), és ez odavisz. A `next` viszi a
     * szándékot: aki a közösségi lapról indul, oda tér vissza.
     */
    const here = String(window.location.hash || '').replace(/^#\/?/, '').split('?')[0]
    const next = here ? `?next=${encodeURIComponent(here)}` : ''
    wrap.append(
      U.el('h3', { text: T('Yume account') }),
      U.el('p', { text: T('Sign in to join the discussion and sync with the platform.') }),
      U.el('div', { style: 'display:flex;gap:var(--space-2);margin-top:var(--space-3);flex-wrap:wrap;' }, [
        U.el('a', { class: 'btn btn-primary btn-sm', href: `#/login${next}` },
          [document.createTextNode(T('Sign in'))]),
        U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/login/register${next}` },
          [document.createTextNode(T('Create account'))])
      ])
    )
  }

  render()
  return wrap
}

export const PageCommunity = {
  async render (root, params) {
    // Whatever the last tab left open, close. A socket outliving its tab is
    // how a page ends up with four of them. (Only a loaded chat can have one.)
    this._chat?.close()

    root.append(C.spotlight(T('Community'), { subtitle: T('Boards, rooms and everything people are saying') }))
    const pad = U.el('div', { class: 'page-pad community-page' })
    root.append(pad)

    // A kiszolgáló címe DOM-szövegként megy ki, nem `innerHTML`-be fűzve: a
    // `yume-api` tárolt értékét bárki átírhatja a saját böngészőjében.
    if (!await YumeAPI.available()) {
      pad.append(U.el('div', { class: 'callout callout-warn' }, [
        U.svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 18),
        U.el('div', {}, [
          U.el('strong', { text: T('The community needs the server, and it is not reachable right now.') }),
          U.el('p', { text: I18n.f(T('Tried: {url}. Try again in a moment.'), { url: YumeAPI.base() }) })
        ])
      ]))
      return
    }

    // A tab whose feature is switched off is not drawn at all, rather than
    // drawn and then answering 404 when opened.
    const available = TABS.filter(tab => !tab.flag || featureOn(tab.flag))
    const asked = params.get('tab') ?? 'feed'
    const active = available.some(tab => tab.key === asked) ? asked : 'feed'

    const rail = U.el('nav', { class: 'tabs', 'aria-label': T('Community') })
    for (const tab of available) {
      rail.append(U.el('a', {
        class: 'tab' + (tab.key === active ? ' active' : ''),
        href: `#/community?tab=${tab.key}`,
        ...(tab.key === active ? { 'aria-current': 'page' } : {})
      }, [U.el('span', { text: T(tab.label) })]))
    }
    pad.append(rail)
    U.revealActiveTab(rail)

    const panel = U.el('div', { class: 'community-panel' })
    pad.append(panel)

    if (!YumeAPI.user() && active !== 'feed') {
      panel.append(authCard(() => { navigate() }))
    }

    const perms = permissionsHeld()
    // A fórum és a csevegés a saját fülükkel jön le, nem a hírfolyammal.
    if (active === 'forum') return await (await import('../features/forum/forum.js')).Forum.render(panel, params, perms)
    if (active === 'chat') {
      this._chat = (await import('../features/chat/chat.js')).Chat
      return await this._chat.render(panel, params, perms)
    }
    return await this._feed(panel)
  },

  async _feed (panel) {
    const feed = U.el('div', {}, Array.from({ length: 5 }, () => P.skeletonRow()))
    panel.append(U.el('h2', { class: 'detail-section-title', text: T('Recent discussion') }), feed)

    try {
      const { data } = await YumeAPI.recentComments()
      feed.replaceChildren()
      if (!data.length) {
        feed.append(P.emptyState(T('No discussion yet — be the first: open any anime and leave a comment.')))
        return
      }
      for (const comment of data) {
        // A cím egy valódi hivatkozás: a sor eddig egy kattintható `div` volt,
        // billentyűzettel elérhetetlen.
        const target = comment.anilist_id ? `#/anime/${comment.anilist_id}` : null
        const context = comment.anime_title
          ? (target
              ? U.el('a', { class: 'comment-context', href: target, text: I18n.f(T('on {title}'), { title: comment.anime_title }) })
              : U.el('span', { class: 'comment-context', text: I18n.f(T('on {title}'), { title: comment.anime_title }) }))
          : null
        feed.append(U.el('article', { class: 'comment' }, [
          U.el('div', { class: 'comment-head' }, [
            C.avatar(comment),
            U.el('span', { class: 'comment-author', text: comment.author }),
            context,
            U.el('time', { class: 'comment-time', datetime: new Date(comment.created_at).toISOString(), text: U.relTime(new Date(comment.created_at)) })
          ]),
          Comments.body(comment)
        ]))
      }
    } catch (e) {
      feed.replaceChildren(C.errorState(e, () => { navigate() }))
    }
  }
}
