/* global window, document */
// The forum, as three views inside one tab: the board list, one board's
// topics, and one topic's posts.
//
// Which one is showing is in the URL — `#/community?tab=forum&f=slug&t=id` —
// so a link to a thread is a link to a thread, the back button walks back out
// of it, and a reload lands where you were. The alternative, keeping it in a
// variable, makes every one of those quietly wrong.
//
// 2026-09, újratervezve:
//
//   * MORZSAMENÜ a „← vissza" link helyett (Fórum › kategória › téma), a
//     közös `.breadcrumbs` komponenssel — a felolvasó is tudja, hol van.
//   * AZ ÚJ KATEGÓRIA ÉS AZ ÚJ TÉMA PÁRBESZÉDABLAKBAN, címkézett mezőkkel. Eddig
//     két címke nélküli, csak helyőrzős mező nyílt a lista fölött, és a hibát
//     egy eltűnő toast mondta — most a mező alatt áll, és a mező `aria-invalid`.
//   * LAPOZÁS: a témák 30-asával, a hozzászólások 50-esével jönnek, és eddig
//     a 31. téma és az 51. hozzászólás egyszerűen nem látszott. Most „Továbbiak"
//     gomb tölti a következő lapot (az API mindig is tudta: `offset`).
//   * A kitűzés és a zárolás ikon + szöveg (eddig egy 📌 emoji), a
//     hozzászólás elrejtése név nélküli „×" helyett megnevezett gomb, és
//     megerősítést kér.
//   * Kijelentkezve a válasz helyén a belépés gombja áll, nem csak egy mondat.

import { C } from '../../shared/ui/components.js'
import { I18n, T } from '../../shared/i18n/i18n.js'
import { P } from '../../shared/ui/primitives.js'
import { U } from '../../shared/lib/dom.js'
import { YumeAPI } from '../../shared/api/yume.js'

const PAGE_TOPICS = 30
const PAGE_POSTS = 50

const PIN = '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'
const LOCK = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
const PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>'

/** Move to another view without reloading. Writes the URL; the router redraws. */
function go (params) {
  const next = new URLSearchParams({ tab: 'forum', ...params })
  window.location.hash = `#/community?${next}`
}

const when = value => (value ? U.relTime(new Date(value)) : '')
const iso = value => (value ? new Date(value).toISOString() : null)

/** Egy időpont: relatív szöveg, a pontos idő a `datetime`-ban és a `title`-ben. */
function time (value) {
  if (!value) return null
  const date = new Date(value)
  return U.el('time', { datetime: iso(value), title: date.toLocaleString(I18n.locale()), text: when(value) })
}

/** Gombcímke ikonnal (a `P.button` címkéje csomópontlista is lehet). */
const withIcon = (icon, label) => [U.svg(icon, 16), document.createTextNode(label)]

/** Jelvény ikonnal: a zárolás és a kitűzés szövegként is elhangzik. */
function flag (icon, label) {
  return U.el('span', { class: 'badge forum-flag' }, [U.svg(icon, 12), document.createTextNode(label)])
}

/** Morzsamenü: Fórum › kategória › téma. Az utolsó elem a mostani lap. */
function crumbs (items) {
  return U.el('nav', { class: 'breadcrumbs forum-crumbs', 'aria-label': T('Breadcrumb') }, [
    U.el('ol', {}, items.map(([label, href], index) => U.el('li', {}, [
      index < items.length - 1
        ? U.el('a', { href, text: label })
        : U.el('span', { 'aria-current': 'page', text: label })
    ])))
  ])
}

/** A nézet fejléce: cím, alcím, és jobbra a műveletek. */
function head (title, sub, actions = []) {
  return U.el('div', { class: 'forum-head' }, [
    U.el('div', { class: 'forum-head-text' }, [
      U.el('h2', { class: 'section-title forum-title' }, [].concat(title)),
      sub ? U.el('p', { class: 'section-sub forum-sub' }, [].concat(sub)) : null
    ]),
    actions.filter(Boolean).length ? U.el('div', { class: 'forum-head-actions' }, actions.filter(Boolean)) : null
  ])
}

/** Kijelentkezve: a belépés gombja. A belépőlap a Közösség lapra hoz vissza. */
function signIn (text) {
  return U.el('div', { class: 'callout callout-info forum-signin' }, [
    U.el('p', { text }),
    U.el('a', { class: 'btn btn-secondary btn-sm', href: '#/login?next=community', text: T('Sign in') })
  ])
}

/**
 * Egy űrlap párbeszédablakban: címkézett mezők, a hiba a mező alatt.
 *
 * `fields`: [{ name, label, hint?, multiline?, maxlength, rows?, check(value) → hibaüzenet|null }]
 * `send(values)`: a kérés; ha dob, az üzenete az űrlap alján jelenik meg.
 */
function formDialog ({ title, submitLabel, fields, send }) {
  const inputs = {}
  const errors = {}
  const nodes = fields.map(field => {
    const input = field.multiline
      ? U.el('textarea', { class: 'textarea', name: field.name, rows: String(field.rows ?? 5), maxlength: String(field.maxlength) })
      : U.el('input', { class: 'input', name: field.name, maxlength: String(field.maxlength), autocomplete: 'off' })
    inputs[field.name] = input
    const wrap = P.field(field.label, input, field.hint ? { hint: field.hint } : {})
    const error = U.el('p', { class: 'field-error', id: `err-${field.name}-${Math.random().toString(36).slice(2, 8)}`, role: 'alert', hidden: true })
    errors[field.name] = error
    wrap.append(error)
    return wrap
  })
  const failure = U.el('p', { class: 'field-error', role: 'alert', hidden: true })
  const submit = P.button(submitLabel, { variant: 'primary', type: 'submit' })
  const form = U.el('form', { class: 'dialog-form', id: 'forum-form-' + Math.random().toString(36).slice(2, 8), novalidate: '' }, [...nodes, failure])
  submit.setAttribute('form', form.id)

  const setError = (name, message) => {
    const input = inputs[name]
    const error = errors[name]
    error.textContent = message ?? ''
    error.hidden = !message
    if (message) {
      input.setAttribute('aria-invalid', 'true')
      input.setAttribute('aria-describedby', error.id)
    } else {
      input.removeAttribute('aria-invalid')
      input.removeAttribute('aria-describedby')
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()
    failure.hidden = true
    const values = Object.fromEntries(fields.map(f => [f.name, inputs[f.name].value.trim()]))
    let first = null
    for (const field of fields) {
      const message = field.check?.(values[field.name]) ?? null
      setError(field.name, message)
      if (message && !first) first = inputs[field.name]
    }
    if (first) { first.focus(); return }
    submit.disabled = true
    submit.dataset.loading = '1'
    try {
      await send(values)
      dialog.close()
    } catch (e) {
      failure.textContent = e?.message ?? T('Something went wrong. Please try again.')
      failure.hidden = false
    } finally {
      submit.disabled = false
      delete submit.dataset.loading
    }
  })

  const dialog = C.openDialog({
    title,
    body: [form],
    actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => dialog.close() }), submit],
    initialFocus: inputs[fields[0].name]
  })
  return dialog
}

/** „Továbbiak": a következő lap, amíg egy teli lap jön vissza. */
function moreButton (onClick) {
  const button = P.button(T('Load more'), { variant: 'secondary' })
  button.addEventListener('click', async () => {
    button.disabled = true
    button.dataset.loading = '1'
    try {
      const more = await onClick()
      if (!more) button.parentElement?.remove()
    } catch (e) {
      U.toast(e.message, 'error')
    } finally {
      button.disabled = false
      delete button.dataset.loading
    }
  })
  return U.el('div', { class: 'load-more-wrap' }, [button])
}

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

    const create = perms.includes('forum.create')
      ? P.button(withIcon(PLUS, T('New board')), { variant: 'primary', size: 'sm', onclick: () => this._newBoard() })
      : null
    wrap.append(head(T('Forum'), T('Anyone can start a board. Be reasonable and it stays.'), [create]))

    const list = U.el('ul', { class: 'forum-list', 'aria-label': T('Boards') }, [U.el('li', {}, [P.spinner()])])
    wrap.append(list)

    let data
    try { ({ data } = await YumeAPI.forum.list()) } catch (e) {
      list.replaceWith(C.errorState(e, () => { root.replaceChildren(); this._boards(root, perms) }))
      return
    }

    if (!data.length) {
      list.replaceWith(P.emptyState(T('No boards yet. Start the first one.'), { title: T('The forum is empty') }))
      return
    }

    list.replaceChildren(...data.map(board => U.el('li', {}, [
      U.el('a', { class: 'forum-row', href: this.href({ f: board.slug }) }, [
        U.el('div', { class: 'forum-row-main' }, [
          U.el('span', { class: 'forum-row-title' }, [
            document.createTextNode(board.name),
            board.locked_at ? flag(LOCK, T('locked')) : null
          ]),
          board.description ? U.el('span', { class: 'forum-row-desc', text: board.description }) : null
        ]),
        U.el('span', { class: 'forum-row-meta' }, [
          U.el('span', { class: 'forum-row-count', text: I18n.f(T('{n} topics'), { n: I18n.number(board.topic_count ?? 0) }) }),
          board.last_post_at ? time(board.last_post_at) : null
        ])
      ])
    ])))
  },

  _newBoard () {
    formDialog({
      title: T('New board'),
      submitLabel: T('Create'),
      fields: [
        { name: 'name', label: T('Board name'), maxlength: 80, check: v => (v.length < 3 ? T('A board needs a name of at least 3 characters.') : null) },
        { name: 'description', label: T('What is it for?'), hint: T('Optional — one sentence is enough.'), maxlength: 500 }
      ],
      send: async ({ name, description }) => {
        const board = await YumeAPI.forum.create(name, description)
        go({ f: board.slug })
      }
    })
  },

  // ---- one board ----

  async _board (root, slug, perms) {
    const wrap = U.el('div', { class: 'forum' })
    root.append(wrap)

    let board, topics
    try {
      board = await YumeAPI.forum.get(slug)
      ;({ data: topics } = await YumeAPI.forum.topics(slug, { limit: PAGE_TOPICS }))
    } catch (e) {
      wrap.append(crumbs([[T('Forum'), this.href({})], [slug, null]]))
      wrap.append(C.errorState(e, () => { root.replaceChildren(); this._board(root, slug, perms) }))
      return
    }

    wrap.append(crumbs([[T('Forum'), this.href({})], [board.name, null]]))
    const canPost = perms.includes('topic.create') && !board.locked_at
    wrap.append(head(
      [document.createTextNode(board.name), board.locked_at ? flag(LOCK, T('locked')) : null],
      board.description ?? null,
      [canPost ? P.button(withIcon(PLUS, T('New topic')), { variant: 'primary', size: 'sm', onclick: () => this._newTopic(slug) }) : null]
    ))

    if (!topics.length) {
      wrap.append(P.emptyState(T('Nothing here yet. Write the first topic.'), { title: T('No topics yet') }))
      return
    }

    const list = U.el('ul', { class: 'forum-list', 'aria-label': T('Topics') })
    wrap.append(list)
    const add = rows => list.append(...rows.map(topic => this._topicRow(topic)))
    add(topics)

    let offset = topics.length
    if (topics.length === PAGE_TOPICS) {
      wrap.append(moreButton(async () => {
        const { data } = await YumeAPI.forum.topics(slug, { limit: PAGE_TOPICS, offset })
        offset += data.length
        add(data)
        return data.length === PAGE_TOPICS
      }))
    }
  },

  _topicRow (topic) {
    return U.el('li', {}, [
      U.el('a', { class: 'forum-row', href: this.href({ t: topic.id }) }, [
        U.el('div', { class: 'forum-row-main' }, [
          U.el('span', { class: 'forum-row-title' }, [
            topic.pinned ? flag(PIN, T('pinned')) : null,
            document.createTextNode(topic.title),
            topic.locked ? flag(LOCK, T('locked')) : null
          ]),
          U.el('span', { class: 'forum-row-byline' }, [
            C.avatar(topic, { size: 'xs' }),
            U.el('span', { text: topic.author }),
            document.createTextNode(' · '),
            time(topic.created_at)
          ])
        ]),
        U.el('span', { class: 'forum-row-meta' }, [
          U.el('span', { class: 'forum-row-count', text: I18n.f(T('{n} posts'), { n: I18n.number(topic.post_count ?? 0) }) })
        ])
      ])
    ])
  },

  _newTopic (slug) {
    formDialog({
      title: T('New topic'),
      submitLabel: T('Post'),
      fields: [
        { name: 'title', label: T('Title'), maxlength: 200, check: v => (v.length < 3 ? T('A topic needs a title of at least 3 characters.') : null) },
        { name: 'body', label: T('First post'), multiline: true, rows: 6, maxlength: 10000, check: v => (v ? null : T('Write something in the first post.')) }
      ],
      send: async ({ title, body }) => {
        const topic = await YumeAPI.forum.createTopic(slug, title, body)
        go({ t: topic.id })
      }
    })
  },

  // ---- one topic ----

  async _topic (root, id, perms) {
    const wrap = U.el('div', { class: 'forum' })
    root.append(wrap)

    let topic, posts
    try {
      topic = await YumeAPI.forum.topic(id)
      ;({ data: posts } = await YumeAPI.forum.posts(id, { limit: PAGE_POSTS }))
    } catch (e) {
      wrap.append(crumbs([[T('Forum'), this.href({})], [T('Topic'), null]]))
      wrap.append(C.errorState(e, () => this._reload(root, id, perms)))
      return
    }

    wrap.append(crumbs([
      [T('Forum'), this.href({})],
      [topic.forum_name, this.href({ f: topic.forum_slug })],
      [topic.title, null]
    ]))

    // Moderation, offered only to accounts that hold the grant. The server
    // checks the same thing again — this decides what to draw, not what is
    // allowed.
    const moderate = (label, patch) => P.button(label, {
      variant: 'ghost',
      size: 'sm',
      onclick: async () => {
        try { await YumeAPI.forum.updateTopic(id, patch); this._reload(root, id, perms) } catch (e) { U.toast(e.message, 'error') }
      }
    })
    wrap.append(head(
      [topic.pinned ? flag(PIN, T('pinned')) : null, document.createTextNode(topic.title), topic.locked ? flag(LOCK, T('locked')) : null],
      [C.avatar(topic, { size: 'xs' }), U.el('span', { text: topic.author }), document.createTextNode(' · '), time(topic.created_at)],
      [
        perms.includes('topic.pin') ? moderate(topic.pinned ? T('Unpin') : T('Pin'), { pinned: !topic.pinned }) : null,
        perms.includes('topic.lock') ? moderate(topic.locked ? T('Unlock') : T('Lock'), { locked: !topic.locked }) : null
      ]
    ))

    const thread = U.el('ol', { class: 'forum-thread', 'aria-label': T('Posts') })
    wrap.append(thread)
    const add = rows => thread.append(...rows.map(post => this._post(post, root, id, perms)))
    add(posts)

    let offset = posts.length
    if (posts.length === PAGE_POSTS) {
      wrap.append(moreButton(async () => {
        const { data } = await YumeAPI.forum.posts(id, { limit: PAGE_POSTS, offset })
        offset += data.length
        add(data)
        return data.length === PAGE_POSTS
      }))
    }

    if (topic.locked || topic.forum_locked) {
      wrap.append(U.el('div', { class: 'callout callout-info forum-locked' }, [
        U.svg(LOCK, 18),
        U.el('p', { text: T('This topic is locked. Nobody can reply.') })
      ]))
      return
    }
    if (!YumeAPI.user()) {
      wrap.append(signIn(T('Sign in to reply.')))
      return
    }
    if (!perms.includes('post.create')) return

    const body = U.el('textarea', { class: 'textarea', name: 'reply', rows: '4', maxlength: '10000' })
    const submit = P.button(T('Reply'), { variant: 'primary', type: 'submit' })
    const form = U.el('form', { class: 'forum-reply' }, [P.field(T('Your reply'), body), submit])
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (!body.value.trim()) { body.focus(); return }
      submit.disabled = true
      try {
        await YumeAPI.forum.reply(id, body.value.trim())
        this._reload(root, id, perms)
      } catch (e) {
        U.toast(e.message, 'error')
        submit.disabled = false
      }
    })
    wrap.append(form)
  },

  _post (post, root, id, perms) {
    return U.el('li', { class: 'forum-post' }, [
      U.el('div', { class: 'forum-post-head' }, [
        C.avatar(post),
        U.el('span', { class: 'forum-post-author', text: post.author }),
        U.el('span', { class: 'forum-post-when' }, [
          time(post.created_at),
          post.edited_at ? document.createTextNode(' · ' + T('(edited)')) : null
        ]),
        perms.includes('post.delete')
          ? U.el('button', {
            class: 'btn btn-ghost btn-sm forum-post-remove',
            type: 'button',
            'aria-label': I18n.f(T('Hide the post by {name}'), { name: post.author }),
            onclick: async () => {
              const ok = await C.confirm({
                title: T('Hide this post?'),
                message: T('It disappears from the thread for everyone. It is hidden, not deleted.'),
                confirmLabel: T('Hide'),
                danger: true
              })
              if (!ok) return
              try { await YumeAPI.forum.removePost(post.id); this._reload(root, id, perms) } catch (e) { U.toast(e.message, 'error') }
            }
          }, [document.createTextNode(T('Hide'))])
          : null
      ]),
      U.el('div', { class: 'forum-post-body', text: post.body })
    ])
  },

  /** Redraw one topic in place, without a round trip through the router. */
  _reload (root, id, perms) {
    root.replaceChildren()
    return this._topic(root, id, perms)
  },

  /** The URL a view lives at (the board list, a board, a topic). */
  href (params) {
    return `#/community?${new URLSearchParams({ tab: 'forum', ...params })}`
  }
}
