/* global MutationObserver, document, location, window */
// Watch page — modern embedded player. Progress is tracked automatically:
// the exact second you reached is saved per profile and resumed next time,
// history is logged the moment you start, and the episode is marked watched
// at 85%. Under the player: prev/next, an auto-save hint, and a Watch
// Together button that opens a sync-room popup. An "up next" end-card offers
// (auto)play of the following episode.

import { navigate } from '../shared/lib/shell.js'
import { featureOn, flagDeclared } from '../shared/lib/site-config.js'
import { Catalogue } from '../entities/anime/catalogue.js'
import { C } from '../shared/ui/components.js'
import { I18n, T } from '../shared/i18n/i18n.js'
import { LibrarySync } from '../features/library-sync/library-sync.js'
import { Prefs } from '../shared/state/preferences.js'
import { Store } from '../shared/state/store.js'
import { StreamEngine } from '../features/player/stream-engine.js'
import { createEpisodePlayer } from '../features/player2/watch/episode-player.js'
import { P } from '../shared/ui/primitives.js'
import { titleTheme } from '../shared/lib/title-theme.js'
import { U } from '../shared/lib/dom.js'
import { WatchTime } from '../features/watch-history/watch-time.js'
import { YumeAPI } from '../shared/api/yume.js'
import { PageW2G } from '../features/watch-together/watch-together.js'

export const PageWatch = {
  async render (root, params, arg) {
    // route: #/watch/{animeId}:{episode}?src=<encoded-url>[&w2g=code]
    // The id is an AniList id or a Yume catalogue uuid — Number() on the latter
    // gave NaN, which read as "Invalid watch link" for every catalogue-only
    // title. The resolver takes either, so it is passed through as written.
    const [idPart, epPart] = (arg ?? '').split(':')
    const animeId = /^\d+$/.test(idPart ?? '') ? Number(idPart) : idPart
    const episode = Math.max(1, Number(epPart) || 1)
    const src = params.get('src')
    const w2gCode = params.get('w2g') ?? window.sessionStorage.getItem('w2g-pending')

    if (!animeId) {
      root.append(P.errorState(T('Invalid watch link.')))
      return
    }

    root.append(P.spinner())
    let media
    try {
      media = await Catalogue.media(animeId)
    } catch (e) {
      root.replaceChildren(P.errorState(T('Failed to load anime: ') + e.message))
      return
    }

    /*
     * NINCS ILYEN CÍM — és ezt ki is kell mondani.
     *
     * A `Catalogue.media()` egy ismeretlen azonosítóra `null`-t AD VISSZA, nem
     * dob: „a uuid-nek nincs hová mennie". A fenti `catch` tehát nem fogja
     * meg, és a következő sor a `null`-on dolgozott tovább — a látogató egy
     * nyers JavaScript-kivételt kapott üzenetként:
     *
     *     Cannot read properties of null (reading 'episodes')
     *
     * Éles oldalon lemérve, egy elrontott `#/watch/…` címmel. Egy elavult
     * könyvjelző, egy törölt cím vagy egy elgépelt link mind ide fut.
     *
     * A RÉSZLETOLDAL EZT MÁR TUDTA: ugyanez a hívás, ugyanez a `null`, és ott
     * áll mellette egy `if (!media)`. Ugyanaz a kérdés, két külön válasz —
     * ezért van itt most ugyanaz az ág.
     */
    if (!media) {
      root.replaceChildren(P.emptyState(T('Anime not found.')))
      return
    }

    // Van-e egyáltalán miből lejátszani ezt a részt?
    //
    // Eddig a lejátszóoldal felépült, a motor végigpróbálta a nulla jelöltet,
    // és a végén kiírta, hogy nincs forrás — a látogató addigra egy üres
    // lejátszót és egy epizódlistát kapott, amiből semmi nem indul el. A
    // részletoldal epizódsorai ezt már tudták (nem kattinthatók, „Nincs
    // forrás" jelvénnyel), de a nagy lejátszásgomb, a következő/előző, egy
    // könyvjelző és a beírt cím megkerülte őket.
    //
    // A kapu itt van, mert ez az egyetlen pont, amin mind átmegy.
    if (!await this.hasSomethingToPlay(media, episode, src)) {
      root.replaceChildren()
      U.toast(T('Nothing to play this episode from yet.'), 'error')
      window.location.replace(`#/anime/${media.id}`)
      return
    }

    root.replaceChildren()
    U.setBanner(null)

    const total = media.episodes ?? (media.nextAiringEpisode ? media.nextAiringEpisode.episode - 1 : episode)
    this._media = media
    this._episode = episode
    this._total = total

    // Themed by the title being watched, exactly as its detail page is — the
    // player had no --custom at all, so the one screen you spend the most time
    // on was the one that did not agree with the artwork on it.
    const pad = U.el('div', { class: 'page-pad watch-page', style: titleTheme(media) })
    root.append(pad)

    // ---- header ----
    pad.append(
      U.el('div', { class: 'watch-head' }, [
        U.el('a', { class: 'player-back', href: `#/anime/${media.id}`, text: '‹ ' + U.title(media) }),
        U.el('h1', { class: 'watch-title' }, [
          document.createTextNode(`${episode}. rész`),
          total ? U.el('span', { class: 'watch-total', text: ` / ${total}` }) : null
        ])
      ])
    )

    // ---- two-column layout: player + content left, episode list right ----
    const left = U.el('div', { class: 'watch-main' })
    // New episode, new sources: without clearing these the switcher would
    // offer the previous episode's providers and switching would play it.
    this._candidates = null
    this._activeCandidate = null
    this._playContext = null

    const side = U.el('aside', { class: 'watch-side' })
    pad.append(U.el('div', { class: 'watch-layout' }, [left, side]))
    const col = left // content below the player goes here

    // ---- player box (or source picker inside the same frame) ----
    const playerBox = U.el('div', { class: 'player-box' })
    col.append(playerBox)

    /*
     * A KATALÓGUS SAJÁT FORRÁSAI IS INDÍTJÁK A LEJÁTSZÓT.
     *
     * Eddig a feltétel csak `src` volt, vagyis a lejátszó KIZÁRÓLAG akkor épült
     * fel, ha a látogató kézzel beillesztett egy URL-t. A `registeredSources`
     * a lejátszón BELÜL kérdezi le a katalógust — tehát amíg a lejátszó nem
     * indult el, a regisztrált forrásokat soha senki nem kérte le.
     *
     * Ez akkor derült ki, amikor mind a 364 064 epizódhoz került forrás: az
     * epizódlista `source_count: 1`-et adott, a `hasSomethingToPlay` átengedte
     * az oldalt, és a látogató mégis a kézi beviteli űrlapot kapta. A
     * `/v1/anime/episodes/:id/sources` végpontot a lap egyszer sem hívta meg.
     *
     * A `hasRegisteredSources` szándékosan szigorúbb a `canPlayEpisode`-nál:
     * csak akkor indítunk lejátszót, ha TUDJUK, hogy van mit lejátszani.
     * „Talán van" alapján indítva üres lejátszót kapna a néző.
     */
    if (src || this.hasRegisteredSources(episode)) {
      this.mountPlayer(playerBox, media, episode, total, src ? decodeURIComponent(src) : '', w2gCode)
    } else {
      this._video = null
      this.mountSourcePicker(playerBox, media, episode)
    }

    // Sub/dub and provider switch. Filled in by mountVariantBar() once the
    // candidates are known, and left empty when there is only one of each —
    // an empty container costs nothing and keeps the DOM order stable.
    col.append(U.el('div', { id: 'watch-variant-bar' }))

    // ---- actions row under the player ----
    const watched = (Store.entry(media.id)?.progress ?? 0) >= episode
    const markBtn = U.el('button', {
      class: 'btn btn-sm ' + (watched ? 'btn-theme' : 'btn-secondary'),
      onclick: () => {
        const progress = Store.entry(media.id)?.progress ?? 0
        Store.setProgress(media, watched && progress === episode ? episode - 1 : episode)
        U.toast(watched
          ? `${T('Episode')} ${episode} — ${T('unmarked')}`
          : `${T('Episode')} ${episode} — ${T('marked as watched')}`)
        navigate()
      }
    }, [U.svg(C.CHECK, 13), document.createTextNode(T(watched ? 'Watched' : 'Mark watched'))])

    const keepSrc = src ? `?src=${encodeURIComponent(decodeURIComponent(src))}` : ''
    col.append(U.el('div', { class: 'watch-actions' }, [
      // Egy szomszéd, amihez nincs forrás, nem ajánlat: a kapu úgyis
      // visszadobná a részletoldalra, és az egy kattintás a semmiért.
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode > 1 && this.canPlayEpisode(episode - 1) ? '' : ' hidden'),
        href: `#/watch/${media.id}:${episode - 1}`
      }, [document.createTextNode(T('‹ Previous'))]),
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode < total && this.canPlayEpisode(episode + 1) ? '' : ' hidden'),
        href: `#/watch/${media.id}:${episode + 1}`
      }, [document.createTextNode(T('Next ›'))]),
      // Watch Together — opens the sync-room popup (feature-flagged)
      featureOn('watch_together')
        ? U.el('button', {
          class: 'btn btn-secondary btn-sm w2g-open',
          onclick: () => this.openW2G()
        }, [U.svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 13), document.createTextNode(T('Watch Together'))])
        : null,
      U.el('div', { style: 'flex-grow:1;' }),
      markBtn,
      src ? U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode(T('Change source'))]) : null
    ]))

    // ---- Continue Watching card: live auto-save progress (reference style) ----
    if (src) {
      const resume = Store.getResume(media.id, episode)
      const estTotal = (media.duration || 24) * 60
      const frac = resume ? Math.min(1, resume / estTotal) : 0
      col.append(U.el('div', { class: 'cw-card', id: 'cw-card' }, [
        U.el('div', { class: 'cw-head' }, [
          U.el('div', { class: 'cw-title' }, [
            U.svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 15),
            document.createTextNode(T('Continue Watching'))
          ]),
          U.el('div', { class: 'cw-right' }, [
            U.el('span', { class: 'cw-right-label', text: T('Your progress') }),
            U.el('b', { id: 'cw-pct', text: Math.round(frac * 100) + '%' })
          ])
        ]),
        U.el('div', { class: 'cw-sub' }, [
          U.el('span', { text: T('Automatically saved. You’ll resume right where you left off.') }),
          U.el('span', { id: 'cw-time', class: 'cw-time', text: resume ? `${U.fmtTime(resume)} / ${U.fmtTime(estTotal)}` : '' })
        ]),
        U.el('div', { class: 'cw-segments', id: 'cw-segments' },
          Array.from({ length: 18 }, (_, i) => U.el('div', { class: 'cw-seg' + ((i + 0.5) / 18 <= frac ? ' on' : '') })))
      ]))
    }

    // ---- episode sidebar: rich vertical list, current highlighted ----
    if (total > 1) this.mountEpisodeList(side, media, episode, total, keepSrc)

    // ---- episode metadata: title + meta chips + expandable summary ----
    Catalogue.episodes(media).then(list => {
      const ep = list.find(e => e.episode === episode) ?? list[episode - 1]
      if (!ep || (!ep.title && !ep.summary)) return

      const metaChip = (icon, text) => U.el('span', { class: 'epmeta-chip' }, [U.svg(icon, 13), document.createTextNode(text)])
      const chips = U.el('div', { class: 'epmeta-row' })
      if (ep.airdate) chips.append(metaChip('<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>', U.airDate(ep.airdate)))
      if (ep.runtime || media.duration) chips.append(metaChip('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', `${ep.runtime ?? media.duration} min`))
      if (media.format) chips.append(metaChip('<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>', U.format(media)))
      if (media.isAdult) chips.append(U.el('span', { class: 'epmeta-badge', text: '18+' }))
      if (ep.filler) chips.append(U.el('span', { class: 'epmeta-badge filler', text: T('Filler') }))

      const summary = ep.summary ? U.el('div', { class: 'watch-ep-summary clamped', text: ep.summary }) : null
      const info = U.el('div', { class: 'watch-ep-info' }, [
        U.el('h2', { class: 'watch-ep-title', text: `${episode}. ${ep.title ?? 'Episode ' + episode}` }),
        chips,
        summary,
        summary && ep.summary.length > 160
          ? U.el('button', {
            class: 'showmore',
            onclick: e => {
              const open = summary.classList.toggle('clamped')
              e.currentTarget.textContent = open ? 'Show more ⌄' : 'Show less ⌃'
            }
          }, [document.createTextNode(T('Show more ⌄'))])
          : null
      ])
      const anchor = col.querySelector('#cw-card') ?? col.querySelector('.watch-actions')
      anchor.after(info)
    }).catch(() => {})

    // ---- comments ----
    col.append(C.commentsSection(media))
  },

  // ---- episode sidebar (thumbnails + titles; falls back to plain rows) ----
  mountEpisodeList (side, media, episode, total, keepSrc) {
    const panel = U.el('div', { class: 'wep-panel' }, [
      U.el('div', { class: 'wep-head' }, [
        U.el('h2', { text: T('Episodes') }),
        U.el('span', { class: 'wep-count', text: `${total}` })
      ])
    ])
    // Long series are paged, the way the detail page's episode list already
    // is. This rail drew every episode unconditionally: ONE PIECE is 1168 in
    // this catalogue, so opening it built 1168 rows — twice, once before the
    // episode metadata arrives and once after — and left a rail nobody can
    // navigate by scrolling.
    //
    // Only above the threshold. A 26-episode series is better as one list
    // than as one list plus a control that offers a single range, so shows
    // shorter than this behave exactly as they did.
    const RANGE = 100
    const paged = total > RANGE
    const progress = Store.entry(media.id)?.progress ?? 0
    // Open on the block holding the episode being watched, not on the first.
    let rangeStart = paged ? Math.floor((episode - 1) / RANGE) * RANGE + 1 : 1

    const ranges = paged ? U.el('div', { class: 'eplist-ranges wep-ranges' }) : null
    if (ranges) panel.append(ranges)

    const list = U.el('div', { class: 'wep-list' })
    panel.append(list)
    side.append(panel)

    let lastMeta = null

    const renderRanges = () => {
      if (!ranges) return
      ranges.replaceChildren()
      for (let s = 1; s <= total; s += RANGE) {
        const e = Math.min(s + RANGE - 1, total)
        ranges.append(U.el('button', {
          class: 'eplist-range' + (s === rangeStart ? ' active' : ''),
          type: 'button',
          text: `${s}–${e}`,
          onclick: () => { rangeStart = s; renderRanges(); renderRows(lastMeta) }
        }))
      }
    }

    const renderRows = meta => {
      lastMeta = meta
      const byNum = meta ? new Map(meta.map(e => [e.episode, e])) : null
      list.replaceChildren()
      const from = paged ? rangeStart : 1
      const to = paged ? Math.min(rangeStart + RANGE - 1, total) : total
      for (let n = from; n <= to; n++) {
        const ep = byNum?.get(n)
        const active = n === episode
        list.append(U.el('a', {
          class: 'wep' + (active ? ' active' : '') + (n <= progress ? ' watched' : ''),
          href: `#/watch/${media.id}:${n}${active ? keepSrc : ''}`
        }, [
          ep?.image
            ? U.el('div', { class: 'wep-thumb' }, [
              U.el('img', { src: ep.image, loading: 'lazy', alt: '' }),
              active ? U.el('div', { class: 'wep-playing' }, [U.svg(C.PLAY, 12)]) : null
            ])
            : U.el('div', { class: 'wep-num', text: String(n) }),
          U.el('div', { class: 'wep-body' }, [
            U.el('div', { class: 'wep-title', text: ep?.title ? `${n}. ${ep.title}` : `Episode ${n}` }),
            U.el('div', { class: 'wep-meta', text: [ep?.airdate ? U.airDate(ep.airdate) : null, ep?.filler ? 'FILLER' : null].filter(Boolean).join(' • ') || (n <= progress ? 'Watched' : '') })
          ]),
          n <= progress ? U.svg(C.CHECK, 13) : null
        ]))
      }
      // keep the current episode in view
      list.querySelector('.wep.active')?.scrollIntoView({ block: 'center' })
    }

    renderRanges()
    renderRows(null)
    Catalogue.episodes(media).then(meta => { if (meta?.length) renderRows(meta) }).catch(() => {})
  },

  // ---- sub / dub + provider switcher ----
  //
  // Anime is served by several providers at once, and the same episode
  // commonly exists as a sub and as a dub. Both are one decision to a viewer
  // — "watch this, this way" — so they sit in one bar under the player
  // instead of being buried in settings.
  //
  // It re-ranks and replays from the candidates already in hand rather than
  // fetching again, so switching is instant. The sub/dub choice
  // is also written back to preferences: someone who switches to dub here
  // almost always wants dub next time too, and making them state it twice is
  // the kind of small rudeness that adds up.

  /** Variants actually on offer for this episode, in a stable order. */
  _variantsAvailable () {
    const order = ['sub', 'dub', 'raw', 'unknown']
    const present = new Set((this._candidates ?? []).map(c => c.variant))
    return order.filter(v => present.has(v))
  },

  /** Providers actually on offer, best-ranked first. */
  _providersAvailable () {
    const seen = new Map()
    for (const candidate of this._candidates ?? []) {
      if (!seen.has(candidate.source.slug)) seen.set(candidate.source.slug, candidate.source)
    }
    return [...seen.values()]
  },

  VARIANT_LABELS: { sub: 'Sub', dub: 'Dub', raw: 'Raw', unknown: 'Unknown' },

  mountVariantBar (media, episode) {
    const host = document.getElementById('watch-variant-bar')
    if (!host) return

    const variants = this._variantsAvailable()
    const providers = this._providersAvailable()

    // One provider offering one variant is not a choice; showing a switch with
    // a single option makes the player look busier without giving the viewer
    // anything to do.
    const subtitleCount = StreamEngine?.subtitleTracks(this._video)?.length ?? 0
    if (variants.length < 2 && providers.length < 2 && subtitleCount === 0) {
      host.replaceChildren()
      return
    }

    const active = this._activeCandidate
    const wanted = Prefs?.get('playback.variant') ?? 'any'
    const row = []

    /*
     * MEGMONDJUK A NÉZŐNEK, HA IDEGEN LEJÁTSZÓT LÁT.
     *
     * Nem apróság: a beágyazott lejátszóban a MI vezérlőink nem működnek —
     * a billentyűparancsok, a minőségváltás, a feliratkapcsoló és a
     * haladásmentés mind a saját `<video>`-nkra épül, ami ilyenkor nincs
     * képen. Enélkül a néző azt hinné, hogy a lejátszó romlott el.
     */
    if (active?.kind === 'embed') {
      row.push(U.el('div', { class: 'vbar-group' }, [
        U.el('span', { class: 'vbar-label', text: T('Player') }),
        U.el('span', {
          class: 'vbar-note',
          title: T('This episode plays in the provider\u2019s own player. The site\u2019s playback controls do not apply to it.')
        }, [document.createTextNode(T('Embedded player'))])
      ]))
    }

    if (variants.length > 1) {
      row.push(U.el('div', { class: 'vbar-group' }, [
        U.el('span', { class: 'vbar-label', text: T('Version') }),
        U.el('div', { class: 'vbar-chips' }, variants.map(variant => {
          const on = active ? active.variant === variant : wanted === variant
          const btn = U.el('button', {
            class: 'vbar-chip' + (on ? ' active' : ''),
            'aria-pressed': on ? 'true' : 'false',
            title: T(this.VARIANT_LABELS[variant])
          }, [document.createTextNode(T(this.VARIANT_LABELS[variant]))])
          btn.addEventListener('click', () => this.switchTo({ variant }, media, episode))
          return btn
        }))
      ]))
    }

    // Subtitle tracks, when the playing stream carries more than one — or one
    // that can be turned off. This is the third thing a viewer reaches for
    // mid-episode, after "wrong version" and "this source is stuttering", so
    // it belongs in the same row rather than behind a settings screen.
    const subtitleTracks = StreamEngine?.subtitleTracks(this._video) ?? []
    if (subtitleTracks.length) {
      const showing = subtitleTracks.find(t => t.showing)
      const chips = [
        { key: 'off', label: T('Off'), on: !showing },
        ...subtitleTracks.map(track => ({
          key: String(track.index),
          label: track.label,
          on: track.showing,
          index: track.index
        }))
      ]
      row.push(U.el('div', { class: 'vbar-group' }, [
        U.el('span', { class: 'vbar-label', text: T('Subtitles') }),
        U.el('div', { class: 'vbar-chips' }, chips.map(chip => {
          const btn = U.el('button', {
            class: 'vbar-chip' + (chip.on ? ' active' : ''),
            'aria-pressed': chip.on ? 'true' : 'false',
            title: chip.label
          }, [document.createTextNode(chip.label)])
          btn.addEventListener('click', () => {
            const tracks = this._video?.textTracks
            if (!tracks) return
            for (const track of tracks) {
              if (track.kind === 'subtitles' || track.kind === 'captions') track.mode = 'disabled'
            }
            if (chip.key !== 'off') {
              const track = tracks[chip.index]
              if (track) track.mode = 'showing'
              // Remember the language, not the index: the next episode is a
              // different stream whose track order is nobody's to predict.
              if (track?.language) {
                const code = StreamEngine.languageCode(track.language)
                if (code) Prefs?.set({ 'playback.subtitles': code })
              }
            } else {
              Prefs?.set({ 'playback.subtitles': 'off' })
            }
            this.mountVariantBar(media, episode)
          })
          return btn
        }))
      ]))
    }

    if (providers.length > 1) {
      row.push(U.el('div', { class: 'vbar-group' }, [
        U.el('span', { class: 'vbar-label', text: T('Provider') }),
        U.el('div', { class: 'vbar-chips' }, providers.map(source => {
          const on = active?.source.slug === source.slug
          const btn = U.el('button', {
            class: 'vbar-chip' + (on ? ' active' : ''),
            'aria-pressed': on ? 'true' : 'false',
            title: source.name
          }, [document.createTextNode(source.name)])
          btn.addEventListener('click', () => this.switchTo({ provider: source.slug }, media, episode))
          return btn
        }))
      ]))
    }

    host.replaceChildren(U.el('div', { class: 'vbar' }, row))
  },

  /**
   * Play the best candidate matching a narrowed choice.
   *
   * Narrowing can produce nothing playable — a provider may only offer a dub,
   * or a variant may only exist behind a source this browser cannot play. That
   * is reported and the current stream is left alone, rather than stopping
   * playback to show an error.
   */
  async switchTo (choice, media, episode) {
    const engine = StreamEngine
    const context = this._playContext
    if (!engine || !context || !this._candidates?.length) return

    let pool = this._candidates
    if (choice.variant) pool = pool.filter(c => c.variant === choice.variant)
    if (choice.provider) pool = pool.filter(c => c.source.slug === choice.provider)

    const playable = pool.filter(c => c.playable)
    if (!playable.length) {
      U.toast(T('Nothing playable here — keeping the current source'), 'error')
      return
    }

    // Remember a sub/dub switch; a provider switch is a one-off and is not
    // worth turning into a standing preference.
    if (choice.variant) Prefs?.set({ 'playback.variant': choice.variant })

    const ranked = engine.rank(playable, {
      variant: choice.variant ?? Prefs?.get('playback.variant'),
      subtitles: Prefs?.get('playback.subtitles')
    })

    try {
      const { candidate } = await engine.play(context.video, ranked, {
        onFallback: (failed, reason) => console.warn('[stream] falling back from', failed.source.slug, '—', reason)
      })
      this._activeCandidate = candidate
      this.mountVariantBar(media, episode)
      U.toast(`${T('Playing from')} ${candidate.source.name}`)
    } catch (error) {
      U.toast(T('That source would not start — keeping the current one'), 'error')
      console.warn('[stream] switch failed:', error.message)
    }
  },

  /**
   * The catalogue's row id for one episode number.
   *
   * Three things now hang off it — sources, skip intervals, subtitle tracks —
   * and the episode list is the only thing that maps a number to a row. It is
   * already fetched and cached by the time playback starts, so this is a map
   * lookup rather than a request.
   */
  /**
   * Elindulhat-e egyáltalán a lejátszás.
   *
   * Ugyanaz a szabály, amit a részletoldal epizódsorai használnak: a
   * katalógus saját, engedélyezett forrásai döntenek — de a „nem tudjuk" nem
   * ugyanaz, mint a „nincs". Egy AniList-címnél, amit sosem importáltunk,
   * nincs epizódsor, amire forrást lehetne akasztani; ott a kapu nem szólal
   * meg, mert nem tud semmit.
   *
   * A kézzel beírt cím (?src=) mindig átmegy: azt a látogató hozta magával.
   */
  async hasSomethingToPlay (media, episode, src) {
    if (src) return true
    await this.loadEpisodeRows(media)
    return this.canPlayEpisode(episode)
  },

  /**
   * Az epizódsorok, egyszer lekérve, az egész oldal idejére.
   *
   * A Catalogue gyorsítótáraz, de a lejátszón belüli gombok (előző, következő,
   * „következik") szinkron döntést hoznak — ezért a sorok itt ülnek, nem egy
   * ígéret mögött.
   */
  async loadEpisodeRows (media) {
    try {
      this._episodeRows = await Catalogue.episodes(media)
    } catch (error) {
      // A lekérdezés hibája nem bizonyíték a forrás hiányára.
      console.warn('[watch] episode list unavailable:', error.message)
      this._episodeRows = []
    }
    return this._episodeRows
  },

  /**
   * Van-e ehhez a részhez engedélyezett forrás.
   *
   * A „nem tudjuk" itt is átenged: üres lista (nem importált cím) vagy
   * hiányzó `sourceCount` esetén nincs mire alapozni a tiltást.
   */
  canPlayEpisode (number) {
    const rows = this._episodeRows
    if (!rows?.length) return true
    const row = rows.find(e => e.episode === number)
    if (!row || row.sourceCount === undefined) return true
    return row.sourceCount > 0
  },

  /**
   * HATÁROZOTTAN tudjuk-e, hogy van regisztrált forrás.
   *
   * A `canPlayEpisode` a „nem tudjuk" esetet szándékosan átengedi: egy sosem
   * importált AniList-címnél nincs epizódsor, amire forrást lehetne akasztani,
   * és ott a tiltás rossz válasz lenne. Ez a függvény az ELLENKEZŐ irányba
   * szigorú — csak akkor mond igent, ha a katalógus sora ténylegesen legalább
   * egy forrást jelent.
   *
   * A kettő különbsége az, ami a lejátszó automatikus indítását eldönti:
   * „talán van" alapján elindítani a lejátszót éppen azt az üres képernyőt
   * adná vissza, amit a `hasSomethingToPlay` megszüntetett.
   */
  hasRegisteredSources (number) {
    const row = this._episodeRows?.find(e => e.episode === number)
    return Boolean(row && Number(row.sourceCount) > 0)
  },

  async _episodeId (media, episode) {
    if (!media?.yumeId) return null
    try {
      const list = await Catalogue.episodes(media)
      return list.find(e => e.episode === episode)?.yumeId ?? null
    } catch (error) {
      return null
    }
  },

  /**
   * The catalogue's own sources for one episode number.
   *
   * Two requests rather than one: the episode list is the only thing that maps
   * a number to the row the sources hang off, and it is already fetched and
   * cached by the time playback starts. Returns [] for anything the catalogue
   * does not hold — an AniList title we have never imported has no episode row
   * to attach a source to, and that is not an error.
   */
  async registeredSources (media, episode) {
    try {
      const episodeId = await this._episodeId(media, episode)
      if (!episodeId) return []
      const sources = await Catalogue.episodeSources(episodeId)
      // Any subtitle tracks this deployment holds ride along on every one of
      // them: a track is attached to the episode, not to whichever mirror the
      // viewer happens to get.
      const tracks = await Catalogue.subtitles(episodeId)
      return tracks.length ? sources.map(s => ({ ...s, subtitles: tracks })) : sources
    } catch (error) {
      // A failure here must not stop the manual URL path working.
      console.warn('[stream] registered sources unavailable:', error.message)
      return []
    }
  },

  /**
   * Build the candidate list for this episode and hand it to the engine.
   *
   * Candidates are what this deployment has registered for the episode, plus
   * any URL the viewer pasted. The engine ranks them and tries each in turn; a
   * failure only reaches the user once nothing is left.
   */
  async startPlayback (video, media, episode, src, giveUp) {
    const engine = StreamEngine
    const manual = String(src ?? '')
      .split('\n').map(u => u.trim()).filter(Boolean)
      .map(url => ({ url, title: T('Manual source'), source: { slug: 'manual', name: 'Manual URL', accuracy: 'low', health: 'unknown' } }))

    /*
     * What this deployment says the episode plays from.
     *
     * First in the candidate list and ranked above a pasted URL: somebody who
     * runs this site attached these to this episode by hand, which is a
     * stronger claim about "this is the right video" than a string somebody
     * typed into a box once.
     */
    const registered = await this.registeredSources(media, episode)

    if (!engine) { // engine unavailable → behave like the old direct player
      if (manual[0]) { video.src = manual[0].url; video.load() }
      return
    }

    // The viewer's sub/dub and subtitle-language choice reaches the engine
    // here, where it decides the order candidates are tried in. Without it the
    // setting would be a label with nothing behind it.
    const prefs = {
      variant: Prefs?.get('playback.variant') ?? 'any',
      subtitles: Prefs?.get('playback.subtitles') ?? null
    }

    const { results, errors } = await engine.candidates(media, episode, { sources: [...registered, ...manual], prefs })
    for (const error of errors) console.warn('[stream] source lookup failed:', error)

    if (!results.length) { giveUp(T('No sources were offered for this episode.')); return }

    // Kept so the switcher can re-rank and replay without fetching again —
    // switching from sub to dub should be instant.
    this._candidates = results
    this._playContext = { video, media, episode, giveUp }
    this.mountVariantBar(media, episode)

    try {
      const { candidate } = await engine.play(video, results, {
        onFallback: (failed, reason) => {
          console.warn('[stream] falling back from', failed.source.slug, '—', reason)
          U.toast(`${T('Source failed')} (${failed.source.name}) — ${T('trying the next one')}`, 'error')
        }
      })
      this._activeCandidate = candidate
      this.mountVariantBar(media, episode)
      if (candidate.source.slug !== 'manual') U.toast(`${T('Playing from')} ${candidate.source.name}`)
    } catch (error) {
      // every candidate was tried; show the reason from the last attempt
      const unplayable = (error.attempts ?? []).filter(a => !a.candidate.playable)
      giveUp(unplayable.length === (error.attempts ?? []).length && unplayable.length
        ? unplayable[0].error
        : String(error.message))
    }
  },

  // ---- source picker inside the player frame ----

  mountSourcePicker (box, media, episode) {
    const input = U.el('textarea', {
      class: 'input',
      rows: 2,
      style: 'width:100%;resize:vertical;font-family:inherit;',
      placeholder: T('https://… direct video stream (mp4 / webm) — one per line to enable automatic fallback')
    })
    const play = () => {
      const urls = input.value.split('\n').map(u => u.trim()).filter(Boolean)
      if (!urls.length) return U.toast(T('Paste a stream URL first'), 'error')
      window.location.hash = `#/watch/${media.id}:${episode}?src=${encodeURIComponent(urls.join('\n'))}`
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') play() })

    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')

    box.append(U.el('div', { class: 'player-pick' }, [
      U.el('div', { class: 'player-pick-inner' }, [
        U.el('h2', { style: 'margin:0 0 var(--space-1);font-weight:800;', text: T('Pick a source') }),
        U.el('p', { style: 'margin:0 0 var(--space-4);color:var(--fg-faint);font-size:var(--text-sm);', text: T('Paste a direct stream URL. Add more on separate lines and the player falls back automatically if one fails.') }),
        U.el('div', { style: 'display:flex;gap:var(--space-2);' }, [input, U.el('button', { class: 'btn btn-primary', onclick: play }, [document.createTextNode(T('Play'))])]),
        streams.length
          ? U.el('div', { style: 'margin-top:var(--space-4);' }, [
            U.el('div', { style: 'font-size:var(--text-xs);font-weight:800;color:var(--fg-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:var(--space-2);', text: T('Official streams') }),
            U.el('div', { class: 'badges' }, streams.map(link =>
              U.el('a', { class: 'badge badge-theme', href: link.url, target: '_blank', rel: 'noopener', text: link.site })))
          ])
          : null
      ])
    ]))
  },

  // ---- the embedded player ----

  /**
   * A Player 2.0 felállítása egy részhez.
   *
   * Ami itt történik, az ADATGYŰJTÉS, nem lejátszás: a lap tudja, melyik
   * részt nézzük, honnan jönnek a források, mi a néző beállítása — az új
   * lejátszó ezekből áll össze, és a huzalozás a saját összeszerelő
   * moduljában van, nem itt.
   */
  async mountPlayer2 (box, media, episode, total, src) {
    const video = U.el('video', { class: 'player-video', playsinline: '', preload: 'metadata' })
    this._video = video

    const manual = String(src ?? '')
      .split('\n').map(url => url.trim()).filter(Boolean)
      .map((url, index) => ({ id: `manual-${index}`, url, label: T('Manual source'), quality: null }))

    const registered = (await this.registeredSources(media, episode)).map((source, index) => ({
      id: source.id ?? `registered-${index}`,
      url: source.url,
      quality: Number(source.quality) || null,
      label: source.source?.name ?? source.title ?? null,
      subtitles: source.subtitles ?? []
    }))

    const rows = await this.loadEpisodeRows(media).catch(() => [])
    const has = number => Array.isArray(rows) && rows.some(row => Number(row.number) === number)

    const mounted = createEpisodePlayer({
      video,
      sources: [...registered, ...manual],
      media: { title: U.title(media), logoImage: media.logoImage ?? null },
      episode: { number: episode },
      nextEpisode: episode < total && has(episode + 1) ? { number: episode + 1 } : null,
      previousEpisode: episode > 1 && has(episode - 1) ? { number: episode - 1 } : null,
      // Az első forrás feliratai: a sávok a RÉSZHEZ tartoznak, nem ahhoz a
      // tükörhöz, amit a néző éppen kapott.
      subtitles: registered.find(source => source.subtitles?.length)?.subtitles ?? [],
      skipSegments: [],
      prefs: Prefs,
      featureOn,
      onNextEpisode: () => navigate(`/watch/${media.id}/${episode + 1}`),
      onPreviousEpisode: () => navigate(`/watch/${media.id}/${episode - 1}`),
      onProgress: (seconds, ratio) => WatchTime?.record?.(media, episode, seconds, ratio),
      onCompleted: () => LibrarySync?.markWatched?.(media, episode)
    })

    box.append(mounted.node)
    this._player2 = mounted
    this._shell = mounted.node
    return mounted
  },

  mountPlayer (box, media, episode, total, src, w2gCode = null) {
    /*
     * A PLAYER 2.0 kapcsoló mögött.
     *
     * A `featureOn` NEM ELÉG ÖNMAGÁBAN: egy nem létező kapcsolóra igazat ad
     * vissza (`if (!flag || !flag.enabled) return !flag`). Ez a többi
     * funkciónál helyes — egy új gomb ne tűnjön el a régi telepítéseken —,
     * egy teljes lejátszócserénél viszont azt jelentené, hogy sor nélkül az
     * ÚJ lejátszó indul el mindenkinél, az első éles kérésnél, mérés nélkül.
     *
     * Ezért a kapcsolónak LÉTEZNIE ÉS BEKAPCSOLVA KELL LENNIE. A sort a 0058-as
     * áttérés hozza létre, kikapcsolva.
     *
     * A KETTŐ EGYÜTT ÉL, amíg az új be nem bizonyítja magát éles forgalmon.
     * Egy visszafordíthatatlan csere azt jelentené, hogy az első meglepetésnél
     * nincs hova visszalépni.
     */
    if (flagDeclared('feature.player2') && featureOn('player2')) {
      return this.mountPlayer2(box, media, episode, total, src)
    }

    /*
     * `preload="metadata"` KIÍRVA, nem a böngészőre bízva.
     *
     * Enélkül az alapértelmezés böngészőnként más: asztali Chrome a teljes
     * fájlt kezdi tölteni, mobilon viszont az automatikus lejátszás tiltása
     * miatt akár semmi nem történik. A motor a `loadedmetadata`-t is elfogadja
     * bizonyítéknak (lásd READY_EVENTS), és ez az attribútum garantálja, hogy
     * a metaadat tényleg megérkezzen — minden eszközön ugyanúgy.
     */
    const video = U.el('video', { class: 'player-video', autoplay: '', playsinline: '', preload: 'metadata' })
    this._video = video

    const PLAY_ICON = '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>'
    const PAUSE_ICON = '<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>'

    const playBtn = U.el('button', { class: 'player-btn player-play', 'aria-label': 'Play/Pause' })
    const timeLabel = U.el('span', { class: 'player-time', text: '0:00 / 0:00' })
    const seekFill = U.el('div', { class: 'player-seek-fill' }, [U.el('div', { class: 'player-seek-thumb' })])
    const seekBuffer = U.el('div', { class: 'player-seek-buffer' })
    const seekBar = U.el('div', { class: 'player-seek' }, [seekBuffer, seekFill])
    const volSlider = U.el('input', { class: 'player-volume', type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' })
    const muteBtn = U.el('button', { class: 'player-btn player-mute', 'aria-label': 'Mute' })
    muteBtn.append(U.svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', 18))
    const speedBtn = U.el('button', { class: 'player-btn player-speed', text: '1×', 'aria-label': 'Playback speed' })
    const pipBtn = U.el('button', { class: 'player-btn player-pip', 'aria-label': 'Picture in picture', title: T('Picture in picture') })
    pipBtn.append(U.svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>', 18))
    const fsBtn = U.el('button', { class: 'player-btn player-fs', 'aria-label': 'Fullscreen', title: T('Fullscreen') })
    fsBtn.append(U.svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>', 18))
    const skipBtn = U.el('button', { class: 'btn btn-primary btn-sm player-skip hidden', text: T('Skip intro') })

    const controls = U.el('div', { class: 'player-controls' }, [
      seekBar,
      U.el('div', { class: 'player-controls-row' }, [
        playBtn, muteBtn, volSlider, timeLabel,
        U.el('div', { style: 'flex-grow:1;' }),
        speedBtn, pipBtn, fsBtn
      ])
    ])

    // ---- Netflix-style top gradient: episode title + settings gear ----
    const settingsBtn = U.el('button', { class: 'player-btn', 'aria-label': 'Player settings' })
    settingsBtn.append(U.svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 18))
    const topBar = U.el('div', { class: 'player-topbar' }, [
      U.el('div', { class: 'player-topbar-title', text: `${U.title(media)} — Episode ${episode}` }),
      U.el('div', { style: 'flex-grow:1;' }),
      settingsBtn
    ])

    // ---- Netflix-style center controls: −10s / play / +10s ----
    const bigPlay = U.el('button', { class: 'player-big', 'aria-label': 'Play/Pause' })
    const back10 = U.el('button', { class: 'player-jump', 'aria-label': 'Back 10 seconds' }, [
      U.svg('<path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v6h6"/>', 26), U.el('span', { text: '10' })
    ])
    const fwd10 = U.el('button', { class: 'player-jump', 'aria-label': 'Forward 10 seconds' }, [
      U.svg('<path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/>', 26), U.el('span', { text: '10' })
    ])
    const center = U.el('div', { class: 'player-center' }, [back10, bigPlay, fwd10])
    back10.addEventListener('click', e => { e.stopPropagation(); video.currentTime = Math.max(0, video.currentTime - 10) })
    fwd10.addEventListener('click', e => { e.stopPropagation(); video.currentTime += 10 })

    /*
     * ---- A betöltőképernyő ----
     *
     * A cím SAJÁT LOGÓJA áll a közepén, szürkén, és egy színsáv fut át rajta
     * balról jobbra, újra meg újra, amíg a videó be nem töltődik. Ez nem
     * díszítés: egy üres fekete négyzet alatt a néző nem tudja, hogy az oldal
     * dolgozik-e vagy megállt, és pont a lejátszás indulása az a pillanat,
     * amikor a leghosszabb a várakozás.
     *
     * A KATALÓGUS 32 536 CÍMÉBŐL 4 810-NEK VAN LOGÓJA — tehát a tartalék nem
     * ritka kivétel, hanem a gyakoribb eset. Ilyenkor a YUME szóvédjegy áll
     * ott, ugyanazzal a mozgással: a betöltőnek egységesnek kell lennie, nem
     * „van logó / nincs logó" alapján kétféle élménynek.
     *
     * A szürkeárnyalat a `filter`-től jön, a színcsík egy maszkolt MÁSODIK
     * példánytól ugyanarról a képről. Két réteg, egy kép, nulla plusz letöltés.
     */
    const logoSrc = media.logoImage ?? null
    const brandLayer = () => (logoSrc
      ? U.el('img', { class: 'player-loader-art', src: logoSrc, alt: '', decoding: 'async' })
      : U.el('div', { class: 'player-loader-art player-loader-wordmark', text: 'YUME' }))

    const loader = U.el('div', { class: 'player-loader' }, [
      U.el('div', { class: 'player-loader-brand' }, [
        // Az alsó réteg a szürke alap, a felső a színes — ez utóbbit egy
        // mozgó maszk vágja csíkra, és a csík fut végig a logón.
        brandLayer(),
        U.el('div', { class: 'player-loader-sweep' }, [brandLayer()])
      ]),
      U.el('div', { class: 'player-loader-ring' })
    ])
    /*
     * A BETÖLTŐT A KÉSZÜLTSÉG REJTI EL, NEM A LEJÁTSZÁS.
     *
     * Ez a sor egyetlen eseményre figyelt: `playing`. Az `autoplay` attribútum
     * ott van a videón, a böngésző viszont HANGGAL NEM ENGEDI az automatikus
     * indítást, amíg a néző nem lépett kapcsolatba az oldallal — és ez nem
     * kivétel, hanem az alapeset minden böngészőben és minden telefonon.
     *
     * Ilyenkor a `playing` SOHA nem érkezik meg. A videó teljesen betöltött
     * (`readyState: 4`, megvan a hossz), a betöltőképernyő mégis ott maradt
     * örökre — és mivel az a felületet takarja, a néző a lejátszás gombot sem
     * érte el. Kívülről ez pontosan úgy néz ki, mintha „nem indulna el".
     *
     * Mérve, éles oldalon, bevezető ablak nélkül:
     *   asztali Chromium   paused: true, readyState: 4, betöltő: LÁTSZIK
     *   iPhone 13          paused: true, readyState: 4, betöltő: LÁTSZIK
     *
     * A készültség három eseménye közül bármelyik elég. A `loadeddata` azért
     * kell, mert mobilon gyakran csak odáig jut el a böngésző magától.
     */
    const mountedAt = Date.now()
    const MIN_LOADER = 1100 // a márkás betöltő mindig látszódjon egy pillanatig
    let loaderHideTimer = null

    const hideLoader = () => {
      if (loaderHideTimer) return // már ütemezve
      const wait = Math.max(0, MIN_LOADER - (Date.now() - mountedAt))
      loaderHideTimer = setTimeout(() => { loader.classList.add('hidden'); loaderHideTimer = null }, wait)
    }
    const showLoader = () => {
      if (loaderHideTimer) { clearTimeout(loaderHideTimer); loaderHideTimer = null }
      loader.classList.remove('hidden')
    }

    for (const type of ['canplay', 'loadeddata', 'playing']) video.addEventListener(type, hideLoader)

    // A `waiting` CSAK akkor hozza vissza, ha tényleg tölt. Szünetben nincs
    // mire várni — egy megállított videó fölé tett betöltő ugyanaz a hiba
    // lenne, csak máskor.
    video.addEventListener('waiting', () => {
      if (!video.paused && video.readyState < 3) showLoader()
    })

    /*
     * És ha az automatikus indítást elutasították, MONDJUK MEG.
     *
     * A középső nagy gomb szünetben magától láthatóvá válik
     * (`.player-paused .player-center`), de csak akkor, ha a `paused` osztály
     * tényleg felkerült — ezért kérjük meg rá a felületet, amint kiderül,
     * hogy a böngésző nemet mondott.
     */
    video.addEventListener('loadeddata', () => {
      const started = video.play?.()
      if (started && typeof started.catch === 'function') {
        started.catch(() => {
          // Nem hiba: a böngésző szabálya. A néző egy koppintással indítja.
          hideLoader()
          shell.classList.add('player-paused')
        })
      }
    }, { once: true })

    // W2G room badge (shown when a room is active)
    const roomBadge = U.el('button', { class: 'player-room-badge hidden', onclick: () => this.openW2G() })

    const shell = U.el('div', { class: 'player-shell' }, [video, topBar, center, roomBadge, skipBtn, controls, loader])
    box.append(shell)
    this._roomBadge = roomBadge
    this._shell = shell
    this.refreshRoomBadge()

    // ---- settings menu (speed + auto-skip), anchored to the gear ----
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation()
      const existing = shell.querySelector('.player-menu')
      if (existing) existing.remove()
      else this._openPlayerMenu(shell, video, speedBtn)
    })

    // --- state wiring ---
    const setPlayIcon = () => {
      playBtn.replaceChildren(U.svg(video.paused ? PLAY_ICON : PAUSE_ICON, 18))
      bigPlay.replaceChildren(U.svg(video.paused ? PLAY_ICON : PAUSE_ICON, 30))
      shell.classList.toggle('player-paused', video.paused)
    }
    setPlayIcon()
    const togglePlay = () => { video.paused ? video.play() : video.pause() }
    playBtn.addEventListener('click', togglePlay)
    bigPlay.addEventListener('click', e => { e.stopPropagation(); togglePlay() })
    video.addEventListener('click', togglePlay)
    video.addEventListener('dblclick', () => fsBtn.click())
    video.addEventListener('play', setPlayIcon)
    video.addEventListener('pause', setPlayIcon)

    // Playback failures are handled by the engine, which advances to the next
    // candidate. Only when every candidate is exhausted does the user see this.
    const giveUp = detail => {
      shell.replaceChildren(U.el('div', { class: 'player-pick' }, [
        U.el('div', { class: 'player-pick-inner', style: 'text-align:center;' }, [
          U.el('p', { style: 'color:var(--danger);font-weight:700;', text: T('Could not play this episode from any available source.') }),
          detail ? U.el('p', { style: 'color:var(--fg-faint);font-size:var(--text-sm);margin:var(--space-1) 0 var(--space-4);', text: detail }) : null,
          U.el('a', { class: 'btn btn-secondary btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode(T('Pick another source'))])
        ])
      ]))
    }

    // Start playback through the engine: it ranks the candidates, tries them in
    // order and falls back automatically, so a dead link never dead-ends here.
    this.startPlayback(video, media, episode, src, giveUp)
      .catch(error => giveUp(String(error?.message ?? error)))

    // --- resume position (per profile) ---
    const saved = Store.getResume(media.id, episode)
    video.addEventListener('loadedmetadata', () => {
      if (saved > 5 && saved < video.duration - 10) {
        video.currentTime = saved
        U.toast(`Resumed from ${U.fmtTime(saved)}`)
      }
    }, { once: true })

    // --- automatic tracking ---
    //
    // Crediting used to be positional: `currentTime / duration >= 0.85`. That
    // makes dragging the scrubber to the end indistinguishable from watching,
    // and it is why opening an episode and poking at it credited a full
    // episode — and, through `progress * nominal runtime`, a flat 24 minutes
    // of "watch time" that nobody had spent.
    //
    // WatchTime measures the seconds the video was genuinely playing and
    // fires when *that* clears the bar. See apps/web/js/watch-time.js.
    let historyLogged = false
    let completedFired = false
    // The runtime travels with the position: the server cannot tell 400
    // seconds into an episode from 400 seconds into a film without it.
    const save = () => {
      if (video.currentTime > 5) {
        Store.setResume(media.id, episode, video.currentTime, { durationSec: video.duration })
      }
    }

    const creditEpisode = () => {
      if (completedFired) return
      completedFired = true
      Store.setProgress(media, episode)
      // The measurement is the verdict, and the server is told so directly.
      // Until this call existed, `watch_history`, `xp_events` and every
      // rollup built on them stayed empty on every deployment.
      LibrarySync?.onEpisodeCompleted(media, episode, video.currentTime, video.duration)
      U.toast(I18n.f('Episode {n} marked as watched', { n: episode }))
    }

    const detachMeter = WatchTime?.attach(video, {
      animeId: media.id,
      episode,
      onComplete: creditEpisode
    }) ?? (() => {})

    video.addEventListener('timeupdate', () => {
      const { currentTime, duration } = video
      timeLabel.textContent = `${U.fmtTime(currentTime)} / ${U.fmtTime(duration)}`
      if (duration) seekFill.style.width = (currentTime / duration * 100) + '%'
      if (video.buffered.length && duration) {
        seekBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / duration * 100) + '%'
      }
      // History records "this was opened and played", which is what the
      // history screen is for. It deliberately does not credit progress.
      if (!historyLogged && currentTime > 3 && !video.paused) {
        historyLogged = true
        Store.recordHistory(media, episode)
      }
      this._updateSkip(skipBtn, video)
      this._updateContinueCard(currentTime, duration)
    })
    video.addEventListener('pause', save)

    // finished → clear resume, show the up-next end card
    video.addEventListener('ended', () => {
      Store.clearResume(media.id, episode)
      // No unconditional credit here: reaching the end by dragging the
      // scrubber is not watching. WatchTime applies a lower bar once the
      // video has actually ended, which covers somebody who skipped the
      // intro, a recap and the ending — and still requires real playback.
      if (episode < total) this._showUpNext(shell, media, episode, total)
    })

    // persist position periodically; teardown when the node leaves the DOM
    const saveTimer = setInterval(() => { if (!video.paused) save() }, 5000)
    // The meter holds a timer and document-level listeners; it has to come
    // down with the player or it keeps counting against a detached element.
    const stopMeter = detachMeter
    const observer = new MutationObserver(() => {
      if (!document.body.contains(shell)) {
        save()
        stopMeter()
        clearInterval(saveTimer)
        observer.disconnect()
        document.removeEventListener('keydown', keys)
        this._video = null
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    })
    observer.observe(document.getElementById('page') ?? document.body, { childList: true, subtree: true })

    const seekTo = clientX => {
      const rect = seekBar.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      if (video.duration) video.currentTime = frac * video.duration
    }
    seekBar.addEventListener('pointerdown', e => {
      seekBar.setPointerCapture(e.pointerId)
      seekTo(e.clientX)
      const move = ev => seekTo(ev.clientX)
      const up = () => { seekBar.removeEventListener('pointermove', move); seekBar.removeEventListener('pointerup', up) }
      seekBar.addEventListener('pointermove', move)
      seekBar.addEventListener('pointerup', up)
    })

    volSlider.addEventListener('input', () => {
      video.volume = Number(volSlider.value)
      video.muted = video.volume === 0
      muteBtn.textContent = video.muted ? '🔇' : '🔊'
    })
    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted
      muteBtn.textContent = video.muted ? '🔇' : '🔊'
    })

    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
    speedBtn.addEventListener('click', () => {
      const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length]
      video.playbackRate = next
      speedBtn.textContent = next + '×'
    })

    pipBtn.addEventListener('click', () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture()
      else video.requestPictureInPicture?.().catch(() => U.toast(T('Picture-in-picture unavailable'), 'error'))
    })
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen()
      else shell.requestFullscreen?.()
    })

    const keys = e => {
      if (!document.body.contains(shell) || /^(input|textarea|select)$/i.test(document.activeElement?.tagName ?? '')) return
      switch (e.key.toLowerCase()) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break
        case 'arrowleft': video.currentTime -= 5; break
        case 'arrowright': video.currentTime += 5; break
        case 'arrowup': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); volSlider.value = String(video.volume); break
        case 'arrowdown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); volSlider.value = String(video.volume); break
        case 'f': fsBtn.click(); break
        case 'm': muteBtn.click(); break
        default:
          if (/^[0-9]$/.test(e.key) && video.duration) video.currentTime = video.duration * Number(e.key) / 10
      }
    }
    document.addEventListener('keydown', keys)

    // auto-hide controls while playing
    let hideTimer
    const poke = () => {
      shell.classList.remove('player-idle')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => { if (!video.paused) shell.classList.add('player-idle') }, 2800)
    }
    shell.addEventListener('pointermove', poke)
    poke()

    this._loadSkips(media, episode, video, skipBtn)
    // auto-join a room passed by deep link / pending session
    if (w2gCode) this.joinW2G(w2gCode).catch(() => {})
  },

  // ---- up-next end card ----
  _showUpNext (shell, media, episode, total) {
    shell.querySelector('.player-upnext')?.remove()
    // Nem ajánljuk fel, és főleg nem indítjuk el magától azt, amihez nincs
    // forrás — az automatikus lejátszás egyenesen a részletoldalra dobná
    // vissza a nézőt, öt másodperccel azután, hogy letette a távirányítót.
    if (!this.canPlayEpisode(episode + 1)) return
    const autoplay = Store.settings().autoplay !== false
    const go = () => { window.location.hash = `#/watch/${media.id}:${episode + 1}` }

    const countLabel = U.el('span', { text: autoplay ? `${T('Autoplaying in')} 5…` : '' })
    const card = U.el('div', { class: 'player-upnext' }, [
      U.el('div', { class: 'player-upnext-inner' }, [
        U.el('div', { class: 'player-upnext-label', text: T('Up next') }),
        U.el('div', { class: 'player-upnext-title', text: `${T('Episode')} ${episode + 1}` }),
        U.el('div', { style: 'display:flex;gap:var(--space-2);justify-content:center;margin-top:var(--space-4);flex-wrap:wrap;' }, [
          U.el('button', { class: 'btn btn-primary', onclick: go }, [U.svg(C.PLAY, 14), document.createTextNode(T(' Play next'))]),
          U.el('button', { class: 'btn btn-ghost', onclick: () => card.remove() }, [document.createTextNode(T('Dismiss'))])
        ]),
        autoplay ? U.el('div', { class: 'player-upnext-count' }, [countLabel]) : null
      ])
    ])
    shell.append(card)

    if (autoplay) {
      let n = 5
      const timer = setInterval(() => {
        n--
        countLabel.textContent = `${T('Autoplaying in')} ${n}…`
        if (n <= 0 || !document.body.contains(card)) { clearInterval(timer); if (document.body.contains(card)) go() }
      }, 1000)
    }
  },

  // ================= Watch Together =================

  refreshRoomBadge () {
    const badge = this._roomBadge
    if (!badge) return
    if (PageW2G.room) { badge.textContent = '● Room ' + PageW2G.room; badge.classList.remove('hidden') } else badge.classList.add('hidden')
  },

  // connect to a room and wire the current video to it (idempotent per room)
  async joinW2G (code) {
    await PageW2G.connect(code)
    this.refreshRoomBadge()
    const video = this._video
    if (!video || this._wiredRoom === code) return
    this._wiredRoom = code

    const channel = 'w2g:' + code

    /*
     * A PLAYER 2.0 SAJÁT SZINKRONJA, ha az megy.
     *
     * Nem stílus kérdése. Az alábbi régi huzalozás egy LOGIKAI ÉRTÉKKEL és egy
     * 250 ezredmásodperces időzítővel némítja a visszhangot — két egymásba érő
     * alkalmazás (egy `seek` közben érkező `pause`) az elsőt befejezve hamisra
     * állítja, és a második már kiküldi magát. Az új modul számlálót használ,
     * és az elsodródást is kezeli, nem csak a három eseményt.
     */
    if (this._player2?.party) {
      const party = this._player2.party
      // A küldés a szobacsatornára megy. Hogy a küldő vezetheti-e a
      // lejátszást, azt a SZERVER dönti el, és a vendég üzenetét
      // visszautasítja — ugyanúgy, ahogy a régi lejátszónál is. A kliens nem
      // tudja biztosan, ki a házigazda (a szoba csak megjelenített nevet ad
      // vissza), és egy találgatásból eredő hamis „nem vagy házigazda" azt
      // némítaná el, akinek vezetnie kellene.
      party.connect({ send: payload => PageW2G.send({ ...payload, channel }) })
      PageW2G.onMessage(message => party.receive(message))
      return
    }

    let applying = false
    const send = (action, position) => { if (!applying) PageW2G.send({ type: 'w2g', channel, action, position }) }
    video.addEventListener('play', () => send('play', video.currentTime))
    video.addEventListener('pause', () => send('pause', video.currentTime))
    video.addEventListener('seeked', () => send('seek', video.currentTime))

    PageW2G.onMessage(msg => {
      if (msg.type !== 'w2g' || !document.body.contains(video)) return
      applying = true
      try {
        if (msg.action === 'seek') video.currentTime = msg.position
        if (msg.action === 'play') { if (Math.abs(video.currentTime - msg.position) > 2) video.currentTime = msg.position; video.play() }
        if (msg.action === 'pause') video.pause()
      } finally {
        setTimeout(() => { applying = false }, 250)
      }
    })
  },

  // the popup itself
  async openW2G () {
    document.getElementById('w2g-modal')?.remove()
    const backdrop = U.el('div', { class: 'modal-backdrop', id: 'w2g-modal', onclick: e => { if (e.target === backdrop) backdrop.remove() } })
    const panel = U.el('div', { class: 'w2g-panel' })
    backdrop.append(panel)
    document.body.append(backdrop)

    const close = () => backdrop.remove()
    const head = U.el('div', { class: 'w2g-panel-head' }, [
      U.el('h2', { text: T('Watch Together') }),
      U.el('button', { class: 'w2g-close', text: '×', onclick: close })
    ])
    const bodyEl = U.el('div', { class: 'w2g-panel-body' })
    panel.append(head, bodyEl)

    // gate: server + account
    if (!await YumeAPI.available()) {
      bodyEl.append(U.el('p', { class: 'list-row-sub', html: `Watch Together needs the Yume server. None reachable at <code>${YumeAPI.base()}</code> — start the backend or set it in <a href="#/settings" onclick="document.getElementById('w2g-modal')?.remove()" style="text-decoration:underline">Settings</a>.` }))
      return
    }
    if (!YumeAPI.user()) {
      bodyEl.append(U.el('p', { class: 'list-row-sub', html: 'Sign in to your <a href="#/settings" onclick="document.getElementById(\'w2g-modal\')?.remove()" style="text-decoration:underline">Yume account</a> to create or join a room.' }))
      return
    }

    if (PageW2G.room) this._roomView(bodyEl, PageW2G.room, close)
    else this._lobbyView(bodyEl, close)
  },

  _lobbyView (bodyEl, close) {
    bodyEl.replaceChildren()
    // create
    const createBtn = U.el('button', {
      class: 'btn btn-primary',
      style: 'width:100%;',
      onclick: async () => {
        try {
          createBtn.disabled = true
          const room = await YumeAPI._request('/v1/w2g', { method: 'POST', auth: true, body: {} })
          await this.joinW2G(room.code)
          this._roomView(bodyEl, room.code, close)
        } catch (e) { U.toast(e.message, 'error'); createBtn.disabled = false }
      }
    }, [document.createTextNode(T('Create a room'))])

    // join
    const codeInput = U.el('input', { class: 'input', placeholder: T('Room code'), maxlength: '16', style: 'flex-grow:1;min-width:0;' })
    const joinBtn = U.el('button', {
      class: 'btn btn-secondary',
      onclick: async () => {
        const code = codeInput.value.trim().toLowerCase()
        if (!code) return
        try { await this.joinW2G(code); this._roomView(bodyEl, code, close) } catch (e) { U.toast(e.message, 'error') }
      }
    }, [document.createTextNode(T('Join'))])
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click() })

    bodyEl.append(
      U.el('p', { class: 'list-row-sub', style: 'margin:0 0 var(--space-4);', text: T('Watch this episode in sync with friends — play, pause and seeks stay together.') }),
      createBtn,
      U.el('div', { class: 'w2g-or', text: T('or') }),
      U.el('div', { style: 'display:flex;gap:var(--space-2);' }, [codeInput, joinBtn])
    )
  },

  _roomView (bodyEl, code, close) {
    bodyEl.replaceChildren()
    this.refreshRoomBadge()
    const shareUrl = location.href.includes('w2g=') ? location.href : location.href + (location.href.includes('?') ? '&' : '?') + 'w2g=' + code
    const viewers = U.el('b', { text: '…' })
    const feed = U.el('div', { class: 'w2g-feed' })

    bodyEl.append(
      U.el('div', { class: 'w2g-room-code' }, [
        U.el('span', { class: 'list-row-sub', text: T('Room code') }),
        U.el('code', { text: code })
      ]),
      U.el('p', { class: 'list-row-sub', style: 'margin:var(--space-2) 0;' }, [viewers, document.createTextNode(T(' watching now'))]),
      U.el('div', { style: 'display:flex;gap:var(--space-2);flex-wrap:wrap;margin:var(--space-2) 0;' }, [
        U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => navigator.clipboard?.writeText(code).then(() => U.toast(T('Code copied'))) }, [document.createTextNode(T('Copy code'))]),
        U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => navigator.clipboard?.writeText(shareUrl).then(() => U.toast(T('Invite link copied'))) }, [document.createTextNode(T('Copy invite link'))]),
        U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { PageW2G.disconnect(); this._wiredRoom = null; this.refreshRoomBadge(); this._lobbyView(bodyEl, close) } }, [document.createTextNode(T('Leave'))])
      ]),
      U.el('div', { class: 'detail-section-title', style: 'margin:var(--space-2) 0 var(--space-1);font-size:var(--text-xs);', text: T('Activity') }),
      feed
    )

    const log = text => { feed.append(U.el('div', { class: 'w2g-event', text })); while (feed.children.length > 8) feed.firstChild.remove() }
    log('Connected to the room')

    const off = PageW2G.onMessage(msg => {
      if (msg.type === 'presence') {
        viewers.textContent = String(msg.count)
        if (msg.joined) log(`${msg.joined} joined`)
        if (msg.left) log(`${msg.left} left`)
      }
      if (msg.type === 'w2g' && msg.action !== 'position') {
        log(`${msg.from ?? 'Someone'} ${msg.action === 'seek' ? 'seeked to ' + U.fmtTime(msg.position) : msg.action + 'd'}`)
      }
    })
    // stop the feed listener when the popup closes (sync listener stays alive)
    const mo = new MutationObserver(() => { if (!document.getElementById('w2g-modal')) { off(); mo.disconnect() } })
    mo.observe(document.body, { childList: true })
  },

  // ---- gear menu: playback speed + auto-skip toggle ----
  _openPlayerMenu (shell, video, speedBtn) {
    const menu = U.el('div', { class: 'player-menu' })
    menu.addEventListener('click', e => e.stopPropagation())

    menu.append(U.el('div', { class: 'player-menu-label', text: T('Speed') }))
    const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2]
    const speedRow = U.el('div', { class: 'player-menu-speeds' }, speeds.map(s =>
      U.el('button', {
        class: 'player-menu-speed' + (video.playbackRate === s ? ' active' : ''),
        text: s + '×',
        onclick: e => {
          video.playbackRate = s
          speedBtn.textContent = s + '×'
          speedRow.querySelectorAll('.player-menu-speed').forEach(b => b.classList.toggle('active', b === e.currentTarget))
        }
      })))
    menu.append(speedRow)

    const autoSkip = Store.settings().autoSkip ?? false
    menu.append(U.el('div', { class: 'player-menu-row' }, [
      U.el('span', { text: T('Auto-skip intro / outro') }),
      // The label wraps the input and a slider span, neither of which is text,
      // so it gave the control no name — the wording sits in a sibling span
      // outside it.
      U.el('label', { class: 'switch' }, [
        U.el('input', { type: 'checkbox', 'aria-label': T('Auto-skip intro / outro'), ...(autoSkip ? { checked: '' } : {}), onchange: e => Store.saveSettings({ autoSkip: e.target.checked }) }),
        U.el('span', { class: 'slider' })
      ])
    ]))

    shell.append(menu)
    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close) } }
    setTimeout(() => document.addEventListener('pointerdown', close), 0)
  },

  // ---- Continue Watching card under the player (live progress) ----
  _cwLast: 0,
  _updateContinueCard (currentTime, duration) {
    if (!duration || Date.now() - this._cwLast < 900) return
    this._cwLast = Date.now()
    const pct = document.getElementById('cw-pct')
    const time = document.getElementById('cw-time')
    const segs = document.getElementById('cw-segments')
    if (!pct) return
    const frac = currentTime / duration
    pct.textContent = Math.round(frac * 100) + '%'
    time.textContent = `${U.fmtTime(currentTime)} / ${U.fmtTime(duration)}`
    if (segs) {
      const kids = [...segs.children]
      kids.forEach((seg, i) => seg.classList.toggle('on', (i + 0.5) / kids.length <= frac))
    }
  },

  _skips: null,
  _lastAutoSkip: 0,

  /**
   * Opening and ending intervals for this episode.
   *
   * Ours first — `skip_segments`, which somebody here entered or corrected —
   * then api.aniskip.com for everything nobody has got to yet.
   *
   * The fallback stays because removing it would silently take the skip button
   * away from every episode with no intervals entered, which is a regression
   * dressed as a refactor.
   */
  async _loadSkips (media, episode, video, skipBtn) {
    this._skips = null

    skipBtn.addEventListener('click', () => {
      const active = this._activeSkip(video.currentTime)
      if (active) video.currentTime = active.end
    })

    const label = type => (type === 'ed' || type === 'outro' ? T('Skip outro') : T('Skip intro'))

    // ---- the catalogue's own, first ----
    const episodeId = await this._episodeId(media, episode)
    if (episodeId) {
      try {
        const own = await Catalogue.skips(episodeId)
        if (own.length) {
          this._skips = own.map(s => ({ kind: label(s.kind), start: s.start, end: s.end }))
          return
        }
      } catch (e) { /* fall through */ }
    }

    // ---- AniSkip, for the episodes nobody has entered intervals for ----
    if (!media.idMal) return
    try {
      const res = await fetch(`https://api.aniskip.com/v2/skip-times/${media.idMal}/${episode}?types[]=op&types[]=ed&episodeLength=0`)
      const json = await res.json()
      if (json.found) {
        this._skips = json.results.map(r => ({ kind: label(r.skipType), start: r.interval.startTime, end: r.interval.endTime }))
      }
    } catch (e) { /* aniskip unavailable — feature simply absent */ }
  },

  _activeSkip (time) {
    return this._skips?.find(s => time >= s.start && time < s.end - 1)
  },

  _updateSkip (skipBtn, video) {
    const active = this._activeSkip(video.currentTime)
    if (!active) { skipBtn.classList.add('hidden'); return }

    // automatic skipping (Settings › Content or the player gear menu)
    if (Store.settings().autoSkip && Date.now() - this._lastAutoSkip > 3000) {
      this._lastAutoSkip = Date.now()
      video.currentTime = active.end
      skipBtn.classList.add('hidden')
      U.toast(active.kind === 'Skip intro' ? 'Skipped opening' : 'Skipped ending')
      return
    }
    skipBtn.textContent = active.kind
    skipBtn.classList.remove('hidden')
  }
}
