/* global window, document, localStorage, U, C, API, Store */
// Watch page — classic anime-site layout: embedded 16:9 player up top,
// prev/next + actions under it, numbered episode picker, episode info and
// comments below. The player keeps custom controls, keyboard shortcuts,
// AniSkip intro/outro skipping, resume positions, auto progress tracking
// and Watch Together sync.

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
      U.el('div', { style: 'flex-grow:1;' }),
      markBtn,
      src ? U.el('a', { class: 'btn btn-ghost btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Change source')]) : null
    ]))

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
      const anchor = pad.querySelector('.ep-grid') ?? pad.querySelector('.watch-actions')
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
    const posKey = `watchpos:${media.id}:${episode}`

    const video = U.el('video', { class: 'player-video', src, autoplay: '', playsinline: '' })

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

    const shell = U.el('div', { class: 'player-shell' }, [video, skipBtn, controls])
    box.append(shell)

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

    // resume position
    const saved = Number(localStorage.getItem(posKey)) || 0
    video.addEventListener('loadedmetadata', () => {
      if (saved > 5 && saved < video.duration - 10) video.currentTime = saved
    })

    // time + seek + buffered + auto watched at 85%
    let completedFired = false
    video.addEventListener('timeupdate', () => {
      const { currentTime, duration } = video
      timeLabel.textContent = `${U.fmtTime(currentTime)} / ${U.fmtTime(duration)}`
      if (duration) seekFill.style.width = (currentTime / duration * 100) + '%'
      if (video.buffered.length && duration) {
        seekBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / duration * 100) + '%'
      }
      if (!completedFired && duration && currentTime / duration >= 0.85) {
        completedFired = true
        Store.setProgress(media, episode)
        U.toast(`Episode ${episode} marked as watched`)
      }
      this._updateSkip(skipBtn, video)
    })

    // persist position; teardown when the page node leaves the DOM
    const saveTimer = setInterval(() => {
      if (!video.paused && video.currentTime > 5) localStorage.setItem(posKey, String(video.currentTime))
    }, 5000)
    const observer = new MutationObserver(() => {
      if (!document.body.contains(shell)) {
        clearInterval(saveTimer)
        observer.disconnect()
        document.removeEventListener('keydown', keys)
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
    if (w2gCode) this._wireW2G(box, video, w2gCode)
  },

  async _wireW2G (box, video, code) {
    /* global PageW2G */
    const badge = U.el('span', { class: 'badge badge-theme w2g-badge', text: '● syncing…' })
    box.before(badge)

    try {
      await PageW2G.connect(code)
    } catch (e) {
      badge.textContent = '● sync failed'
      U.toast('Watch Together: ' + e.message, 'error')
      return
    }
    badge.textContent = '● room ' + code

    let applying = false
    const channel = 'w2g:' + code
    const send = (action, position) => {
      if (!applying) PageW2G.send({ type: 'w2g', channel, action, position })
    }

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
