/* global window, document, U, Store */
// Reusable render helpers: cards, horizontal sections, skeletons, modals.

const C = {
  HEART: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  PLAY: '<polygon points="6 3 20 12 6 21 6 3"/>',
  PLUS: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  CHECK: '<path d="M20 6 9 17l-5-5"/>',
  MINUS: '<path d="M5 12h14"/>',
  TRASH: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',

  card (media, { progress = null, subline = null } = {}) {
    const entry = Store.entry(media.id)
    const cover = U.el('div', { class: 'card-cover' }, [
      U.el('img', { src: U.cover(media), alt: U.title(media), loading: 'lazy' })
    ])

    if (entry) cover.append(U.el('div', { class: `card-status-dot dot-${entry.status}` }))

    if (media.averageScore) {
      cover.append(U.el('div', { class: 'card-score' }, [
        U.svg(this.HEART, 11),
        U.el('span', { text: media.averageScore + '%' })
      ]))
    }

    const prog = progress ?? entry?.progress
    if (prog && media.episodes) {
      cover.append(U.el('div', { class: 'card-progress' }, [
        U.el('div', { style: `width: ${Math.min(100, prog / media.episodes * 100)}%` })
      ]))
    }

    // play affordance revealed on hover
    cover.append(U.el('div', { class: 'card-play' }, [U.svg(this.PLAY, 18)]))

    const sub = subline ?? [U.format(media), U.seasonYear(media), media.episodes ? `${media.episodes} ep` : null].filter(Boolean).join(' • ')

    const card = U.el('a', { class: 'card', href: `#/anime/${media.id}` }, [
      cover,
      U.el('div', { class: 'card-title', text: U.title(media) }),
      U.el('div', { class: 'card-sub', text: sub })
    ])
    this._attachPreview(card, media)
    return card
  },

  // ---- spotlight header: a full-bleed banner from a random popular anime ----
  // The Yume catalogue DB stores metadata only, so banner artwork comes from
  // the same AniList source the rest of the app already uses. The chosen title
  // is credited, faintly, in the bottom-right corner.
  _spotlightPool: null,

  _spotlightPick () {
    if (!this._spotlightPool) {
      this._spotlightPool = (async () => {
        try {
          const page = await window.API.search({ sort: ['POPULARITY_DESC'], perPage: 50 })
          return (page.media ?? []).filter(m => m.bannerImage)
        } catch (e) { return [] }
      })()
    }
    return this._spotlightPool.then(pool => pool.length ? pool[Math.floor(Math.random() * pool.length)] : null)
  },

  spotlight (title, { subtitle = null, actions = null } = {}) {
    const bg = U.el('div', { class: 'spotlight-bg' })
    const credit = U.el('a', { class: 'spotlight-credit hidden' })
    const inner = U.el('div', { class: 'spotlight-inner' }, [
      U.el('h1', { class: 'spotlight-title', text: title }),
      subtitle ? U.el('p', { class: 'spotlight-sub', text: subtitle }) : null,
      actions ?? null
    ])
    const header = U.el('div', { class: 'spotlight' }, [bg, U.el('div', { class: 'spotlight-scrim' }), inner, credit])

    this._spotlightPick().then(m => {
      if (!m) return
      const url = m.bannerImage || U.cover(m)
      if (!url) return
      bg.style.backgroundImage = `url("${url}")`
      requestAnimationFrame(() => bg.classList.add('loaded'))
      credit.href = `#/anime/${m.id}`
      credit.textContent = U.title(m)
      credit.classList.remove('hidden')
    })
    return header
  },

  // ---- hover preview (like the original app's preview cards) ----
  _preview: null,
  _previewTimer: null,

  _closePreview () {
    clearTimeout(this._previewTimer)
    this._previewTimer = null
    this._preview?.remove()
    this._preview = null
  },

  _attachPreview (card, media) {
    if (!window.matchMedia('(hover: hover)').matches) return

    card.addEventListener('pointerenter', () => {
      clearTimeout(this._previewTimer)
      this._previewTimer = setTimeout(() => this._openPreview(card, media), 500)
    })
    card.addEventListener('pointerleave', () => {
      clearTimeout(this._previewTimer)
      // small grace period so the pointer can travel onto the panel
      this._previewTimer = setTimeout(() => {
        if (!this._preview?.matches(':hover')) this._closePreview()
      }, 150)
    })
  },

  _openPreview (card, media) {
    this._closePreview()
    const entry = Store.entry(media.id)
    const next = (entry?.progress ?? 0) + 1

    const head = U.el('div', { class: 'preview-media' })
    if (media.trailer?.id && media.trailer.site === 'youtube') {
      const frame = U.el('iframe', {
        class: 'preview-trailer',
        src: `https://www.youtube-nocookie.com/embed/${media.trailer.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${media.trailer.id}`,
        allow: 'autoplay',
        title: 'trailer preview'
      })
      frame.addEventListener('load', () => frame.classList.add('loaded'))
      head.append(frame)
    }
    if (media.bannerImage) head.style.backgroundImage = `url("${media.bannerImage}")`
    else if (U.cover(media)) head.style.backgroundImage = `url("${U.cover(media)}")`

    const meta = [U.format(media), U.seasonYear(media), media.episodes ? media.episodes + ' ep' : null, media.averageScore ? media.averageScore + '%' : null].filter(Boolean).join(' • ')

    const panel = U.el('div', { class: 'preview-panel' }, [
      head,
      U.el('div', { class: 'preview-body' }, [
        U.el('div', { class: 'preview-title', text: U.title(media) }),
        U.el('div', { class: 'preview-meta', text: meta }),
        U.el('div', { class: 'preview-desc', text: U.plainDesc(media.description) }),
        U.el('div', { style: 'display:flex;gap:.5rem;margin-top:.6rem;' }, [
          U.el('a', { class: 'btn btn-primary btn-sm', href: `#/watch/${media.id}:${next}`, onclick: () => this._closePreview() },
            [U.svg(this.PLAY, 12), document.createTextNode(entry?.progress ? `Ep ${next}` : 'Watch')]),
          entry
            ? U.el('span', { class: 'badge badge-outline', style: 'align-self:center;', text: U.listStatusMap[entry.status] })
            : U.el('button', {
                class: 'btn btn-secondary btn-sm',
                onclick: e => { Store.saveEntry(media, { status: 'PLANNING' }); U.toast('Added to Planning'); e.target.replaceWith(U.el('span', { class: 'badge badge-outline', text: 'Planning' })) }
              }, [document.createTextNode('+ Add to list')])
        ])
      ])
    ])

    panel.addEventListener('pointerleave', () => this._closePreview())
    panel.addEventListener('click', e => { if (e.target === panel) this._closePreview() })

    document.body.append(panel)
    const rect = card.getBoundingClientRect()
    const width = 320
    let left = rect.left + rect.width / 2 - width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(rect.top - 40, window.innerHeight - 320))
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
    this._preview = panel
    requestAnimationFrame(() => panel.classList.add('open'))
  },

  skeletonCard () {
    return U.el('div', { class: 'card' }, [
      U.el('div', { class: 'card-cover skeleton' }),
      U.el('div', { class: 'card-title skeleton', style: 'height:1em;border-radius:4px;' })
    ])
  },

  // horizontal scrolling section fed by a promise resolving to a media array
  section (title, mediaPromise, { moreHref = null, cardOptions = () => ({}) } = {}) {
    const row = U.el('div', { class: 'hscroll' }, Array.from({ length: 8 }, () => this.skeletonCard()))
    const head = U.el('div', { class: 'section-head' }, [
      U.el('h2', { class: 'section-title', text: title })
    ])
    if (moreHref) head.append(U.el('a', { class: 'section-more', href: moreHref, text: 'View more' }))

    const section = U.el('section', { class: 'section' }, [head, row])

    Promise.resolve(mediaPromise).then(mediaList => {
      row.replaceChildren()
      if (!mediaList?.length) {
        section.remove()
        return
      }
      for (const media of mediaList) row.append(this.card(media, cardOptions(media)))
    }).catch(() => {
      row.replaceChildren(U.el('div', { class: 'empty-state', text: 'Failed to load.' }))
    })

    return section
  },

  grid (mediaList, cardOptions = () => ({})) {
    return U.el('div', { class: 'grid' }, mediaList.map(media => this.card(media, cardOptions(media))))
  },

  // list-status dropdown + progress buttons used on the detail page
  listControls (media, onChange = () => {}) {
    const wrap = U.el('div', { class: 'detail-actions' })

    const render = () => {
      wrap.replaceChildren()
      const entry = Store.entry(media.id)

      const select = U.el('select', {
        class: 'select',
        onchange: e => {
          if (e.target.value === '') {
            Store.removeEntry(media.id)
            U.toast('Removed from list')
          } else {
            Store.saveEntry(media, { status: e.target.value })
            U.toast(`Set to ${U.listStatusMap[e.target.value]}`)
          }
          render()
          onChange()
        }
      }, [
        U.el('option', { value: '', text: entry ? 'Remove from list' : 'Add to list…' }),
        ...Object.entries(U.listStatusMap).map(([value, label]) =>
          U.el('option', { value, text: label, ...(entry?.status === value ? { selected: '' } : {}) }))
      ])
      wrap.append(select)

      if (entry && entry.status !== 'PLANNING') {
        const total = media.episodes ? ` / ${media.episodes}` : ''
        wrap.append(
          U.el('button', {
            class: 'icon-btn',
            title: 'Decrease progress',
            onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) - 1); render(); onChange() }
          }, [U.svg(this.MINUS, 14)]),
          U.el('span', { style: 'font-weight:800;font-size:.9rem;', text: `${entry.progress ?? 0}${total} ep` }),
          U.el('button', {
            class: 'icon-btn',
            title: 'Increase progress',
            onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) + 1); render(); onChange() }
          }, [U.svg(this.PLUS, 14)])
        )
      }

      const fav = Store.isFavourite(media.id)
      wrap.append(U.el('button', {
        class: `btn btn-sm ${fav ? 'btn-theme' : 'btn-ghost'}`,
        onclick: () => {
          const nowFav = Store.toggleFavourite(media.id)
          U.toast(nowFav ? 'Added to favourites' : 'Removed from favourites')
          render()
        }
      }, [U.svg(this.HEART, 14), document.createTextNode(fav ? 'Favourited' : 'Favourite')]))
    }

    render()
    return wrap
  },

  // ---- Yume account sign-in/register card ----
  authCard (onAuthed = () => {}) {
    /* global YumeAPI */
    const wrap = U.el('div', { class: 'setting-card' })

    const render = () => {
      wrap.replaceChildren()
      const user = YumeAPI.user()

      if (user) {
        wrap.append(
          U.el('h3', { text: 'Yume account' }),
          U.el('p', { text: `Signed in as ${user.username}.` }),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            onclick: async () => { await YumeAPI.logout(); render(); onAuthed() }
          }, [document.createTextNode('Sign out')])
        )
        return
      }

      let mode = 'login'
      const email = U.el('input', { class: 'input', type: 'email', placeholder: 'Email', autocomplete: 'email' })
      const identifier = U.el('input', { class: 'input', type: 'text', placeholder: 'Email or username', autocomplete: 'username' })
      const username = U.el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'username' })
      const password = U.el('input', { class: 'input', type: 'password', placeholder: 'Password (min 8 chars)', autocomplete: 'current-password' })
      const fields = U.el('div', { style: 'display:flex;flex-direction:column;gap:.6rem;max-width:22rem;' })
      const switchBtn = U.el('button', { class: 'btn btn-ghost btn-sm' })
      const submitBtn = U.el('button', { class: 'btn btn-primary btn-sm' })

      const renderMode = () => {
        fields.replaceChildren(...(mode === 'login' ? [identifier, password] : [email, username, password]))
        submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Create account'
        switchBtn.textContent = mode === 'login' ? 'New here? Register' : 'Have an account? Sign in'
      }
      switchBtn.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; renderMode() })

      submitBtn.addEventListener('click', async () => {
        try {
          submitBtn.disabled = true
          if (mode === 'login') await YumeAPI.login(identifier.value.trim(), password.value)
          else await YumeAPI.register(email.value.trim(), username.value.trim(), password.value)
          U.toast(`Signed in as ${YumeAPI.user().username}`)
          render()
          onAuthed()
        } catch (e) {
          U.toast(e.message, 'error')
        } finally {
          submitBtn.disabled = false
        }
      })
      password.addEventListener('keydown', e => { if (e.key === 'Enter') submitBtn.click() })

      renderMode()
      wrap.append(
        U.el('h3', { text: 'Yume account' }),
        U.el('p', { text: 'Sign in to join the discussion and sync with the platform.' }),
        fields,
        U.el('div', { style: 'display:flex;gap:.6rem;margin-top:.75rem;' }, [submitBtn, switchBtn])
      )
    }

    render()
    return wrap
  },

  // ---- comment rendering (spoiler-aware, plain text) ----
  commentBody (comment) {
    const body = U.el('div', { class: 'comment-body', text: comment.body })
    if (!comment.spoiler) return body
    const shield = U.el('div', {
      class: 'comment-spoiler',
      text: 'Spoiler — click to reveal',
      onclick: e => { e.stopPropagation(); shield.replaceWith(body) }
    })
    return shield
  },

  // ---- per-anime comment section (detail page) ----
  commentsSection (media) {
    const wrap = U.el('div')
    const list = U.el('div', {}, [U.el('div', { class: 'spinner' })])

    const load = async () => {
      const yumeId = await YumeAPI.yumeAnimeId(media)
      list.replaceChildren()

      if (yumeId) {
        try {
          const { data } = await YumeAPI.comments('anime', yumeId)
          if (!data.length) {
            list.append(U.el('div', { class: 'empty-state', style: 'padding:1.5rem;', text: 'No comments yet.' }))
          }
          const byParent = new Map()
          for (const c of data) {
            const key = c.parent_id ?? 'root'
            if (!byParent.has(key)) byParent.set(key, [])
            byParent.get(key).push(c)
          }
          const renderThread = (comment, depth) => {
            const node = U.el('div', { class: 'comment', style: depth ? `margin-left:${Math.min(depth, 4) * 1.5}rem;` : null }, [
              U.el('div', { class: 'comment-head' }, [
                U.el('span', { class: 'comment-author', text: comment.author }),
                U.el('span', { class: 'comment-time', text: U.relTime(new Date(comment.created_at)) })
              ]),
              this.commentBody(comment),
              U.el('div', { class: 'comment-actions' }, [
                U.el('button', {
                  class: 'comment-action',
                  text: `♥ ${comment.like_count}`,
                  onclick: async e => {
                    try {
                      const { liked } = await YumeAPI.likeComment(comment.id)
                      comment.like_count += liked ? 1 : -1
                      e.target.textContent = `♥ ${comment.like_count}`
                    } catch (err) { U.toast(err.message, 'error') }
                  }
                }),
                U.el('button', {
                  class: 'comment-action',
                  text: 'Reply',
                  onclick: () => {
                    if (node.querySelector('.comment-form')) return
                    node.append(form(comment.id, () => load()))
                  }
                }),
                U.el('button', {
                  class: 'comment-action',
                  text: 'Report',
                  onclick: async () => {
                    const reason = window.prompt('Reason (spam / harassment / nsfw / spoiler / illegal / other):', 'spam')
                    if (!reason) return
                    try {
                      await YumeAPI.report('comment', comment.id, ['spam', 'harassment', 'nsfw', 'spoiler', 'illegal'].includes(reason) ? reason : 'other', reason)
                      U.toast('Report submitted — thank you')
                    } catch (err) { U.toast(err.message, 'error') }
                  }
                })
              ])
            ])
            list.append(node)
            for (const child of byParent.get(comment.id) ?? []) renderThread(child, depth + 1)
          }
          for (const comment of byParent.get('root') ?? []) renderThread(comment, 0)
        } catch (e) {
          list.append(U.el('div', { class: 'error-state', text: 'Failed to load comments: ' + e.message }))
        }
      } else {
        list.append(U.el('div', { class: 'empty-state', style: 'padding:1.5rem;', text: 'No comments yet.' }))
      }

      // composer / auth prompt
      if (YumeAPI.user()) {
        if (!list.querySelector('.comment-form-root')) list.append(form(null, () => load(), true))
      } else {
        list.append(U.el('div', { class: 'callout', html: 'Sign in to your <a href="#/community" style="text-decoration:underline">Yume account</a> to join the discussion.' }))
      }
    }

    const form = (parentId, done, root = false) => {
      const textarea = U.el('textarea', { class: 'input comment-input', rows: '3', placeholder: parentId ? 'Write a reply…' : 'Share your thoughts… (no spoilers unmarked!)' })
      const spoiler = U.el('input', { type: 'checkbox' })
      const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: 'Post' })
      submit.addEventListener('click', async () => {
        const body = textarea.value.trim()
        if (!body) return
        try {
          submit.disabled = true
          const yumeId = await YumeAPI.yumeAnimeId(media, { create: true })
          await YumeAPI.postComment('anime', yumeId, body, { parentId, spoiler: spoiler.checked })
          U.toast('Comment posted')
          done()
        } catch (e) {
          U.toast(e.message, 'error')
        } finally {
          submit.disabled = false
        }
      })
      return U.el('div', { class: 'comment-form' + (root ? ' comment-form-root' : '') }, [
        textarea,
        U.el('div', { style: 'display:flex;gap:.75rem;align-items:center;margin-top:.5rem;' }, [
          submit,
          U.el('label', { style: 'display:flex;gap:.4rem;align-items:center;font-size:.78rem;color:var(--fg-faint);cursor:pointer;' }, [spoiler, document.createTextNode('Spoiler')])
        ])
      ])
    }

    YumeAPI.available().then(ok => {
      if (!ok) {
        wrap.remove() // no backend → no comment section at all, no dead UI
        return
      }
      wrap.append(U.el('h2', { class: 'detail-section-title', text: 'Comments' }), list)
      load()
    })

    return wrap
  },

  // generic form modal (shared by developer portal and admin webhooks)
  modalShell (title, fields, onSubmit) {
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', onclick: onSubmit }, [document.createTextNode('Save')])
    const backdrop = U.el('div', { class: 'modal-backdrop', onclick: e => { if (e.target === backdrop) backdrop.remove() } }, [
      U.el('div', { class: 'search-modal', style: 'padding:1.25rem;max-width:40rem;width:min(40rem,calc(100vw - 2rem));' }, [
        U.el('h3', { style: 'margin:0 0 1rem;font-size:1.1rem;font-weight:800;', text: title }),
        U.el('div', { style: 'display:flex;flex-direction:column;gap:.85rem;max-height:65vh;overflow-y:auto;' }, fields),
        U.el('div', { style: 'display:flex;gap:.6rem;margin-top:1.25rem;' }, [
          submit,
          U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => backdrop.remove() }, [document.createTextNode('Cancel')])
        ])
      ])
    ])
    document.body.append(backdrop)
    return backdrop
  },

  trailerModal (trailer) {
    if (!trailer?.id || trailer.site !== 'youtube') {
      U.toast('No trailer available', 'error')
      return
    }
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      onclick: e => { if (e.target === backdrop) close() }
    }, [
      U.el('div', { class: 'trailer-modal' }, [
        U.el('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1`,
          title: 'Trailer',
          allow: 'autoplay; fullscreen',
          allowfullscreen: ''
        })
      ])
    ])
    const close = () => {
      backdrop.remove()
      document.removeEventListener('keydown', esc)
    }
    const esc = e => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', esc)
    document.body.append(backdrop)
  }
}

window.C = C
