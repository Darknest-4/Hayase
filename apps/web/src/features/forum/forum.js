/* global window, document */
// The forum, as three views inside one tab: the board list, one board's
// topics, and one topic's posts.
//
// Which one is showing is in the URL — `#/community?tab=forum&f=slug&t=id` —
// so a link to a thread is a link to a thread, the back button walks back out
// of it, and a reload lands where you were. The alternative, keeping it in a
// variable, makes every one of those quietly wrong.

import { C } from '../../shared/ui/components.js'
import { I18n, T } from '../../shared/i18n/i18n.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

/** Move to another view without reloading. Writes the URL; the router redraws. */
function go (params) {
  const next = new URLSearchParams({ tab: 'forum', ...params })
  window.location.hash = `#/community?${next}`
}

const when = value => (value ? U.relTime(new Date(value)) : '')

export const Forum = {
  /** `perms` is App.perms — what to *offer*; the server decides what happens. */
  async render (root, params, perms = []) {
    const forumSlug = params.get('f')
    const topicId = params.get('t')

    if (topicId) return await this._topic(root, topicId, perms)
    if (forumSlug) return await this._board(root, forumSlug, perms)
    return await this._boards(root, perms)
  },

  // ---- every board ----

  async _boards (root, perms) {
    const wrap = U.el('div', { class: 'forum' })
    root.append(wrap)

    const head = U.el('div', { class: 'forum-head' }, [
      U.el('div', {}, [
        U.el('h2', { class: 'detail-section-title', style: 'margin:0;', text: T('Forum') }),
        U.el('p', { class: 'forum-sub', text: T('Anyone can start a board. Be reasonable and it stays.') })
      ])
    ])
    if (perms.includes('forum.create')) {
      head.append(U.el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => this._newBoardForm(wrap)
      }, [document.createTextNode(T('New board'))]))
    }
    wrap.append(head)

    const list = U.el('div', { class: 'forum-boards' }, [U.el('div', { class: 'spinner' })])
    wrap.append(list)

    let data
    try { ({ data } = await YumeAPI.forum.list()) } catch (e) {
      list.replaceChildren(C.errorState(e, () => this._boards(root, perms)))
      return
    }

    list.replaceChildren()
    if (!data.length) {
      list.append(U.el('div', { class: 'empty-state', text: T('No boards yet. Start the first one.') }))
      return
    }

    for (const board of data) {
      list.append(U.el('a', { class: 'forum-board', href: `#/community?tab=forum&f=${encodeURIComponent(board.slug)}` }, [
        U.el('div', { class: 'forum-board-main' }, [
          U.el('div', { class: 'forum-board-name' }, [
            document.createTextNode(board.name),
            board.locked_at ? U.el('span', { class: 'forum-badge', text: T('locked') }) : null
          ]),
          board.description ? U.el('div', { class: 'forum-board-desc', text: board.description }) : null
        ]),
        U.el('div', { class: 'forum-board-stats' }, [
          U.el('span', { class: 'forum-count', text: String(board.topic_count) }),
          U.el('span', { class: 'forum-count-label', text: T('topics') }),
          board.last_post_at ? U.el('span', { class: 'forum-board-when', text: when(board.last_post_at) }) : null
        ])
      ]))
    }
  },

  _newBoardForm (wrap) {
    if (wrap.querySelector('.forum-new')) return
    const name = U.el('input', { class: 'input', placeholder: T('Board name'), maxlength: '80' })
    const description = U.el('input', { class: 'input', placeholder: T('What is it for? (optional)'), maxlength: '500' })
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Create') })
    const form = U.el('div', { class: 'forum-new' }, [
      name,
      description,
      U.el('div', { class: 'forum-new-actions' }, [
        submit,
        U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => form.remove() }, [document.createTextNode(T('Cancel'))])
      ])
    ])
    submit.addEventListener('click', async () => {
      const value = name.value.trim()
      if (value.length < 3) return U.toast(T('A board needs a name of at least 3 characters.'), 'error')
      submit.disabled = true
      try {
        const board = await YumeAPI.forum.create(value, description.value.trim())
        go({ f: board.slug })
      } catch (e) {
        U.toast(e.message, 'error')
        submit.disabled = false
      }
    })
    wrap.querySelector('.forum-boards').before(form)
    name.focus()
  },

  // ---- one board ----

  async _board (root, slug, perms) {
    const wrap = U.el('div', { class: 'forum' })
    root.append(wrap)
    wrap.append(U.el('a', { class: 'forum-back', href: '#/community?tab=forum', text: '← ' + T('All boards') }))

    let board, topics
    try {
      board = await YumeAPI.forum.get(slug)
      ;({ data: topics } = await YumeAPI.forum.topics(slug))
    } catch (e) {
      wrap.append(C.errorState(e, () => this._board(root, slug, perms)))
      return
    }

    const head = U.el('div', { class: 'forum-head' }, [
      U.el('div', {}, [
        U.el('h2', { class: 'detail-section-title', style: 'margin:0;', text: board.name }),
        board.description ? U.el('p', { class: 'forum-sub', text: board.description }) : null
      ])
    ])
    const canPost = perms.includes('topic.create') && !board.locked_at
    if (canPost) {
      head.append(U.el('button', {
        class: 'btn btn-primary btn-sm',
        onclick: () => this._newTopicForm(wrap, slug)
      }, [document.createTextNode(T('New topic'))]))
    }
    if (board.locked_at) head.append(U.el('span', { class: 'forum-badge', text: T('locked') }))
    wrap.append(head)

    const list = U.el('div', { class: 'forum-topics' })
    wrap.append(list)

    if (!topics.length) {
      list.append(U.el('div', { class: 'empty-state', text: T('Nothing here yet. Write the first topic.') }))
      return
    }

    for (const topic of topics) {
      list.append(U.el('a', { class: 'forum-topic', href: `#/community?tab=forum&t=${topic.id}` }, [
        U.el('div', { class: 'forum-topic-main' }, [
          U.el('div', { class: 'forum-topic-title' }, [
            topic.pinned ? U.el('span', { class: 'forum-pin', text: '📌' }) : null,
            document.createTextNode(topic.title),
            topic.locked ? U.el('span', { class: 'forum-badge', text: T('locked') }) : null
          ]),
          U.el('div', { class: 'forum-topic-meta', text: `${topic.author} · ${when(topic.created_at)}` })
        ]),
        U.el('div', { class: 'forum-board-stats' }, [
          U.el('span', { class: 'forum-count', text: String(topic.post_count) }),
          U.el('span', { class: 'forum-count-label', text: T('posts') })
        ])
      ]))
    }
  },

  _newTopicForm (wrap, slug) {
    if (wrap.querySelector('.forum-new')) return
    const title = U.el('input', { class: 'input', placeholder: T('Title'), maxlength: '200' })
    const body = U.el('textarea', { class: 'input', rows: '5', placeholder: T('Write the first post…') })
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Post') })
    const form = U.el('div', { class: 'forum-new' }, [
      title,
      body,
      U.el('div', { class: 'forum-new-actions' }, [
        submit,
        U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => form.remove() }, [document.createTextNode(T('Cancel'))])
      ])
    ])
    submit.addEventListener('click', async () => {
      if (title.value.trim().length < 3 || !body.value.trim()) {
        return U.toast(T('A topic needs a title and something to say.'), 'error')
      }
      submit.disabled = true
      try {
        const topic = await YumeAPI.forum.createTopic(slug, title.value.trim(), body.value.trim())
        go({ t: topic.id })
      } catch (e) {
        U.toast(e.message, 'error')
        submit.disabled = false
      }
    })
    wrap.querySelector('.forum-topics').before(form)
    title.focus()
  },

  // ---- one topic ----

  async _topic (root, id, perms) {
    const wrap = U.el('div', { class: 'forum' })
    root.append(wrap)

    let topic, posts
    try {
      topic = await YumeAPI.forum.topic(id)
      ;({ data: posts } = await YumeAPI.forum.posts(id))
    } catch (e) {
      wrap.append(C.errorState(e, () => this._topic(root, id, perms)))
      return
    }

    wrap.append(U.el('a', {
      class: 'forum-back',
      href: `#/community?tab=forum&f=${encodeURIComponent(topic.forum_slug)}`,
      text: '← ' + topic.forum_name
    }))

    const head = U.el('div', { class: 'forum-head' }, [
      U.el('div', {}, [
        U.el('h2', { class: 'detail-section-title', style: 'margin:0;' }, [
          topic.pinned ? U.el('span', { class: 'forum-pin', text: '📌' }) : null,
          document.createTextNode(topic.title)
        ]),
        U.el('p', { class: 'forum-sub', text: `${topic.author} · ${when(topic.created_at)}` })
      ])
    ])

    // Moderation, offered only to accounts that hold the grant. The server
    // checks the same thing again — this decides what to draw, not what is
    // allowed.
    const tools = U.el('div', { class: 'forum-tools' })
    if (perms.includes('topic.pin')) {
      tools.append(U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: async () => {
          try { await YumeAPI.forum.updateTopic(id, { pinned: !topic.pinned }); this._reload(root, id, perms) } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode(topic.pinned ? T('Unpin') : T('Pin'))]))
    }
    if (perms.includes('topic.lock')) {
      tools.append(U.el('button', {
        class: 'btn btn-ghost btn-sm',
        onclick: async () => {
          try { await YumeAPI.forum.updateTopic(id, { locked: !topic.locked }); this._reload(root, id, perms) } catch (e) { U.toast(e.message, 'error') }
        }
      }, [document.createTextNode(topic.locked ? T('Unlock') : T('Lock'))]))
    }
    if (tools.children.length) head.append(tools)
    wrap.append(head)

    const thread = U.el('div', { class: 'forum-thread' })
    wrap.append(thread)
    const me = YumeAPI.user()
    for (const post of posts) {
      thread.append(U.el('article', { class: 'forum-post' }, [
        U.el('div', { class: 'forum-post-head' }, [
          U.el('span', { class: 'forum-post-author', text: post.author }),
          U.el('span', { class: 'forum-post-when', text: when(post.created_at) }),
          post.edited_at ? U.el('span', { class: 'forum-post-when', text: T('(edited)') }) : null,
          perms.includes('post.delete')
            ? U.el('button', {
              class: 'icon-btn forum-post-remove',
              title: T('Hide this post'),
              onclick: async () => {
                try { await YumeAPI.forum.removePost(post.id); this._reload(root, id, perms) } catch (e) { U.toast(e.message, 'error') }
              }
            }, [document.createTextNode('×')])
            : null
        ]),
        U.el('div', { class: 'forum-post-body', text: post.body })
      ]))
    }

    if (topic.locked || topic.forum_locked) {
      wrap.append(U.el('div', { class: 'callout', text: T('This topic is locked. Nobody can reply.') }))
      return
    }
    if (!me) {
      wrap.append(U.el('div', { class: 'callout', text: T('Sign in to reply.') }))
      return
    }
    if (!perms.includes('post.create')) return

    const body = U.el('textarea', { class: 'input', rows: '4', placeholder: T('Write a reply…') })
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Reply') })
    submit.addEventListener('click', async () => {
      if (!body.value.trim()) return
      submit.disabled = true
      try {
        await YumeAPI.forum.reply(id, body.value.trim())
        this._reload(root, id, perms)
      } catch (e) {
        U.toast(e.message, 'error')
        submit.disabled = false
      }
    })
    wrap.append(U.el('div', { class: 'forum-reply' }, [body, submit]))
  },

  /** Redraw one topic in place, without a round trip through the router. */
  _reload (root, id, perms) {
    root.replaceChildren()
    return this._topic(root, id, perms)
  },

  /** Exported for the tests: the URL a view lives at. */
  href (params) {
    return `#/community?${new URLSearchParams({ tab: 'forum', ...params })}`
  },

  locale () { return I18n.locale() }
}
