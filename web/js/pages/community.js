/* global window, U, C, YumeAPI, T */
// Community page — platform-wide recent discussion feed (Yume API),
// with account sign-in when the user isn't authenticated yet.

const PageCommunity = {
  async render (root) {
    root.append(window.C.spotlight(T('Community'), { subtitle: T('Live discussion across the whole platform') }))
    const pad = U.el('div', { class: 'page-pad', style: 'max-width:56rem;' })
    root.append(pad)

    const content = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    pad.append(content)

    if (!await YumeAPI.available()) {
      content.replaceChildren(U.el('div', {
        class: 'callout',
        html: `
        <b>Community is a platform feature.</b><br>
        No Yume API reachable at <code>${YumeAPI.base()}</code> — start the backend or set
        your server in <a href="#/settings" style="text-decoration:underline">Settings</a>.`
      }))
      return
    }

    content.replaceChildren()

    if (!YumeAPI.user()) {
      content.append(C.authCard(() => { window.App.navigate() }))
    }

    const feed = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    content.append(U.el('h2', { class: 'detail-section-title', text: T('Recent discussion') }), feed)

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
            U.el('span', { class: 'comment-author', text: comment.author }),
            comment.anime_title ? U.el('span', { class: 'comment-context', text: T('on ') + comment.anime_title }) : null,
            U.el('span', { class: 'comment-time', text: U.relTime(new Date(comment.created_at)) })
          ]),
          C.commentBody(comment)
        ]))
      }
    } catch (e) {
      feed.replaceChildren(U.el('div', { class: 'error-state', text: T('Failed to load the feed: ') + e.message }))
    }
  }
}

window.PageCommunity = PageCommunity
