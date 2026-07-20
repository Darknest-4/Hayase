/* global window, document, sessionStorage, U, C, API, Store, YumeAPI, PageW2G */
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

    // ---- player box (or source picker inside the same frame) ----
    const playerBox = U.el('div', { class: 'player-box' })
    pad.append(playerBox)

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
    pad.append(U.el('div', { class: 'watch-actions' }, [
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode <= 1 ? ' hidden' : ''),
        href: `#/watch/${media.id}:${episode - 1}`
      }, [document.createTextNode('‹ Previous')]),
      U.el('a', {
        class: 'btn btn-secondary btn-sm' + (episode >= total ? ' hidden' : ''),
        href: `#/watch/${media.id}:${episode + 1}`
      }, [document.createTextNode('Next ›')]),
      // Watch Together — opens the sync-room popup
      U.el('button', {
        class: 'btn btn-secondary btn-sm w2g-open',
        onclick: () => this.openW2G()
      }, [U.svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 13), document.createTextNode('Watch Together')]),
      U.el('div', { style: 'flex-grow:1;' }),
      markBtn,
      src ? U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Change source')]) : null
    ]))

    // auto-save hint
    if (src) {
      pad.append(U.el('div', { class: 'watch-autosave' }, [
        U.svg('<path d="M20 6 9 17l-5-5"/>', 12),
        document.createTextNode('Progress saves automatically — you’ll resume right where you left off.')
      ]))
    }

    // ---- numbered episode picker ----
    if (total > 1) {
      const progress = Store.entry(media.id)?.progress ?? 0
      const grid = U.el('div', { class: 'ep-grid' })
      for (let n = 1; n <= total; n++) {
        grid.append(U.el('a', {
          class: 'ep-num-btn' + (n === episode ? ' active' : '') + (n <= progress ? ' watched' : ''),
          href: `#/watch/${media.id}:${n}${n === episode ? keepSrc : ''}`,
          text: String(n)
        }))
      }
      pad.append(U.el('h2', { class: 'detail-section-title', text: 'Episodes' }), grid)
    }

    // ---- episode metadata (title/summary/air date) ----
    API.episodes(media).then(list => {
      const ep = list[episode - 1]
      if (!ep || (!ep.title && !ep.summary)) return
      const info = U.el('div', { class: 'watch-ep-info' }, [
        U.el('div', { class: 'episode-title', style: '-webkit-line-clamp:2;', text: `${episode}. ${ep.title ?? 'Episode ' + episode}` }),
        ep.airdate ? U.el('div', { class: 'episode-meta', text: U.airDate(ep.airdate) + (ep.filler ? ' • FILLER' : '') }) : null,
        ep.summary ? U.el('div', { class: 'watch-ep-summary', text: ep.summary }) : null
      ])
      const anchor = pad.querySelector('.ep-grid') ?? pad.querySelector('.watch-autosave') ?? pad.querySelector('.watch-actions')
      anchor.after(info)
    }).catch(() => {})

    // ---- comments ----
    pad.append(C.commentsSection(media))
  },

  // ---- source picker inside the player frame ----

  mountSourcePicker (box, media, episode) {
    const input = U.el('input', {
      class: 'input',
      type: 'url',
      style: 'width:100%;',
      placeholder: 'https://… direct video stream (mp4 / webm)'
    })
    const play = () => {
      const url = input.value.trim()
      if (!url) return U.toast('Paste a stream URL first', 'error')
      window.location.hash = `#/watch/${media.id}:${episode}?src=${encodeURIComponent(url)}`
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') play() })

    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')

    box.append(U.el('div', { class: 'player-pick' }, [
      U.el('div', { class: 'player-pick-inner' }, [
        U.el('h3', { style: 'margin:0 0 .35rem;font-weight:800;', text: 'Pick a source' }),
        U.el('p', { style: 'margin:0 0 .9rem;color:var(--fg-faint);font-size:.85rem;', text: 'Paste a direct stream URL — extensions and the desktop client fill this automatically from torrent sources.' }),
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
    const video = U.el('video', { class: 'player-video', src, autoplay: '', playsinline: '' })
    this._video = video

    const playBtn = U.el('button', { class: 'player-btn player-play', 'aria-label': 'Play/Pause' })
    const timeLabel = U.el('span', { class: 'player-time', text: '0:00 / 0:00' })
    const seekFill = U.el('div', { class: 'player-seek-fill' })
    const seekBuffer = U.el('div', { class: 'player-seek-buffer' })
    const seekBar = U.el('div', { class: 'player-seek' }, [seekBuffer, seekFill])
    const volSlider = U.el('input', { class: 'player-volume', type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' })
    const muteBtn = U.el('button', { class: 'player-btn', 'aria-label': 'Mute', text: '🔊' })
    const speedBtn = U.el('button', { class: 'player-btn player-speed', text: '1×', 'aria-label': 'Playback speed' })
    const pipBtn = U.el('button', { class: 'player-btn', text: '⧉', 'aria-label': 'Picture in picture', title: 'Picture in picture' })
    const fsBtn = U.el('button', { class: 'player-btn', text: '⛶', 'aria-label': 'Fullscreen', title: 'Fullscreen' })
    const skipBtn = U.el('button', { class: 'btn btn-primary btn-sm player-skip hidden', text: 'Skip intro' })

    const controls = U.el('div', { class: 'player-controls' }, [
      seekBar,
      U.el('div', { class: 'player-controls-row' }, [
        playBtn, timeLabel,
        U.el('div', { style: 'flex-grow:1;' }),
        muteBtn, volSlider, speedBtn, pipBtn, fsBtn
      ])
    ])

    // W2G room badge (shown when a room is active)
    const roomBadge = U.el('button', { class: 'player-room-badge hidden', onclick: () => this.openW2G() })

    const shell = U.el('div', { class: 'player-shell' }, [video, roomBadge, skipBtn, controls])
    box.append(shell)
    this._roomBadge = roomBadge
    this._shell = shell
    this.refreshRoomBadge()

    // --- state wiring ---
    const setPlayIcon = () => { playBtn.textContent = video.paused ? '▶' : '❚❚' }
    setPlayIcon()
    const togglePlay = () => { video.paused ? video.play() : video.pause() }
    playBtn.addEventListener('click', togglePlay)
    video.addEventListener('click', togglePlay)
    video.addEventListener('play', setPlayIcon)
    video.addEventListener('pause', setPlayIcon)

    video.addEventListener('error', () => {
      shell.replaceChildren(U.el('div', { class: 'player-pick' }, [
        U.el('div', { class: 'player-pick-inner', style: 'text-align:center;' }, [
          U.el('p', { style: 'color:var(--danger);font-weight:700;', text: 'Could not play this stream — offline, region-locked or unsupported codec.' }),
          U.el('a', { class: 'btn btn-secondary btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Pick another source')])
        ])
      ]))
    })

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
    if (PageW2G.room) { badge.textContent = '● Room ' + PageW2G.room; badge.classList.remove('hidden') }
    else badge.classList.add('hidden')
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
      class: 'btn btn-primary', style: 'width:100%;',
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

  _skips: null,

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
    if (active) {
      skipBtn.textContent = active.kind
      skipBtn.classList.remove('hidden')
    } else {
      skipBtn.classList.add('hidden')
    }
  }
}

window.PageWatch = PageWatch
