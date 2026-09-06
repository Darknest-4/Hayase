/* global Catalogue, HTMLElement, Store, T, U, document, getComputedStyle, requestAnimationFrame, window */
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
          const page = await Catalogue.searchOrAniList({ sort: ['POPULARITY_DESC'], perPage: 50 })
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

  // ---- site footer ----
  footer () {
    const col = (title, links) => U.el('div', { class: 'footer-col' }, [
      U.el('h4', { text: title }),
      ...links.map(([label, href]) => U.el('a', { href, text: label }))
    ])

    const year = new Date().getFullYear()
    return U.el('footer', { class: 'site-footer' }, [
      U.el('div', { class: 'footer-main' }, [
        U.el('div', { class: 'footer-brand' }, [
          U.el('div', { class: 'footer-logo' }, [
            U.svg('<path d="M18 3.5A10 10 0 1 0 21 16 8 8 0 0 1 18 3.5Z" fill="currentColor" stroke="none"/>', 22),
            U.el('span', { text: T('yume') })
          ]),
          // The operator's tagline, if they set one in the admin panel — the
          // setting existed and was rendered nowhere, so the field silently did
          // nothing. An empty value falls back to the translated default rather
          // than leaving a blank line.
          U.el('p', { class: 'footer-tagline', text: window.App?.config?.site?.tagline?.trim() || T('footer.tagline') })
        ]),
        col(T('footer.discover'), [[T('nav.home'), '#/home'], [T('nav.search'), '#/search'], [T('nav.schedule'), '#/schedule'], [T('nav.dashboard'), '#/dashboard']]),
        col(T('footer.library'), [[T('footer.myLibrary'), '#/list'], [T('footer.profile'), '#/profile'], [T('footer.watchHistory'), '#/profile?tab=history'], [T('footer.analytics'), '#/profile?tab=analytics']]),
        col(T('footer.community'), [[T('nav.community'), '#/community'], [T('nav.w2g'), '#/w2g'], [T('nav.extensions'), '#/extensions']]),
        col(T('footer.yume'), [[T('nav.settings'), '#/settings'], [T('nav.notifications'), '#/notifications'], [T('footer.developer'), '#/developer']])
      ]),
      U.el('div', { class: 'footer-bottom' }, [
        U.el('span', { text: `© ${year} ${window.Copy?.footer?.brand ?? (window.App?.config?.site?.name ?? 'Yume')} · ${T('footer.colophon')}` }),
        U.el('span', { class: 'footer-credits', html: 'Anime data from <a href="https://anilist.co" target="_blank" rel="noopener">AniList</a>, <a href="https://jikan.moe" target="_blank" rel="noopener">Jikan</a> &amp; <a href="https://api.ani.zip" target="_blank" rel="noopener">ani.zip</a>' })
      ])
    ])
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
    if (window.App && !window.App.featureOn('hover_preview')) return

    card.addEventListener('pointerenter', () => {
      clearTimeout(this._previewTimer)
      this._previewTimer = setTimeout(() => this._openPreview(card, media), 350)
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

    // media header: banner (or cover) + gradient + title overlaid; trailer
    // fades in on top when available
    const head = U.el('div', { class: 'preview-media' })
    if (media.trailer?.id && media.trailer.site === 'youtube') {
      const frame = U.el('iframe', {
        class: 'preview-trailer',
        src: `https://www.youtube-nocookie.com/embed/${media.trailer.id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${media.trailer.id}`,
        allow: 'autoplay',
        title: T('trailer preview')
      })
      frame.addEventListener('load', () => frame.classList.add('loaded'))
      head.append(frame)
    }
    if (media.bannerImage) head.style.backgroundImage = `url("${media.bannerImage}")`
    else if (U.cover(media)) head.style.backgroundImage = `url("${U.cover(media)}")`
    head.append(
      U.el('div', { class: 'preview-media-scrim' }),
      U.el('div', { class: 'preview-media-title', text: U.title(media) })
    )
    if (media.averageScore) {
      head.append(U.el('div', { class: 'preview-score' }, [U.svg(this.HEART, 11), U.el('span', { text: media.averageScore + '%' })]))
    }

    // meta chips instead of a plain dot-row
    const metaChips = U.el('div', { class: 'preview-chips' },
      [U.format(media), U.seasonYear(media), media.episodes ? media.episodes + ' ep' : null, U.statusMap[media.status]]
        .filter(Boolean).map(t => U.el('span', { class: 'preview-chip', text: t })))

    // actions: Play + add-to-list + favourite
    const heart = U.svg(this.HEART, 14)
    if (Store.isFavourite(media.id)) heart.style.fill = 'currentColor'
    const favBtn = U.el('button', {
      class: 'preview-icon-btn' + (Store.isFavourite(media.id) ? ' active' : ''),
      title: T('Favourite'),
      onclick: e => {
        const now = Store.toggleFavourite(media.id)
        heart.style.fill = now ? 'currentColor' : 'none'
        e.currentTarget.classList.toggle('active', now)
      }
    })
    favBtn.append(heart)

    const listBtn = entry
      ? U.el('span', { class: 'badge badge-theme', style: 'align-self:center;', text: U.listStatusMap[entry.status] })
      : U.el('button', {
        class: 'preview-icon-btn',
        title: T('Add to Planning'),
        onclick: e => {
          Store.saveEntry(media, { status: 'PLANNING' })
          U.toast(T('Added to Planning'))
          e.currentTarget.replaceWith(U.el('span', { class: 'badge badge-theme', style: 'align-self:center;', text: T('Planning') }))
        }
      }, [U.svg(this.PLUS, 14)])

    const panel = U.el('div', { class: 'preview-panel' }, [
      head,
      U.el('div', { class: 'preview-body' }, [
        metaChips,
        U.el('div', { class: 'preview-desc', text: U.plainDesc(media.description) }),
        (media.genres ?? []).length
          ? U.el('div', { class: 'preview-genres' }, media.genres.slice(0, 4).map(g =>
            U.el('a', { class: 'preview-genre', href: `#/search?genre=${encodeURIComponent(g)}`, text: g, onclick: () => this._closePreview() })))
          : null,
        U.el('div', { class: 'preview-actions' }, [
          U.el('a', { class: 'btn btn-primary btn-sm', style: 'flex-grow:1;justify-content:center;', href: `#/watch/${media.id}:${next}`, onclick: () => this._closePreview() },
            [U.svg(this.PLAY, 12), document.createTextNode(entry?.progress ? ` Continue Ep ${next}` : ' Watch now')]),
          listBtn,
          favBtn,
          U.el('a', { class: 'preview-icon-btn', title: T('Details'), href: `#/anime/${media.id}`, onclick: () => this._closePreview() },
            [U.svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', 14)])
        ])
      ])
    ])

    panel.addEventListener('pointerleave', () => this._closePreview())

    document.body.append(panel)
    const rect = card.getBoundingClientRect()
    const width = 360
    let left = rect.left + rect.width / 2 - width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(rect.top - 48, window.innerHeight - 340))
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
    if (moreHref) head.append(U.el('a', { class: 'section-more', href: moreHref, text: T('View more') }))

    const section = U.el('section', { class: 'section' }, [head, row])

    Promise.resolve(mediaPromise).then(mediaList => {
      row.replaceChildren()
      if (!mediaList?.length) {
        section.remove()
        return
      }
      for (const media of mediaList) row.append(this.card(media, cardOptions(media)))
    }).catch(() => {
      row.replaceChildren(U.el('div', { class: 'empty-state', text: T('Failed to load.') }))
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
            U.toast(T('Removed from list'))
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
            title: T('Decrease progress'),
            onclick: () => { Store.setProgress(media, (Store.entry(media.id)?.progress ?? 0) - 1); render(); onChange() }
          }, [U.svg(this.MINUS, 14)]),
          U.el('span', { style: 'font-weight:800;font-size:.9rem;', text: `${entry.progress ?? 0}${total} ep` }),
          U.el('button', {
            class: 'icon-btn',
            title: T('Increase progress'),
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
          U.el('h3', { text: T('Yume account') }),
          U.el('p', { text: `Signed in as ${user.username}.` }),
          U.el('button', {
            class: 'btn btn-secondary btn-sm',
            onclick: async () => { await YumeAPI.logout(); render(); onAuthed() }
          }, [document.createTextNode(T('Sign out'))])
        )
        return
      }

      let mode = 'login'
      const email = U.el('input', { class: 'input', type: 'email', placeholder: T('Email'), autocomplete: 'email' })
      const identifier = U.el('input', { class: 'input', type: 'text', placeholder: T('Email or username'), autocomplete: 'username' })
      const username = U.el('input', { class: 'input', type: 'text', placeholder: T('Username'), autocomplete: 'username' })
      const password = U.el('input', { class: 'input', type: 'password', placeholder: T('Password (min 8 chars)'), autocomplete: 'current-password' })
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
        U.el('h3', { text: T('Yume account') }),
        U.el('p', { text: T('Sign in to join the discussion and sync with the platform.') }),
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
      text: T('Spoiler — click to reveal'),
      onclick: e => { e.stopPropagation(); shield.replaceWith(body) }
    })
    return shield
  },

  // ---- per-anime comment section (detail page) ----
  commentsSection (media) {
    const wrap = U.el('div')
    if (window.App && !window.App.featureOn('comments')) {
      return U.el('div', { class: 'empty-state', style: 'max-width:none;', text: T('Comments are turned off.') })
    }
    const list = U.el('div', {}, [U.el('div', { class: 'spinner' })])

    const load = async () => {
      const yumeId = await YumeAPI.yumeAnimeId(media)
      list.replaceChildren()

      if (yumeId) {
        try {
          const { data } = await YumeAPI.comments('anime', yumeId)
          if (!data.length) {
            list.append(U.el('div', { class: 'empty-state', style: 'padding:1.5rem;', text: T('No comments yet.') }))
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
                  text: T('Reply'),
                  onclick: () => {
                    if (node.querySelector('.comment-form')) return
                    node.append(form(comment.id, () => load()))
                  }
                }),
                U.el('button', {
                  class: 'comment-action',
                  text: T('Report'),
                  onclick: async () => {
                    const reason = window.prompt('Reason (spam / harassment / nsfw / spoiler / illegal / other):', 'spam')
                    if (!reason) return
                    try {
                      await YumeAPI.report('comment', comment.id, ['spam', 'harassment', 'nsfw', 'spoiler', 'illegal'].includes(reason) ? reason : 'other', reason)
                      U.toast(T('Report submitted — thank you'))
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
          list.append(U.el('div', { class: 'error-state', text: T('Failed to load comments: ') + e.message }))
        }
      } else {
        list.append(U.el('div', { class: 'empty-state', style: 'padding:1.5rem;', text: T('No comments yet.') }))
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
      const submit = U.el('button', { class: 'btn btn-primary btn-sm', text: T('Post') })
      submit.addEventListener('click', async () => {
        const body = textarea.value.trim()
        if (!body) return
        try {
          submit.disabled = true
          const yumeId = await YumeAPI.yumeAnimeId(media, { create: true })
          await YumeAPI.postComment('anime', yumeId, body, { parentId, spoiler: spoiler.checked })
          U.toast(T('Comment posted'))
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
          U.el('label', { style: 'display:flex;gap:.4rem;align-items:center;font-size:.78rem;color:var(--fg-faint);cursor:pointer;' }, [spoiler, document.createTextNode(T('Spoiler'))])
        ])
      ])
    }

    YumeAPI.available().then(ok => {
      if (!ok) {
        wrap.remove() // no backend → no comment section at all, no dead UI
        return
      }
      wrap.append(U.el('h2', { class: 'detail-section-title', text: T('Comments') }), list)
      load()
    })

    return wrap
  },

  /**
   * Keyboard and focus behaviour every modal on the site should have had.
   *
   * modalShell had neither Escape nor focus management, while trailerModal
   * had Escape only — the two drifted apart. This is the shared piece, so
   * fixing it once fixes the developer portal, the admin webhook forms and
   * anything built on them later.
   *
   * Returns a close function; call it instead of removing the node, so the
   * document-level listener is removed with it.
   */
  trapModal (backdrop, { onClose = () => {} } = {}) {
    const previouslyFocused = document.activeElement
    const focusable = () => [...backdrop.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden')

    const close = () => {
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      // Returning focus is what makes a modal usable by keyboard at all:
      // without it focus falls back to <body> and the next Tab starts over
      // from the top of the page.
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
      onClose()
    }

    function onKey (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      // Wrap at both ends, so Tab cannot walk out of the dialog into the page
      // behind it while that page is inert to the eye but not to the keyboard.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    focusable()[0]?.focus()
    return close
  },

  // generic form modal (shared by developer portal and admin webhooks)
  modalShell (title, fields, onSubmit) {
    const submit = U.el('button', { class: 'btn btn-primary btn-sm', onclick: onSubmit }, [document.createTextNode(T('Save'))])
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onclick: e => { if (e.target === backdrop) backdrop.close() }
    }, [
      U.el('div', { class: 'search-modal', style: 'padding:1.25rem;max-width:40rem;width:min(40rem,calc(100vw - 2rem));' }, [
        U.el('h3', { style: 'margin:0 0 1rem;font-size:1.1rem;font-weight:800;', text: title }),
        U.el('div', { style: 'display:flex;flex-direction:column;gap:.85rem;max-height:65vh;overflow-y:auto;' }, fields),
        U.el('div', { style: 'display:flex;gap:.6rem;margin-top:1.25rem;' }, [
          submit,
          U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => backdrop.close() }, [document.createTextNode(T('Cancel'))])
        ])
      ])
    ])
    document.body.append(backdrop)
    // Exposed on the node because callers already hold the node and used to
    // call .remove() on it; .close() is the version that also unbinds.
    backdrop.close = this.trapModal(backdrop)
    return backdrop
  },

  trailerModal (trailer) {
    if (!trailer?.id || trailer.site !== 'youtube') {
      U.toast(T('No trailer available'), 'error')
      return
    }
    const backdrop = U.el('div', {
      class: 'modal-backdrop',
      onclick: e => { if (e.target === backdrop) close() }
    }, [
      U.el('div', { class: 'trailer-modal' }, [
        U.el('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1`,
          title: T('Trailer'),
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
