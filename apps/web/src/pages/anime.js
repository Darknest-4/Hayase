/* global navigator, requestAnimationFrame */
// Anime adatlap — #/anime/:id (AniList-szám vagy katalógus-uuid).
//
// 2026-09, újratervezve. Ami változott, és miért:
//
//   * EGY PONTSZÁM. A lap kétszer mondta ki ugyanazt két alakban („★ 5.10" és
//     egy piros „51.0%" csempe), és a csempe színe — piros, sárga, zöld — úgy
//     ítélkezett, mintha egy szám minősítené a sorozatot. Most egyszer, százalékban.
//
//   * AZ EPIZÓDSOR HIVATKOZÁS. A sor eddig egy `div` volt kattintáskezelővel:
//     billentyűzettel elérhetetlen, és a benne ülő „megnézve" gomb egy
//     kattintható elem a kattintható elemben. Most a cím egy valódi `<a>`, ami
//     a sort kitölti, a gomb pedig mellette külön vezérlő.
//
//   * A MEGOSZTÁS A SAJÁT CÍMÜNKET ADJA. A gomb eddig egy bedrótozott idegen
//     domaint másolt ki (`hayase.watch`) — minden megosztott link egy másik
//     oldalra vitt. Most `<origin>/anime/<id>`, amit a kiszolgáló a cím saját
//     fejlécével (SEO, link-előnézet) szolgál ki; telefonon a rendszer
//     megosztó lapja.
//
//   * A FÜL A CÍMBEN. `?tab=characters` — egy linkkel meg lehet mutatni a
//     szereplőket, és a vissza gomb nem dobja el a választást.
//
//   * A LISTÁRA VÉTEL NEM RAJZOLJA ÚJRA A LAPOT. Eddig egy teljes navigáció
//     futott, ami a görgetést és a nyitott fület is visszaállította.

import { featureOn } from '../shared/lib/site-config.js'
import { setTitle } from '../shared/lib/shell.js'
import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { Prefs } from '../shared/state/preferences.js'
import { Store } from '../shared/state/store.js'
import { P } from '../shared/ui/primitives.js'
import { titleTheme } from '../shared/lib/title-theme.js'
import { U } from '../shared/lib/dom.js'
import { viewEntity } from '../shared/lib/analytics.js'
import { Comments } from '../features/comments/comments.js'
import { openTrailer } from '../features/trailer/trailer.js'

const ICONS = {
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'
}

const TABS = ['episodes', 'relations', 'characters', 'comments', 'recommendations']

export const PageAnime = {
  async render (root, params, id) {
    root.append(this.skeleton())

    // Catalogue first, AniList as the fallback — see entities/anime/catalogue.js.
    // `id` is an AniList id or a Yume uuid; the resolver accepts either, which
    // is what makes a catalogue-only title reachable at all.
    let media
    try {
      media = await Catalogue.media(id)
    } catch (e) {
      root.replaceChildren(U.el('div', { class: 'page-pad' }, [C.errorState(e, () => { window.location.reload() })]))
      return
    }
    if (!media) {
      root.replaceChildren(U.el('div', { class: 'page-pad' }, [
        P.emptyState(T('Anime not found.'), {
          action: U.el('a', { class: 'btn btn-secondary', href: '#/search' }, [document.createTextNode(T('Search'))])
        })
      ]))
      return
    }

    viewEntity(media.yumeId)
    root.replaceChildren()
    setTitle(U.title(media))

    // A borító vagy a banner a lap tetején, halványan — a néző tudja, hol van.
    U.setBanner(media.bannerImage ?? U.cover(media))

    const page = U.el('div', { class: 'page-pad anime-page', style: titleTheme(media) })
    root.append(page)
    page.append(this.hero(media))

    const tab = TABS.includes(params?.get?.('tab')) ? params.get('tab') : 'episodes'
    page.append(U.el('div', { class: 'anime-layout' }, [
      this.tabs(media, tab),
      this.sidePanel(media)
    ]))
  },

  /** Az adatlap alakja, amíg a cím betölt. */
  skeleton () {
    return U.el('div', { class: 'page-pad anime-page', 'aria-busy': 'true' }, [
      U.el('div', { class: 'anime-hero' }, [
        U.el('div', { class: 'anime-cover skeleton' }),
        U.el('div', { class: 'anime-head' }, [
          U.el('div', { class: 'skeleton skel-text', style: 'width:9rem' }),
          U.el('div', { class: 'skeleton skel-title', style: 'width:min(30rem,90%);height:2.5rem' }),
          U.el('div', { class: 'skeleton skel-text', style: 'width:min(20rem,70%)' }),
          U.el('div', { class: 'skeleton skel-text' }),
          U.el('div', { class: 'skeleton skel-text skel-line-mid' })
        ])
      ])
    ])
  },

  hero (media) {
    const mainTitle = U.title(media)
    const romaji = media.title?.romaji ?? ''
    const native = media.title?.native ?? ''
    // A második cím: ha a fő cím maga a romaji, az eredeti írásmód jön alá.
    const secondary = romaji.toLowerCase().trim() === mainTitle.toLowerCase().trim() ? native : romaji
    const score = U.score(media)
    const count = media.episodes ?? (media.nextAiringEpisode ? media.nextAiringEpisode.episode - 1 : null)

    const facts = U.el('div', { class: 'anime-facts' })
    const fact = (node) => facts.append(node)
    if (score) {
      fact(U.el('span', { class: 'anime-score', title: T('Average score') }, [
        U.svg(C.HEART, 16), U.el('b', { text: `${score}%` })
      ]))
    }
    if (media.status) {
      fact(U.el('span', { class: 'badge badge-dot ' + (media.status === 'RELEASING' ? 'badge-live' : media.status === 'NOT_YET_RELEASED' ? 'badge-info' : ''), text: U.status(media) }))
    }
    if (count) fact(U.el('span', { class: 'anime-fact', text: `${count} ${T('episodes')}` }))
    if (media.duration) fact(U.el('span', { class: 'anime-fact', text: `${media.duration} ${T('min')}` }))
    const studio = media.studios?.nodes?.[0]?.name
    if (studio) fact(U.el('span', { class: 'anime-fact', text: studio }))

    const eyebrow = [
      U.format(media),
      U.seasonYear(media) ? String(U.seasonYear(media)) : null
    ].filter(Boolean)

    // ---- leírás: négy sor, és csak akkor „Tovább", ha tényleg van tovább ----
    const descText = U.plainDesc(media.description).trim()
    const wantLang = Prefs?.get('language.content') ?? 'hu'
    const gotLang = media._lang?.synopsis ?? null
    const descNote = descText && gotLang && gotLang !== wantLang && gotLang !== 'unknown'
      ? U.el('p', { class: 'anime-desc-note', text: T('This description has not been translated yet.') })
      : null
    const desc = U.el('p', { class: 'detail-desc anime-desc clamp-4', id: 'anime-desc', text: descText || T('No description yet.') })
    const more = U.el('button', {
      class: 'link anime-desc-toggle',
      type: 'button',
      hidden: true,
      'aria-controls': 'anime-desc',
      'aria-expanded': 'false',
      onclick: () => {
        const open = desc.classList.toggle('clamp-4') === false
        more.setAttribute('aria-expanded', String(open))
        more.textContent = open ? T('Show less') : T('Read more')
      }
    }, [document.createTextNode(T('Read more'))])
    requestAnimationFrame(() => {
      if (desc.scrollHeight > desc.clientHeight + 4) more.hidden = false
    })

    const genres = (media.genres ?? []).length
      ? U.el('div', { class: 'badges anime-genres' }, media.genres.map(g =>
        U.el('a', { class: 'badge badge-outline', href: `#/search?genre=${encodeURIComponent(g)}`, text: T(g) })))
      : null

    return U.el('section', { class: 'anime-hero', 'aria-labelledby': 'anime-title' }, [
      U.el('div', { class: 'anime-cover' }, [
        U.el('img', { src: U.cover(media), alt: '', decoding: 'async', fetchpriority: 'high' })
      ]),
      U.el('div', { class: 'anime-head' }, [
        eyebrow.length ? U.el('p', { class: 'eyebrow', text: eyebrow.join(' · ') }) : null,
        U.el('h1', { class: 'anime-title', id: 'anime-title', text: mainTitle }),
        secondary ? U.el('p', { class: 'anime-subtitle', lang: secondary === native ? 'ja' : null, text: secondary }) : null,
        facts,
        descNote,
        desc,
        more,
        genres,
        this.actions(media)
      ])
    ])
  },

  /** Lejátszás, lista, kedvenc, megosztás, előzetes, külső oldalak. */
  actions (media) {
    const row = U.el('div', { class: 'anime-actions' })
    const progress = Store.entry(media.id)?.progress ?? 0

    // Hol folytassa: a következő rész, ha annak van mentett helye vagy a
    // mostaninak nincs; különben a félbehagyott mostani.
    const resumeNextEp = Store.getResume(media.id, progress + 1)
    const resumeCurEp = progress > 0 ? Store.getResume(media.id, progress) : 0
    const targetEp = resumeNextEp || !resumeCurEp ? progress + 1 : progress
    const resumeAt = resumeNextEp || resumeCurEp
    const estTotal = (media.duration || 24) * 60

    const playLabel = progress || resumeAt ? T('Continue Watching') : T('Start Watching')
    const playSub = resumeAt
      ? `${I18n.f(T('Episode {n}'), { n: targetEp })} · ${U.fmtTime(resumeAt)} / ${U.fmtTime(estTotal)}`
      : I18n.f(T('Episode {n}'), { n: targetEp })

    const play = U.el('a', { class: 'btn btn-primary btn-lg anime-play', href: `#/watch/${media.id}:${targetEp}` }, [
      U.svg(C.PLAY, 18),
      U.el('span', { class: 'anime-play-text' }, [
        U.el('b', { text: playLabel }),
        U.el('small', { text: playSub })
      ]),
      resumeAt ? U.el('span', { class: 'anime-play-bar', 'aria-hidden': 'true' }, [U.el('span', { style: `width:${Math.min(100, resumeAt / estTotal * 100)}%` })]) : null
    ])
    row.append(play)

    /*
     * A nagy gomb csak arra mutathat, ami el is indul.
     *
     * A katalógus tudja, melyik résznek van forrása. Ha a célzott résznek
     * nincs, de egy másiknak van, a gomb oda visz; ha egyiknek sincs, a gomb
     * kimondja — egy lejátszóra mutató gomb, ami egy üres lejátszót nyit,
     * rosszabb, mint egy őszinte „még nincs forrás".
     */
    Catalogue.episodes(media).then(list => {
      if (!play.isConnected || !list?.length) return
      if (!list.some(e => e.sourceCount !== undefined)) return
      const target = list.find(e => e.episode === targetEp)
      if (target && (target.sourceCount === undefined || target.sourceCount > 0)) return
      const firstPlayable = list.find(e => (e.sourceCount ?? 0) > 0)
      if (firstPlayable) {
        play.href = `#/watch/${media.id}:${firstPlayable.episode}`
        const sub = play.querySelector('small')
        if (sub) sub.textContent = I18n.f(T('Episode {n}'), { n: firstPlayable.episode })
        return
      }
      play.replaceWith(U.el('button', {
        class: 'btn btn-secondary btn-lg anime-play',
        type: 'button',
        disabled: true,
        title: T('Nothing to play this episode from yet.')
      }, [
        U.svg(C.PLAY, 18),
        U.el('span', { class: 'anime-play-text' }, [
          U.el('b', { text: T('No source yet') }),
          U.el('small', { text: T('The episode list below is complete.') })
        ])
      ]))
    }).catch(() => { /* a lekérdezés hibája nem bizonyíték a forrás hiányára */ })

    row.append(this.entrySelect(media))

    // Kedvenc: kapcsoló, aria-pressed-del — a szív kitöltése csak a látható fele.
    const fav = U.el('button', {
      class: 'icon-btn icon-btn-lg',
      type: 'button',
      'aria-label': T('Favourite'),
      title: T('Favourite'),
      'aria-pressed': String(Store.isFavourite(media.id)),
      onclick: () => {
        const now = Store.toggleFavourite(media.id)
        fav.setAttribute('aria-pressed', String(now))
        U.toast(T(now ? 'Added to favourites' : 'Removed from favourites'), now ? 'success' : '')
      }
    }, [U.svg(C.HEART, 18)])
    row.append(fav)

    row.append(U.el('button', {
      class: 'icon-btn icon-btn-lg',
      type: 'button',
      'aria-label': T('Share'),
      title: T('Share'),
      onclick: () => this.share(media)
    }, [U.svg(ICONS.share, 18)]))

    if (media.trailer?.id && media.trailer.site === 'youtube' && featureOn('trailers')) {
      row.append(U.el('button', {
        class: 'icon-btn icon-btn-lg',
        type: 'button',
        'aria-label': T('Trailer'),
        title: T('Trailer'),
        onclick: () => openTrailer(media.trailer)
      }, [U.svg(ICONS.film, 18)]))
    }

    // A külső oldalak: nevükön, nem két rejtélyes betűvel („AL", „MAL").
    const anilistId = media.anilistId ?? (typeof media.id === 'number' ? media.id : null)
    const links = [
      anilistId ? ['AniList', `https://anilist.co/anime/${anilistId}`] : null,
      media.idMal ? ['MyAnimeList', `https://myanimelist.net/anime/${media.idMal}`] : null
    ].filter(Boolean)
    if (links.length) {
      row.append(U.el('div', { class: 'anime-links' }, links.map(([name, href]) =>
        U.el('a', { class: 'btn btn-quiet btn-sm', href, target: '_blank', rel: 'noopener noreferrer' }, [
          document.createTextNode(name), U.svg(ICONS.external, 14)
        ]))))
    }
    return row
  },

  /** A lap saját címe — a kiszolgáló ezt a cím saját fejlécével adja ki. */
  async share (media) {
    const url = `${window.location.origin}/anime/${media.id}`
    const title = U.title(media)
    try {
      if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
        await navigator.share({ title, url })
        return
      }
      await navigator.clipboard.writeText(url)
      U.toast(T('Link copied'), 'success')
    } catch (e) {
      if (e?.name === 'AbortError') return // a néző bezárta a megosztó lapot
      U.toast(T('Could not copy'), 'error')
    }
  },

  entrySelect (media) {
    const id = 'entry-' + Math.random().toString(36).slice(2, 8)
    const select = U.el('select', {
      class: 'select entry-select',
      id,
      'aria-label': T('List status'),
      onchange: () => {
        if (select.value === '') {
          Store.removeEntry(media.id)
          U.toast(T('Removed from list'))
        } else {
          Store.saveEntry(media, { status: select.value })
          U.toast(I18n.f(T('Saved as: {status}'), { status: T(U.listStatusMap[select.value]) }), 'success')
        }
        paint()
      }
    })
    const paint = () => {
      const now = Store.entry(media.id)
      select.replaceChildren(
        U.el('option', { value: '', text: now ? T('Remove from list') : T('Add to list') }),
        ...Object.entries(U.listStatusMap).map(([value, label]) =>
          U.el('option', { value, text: T(label), selected: now?.status === value }))
      )
      select.value = now?.status ?? ''
      select.classList.toggle('entry-select-on', !!now)
    }
    paint()
    return select
  },

  // ---------------------------------------------------------------- tabs

  tabs (media, initial) {
    const labels = {
      episodes: T('Episodes'),
      relations: T('Relations'),
      characters: T('Characters'),
      comments: T('Comments'),
      recommendations: T('Recommendations')
    }
    const rendered = {}
    const bar = P.tabs(TABS.map(id => ({ id, label: labels[id] })), {
      selected: initial,
      label: T('About this title'),
      onSelect: id => {
        show(id)
        // A választás a címben: megosztható, és a vissza gomb megtartja.
        const url = new URL(window.location.href)
        const hash = url.hash.split('?')
        const q = new URLSearchParams(hash[1] ?? '')
        if (id === 'episodes') q.delete('tab')
        else q.set('tab', id)
        const next = hash[0] + (q.toString() ? '?' + q.toString() : '')
        window.history.replaceState(window.history.state, '', next)
      }
    })
    const show = name => {
      if (!rendered[name]) {
        rendered[name] = U.el('div', { class: 'anime-tab' })
        Promise
          .resolve(this['renderTab' + name[0].toUpperCase() + name.slice(1)](rendered[name], media))
          .catch(error => {
            console.warn('[anime] tab failed:', name, error)
            rendered[name].replaceChildren(C.errorState(error))
          })
      }
      bar.panel.replaceChildren(rendered[name])
    }
    show(initial)
    return U.el('div', { class: 'anime-main' }, [bar, bar.panel])
  },

  renderTabEpisodes (wrap, media) {
    const list = U.el('div', { class: 'ep-list', 'aria-busy': 'true' }, Array.from({ length: 5 }, () => this.episodeSkeleton()))
    wrap.append(list)
    this.renderEpisodes(list, media).catch(() => {
      list.removeAttribute('aria-busy')
      list.replaceChildren(P.emptyState(T('No episode data available.')))
    })
  },

  episodeSkeleton () {
    return U.el('div', { class: 'ep-row ep-row-skeleton', 'aria-hidden': 'true' }, [
      U.el('div', { class: 'ep-thumb skeleton' }),
      U.el('div', { class: 'ep-body' }, [
        U.el('div', { class: 'skeleton skel-text skel-line-short' }),
        U.el('div', { class: 'skeleton skel-text skel-line-mid' })
      ])
    ])
  },

  async renderEpisodes (wrap, media) {
    const episodes = await Catalogue.episodes(media)
    wrap.removeAttribute('aria-busy')
    if (!episodes.length) {
      wrap.replaceChildren(P.emptyState(T(media.status === 'NOT_YET_RELEASED' ? 'Not yet aired.' : 'No episode data available.')))
      return
    }

    // Sok rész (egy hosszú sorozat ezres nagyságrend) huszonötös lapokon: az
    // összes egyszerre több ezer csomópont volt, és telefonon akadt tőle a lap.
    const RANGE = 25
    const paged = episodes.length > 30
    let rangeStart = 1
    if (paged) {
      const entryProg = Store.entry(media.id)?.progress ?? 0
      rangeStart = Math.floor(Math.max(0, Math.min(entryProg, episodes.length - 1)) / RANGE) * RANGE + 1
    }
    const playable = ep => ep.sourceCount === undefined || ep.sourceCount > 0

    const render = () => {
      const progress = Store.entry(media.id)?.progress ?? 0
      const head = U.el('div', { class: 'ep-head' }, [
        U.el('h2', { class: 'section-title', text: T('Episodes') }),
        U.el('span', {
          class: 'ep-head-sub',
          text: [`${episodes.length} ${T('episodes')}`, media.duration ? `${T('each')} ${media.duration} ${T('min')}` : null].filter(Boolean).join(' · ')
        })
      ])
      const rows = U.el('ol', { class: 'ep-rows' })
      wrap.replaceChildren(head)

      if (paged) {
        const ranges = U.el('div', { class: 'segmented ep-ranges', role: 'group', 'aria-label': T('Episode range') })
        for (let s = 1; s <= episodes.length; s += RANGE) {
          const e = Math.min(s + RANGE - 1, episodes.length)
          ranges.append(U.el('button', {
            type: 'button',
            'aria-pressed': String(s === rangeStart),
            text: `${s}–${e}`,
            onclick: () => { rangeStart = s; render() }
          }))
        }
        wrap.append(ranges)
      }
      wrap.append(rows)

      const visible = paged
        ? episodes.filter(ep => ep.episode >= rangeStart && ep.episode < rangeStart + RANGE)
        : episodes
      for (const ep of visible) {
        const watched = progress >= ep.episode
        const canPlay = playable(ep)
        const epTitle = ep.title ?? I18n.f(T('Episode {n}'), { n: ep.episode })
        const resume = Store.getResume(media.id, ep.episode)
        const totalSec = (ep.runtime ?? media.duration ?? 24) * 60

        const thumb = U.el('div', { class: 'ep-thumb' + (ep.image ? '' : ' ep-thumb-empty') }, [
          ep.image ? U.el('img', { src: ep.image, loading: 'lazy', decoding: 'async', alt: '' }) : U.el('span', { class: 'ep-thumb-num', text: String(ep.episode) }),
          watched ? U.el('span', { class: 'ep-thumb-watched' }, [U.svg(C.CHECK, 20)]) : null,
          resume ? U.el('span', { class: 'ep-thumb-progress' }, [U.el('span', { style: `width:${Math.min(100, resume / totalSec * 100)}%` })]) : null
        ])

        const meta = [
          ep.airdate ? U.airDate(ep.airdate) : null,
          ep.runtime ? `${ep.runtime} ${T('min')}` : null,
          ep.rating ? `★ ${ep.rating}` : null
        ].filter(Boolean).join(' · ')

        const titleNode = canPlay
          ? U.el('a', { class: 'ep-link', href: `#/watch/${media.id}:${ep.episode}` }, [document.createTextNode(epTitle)])
          : U.el('span', { class: 'ep-link-off', text: epTitle })

        rows.append(U.el('li', { class: 'ep-row' + (canPlay ? '' : ' ep-row-off') + (watched ? ' ep-row-watched' : '') }, [
          thumb,
          U.el('div', { class: 'ep-body' }, [
            U.el('div', { class: 'ep-kicker' }, [
              U.el('span', { text: I18n.f(T('Episode {n}'), { n: ep.episode }) }),
              ep.filler ? U.el('span', { class: 'badge badge-warn', text: T('Filler') }) : null,
              canPlay ? null : U.el('span', { class: 'badge', text: T('No source') })
            ]),
            U.el('h3', { class: 'ep-title' }, [titleNode]),
            meta ? U.el('p', { class: 'ep-meta', text: meta }) : null,
            ep.summary ? U.el('p', { class: 'ep-summary clamp-2', text: ep.summary }) : null
          ]),
          U.el('button', {
            class: 'icon-btn ep-watched',
            type: 'button',
            'aria-pressed': String(watched),
            'aria-label': I18n.f(T(watched ? 'Mark episode {n} unwatched' : 'Mark episode {n} watched'), { n: ep.episode }),
            title: T(watched ? 'Mark as unwatched' : 'Mark as watched'),
            onclick: () => {
              Store.setProgress(media, watched && progress === ep.episode ? ep.episode - 1 : ep.episode)
              render()
            }
          }, [U.svg(C.CHECK, 16)])
        ]))
      }
    }
    render()
  },

  async renderTabRelations (wrap, media) {
    if (media.yumeId) await this.renderWatchOrder(wrap, media)
    const relations = (media.relations?.edges ?? [])
      .filter(e => e.node?.type !== 'MANGA' && e.relationType !== 'CHARACTER' && e.node?.coverImage)
    if (!relations.length) {
      if (!wrap.childElementCount) wrap.append(P.emptyState(T('No known relations.')))
      return
    }
    wrap.append(U.el('h2', { class: 'section-title anime-subhead', text: T('Related') }))
    const grid = U.el('div', { class: 'grid' })
    for (const edge of relations) {
      const card = C.card(edge.node)
      card.prepend(U.el('span', { class: 'relation-label', text: T(this.relationLabel(edge.relationType)) }))
      grid.append(card)
    }
    wrap.append(grid)
  },

  relationLabel (type) {
    const known = {
      SEQUEL: 'Sequel',
      PREQUEL: 'Prequel',
      SIDE_STORY: 'Side story',
      PARENT: 'Parent story',
      SPIN_OFF: 'Spin-off',
      ALTERNATIVE: 'Alternative',
      SUMMARY: 'Summary',
      ADAPTATION: 'Adaptation',
      OTHER: 'Other'
    }
    return known[type] ?? String(type ?? '').replaceAll('_', ' ').toLowerCase()
  },

  FRANCHISE_GROUPS: [
    ['seasons', 'Seasons', ['TV', 'TV_SHORT', 'ONA']],
    ['films', 'Films', ['MOVIE']],
    ['extras', 'Specials & OVAs', ['SPECIAL', 'OVA', 'MUSIC']]
  ],

  /** Nézési sorrend a katalógus kapcsolataiból, évad / film / extra bontásban. */
  async renderWatchOrder (wrap, media) {
    const result = await Catalogue.franchise(media.yumeId)
    const entries = result?.data ?? []
    if (entries.length < 2) return
    const box = U.el('div', { class: 'franchise' })
    box.append(U.el('h2', { class: 'section-title anime-subhead', text: T('Watch order') }))
    for (const [key, label, formats] of this.FRANCHISE_GROUPS) {
      const inGroup = entries.filter(e => formats.includes(e.format))
      if (!inGroup.length) continue
      box.append(U.el('h3', { class: 'franchise-group', text: T(label) }))
      const list = U.el('ol', { class: 'franchise-list', dataset: { group: key } })
      inGroup.forEach((e, index) => {
        const current = e.id === media.yumeId
        const year = e.start_date ? String(e.start_date).slice(0, 4) : (e.season_year ?? null)
        list.append(U.el('li', {}, [U.el(current ? 'div' : 'a', {
          class: 'franchise-item' + (current ? ' current' : ''),
          ...(current ? { 'aria-current': 'page' } : { href: `#/anime/${e.anilist_id ?? e.id}` })
        }, [
          U.el('span', { class: 'franchise-index', text: String(index + 1) }),
          U.el('span', { class: 'franchise-title', text: e.canonical_title }),
          U.el('span', {
            class: 'franchise-meta',
            text: [year ? String(year) : null, e.episode_count ? `${e.episode_count} ${T('ep')}` : null, current ? T('you are here') : null]
              .filter(Boolean).join(' · ')
          })
        ])]))
      })
      box.append(list)
    }
    if (result.truncated) {
      box.append(U.el('p', { class: 'franchise-note', text: T('Only the closest entries are shown — this franchise is larger.') }))
    }
    wrap.append(box)
  },

  _charCard (name, role, image) {
    return U.el('div', { class: 'char-card' }, [
      U.el('div', { class: 'char-photo' }, [
        image ? U.el('img', { src: image, alt: '', loading: 'lazy', decoding: 'async' }) : U.el('span', { text: (name ?? '?').slice(0, 1) })
      ]),
      U.el('div', { class: 'char-name', text: name ?? '' }),
      role ? U.el('div', { class: 'char-role', text: T(this.roleLabel(role)) }) : null
    ])
  },

  roleLabel (role) {
    return { MAIN: 'Main', SUPPORTING: 'Supporting', BACKGROUND: 'Background' }[role] ?? role
  },

  async renderTabCharacters (wrap, media) {
    let characters = media.characters?.edges ?? []
    if (!characters.length && media.yumeId) {
      characters = await Catalogue.characters(media.yumeId) ?? []
      if (characters.length) media.characters = { edges: characters }
    }
    if (!characters.length) {
      wrap.append(P.emptyState(T('No character data.')))
      return
    }
    wrap.append(U.el('div', { class: 'char-grid' }, characters.map(edge =>
      this._charCard(edge.node.name?.userPreferred, edge.role, edge.node.image?.large))))

    const staff = media.staff?.edges ?? (media.yumeId ? await Catalogue.staff(media.yumeId) : []) ?? []
    if (staff.length) {
      wrap.append(U.el('h2', { class: 'section-title anime-subhead', text: T('Staff') }))
      wrap.append(U.el('div', { class: 'char-grid' }, staff.map(edge =>
        this._charCard(edge.node.name?.userPreferred, edge.role, edge.node.image?.large))))
    }
  },

  renderTabComments (wrap, media) {
    wrap.append(Comments.section(media))
  },

  async renderTabRecommendations (wrap, media) {
    let recs = (media.recommendations?.nodes ?? []).map(n => n.mediaRecommendation).filter(Boolean)
    if (!recs.length && media.yumeId) recs = await Catalogue.recommendations(media.yumeId) ?? []
    if (recs.length) {
      wrap.append(C.grid(recs))
      return
    }
    wrap.append(P.emptyState(T('No recommendations yet.')))
  },

  // ---------------------------------------------------------------- aside

  sidePanel (media) {
    const side = U.el('aside', { class: 'anime-side', 'aria-label': T('Information') })

    const air = media.nextAiringEpisode
    if (air?.airingAt) {
      const when = new Date(air.airingAt * 1000)
      side.append(U.el('section', { class: 'surface anime-airing' }, [
        U.svg(ICONS.clock, 20),
        U.el('div', {}, [
          U.el('p', { class: 'eyebrow', text: T('Next episode') }),
          U.el('p', { class: 'anime-airing-ep', text: I18n.f(T('Episode {n}'), { n: air.episode }) }),
          U.el('p', { class: 'anime-airing-time' }, [
            U.el('time', { datetime: when.toISOString(), text: U.relTime(when) }),
            document.createTextNode(' · ' + I18n.date(when, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
          ])
        ])
      ]))
    }

    const prettify = v => v ? T(String(v).replaceAll('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())) : null
    const start = media.startDate?.year
      ? I18n.date(new Date(Date.UTC(media.startDate.year, (media.startDate.month ?? 1) - 1, media.startDate.day ?? 1)),
        media.startDate.day ? { year: 'numeric', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' })
      : null
    const rows = [
      [T('Format'), U.format(media)],
      [T('Episodes'), media.episodes ? String(media.episodes) : null],
      [T('Duration'), media.duration ? `${media.duration} ${T('min')}` : null],
      [T('Status'), U.status(media)],
      [T('Season'), U.seasonYear(media) ? String(U.seasonYear(media)) : null],
      [T('Start date'), start],
      [T('Studio'), media.studios?.nodes?.[0]?.name],
      [T('Source'), prettify(media.source)],
      [T('Country'), media.countryOfOrigin],
      [T('Popularity'), media.popularity ? I18n.number(media.popularity) : null],
      [T('Favourites'), media.favourites ? I18n.number(media.favourites) : null]
    ].filter(([, v]) => v)
    side.append(U.el('section', { class: 'surface' }, [
      U.el('h2', { class: 'surface-title', text: T('Information') }),
      U.el('dl', { class: 'kv anime-kv' }, rows.flatMap(([label, value]) => [
        U.el('dt', { text: label }),
        U.el('dd', { text: value })
      ]))
    ]))

    const entry = Store.entry(media.id)
    if (entry) {
      const total = media.episodes ?? null
      const done = entry.progress ?? 0
      side.append(U.el('section', { class: 'surface' }, [
        U.el('h2', { class: 'surface-title', text: T('Your Progress') }),
        U.el('p', { class: 'anime-progress-line' }, [
          U.el('b', { text: total ? `${done} / ${total}` : String(done) }),
          document.createTextNode(' ' + T('episodes') + ' · ' + T(U.listStatusMap[entry.status] ?? ''))
        ]),
        total
          ? U.el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': T('Your Progress') }, [
            U.el('span', { style: `width:${Math.min(100, Math.round(done / total * 100))}%` })
          ])
          : null,
        entry.score ? U.el('p', { class: 'faint', text: `${T('Your score')}: ${entry.score}/10` }) : null
      ]))
    }

    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')
    if (streams.length) {
      side.append(U.el('section', { class: 'surface' }, [
        U.el('h2', { class: 'surface-title', text: T('Where to watch') }),
        U.el('div', { class: 'chips' }, streams.slice(0, 8).map(link =>
          U.el('a', { class: 'chip', href: link.url, target: '_blank', rel: 'noopener noreferrer' }, [
            link.color ? U.el('span', { class: 'anime-stream-dot', style: `background:${link.color}` }) : null,
            document.createTextNode(link.site)
          ])))
      ]))
    }

    const tags = (media.tags ?? []).filter(t => t?.name && !t.isAdult)
      .sort((a, b) => (b?.rank ?? 0) - (a?.rank ?? 0)).slice(0, 14)
    if (tags.length) {
      side.append(U.el('section', { class: 'surface' }, [
        U.el('h2', { class: 'surface-title', text: T('Tags') }),
        U.el('div', { class: 'badges' }, tags.map(tag =>
          U.el('span', {
            class: 'badge' + (tag.isMediaSpoiler || tag.isGeneralSpoiler ? ' anime-tag-spoiler' : ''),
            title: tag.rank ? tag.rank + '%' : null,
            text: tag.name
          })))
      ]))
    }

    if (media.synonyms?.length) {
      side.append(U.el('section', { class: 'surface' }, [
        U.el('h2', { class: 'surface-title', text: T('Also known as') }),
        U.el('p', { class: 'anime-synonyms', text: media.synonyms.slice(0, 6).join(' · ') })
      ]))
    }
    return side
  }
}
