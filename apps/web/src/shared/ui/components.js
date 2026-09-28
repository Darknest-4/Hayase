/* global HTMLElement, document, getComputedStyle, requestAnimationFrame, window */
// Reusable render helpers: cards, horizontal sections, skeletons, modals.

import { Copy } from '../i18n/copy.js'
import { featureOn, pageAvailable, playbackAvailable, site } from '../lib/site-config.js'
import { T } from '../i18n/i18n.js'
import { Store } from '../state/store.js'
import { P } from '../ui/primitives.js'
import { titleTheme } from '../lib/title-theme.js'
import { U } from '../lib/dom.js'

export const C = {
  HEART: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  PLAY: '<polygon points="6 3 20 12 6 21 6 3"/>',
  PLUS: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  CHECK: '<path d="M20 6 9 17l-5-5"/>',
  MINUS: '<path d="M5 12h14"/>',
  TRASH: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',

  card (media, { progress = null, subline = null } = {}) {
    const entry = Store.entry(media.id)
    // alt="": a cím a hivatkozás szövegében már elhangzik, a borító neve
    // ugyanazt mondaná el másodszor.
    const cover = U.el('div', { class: 'card-cover' }, [
      U.el('img', { src: U.cover(media), alt: '', loading: 'lazy', decoding: 'async' })
    ])

    if (entry) cover.append(U.el('div', { class: `card-status-dot dot-${entry.status}` }))

    // Fut-e még. A borítóról ez nem derül ki, és a katalógusban ez az egyetlen
    // olyan tény, ami magától változik: egy befejezett sorozat holnap is
    // befejezett, egy futó holnap egy résszel hosszabb. A többi állapotot nem
    // írjuk ki — a „Befejezett" minden második kártyán ott lenne, és nem
    // mondana semmit.
    if (media.status === 'RELEASING') {
      // Ha tudjuk, mikor jön a következő rész, azt mondjuk — „3 nap múlva"
      // többet ér, mint „Adásban", és ugyanannyi helyet foglal. A dátum a
      // katalógus epizódsoraiból vezetődik le óránként; ahol nincs, ott marad
      // a puszta tény.
      const air = media.nextAiringEpisode?.airingAt
      cover.append(U.el('div', { class: 'card-airing', title: air ? `${T('Episode')} ${media.nextAiringEpisode.episode}` : null }, [
        U.el('span', { class: 'card-airing-dot' }),
        U.el('span', { text: air ? U.relTime(new Date(air * 1000)) : T(U.statusMap.RELEASING) })
      ]))
    }

    const score = U.score(media)
    if (score) {
      cover.append(U.el('div', { class: 'card-score', title: T('Average score') }, [
        U.svg(this.HEART, 11),
        U.el('span', { text: score + '%' })
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

    const sub = subline ?? [U.format(media), U.seasonYear(media), media.episodes ? `${media.episodes} ${T('ep')}` : null].filter(Boolean).join(' • ')

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
  _bannerSource: null,

  /**
   * Where the ambient banner images come from.
   *
   * Registered once at boot rather than imported here. This file is the shared
   * UI: it knows how to draw a banner and must not know that this application
   * resolves anime through a catalogue that falls back to AniList. Reaching
   * for that directly is what tied the foundation to one application's data
   * layer — and a second application (the admin panel) has no catalogue at all.
   *
   * With nothing registered the header simply draws without a banner, which is
   * exactly what the admin panel wants.
   */
  useBannerSource (fetchPool) {
    this._bannerSource = fetchPool
    this._spotlightPool = null
  },

  _spotlightPick () {
    if (!this._bannerSource) return Promise.resolve(null)
    if (!this._spotlightPool) {
      this._spotlightPool = (async () => {
        try {
          return await this._bannerSource()
        } catch (e) { return [] }
      })()
    }
    return this._spotlightPool.then(pool => pool.length ? pool[Math.floor(Math.random() * pool.length)] : null)
  },

  /**
   * Somebody's picture, or the first letter of their name.
   *
   * One component because the same face has to appear in eight places — the
   * sidebar, the mobile sheet, the profile header, comments, forum topics and
   * posts, and every line of chat — and eight copies of "an image if there is
   * one, otherwise a letter" is eight places to get the fallback wrong.
   *
   * `person` is whatever the caller has: `{ author, author_avatar }` from an
   * API row, or `{ name, avatar }` from the store. Both spellings are read
   * rather than making every call site normalise first.
   */
  avatar (person, { size = 'sm' } = {}) {
    const name = person?.name ?? person?.author ?? person?.display_name ?? person?.username ?? ''
    // Four spellings because four sources: the profile row, an API row, the
    // local store, and the socket — which is camelCase like the rest of its
    // protocol. Reading all of them here is one place rather than four.
    const image = person?.avatar_key ?? person?.author_avatar ?? person?.authorAvatar ?? person?.avatar ?? null
    const letter = name.slice(0, 1).toUpperCase() || '·'

    // An emoji avatar is a letter's worth of text, not an image.
    if (image && !/^https?:/i.test(String(image))) {
      return U.el('span', { class: `avatar avatar-${size}`, text: String(image) })
    }
    if (!image) return U.el('span', { class: `avatar avatar-${size}`, text: letter })

    // The letter stays underneath: a CDN that fails, or a picture that has
    // been taken down, leaves the initial rather than an empty square.
    return U.el('span', { class: `avatar avatar-${size} avatar-image`, text: letter }, [
      U.el('img', {
        src: image,
        alt: '',
        loading: 'lazy',
        onerror: event => { event.target.remove() }
      })
    ])
  },

  spotlight (title, { subtitle = null, actions = null, banner = null, bannerCredit = null } = {}) {
    const bg = U.el('div', { class: 'spotlight-bg' })
    const credit = U.el('a', { class: 'spotlight-credit hidden' })
    const inner = U.el('div', { class: 'spotlight-inner' }, [
      U.el('h1', { class: 'spotlight-title', text: title }),
      subtitle ? U.el('p', { class: 'spotlight-sub', text: subtitle }) : null,
      actions ?? null
    ])
    const header = U.el('div', { class: 'spotlight' }, [bg, U.el('div', { class: 'spotlight-scrim' }), inner, credit])

    // A pinned banner — the profile's own — replaces the wandering one. The
    // picker is only asked when nothing was chosen, so a profile with a banner
    // never flashes somebody else's art first.
    if (banner) {
      bg.style.backgroundImage = `url("${banner}")`
      requestAnimationFrame(() => bg.classList.add('loaded'))
      if (bannerCredit) {
        credit.href = bannerCredit.href ?? '#/profile'
        credit.textContent = bannerCredit.text
        credit.classList.remove('hidden')
      }
      return header
    }

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
    // h3, under a hidden h2 for the landmark itself. The columns were h4 while
    // pages end at h1 or h2, so every page skipped a level — twelve routes,
    // one cause. The hidden h2 is what makes h3 correct on a page that ends at
    // h1 as well as on one that ends at h2.
    const col = (title, links) => U.el('div', { class: 'footer-col' }, [
      U.el('h3', { text: title }),
      ...links.map(([label, href]) => U.el('a', { href, text: label }))
    ])

    const year = new Date().getFullYear()
    return U.el('footer', { class: 'site-footer' }, [U.el('div', { class: 'footer-inner' }, [
      // The landmark's own heading, for screen readers only. Without it a page
      // that ends at h1 would jump straight to the columns' h3; with it the
      // sequence is h1 -> h2 -> h3 on every page, whatever the page above it
      // did.
      U.el('h2', { class: 'sr-only', text: T('Oldaltérkép') }),
      U.el('div', { class: 'footer-main' }, [
        U.el('div', { class: 'footer-brand' }, [
          U.el('div', { class: 'footer-logo' }, [
            U.svg('<path d="M18 3.5A10 10 0 1 0 21 16 8 8 0 0 1 18 3.5Z" fill="currentColor" stroke="none"/>', 22),
            /*
             * A PÉLDÁNY NEVE, nem a designrendszeré. Bedrótozott „yume" volt
             * — az oldalsáv logója közben a beállított nevet írja ki (lásd
             * `router.init`, `.sidebar-logo-text`), tehát ugyanazon a
             * képernyőn fent „animehub" állt, lent „yume".
             */
            U.el('span', { text: (site()?.name ?? 'Yume').toLowerCase() })
          ]),
          // The operator's tagline, if they set one in the admin panel — the
          // setting existed and was rendered nowhere, so the field silently did
          // nothing. An empty value falls back to the translated default rather
          // than leaving a blank line.
          //
          // Through T(): the value the 0011 migration seeds ("Track, discover
          // and watch anime — your way.") is in the dictionary, so an instance
          // nobody customised no longer shows English under a Hungarian UI. A
          // tagline the operator wrote is not a key, and T() hands it back as is.
          U.el('p', { class: 'footer-tagline', text: site()?.tagline?.trim() ? T(site().tagline.trim()) : T('footer.tagline') })
        ]),
        /*
         * A LÁBLÉC UGYANAZT KÉRDEZI, AMIT A FEJLÉC.
         *
         * Ez a lista korábban BEDRÓTOZVA állt itt, és minden rendereléskor
         * újraépült — miközben a fejléc futásidőben szűrt a kapcsolótáblából.
         * Egy adminban kikapcsolt oldal ezért eltűnt fent, és itt lent ott
         * maradt: ugyanaz a kérdés, két külön válasz. A harmadik fogyasztó, a
         * mobil sáv, a fejléc elemeit használja, tehát az együtt mozgott vele.
         *
         * Ahol egy hivatkozás egy oldal FÜLÉRE mutat (`#/profile?tab=history`),
         * ott is az OLDAL elérhetősége dönt — egy letiltott profiloldal füle
         * sem jár.
         *
         * Üresre fogyott oszlop nem jelenik meg: egy cím alatt semmi rosszabb,
         * mint a hiányzó cím.
         */
        ...[
          ['footer.discover', [
            ['nav.home', '#/home', 'home'],
            ['nav.search', '#/search', 'search'],
            ['nav.schedule', '#/schedule', 'schedule'],
            ['nav.dashboard', '#/dashboard', 'dashboard']
          ]],
          ['footer.library', [
            ['footer.myLibrary', '#/list', 'list'],
            ['footer.profile', '#/profile', 'profile'],
            ['footer.watchHistory', '#/profile?tab=history', 'profile'],
            ['footer.analytics', '#/profile?tab=analytics', 'profile']
          ]],
          ['footer.community', [
            ['nav.community', '#/community', 'community'],
            ['nav.w2g', '#/w2g', 'w2g']
          ]],
          /*
           * AZ OSZLOP A PÉLDÁNY NEVÉT VISELI, nem a designrendszerét.
           *
           * A `footer.yume` kulcs a „Yume" szót adta, mert tulajdonnév, és a
           * fordító szándékosan nem fordítja. Az animehub.hu-n viszont ettől
           * a fejlécben „animehub" állt, a láblécben meg „Yume" — ugyanazon a
           * képernyőn, két név.
           */
          [site()?.name ?? 'Yume', [
            ['nav.settings', '#/settings', 'settings'],
            ['nav.notifications', '#/notifications', 'notifications'],
            ['nav.themes', '#/themes', 'themes']
          ]]
        ].map(([title, links]) => {
          const shown = links.filter(([, , route]) => pageAvailable(route))
          return shown.length ? col(T(title), shown.map(([label, href]) => [T(label), href])) : null
        })
      ]),
      U.el('div', { class: 'footer-bottom' }, [
        U.el('span', { text: `© ${year} ${Copy?.footer?.brand ?? (site()?.name ?? 'Yume')} · ${T('footer.colophon')}` }),
        /*
         * A FORRÁSMEGJELÖLÉS IS MAGYARUL. Ez a sor bedrótozott angol HTML
         * volt egy magyar nyelvű oldal alján. A szolgáltatások NEVE marad
         * (tulajdonnév), csak a köré írt mondat fordul.
         */
        U.el('span', {
          class: 'footer-credits',
          html: `${T('Anime data from')} <a href="https://anilist.co" target="_blank" rel="noopener">AniList</a>, <a href="https://jikan.moe" target="_blank" rel="noopener">Jikan</a> &amp; <a href="https://api.ani.zip" target="_blank" rel="noopener">ani.zip</a>`
        })
      ])
    ])])
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
    if (!featureOn('hover_preview')) return

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
    if (U.score(media)) {
      head.append(U.el('div', { class: 'preview-score' }, [U.svg(this.HEART, 11), U.el('span', { text: U.score(media) + '%' })]))
    }

    // meta chips instead of a plain dot-row
    const metaChips = U.el('div', { class: 'preview-chips' },
      [U.format(media), U.seasonYear(media), media.episodes ? `${media.episodes} ${T('ep')}` : null, U.status(media)]
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
          // Ugyanaz, mint a főoldali kiemelésen: forrás nélkül nem lejátszást
          // ígérünk, hanem a részletoldalt.
          !playbackAvailable()
            ? U.el('a', { class: 'btn btn-primary btn-sm', style: 'flex-grow:1;justify-content:center;', href: `#/anime/${media.id}`, onclick: () => this._closePreview() },
              [document.createTextNode(T('Details'))])
            : U.el('a', { class: 'btn btn-primary btn-sm', style: 'flex-grow:1;justify-content:center;', href: `#/watch/${media.id}:${next}`, onclick: () => this._closePreview() },
              [U.svg(this.PLAY, 12), document.createTextNode(entry?.progress ? `${T('Continue')} ${T('Ep')} ${next}` : T('Watch now'))]),
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
    // A kártya alakja: borító, két sor cím, egy sor tény — nem egy szürke doboz.
    return U.el('div', { class: 'card card-skeleton', 'aria-hidden': 'true' }, [
      U.el('div', { class: 'card-cover skeleton' }),
      U.el('div', { class: 'skeleton skel-text', style: 'margin-top:var(--space-2)' }),
      U.el('div', { class: 'skeleton skel-text skel-text-sm skel-line-mid' })
    ])
  },

  /**
   * Fekvő bannerkártya: a sorozat saját kulcsművészete, a címmel ráégetve.
   *
   * Nem a portré kártya szélesebb változata. Azért van, hogy egy sor *másképp*
   * nézzen ki, mint a fölötte lévő — nyolc egyforma sor egyetlen falnak
   * olvas, és a nyolcadiknál már senki nem néz oda.
   *
   * Bannere 7 959 címnek van; amelyiknek nincs, az a borítójára esik vissza,
   * és a sor attól még működik — csak kevésbé látványos.
   */
  bannerCard (media) {
    const art = media.bannerImage || U.cover(media)
    const card = U.el('a', {
      class: 'bcard',
      href: `#/anime/${media.id}`,
      style: titleTheme(media)
    }, [
      U.el('div', { class: 'bcard-art' }, [
        U.el('img', { src: art, alt: '', loading: 'lazy' })
      ]),
      U.el('div', { class: 'bcard-scrim' }, [
        U.el('span', { class: 'bcard-title', text: U.title(media) }),
        U.el('span', { class: 'bcard-meta', text: [U.format(media), media.episodes ? `${media.episodes} rész` : null].filter(Boolean).join(' · ') })
      ])
    ])
    return card
  },

  /** Ugyanaz a sor, fekvő kártyákkal. */
  bannerSection (title, source, { moreHref = null } = {}) {
    const row = U.el('div', { class: 'hscroll hscroll-banner', 'aria-busy': 'true' },
      Array.from({ length: 3 }, () => U.el('div', { class: 'bcard skeleton', 'aria-hidden': 'true' })))
    const wrap = this._sectionShell(title, row, { moreHref, className: 'section section-banner' })

    this._whenNear(wrap, source, mediaList => {
      row.removeAttribute('aria-busy')
      if (!mediaList?.length) { wrap.remove(); return }
      row.replaceChildren(...mediaList.slice(0, 12).map(m => this.bannerCard(m)))
    }, () => { wrap.remove() })

    return wrap
  },

  // horizontal scrolling section fed by a promise resolving to a media array
  section (title, source, { moreHref = null, cardOptions = () => ({}) } = {}) {
    const row = U.el('div', { class: 'hscroll', 'aria-busy': 'true' }, Array.from({ length: 8 }, () => this.skeletonCard()))
    const section = this._sectionShell(title, row, { moreHref })

    // Újrapróbálni csak egy betöltő függvényt lehet; egy elhasalt ígéret
    // ugyanúgy hasalna el másodszor is.
    const retry = typeof source !== 'function'
      ? null
      : U.el('button', {
        class: 'btn btn-secondary btn-sm',
        type: 'button',
        onclick: () => {
          row.setAttribute('aria-busy', 'true')
          row.replaceChildren(...Array.from({ length: 8 }, () => this.skeletonCard()))
          load()
        }
      }, [document.createTextNode(T('Try again'))])
    const load = () => this._whenNear(section, source, mediaList => {
      row.removeAttribute('aria-busy')
      row.replaceChildren()
      // Egy üres sor nem hiba, hanem hiány: a cím alatt semmi rosszabb, mint
      // a hiányzó sor.
      if (!mediaList?.length) { section.remove(); return }
      for (const media of mediaList) row.append(this.card(media, cardOptions(media)))
    }, () => {
      row.removeAttribute('aria-busy')
      row.replaceChildren(U.el('div', { class: 'hscroll-error' }, [
        U.el('span', { text: T('Failed to load.') }),
        retry
      ]))
    })
    load()
    return section
  },

  /** A sor keretét adja: cím, „Továbbiak", és maga a sor. */
  _sectionShell (title, row, { moreHref = null, className = 'section' } = {}) {
    const id = 'sec-' + Math.random().toString(36).slice(2, 9)
    const head = U.el('div', { class: 'section-head' }, [
      U.el('h2', { class: 'section-title', id, text: title })
    ])
    if (moreHref) head.append(U.el('a', { class: 'section-more', href: moreHref, text: T('View more'), 'aria-describedby': id }))
    return U.el('section', { class: className, 'aria-labelledby': id }, [head, row])
  },

  /**
   * Betölt, amikor a sor a képernyő közelébe ér.
   *
   * `source` lehet ígéret (azonnal fut, ahogy eddig) vagy függvény: azt csak
   * akkor hívjuk meg, amikor a sor 600 pixelen belülre ér. IntersectionObserver
   * híján — régi böngésző, egységteszt — azonnal.
   */
  _whenNear (node, source, done, failed) {
    const run = () => {
      Promise.resolve(typeof source === 'function' ? source() : source).then(done, failed)
    }
    if (typeof source !== 'function' || typeof window.IntersectionObserver !== 'function') { run(); return }
    const observer = new window.IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      observer.disconnect()
      run()
    }, { rootMargin: '600px 0px' })
    // A csomópont még nincs a dokumentumban: a megfigyelés a következő
    // képkockában indul, amikor a lap már beillesztette.
    window.requestAnimationFrame(() => observer.observe(node))
  },

  grid (mediaList, cardOptions = () => ({})) {
    return U.el('div', { class: 'grid' }, mediaList.map(media => this.card(media, cardOptions(media))))
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

    // `keepNode`: the caller animates the node out itself. `silent`: the
    // caller is the one closing, so there is nobody to tell.
    const close = ({ keepNode = false, silent = false } = {}) => {
      document.removeEventListener('keydown', onKey, true)
      if (!keepNode) backdrop.remove()
      // Returning focus is what makes a modal usable by keyboard at all:
      // without it focus falls back to <body> and the next Tab starts over
      // from the top of the page.
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true })
      if (!silent) onClose()
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

  /**
   * Egy párbeszédablak: cím, tartalom, gombok — fókuszcsapdával.
   *
   * A modálok eddig négyféleképpen készültek (keresőablak-osztállyal, inline
   * stílusokkal, csapdával vagy anélkül). Ez az egy: `role="dialog"`, a címe
   * `aria-labelledby`-jal kötve, Escape és a háttérre kattintás bezárja, a
   * fókusz bezáráskor visszatér oda, ahonnan jött. Telefonon alsó lapként
   * nyílik (components.css).
   *
   * `initialFocus`: amit nyitáskor fókuszálni kell (egy űrlap első mezője);
   * alapból az első fókuszálható elem.
   */
  openDialog ({ title, body = [], actions = [], onClose = () => {}, size = null, initialFocus = null } = {}) {
    const titleId = 'dlg-' + Math.random().toString(36).slice(2, 9)
    const closeButton = U.el('button', {
      class: 'icon-btn icon-btn-sm icon-btn-quiet dialog-close',
      type: 'button',
      'aria-label': T('Close'),
      onclick: () => close()
    }, [U.svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 16)])
    const panel = U.el('div', {
      class: 'dialog' + (size === 'lg' ? ' dialog-lg' : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId
    }, [
      U.el('div', { class: 'dialog-head' }, [U.el('h2', { class: 'dialog-title', id: titleId, text: title })]),
      U.el('div', { class: 'dialog-body' }, body),
      actions.length ? U.el('div', { class: 'dialog-foot' }, actions) : null,
      closeButton
    ])
    const backdrop = U.el('div', { class: 'modal-backdrop' }, [panel])
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close() })
    document.body.append(backdrop)
    let open = true
    const release = this.trapModal(backdrop, { onClose: () => { open = false; onClose() } })
    const close = () => { if (open) release() }
    if (initialFocus) initialFocus.focus()
    return { close, node: panel }
  },

  /**
   * Megerősítés egy visszafordíthatatlan lépés előtt. `true`, ha a néző
   * megerősítette; `false`, ha mégsem.
   */
  confirm ({ title, message, confirmLabel, danger = false }) {
    return new Promise(resolve => {
      let answered = false
      const answer = value => { if (answered) return; answered = true; dialog.close(); resolve(value) }
      const yes = P.button(confirmLabel ?? T('OK'), { variant: danger ? 'danger-solid' : 'primary', onclick: () => answer(true) })
      const dialog = this.openDialog({
        title,
        body: [U.el('p', { class: 'dialog-text', text: message })],
        actions: [P.button(T('Cancel'), { variant: 'ghost', onclick: () => answer(false) }), yes],
        onClose: () => { if (!answered) { answered = true; resolve(false) } },
        initialFocus: yes
      })
    })
  },

  /**
   * A failure the reader can do something about.
   *
   * The message alone is not reportable and not searchable. The server has
   * always answered with a stable code and a request id — YumeAPI attaches
   * both to the Error — and this is where they reach a person: shown, and
   * copyable in one press, because the realistic path is somebody pasting them
   * into a message to whoever runs the instance.
   *
   * Both are optional. A failure that never reached the server — offline, a
   * client bug — has neither, and renders as the message it always did rather
   * than as a box with two empty fields.
   */
  errorState (error, onRetry) {
    const message = typeof error === 'string' ? error : (error?.message ?? String(error))
    const code = typeof error === 'object' ? error?.code : null
    const requestId = typeof error === 'object' ? error?.requestId : null

    const box = U.el('div', { class: 'error-state', role: 'alert' }, [
      U.el('span', { class: 'error-state-icon', 'aria-hidden': 'true' }, [
        U.svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>', 22)
      ]),
      U.el('div', { class: 'error-state-msg', text: message })
    ])

    if (code || requestId) {
      const line = [code, requestId].filter(Boolean).join(' · ')
      box.append(U.el('button', {
        class: 'error-state-ref',
        type: 'button',
        title: T('Copy so you can report it'),
        onclick: () => {
          navigator.clipboard?.writeText(line)
            .then(() => U.toast(T('Copied')))
            .catch(() => U.toast(T('Could not copy'), 'error'))
        }
      }, [
        U.el('span', { class: 'error-state-ref-text', text: line }),
        U.el('span', { class: 'error-state-ref-hint', text: T('copy') })
      ]))
    }

    if (onRetry) {
      box.append(U.el('div', { class: 'error-state-action' }, [U.el('button', {
        class: 'btn btn-secondary',
        type: 'button',
        onclick: onRetry
      }, [document.createTextNode(T('Try again'))])]))
    }
    return box
  }
}
