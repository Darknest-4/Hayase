/* global API, C, MutationObserver, PageW2G, Store, U, YumeAPI, document, location, window */
// Watch page — modern embedded player. Progress is tracked automatically:
// the exact second you reached is saved per profile and resumed next time,
// history is logged the moment you start, and the episode is marked watched
// at 85%. Under the player: prev/next, an auto-save hint, and a Watch
// Together button that opens a sync-room popup. An "up next" end-card offers
// (auto)play of the following episode.

const PageWatch = {
  async render (root, params, arg) {
    // route: #/watch/{animeId}:{episode}?src=<encoded-url>[&w2g=code]
    const [idPart, epPart] = (arg ?? '').split(':')
    const animeId = Number(idPart)
    const episode = Math.max(1, Number(epPart) || 1)
    const src = params.get('src')
    const w2gCode = params.get('w2g') ?? window.sessionStorage.getItem('w2g-pending')

    if (!animeId) {
      root.append(U.el('div', { class: 'error-state', text: 'Invalid watch link.' }))
      return
    }

    root.append(U.el('div', { class: 'spinner' }))
    let media
    try {
      media = await API.media(animeId)
    } catch (e) {
      root.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load anime: ' + e.message }))
      return
    }
    root.replaceChildren()
    U.setBanner(null)

    const total = media.episodes ?? (media.nextAiringEpisode ? media.nextAiringEpisode.episode - 1 : episode)
    this._media = media
    this._episode = episode
    this._total = total

    const pad = U.el('div', { class: 'page-pad watch-page' })
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
    const side = U.el('aside', { class: 'watch-side' })
    pad.append(U.el('div', { class: 'watch-layout' }, [left, side]))
    const col = left // content below the player goes here

    // ---- player box (or source picker inside the same frame) ----
    const playerBox = U.el('div', { class: 'player-box' })
    col.append(playerBox)

    if (src) {
      this.mountPlayer(playerBox, media, episode, total, decodeURIComponent(src), w2gCode)
    } else {
      this._video = null
      this.mountSourcePicker(playerBox, media, episode)
    }

    // ---- actions row under the player ----
    const watched = (Store.entry(media.id)?.progress ?? 0) >= episode
    const markBtn = U.el('button', {
      class: 'btn btn-sm ' + (watched ? 'btn-theme' : 'btn-secondary'),
      onclick: () => {
        const progress = Store.entry(media.id)?.progress ?? 0
        Store.setProgress(media, watched && progress === episode ? episode - 1 : episode)
        U.toast(watched ? `Episode ${episode} unmarked` : `Episode ${episode} marked as watched`)
        window.App.navigate()
      }
    }, [U.svg(C.CHECK, 13), document.createTextNode(watched ? 'Watched' : 'Mark watched')])

    const keepSrc = src ? `?src=${encodeURIComponent(decodeURIComponent(src))}` : ''
    col.append(U.el('div', { class: 'watch-actions' }, [
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode <= 1 ? ' hidden' : ''),
        href: `#/watch/${media.id}:${episode - 1}`
      }, [document.createTextNode('‹ Previous')]),
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode >= total ? ' hidden' : ''),
        href: `#/watch/${media.id}:${episode + 1}`
      }, [document.createTextNode('Next ›')]),
      // Watch Together — opens the sync-room popup (feature-flagged)
      (!window.App || window.App.featureOn('watch_together'))
        ? U.el('button', {
          class: 'btn btn-secondary btn-sm w2g-open',
          onclick: () => this.openW2G()
        }, [U.svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 13), document.createTextNode('Watch Together')])
        : null,
      U.el('div', { style: 'flex-grow:1;' }),
      markBtn,
      src ? U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Change source')]) : null
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
            document.createTextNode('Continue Watching')
          ]),
          U.el('div', { class: 'cw-right' }, [
            U.el('span', { class: 'cw-right-label', text: 'Your progress' }),
            U.el('b', { id: 'cw-pct', text: Math.round(frac * 100) + '%' })
          ])
        ]),
        U.el('div', { class: 'cw-sub' }, [
          U.el('span', { text: 'Automatically saved. You’ll resume right where you left off.' }),
          U.el('span', { id: 'cw-time', class: 'cw-time', text: resume ? `${U.fmtTime(resume)} / ${U.fmtTime(estTotal)}` : '' })
        ]),
        U.el('div', { class: 'cw-segments', id: 'cw-segments' },
          Array.from({ length: 18 }, (_, i) => U.el('div', { class: 'cw-seg' + ((i + 0.5) / 18 <= frac ? ' on' : '') })))
      ]))
    }

    // ---- episode sidebar: rich vertical list, current highlighted ----
    if (total > 1) this.mountEpisodeList(side, media, episode, total, keepSrc)

    // ---- episode metadata: title + meta chips + expandable summary ----
    API.episodes(media).then(list => {
      const ep = list.find(e => e.episode === episode) ?? list[episode - 1]
      if (!ep || (!ep.title && !ep.summary)) return

      const metaChip = (icon, text) => U.el('span', { class: 'epmeta-chip' }, [U.svg(icon, 13), document.createTextNode(text)])
      const chips = U.el('div', { class: 'epmeta-row' })
      if (ep.airdate) chips.append(metaChip('<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>', U.airDate(ep.airdate)))
      if (ep.runtime || media.duration) chips.append(metaChip('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', `${ep.runtime ?? media.duration} min`))
      if (media.format) chips.append(metaChip('<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>', U.format(media)))
      if (media.isAdult) chips.append(U.el('span', { class: 'epmeta-badge', text: '18+' }))
      if (ep.filler) chips.append(U.el('span', { class: 'epmeta-badge filler', text: 'Filler' }))

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
          }, [document.createTextNode('Show more ⌄')])
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
        U.el('h3', { text: 'Episodes' }),
        U.el('span', { class: 'wep-count', text: `${total}` })
      ])
    ])
    const list = U.el('div', { class: 'wep-list' })
    panel.append(list)
    side.append(panel)

    const progress = Store.entry(media.id)?.progress ?? 0

    const renderRows = meta => {
      const byNum = meta ? new Map(meta.map(e => [e.episode, e])) : null
      list.replaceChildren()
      for (let n = 1; n <= total; n++) {
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

    renderRows(null)
    API.episodes(media).then(meta => { if (meta?.length) renderRows(meta) }).catch(() => {})
  },

  /**
   * Build the candidate list for this episode and hand it to the engine.
   *
   * Candidates come from the URL(s) the user picked plus every extension the
   * sandbox currently has loaded. The engine ranks them and tries each in turn;
   * a failure only reaches the user once nothing is left.
   */
  async startPlayback (video, media, episode, src, giveUp) {
    const engine = window.StreamEngine
    const manual = String(src ?? '')
      .split('\n').map(u => u.trim()).filter(Boolean)
      .map(url => ({ url, title: 'Manual source', source: { slug: 'manual', name: 'Manual URL', accuracy: 'low', health: 'unknown' } }))

    if (!engine) { // engine unavailable → behave like the old direct player
      if (manual[0]) { video.src = manual[0].url; video.load() }
      return
    }

    // only extensions that are actually loaded in the sandbox can be asked
    const loaded = (window.ExtensionHost?.loaded?.() ?? []).map(slug => ({ slug }))
    const { results, errors } = await engine.candidates(media, episode, { sources: manual, extensions: loaded })
    for (const error of errors) console.warn('[stream] extension failed:', error)

    if (!results.length) { giveUp('No sources were offered for this episode.'); return }

    try {
      const { candidate } = await engine.play(video, results, {
        onFallback: (failed, reason) => {
          console.warn('[stream] falling back from', failed.source.slug, '—', reason)
          U.toast(`Source failed (${failed.source.name}) — trying the next one`, 'error')
        }
      })
      this._activeCandidate = candidate
      if (candidate.source.slug !== 'manual') U.toast(`Playing from ${candidate.source.name}`)
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
      placeholder: 'https://… direct video stream (mp4 / webm) — one per line to enable automatic fallback'
    })
    const play = () => {
      const urls = input.value.split('\n').map(u => u.trim()).filter(Boolean)
      if (!urls.length) return U.toast('Paste a stream URL first', 'error')
      window.location.hash = `#/watch/${media.id}:${episode}?src=${encodeURIComponent(urls.join('\n'))}`
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') play() })

    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')

    box.append(U.el('div', { class: 'player-pick' }, [
      U.el('div', { class: 'player-pick-inner' }, [
        U.el('h3', { style: 'margin:0 0 .35rem;font-weight:800;', text: 'Pick a source' }),
        U.el('p', { style: 'margin:0 0 .9rem;color:var(--fg-faint);font-size:.85rem;', text: 'Paste a direct stream URL. Add more on separate lines and the player falls back automatically if one fails. Installed extensions supply sources here too.' }),
        U.el('div', { style: 'display:flex;gap:.6rem;' }, [input, U.el('button', { class: 'btn btn-primary', onclick: play }, [document.createTextNode('Play')])]),
        streams.length
          ? U.el('div', { style: 'margin-top:1rem;' }, [
            U.el('div', { style: 'font-size:.75rem;font-weight:800;color:var(--fg-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem;', text: 'Official streams' }),
            U.el('div', { class: 'badges' }, streams.map(link =>
              U.el('a', { class: 'badge badge-theme', href: link.url, target: '_blank', rel: 'noopener', text: link.site })))
          ])
          : null
      ])
    ]))
  },

  // ---- the embedded player ----

  mountPlayer (box, media, episode, total, src, w2gCode = null) {
    const video = U.el('video', { class: 'player-video', autoplay: '', playsinline: '' })
    this._video = video

    const PLAY_ICON = '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>'
    const PAUSE_ICON = '<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>'

    const playBtn = U.el('button', { class: 'player-btn player-play', 'aria-label': 'Play/Pause' })
    const timeLabel = U.el('span', { class: 'player-time', text: '0:00 / 0:00' })
    const seekFill = U.el('div', { class: 'player-seek-fill' }, [U.el('div', { class: 'player-seek-thumb' })])
    const seekBuffer = U.el('div', { class: 'player-seek-buffer' })
    const seekBar = U.el('div', { class: 'player-seek' }, [seekBuffer, seekFill])
    const volSlider = U.el('input', { class: 'player-volume', type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' })
    const muteBtn = U.el('button', { class: 'player-btn', 'aria-label': 'Mute' })
    muteBtn.append(U.svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>', 18))
    const speedBtn = U.el('button', { class: 'player-btn player-speed', text: '1×', 'aria-label': 'Playback speed' })
    const pipBtn = U.el('button', { class: 'player-btn', 'aria-label': 'Picture in picture', title: 'Picture in picture' })
    pipBtn.append(U.svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>', 18))
    const fsBtn = U.el('button', { class: 'player-btn', 'aria-label': 'Fullscreen', title: 'Fullscreen' })
    fsBtn.append(U.svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>', 18))
    const skipBtn = U.el('button', { class: 'btn btn-primary btn-sm player-skip hidden', text: 'Skip intro' })

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

    // ---- Yume loader (Netflix-style intro + buffering spinner) ----
    const loader = U.el('div', { class: 'player-loader' }, [
      U.el('div', { class: 'player-loader-ring' }),
      U.svg('<path d="M23.5 4.5A13 13 0 1 0 27.5 21 10.5 10.5 0 0 1 23.5 4.5Z" fill="currentColor" stroke="none"/>', 34)
    ])
    loader.querySelector('svg').setAttribute('viewBox', '0 0 32 32')
    const mountedAt = Date.now()
    const MIN_LOADER = 1100 // always show the branded loader at start, like Netflix
    const hideLoader = () => {
      const wait = Math.max(0, MIN_LOADER - (Date.now() - mountedAt))
      setTimeout(() => loader.classList.add('hidden'), wait)
    }
    video.addEventListener('playing', hideLoader)
    video.addEventListener('waiting', () => loader.classList.remove('hidden'))

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
          U.el('p', { style: 'color:var(--danger);font-weight:700;', text: 'Could not play this episode from any available source.' }),
          detail ? U.el('p', { style: 'color:var(--fg-faint);font-size:.85rem;margin:.3rem 0 .9rem;', text: detail }) : null,
          U.el('a', { class: 'btn btn-secondary btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Pick another source')])
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

    // --- automatic tracking: history on first play, watched at 85% ---
    let historyLogged = false
    let completedFired = false
    const save = () => { if (video.currentTime > 5) Store.setResume(media.id, episode, video.currentTime) }

    video.addEventListener('timeupdate', () => {
      const { currentTime, duration } = video
      timeLabel.textContent = `${U.fmtTime(currentTime)} / ${U.fmtTime(duration)}`
      if (duration) seekFill.style.width = (currentTime / duration * 100) + '%'
      if (video.buffered.length && duration) {
        seekBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / duration * 100) + '%'
      }
      if (!historyLogged && currentTime > 3) {
        historyLogged = true
        Store.recordHistory(media, episode)
      }
      if (!completedFired && duration && currentTime / duration >= 0.85) {
        completedFired = true
        Store.setProgress(media, episode)
        U.toast(`Episode ${episode} marked as watched`)
      }
      this._updateSkip(skipBtn, video)
      this._updateContinueCard(currentTime, duration)
    })
    video.addEventListener('pause', save)

    // finished → clear resume, show the up-next end card
    video.addEventListener('ended', () => {
      Store.clearResume(media.id, episode)
      if (!completedFired) { Store.setProgress(media, episode); completedFired = true }
      if (episode < total) this._showUpNext(shell, media, episode, total)
    })

    // persist position periodically; teardown when the node leaves the DOM
    const saveTimer = setInterval(() => { if (!video.paused) save() }, 5000)
    const observer = new MutationObserver(() => {
      if (!document.body.contains(shell)) {
        save()
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
      else video.requestPictureInPicture?.().catch(() => U.toast('Picture-in-picture unavailable', 'error'))
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
    const autoplay = Store.settings().autoplay !== false
    const go = () => { window.location.hash = `#/watch/${media.id}:${episode + 1}` }

    const countLabel = U.el('span', { text: autoplay ? 'Autoplaying in 5…' : '' })
    const card = U.el('div', { class: 'player-upnext' }, [
      U.el('div', { class: 'player-upnext-inner' }, [
        U.el('div', { class: 'player-upnext-label', text: 'Up next' }),
        U.el('div', { class: 'player-upnext-title', text: `Episode ${episode + 1}` }),
        U.el('div', { style: 'display:flex;gap:.6rem;justify-content:center;margin-top:1rem;flex-wrap:wrap;' }, [
          U.el('button', { class: 'btn btn-primary', onclick: go }, [U.svg(C.PLAY, 14), document.createTextNode(' Play next')]),
          U.el('button', { class: 'btn btn-ghost', onclick: () => card.remove() }, [document.createTextNode('Dismiss')])
        ]),
        autoplay ? U.el('div', { class: 'player-upnext-count' }, [countLabel]) : null
      ])
    ])
    shell.append(card)

    if (autoplay) {
      let n = 5
      const timer = setInterval(() => {
        n--
        countLabel.textContent = `Autoplaying in ${n}…`
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

    let applying = false
    const channel = 'w2g:' + code
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
      U.el('h3', { text: 'Watch Together' }),
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
    }, [document.createTextNode('Create a room')])

    // join
    const codeInput = U.el('input', { class: 'input', placeholder: 'Room code', maxlength: '16', style: 'flex-grow:1;min-width:0;' })
    const joinBtn = U.el('button', {
      class: 'btn btn-secondary',
      onclick: async () => {
        const code = codeInput.value.trim().toLowerCase()
        if (!code) return
        try { await this.joinW2G(code); this._roomView(bodyEl, code, close) } catch (e) { U.toast(e.message, 'error') }
      }
    }, [document.createTextNode('Join')])
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click() })

    bodyEl.append(
      U.el('p', { class: 'list-row-sub', style: 'margin:0 0 1rem;', text: 'Watch this episode in sync with friends — play, pause and seeks stay together.' }),
      createBtn,
      U.el('div', { class: 'w2g-or', text: 'or' }),
      U.el('div', { style: 'display:flex;gap:.5rem;' }, [codeInput, joinBtn])
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
        U.el('span', { class: 'list-row-sub', text: 'Room code' }),
        U.el('code', { text: code })
      ]),
      U.el('p', { class: 'list-row-sub', style: 'margin:.4rem 0;' }, [viewers, document.createTextNode(' watching now')]),
      U.el('div', { style: 'display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0;' }, [
        U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => navigator.clipboard?.writeText(code).then(() => U.toast('Code copied')) }, [document.createTextNode('Copy code')]),
        U.el('button', { class: 'btn btn-secondary btn-sm', onclick: () => navigator.clipboard?.writeText(shareUrl).then(() => U.toast('Invite link copied')) }, [document.createTextNode('Copy invite link')]),
        U.el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { PageW2G.disconnect(); this._wiredRoom = null; this.refreshRoomBadge(); this._lobbyView(bodyEl, close) } }, [document.createTextNode('Leave')])
      ]),
      U.el('div', { class: 'detail-section-title', style: 'margin:.6rem 0 .3rem;font-size:.8rem;', text: 'Activity' }),
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

    menu.append(U.el('div', { class: 'player-menu-label', text: 'Speed' }))
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
      U.el('span', { text: 'Auto-skip intro / outro' }),
      U.el('label', { class: 'switch' }, [
        U.el('input', { type: 'checkbox', ...(autoSkip ? { checked: '' } : {}), onchange: e => Store.saveSettings({ autoSkip: e.target.checked }) }),
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

  async _loadSkips (media, episode, video, skipBtn) {
    this._skips = null
    if (!media.idMal) return
    try {
      const res = await fetch(`https://api.aniskip.com/v2/skip-times/${media.idMal}/${episode}?types[]=op&types[]=ed&episodeLength=0`)
      const json = await res.json()
      if (json.found) {
        this._skips = json.results.map(r => ({ kind: r.skipType === 'op' ? 'Skip intro' : 'Skip outro', start: r.interval.startTime, end: r.interval.endTime }))
      }
    } catch (e) { /* aniskip unavailable — feature simply absent */ }

    skipBtn.addEventListener('click', () => {
      const active = this._activeSkip(video.currentTime)
      if (active) video.currentTime = active.end
    })
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

window.PageWatch = PageWatch
