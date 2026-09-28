// Főoldal — egy kiemelt cím nagyban, alatta a sorok.
//
// 2026-09, újratervezve. Ami változott, és miért:
//
//   * A HERO KÉP, NEM VIDEÓ. A kiemelt cím előzetese eddig magától indult,
//     némítva, egy YouTube-kerettel a lap tetején. Minden látogatónak minden
//     főoldal-betöltéskor: egy harmadik fél szkriptjei, néhány megabájt, és egy
//     telefonon vagy egy PS5 böngészőjén akadozó görgetés — egy olyan videóért,
//     amit senki nem kért. Az előzetes most gomb, és csak akkor van ott, ha van
//     mit lejátszani.
//
//   * A SOROK AKKOR TÖLTENEK, AMIKOR ODAÉR A NÉZŐ. Tizenhárom sor tizenhárom
//     kérést indított az első festéskor, a legtöbbjük a képernyő alatt, és egy
//     katalógushiány esetén mind az AniList percenkénti korlátjába futott. A
//     `C.section` most egy betöltő függvényt is elfogad, és csak a képernyő
//     közelében hívja meg.
//
//   * A „FOLYTATÁS" ÉS A „LISTÁD" AZONNAL MEGJELENIK. A könyvtár minden
//     bejegyzése hordoz egy pillanatképet a címről (Store._snapshot) — abból a
//     kártya hálózat nélkül kirajzolható, és a néző ezt a két sort keresi
//     először.

import { playbackAvailable, site } from '../shared/lib/site-config.js'
import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Store } from '../shared/state/store.js'
import { U } from '../shared/lib/dom.js'
import { openTrailer } from '../features/trailer/trailer.js'

/** A műfaj-gyorslinkek: amit a katalógus szűrője név szerint ismer. */
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Sci-Fi', 'Slice of Life', 'Mystery', 'Sports', 'Supernatural', 'Horror']

export const PageHome = {
  async render (root) {
    const { season, year } = U.currentSeason()

    // A lap neve annak, aki nem látja a herót. Kiemelhető cím híján a főoldalnak
    // egyáltalán nem volt h1-e.
    root.append(U.el('h1', { class: 'sr-only', text: site()?.name ?? 'Yume' }))

    const hero = this.heroSkeleton()
    const body = U.el('div', { class: 'page-pad home-body' })
    root.append(hero, body)

    // ---- a néző saját sorai: helyből, hálózat nélkül ----
    const entries = Object.values(Store.list())
    const byRecent = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    const watching = entries.filter(e => e.status === 'CURRENT' || e.status === 'REPEATING').sort(byRecent)
    if (watching.length) {
      body.append(C.section(T('home.continueWatching'), Promise.resolve(watching.slice(0, 20).map(e => e.media)), {
        moreHref: '#/list?status=CURRENT',
        cardOptions: media => {
          const entry = Store.entry(media.id)
          const next = (entry?.progress ?? 0) + 1
          return { subline: entry ? I18n.f(T('Next: episode {n}'), { n: next }) : null }
        }
      }))
    }

    const planning = entries.filter(e => e.status === 'PLANNING').sort(byRecent)
    if (planning.length) {
      body.append(C.section(T('home.yourList'), Promise.resolve(planning.slice(0, 20).map(e => e.media)), {
        moreHref: '#/list?status=PLANNING'
      }))
    }

    // Folytatások, amikről lemaradt: a befejezett címek közvetlen folytatásai,
    // amik még nincsenek a listáján. Kapcsolati adat kell hozzá — ez hálózat.
    const completedIds = entries.filter(e => e.status === 'COMPLETED').sort(byRecent).map(e => e.media.id)
    if (completedIds.length) {
      body.append(C.section(T('home.sequelsYouMissed'), async () => {
        const page = await Catalogue.searchOrAniList({ ids: completedIds.slice(0, 25), perPage: 25 })
        const inList = new Set(Object.keys(Store.list()).map(String))
        const sequelIds = [...new Set((page.media ?? []).flatMap(m =>
          (m.relations?.edges ?? [])
            .filter(e => e?.relationType === 'SEQUEL' && e.node && ['FINISHED', 'RELEASING'].includes(e.node.status) && !inList.has(String(e.node.id)))
            .map(e => e.node.id)))]
        if (!sequelIds.length) return []
        const res = await Catalogue.searchOrAniList({ ids: sequelIds.slice(0, 25), perPage: 25 })
        return res.media ?? []
      }))
    }

    // ---- a katalógus sorai ----
    const defs = [
      { title: T('home.rails.popularSeason'), vars: { sort: ['POPULARITY_DESC'], season, seasonYear: year } },
      { title: T('home.rails.trending'), vars: { sort: ['TRENDING_DESC'] } },
      { title: T('home.rails.action'), vars: { sort: ['TRENDING_DESC'], genre: ['Action'] }, banner: true },
      { title: T('home.rails.airing'), vars: { sort: ['POPULARITY_DESC'], status: ['RELEASING'] } },
      { title: T('home.rails.romance'), vars: { sort: ['TRENDING_DESC'], genre: ['Romance'] }, banner: true },
      { title: T('home.rails.allTimePopular'), vars: { sort: ['POPULARITY_DESC'] } },
      { title: T('home.rails.fantasy'), vars: { sort: ['TRENDING_DESC'], genre: ['Fantasy'] }, banner: true },
      { title: T('home.rails.topRated'), vars: { sort: ['SCORE_DESC'] } },
      { title: T('home.rails.adventure'), vars: { sort: ['TRENDING_DESC'], genre: ['Adventure'] }, banner: true },
      { title: T('home.rails.movies'), vars: { sort: ['POPULARITY_DESC'], format: ['MOVIE'] } }
    ]

    defs.forEach((def, index) => {
      // "Továbbiak" → a kereső ugyanezzel a szűréssel. A kereső a `year`-t
      // olvassa, a sor a `seasonYear`-t: itt fordítjuk le.
      const params = new URLSearchParams()
      if (def.vars.genre) params.set('genre', def.vars.genre[0])
      if (def.vars.season) { params.set('season', def.vars.season); params.set('year', def.vars.seasonYear ?? year) }
      if (def.vars.format) params.set('format', def.vars.format[0])
      if (def.vars.status) params.set('status', def.vars.status[0])
      params.set('sort', def.vars.sort[0])

      const load = () => Catalogue.searchOrAniList(def.vars).then(page => page.media ?? [])
      const options = { moreHref: '#/search?' + params.toString() }
      body.append(def.banner ? C.bannerSection(def.title, load, options) : C.section(def.title, load, options))

      // A műfajok a harmadik sor után: addigra a néző látta, mi a felkapott,
      // és itt kaphat egy rövidebb utat ahhoz, amit ő keres.
      if (index === 2) body.append(this.genreLinks())
    })

    // ---- a hero: a felkapottak közül egy, amihez van nagy kép ----
    try {
      const page = await Catalogue.searchOrAniList({ sort: ['TRENDING_DESC'], perPage: 10 })
      const pool = (page.media ?? []).filter(m => m.bannerImage)
      const media = pool.length ? pool[Math.floor(Math.random() * Math.min(pool.length, 5))] : page.media?.[0]
      if (media) hero.replaceWith(this.renderHero(media))
      else hero.remove()
    } catch (e) {
      hero.remove()
    }
  },

  /** A hero helye, amíg a kiemelt cím megjön — ugyanakkora, hogy ne ugorjon a lap. */
  heroSkeleton () {
    return U.el('section', { class: 'home-hero home-hero-loading', 'aria-hidden': 'true' }, [
      U.el('div', { class: 'home-hero-inner' }, [
        U.el('div', { class: 'skeleton skel-text', style: 'width:8rem' }),
        U.el('div', { class: 'skeleton skel-title', style: 'width:min(28rem,80%);height:3rem' }),
        U.el('div', { class: 'skeleton skel-text', style: 'width:min(22rem,70%)' }),
        U.el('div', { class: 'skeleton skel-text', style: 'width:min(18rem,60%)' })
      ])
    ])
  },

  renderHero (media) {
    const art = media.bannerImage || U.cover(media)
    const score = U.score(media)
    const entry = Store.entry(media.id)
    const meta = [
      U.format(media),
      U.seasonYear(media),
      media.episodes ? `${media.episodes} ${T('episodes')}` : null,
      U.status(media)
    ].filter(Boolean)

    const metaRow = U.el('div', { class: 'home-hero-meta' })
    for (const text of meta) metaRow.append(U.el('span', { text: String(text) }))
    if (score) {
      metaRow.append(U.el('span', { class: 'home-hero-score', title: T('Average score') }, [
        U.svg(C.HEART, 14), document.createTextNode(`${score}%`)
      ]))
    }

    const listButton = U.el('button', {
      class: 'btn btn-secondary btn-lg',
      type: 'button',
      'aria-pressed': String(!!entry),
      onclick: () => {
        if (Store.entry(media.id)) { window.location.hash = '#/list'; return }
        Store.saveEntry(media, { status: 'PLANNING' })
        U.toast(T('Added to Planning'), 'success')
        paintList()
      }
    })
    const paintList = () => {
      const on = !!Store.entry(media.id)
      listButton.setAttribute('aria-pressed', String(on))
      listButton.replaceChildren(U.svg(on ? C.CHECK : C.PLUS, 18), document.createTextNode(on ? T('In your list') : T('Add to list')))
    }
    paintList()

    const trailer = media.trailer?.id && media.trailer.site === 'youtube'
      ? U.el('button', { class: 'btn btn-quiet btn-lg', type: 'button', onclick: () => openTrailer(media.trailer) },
        [U.svg('<polygon points="6 3 20 12 6 21 6 3"/>', 16), document.createTextNode(T('Trailer'))])
      : null

    const primary = playbackAvailable()
      ? U.el('a', { class: 'btn btn-primary btn-lg', href: `#/watch/${media.id}:${(entry?.progress ?? 0) + 1}` },
        [U.svg(C.PLAY, 18), document.createTextNode(entry?.progress ? I18n.f(T('Continue: episode {n}'), { n: entry.progress + 1 }) : T('Watch now'))])
      : U.el('a', { class: 'btn btn-primary btn-lg', href: `#/anime/${media.id}` }, [document.createTextNode(T('Details'))])

    return U.el('section', { class: 'home-hero', 'aria-labelledby': 'home-hero-title' }, [
      U.el('div', { class: 'home-hero-art' }, [
        U.el('img', { src: art, alt: '', fetchpriority: 'high', decoding: 'async' })
      ]),
      U.el('div', { class: 'home-hero-scrim' }),
      U.el('div', { class: 'home-hero-inner' }, [
        U.el('p', { class: 'eyebrow home-hero-eyebrow', text: T('Trending now') }),
        U.el('h2', { class: 'home-hero-title', id: 'home-hero-title' }, [
          U.el('a', { href: `#/anime/${media.id}`, text: U.title(media) })
        ]),
        metaRow,
        media.description ? U.el('p', { class: 'home-hero-desc clamp-3', text: U.plainDesc(media.description) }) : null,
        (media.genres ?? []).length
          ? U.el('div', { class: 'badges home-hero-genres' }, media.genres.slice(0, 4).map(g =>
            U.el('a', { class: 'badge', href: `#/search?genre=${encodeURIComponent(g)}`, text: T(g) })))
          : null,
        U.el('div', { class: 'home-hero-actions' }, [
          primary,
          listButton,
          playbackAvailable() ? U.el('a', { class: 'btn btn-quiet btn-lg', href: `#/anime/${media.id}` }, [document.createTextNode(T('Details'))]) : null,
          trailer
        ])
      ])
    ])
  },

  /** Rövid út a keresőbe, műfaj szerint. */
  genreLinks () {
    return U.el('section', { class: 'section home-genres', 'aria-labelledby': 'home-genres-title' }, [
      U.el('div', { class: 'section-head' }, [
        U.el('h2', { class: 'section-title', id: 'home-genres-title', text: T('Browse by genre') }),
        U.el('a', { class: 'section-more', href: '#/search', text: T('All filters') })
      ]),
      U.el('div', { class: 'home-genre-grid' }, GENRES.map(g =>
        U.el('a', { class: 'home-genre', href: `#/search?genre=${encodeURIComponent(g)}` }, [
          U.el('span', { text: T(g) })
        ])))
    ])
  }
}
