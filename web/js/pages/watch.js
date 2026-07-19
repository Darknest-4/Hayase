/* global window, document, U, API, Store */
// Watch page — full player UI: custom controls, keyboard shortcuts,
// skip-intro/outro (AniSkip), resume positions and automatic progress
// tracking. Plays any direct stream URL (extension/webseed/own file);
// official external streams are linked out when AniList knows them.

const PageWatch = {
  async render (root, params, arg) {
    // route: #/watch/{animeId}/{episode}?src=<encoded-url>
    const [idPart, epPart] = (arg ?? '').split(':')
    const animeId = Number(idPart)
    const episode = Math.max(1, Number(epPart) || 1)
    const src = params.get('src')

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

    if (!src) {
      this.renderSourcePicker(root, media, episode)
      return
    }

    this.renderPlayer(root, media, episode, total, decodeURIComponent(src))
  },

  // ---- source picker: shown when no stream URL was passed ----

  renderSourcePicker (root, media, episode) {
    const pad = U.el('div', { class: 'page-pad', style: 'max-width:52rem;' })
    root.append(pad)

    pad.append(
      U.el('a', { class: 'player-back', href: `#/anime/${media.id}`, text: '‹ ' + U.title(media) }),
      U.el('h1', { class: 'page-title', text: `Episode ${episode}` })
    )

    // direct stream URL (what an extension / webseed / own server provides)
    const input = U.el('input', {
      class: 'input',
      type: 'url',
      style: 'flex-grow:1;min-width:0;',
      placeholder: 'https://… direct video stream (mp4 / webm / HLS-mp4)'
    })
    const play = () => {
      const url = input.value.trim()
      if (!url) return U.toast('Paste a stream URL first', 'error')
      window.location.hash = `#/watch/${media.id}:${episode}?src=${encodeURIComponent(url)}`
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') play() })

    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'Play a stream' }),
      U.el('p', { text: 'Paste a direct video URL — from an extension source, a webseed, or your own server. The desktop client fills this automatically from torrent sources.' }),
      U.el('div', { style: 'display:flex;gap:.6rem;' }, [
        input,
        U.el('button', { class: 'btn btn-primary', onclick: play }, [document.createTextNode('Play')])
      ])
    ]))

    const streams = (media.externalLinks ?? []).filter(l => l.type === 'STREAMING')
    if (streams.length) {
      pad.append(U.el('div', { class: 'setting-card' }, [
        U.el('h3', { text: 'Official streams' }),
        U.el('p', { text: 'Watch this episode on a licensed service.' }),
        U.el('div', { class: 'badges' }, streams.map(link =>
          U.el('a', { class: 'badge badge-theme', href: link.url, target: '_blank', rel: 'noopener', text: link.site })))
      ]))
    }

    pad.append(U.el('div', { class: 'setting-card' }, [
      U.el('h3', { text: 'Already watched elsewhere?' }),
      U.el('p', { text: 'Mark the episode watched to keep your progress in sync.' }),
      U.el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: () => {
          Store.setProgress(media, episode)
          U.toast(`Episode ${episode} marked as watched`)
          window.location.hash = `#/anime/${media.id}`
        }
      }, [document.createTextNode(`Mark episode ${episode} watched`)])
    ]))
  },

  // ---- the actual player ----

  renderPlayer (root, media, episode, total, src) {
    const posKey = `watchpos:${media.id}:${episode}`

    const video = U.el('video', { class: 'player-video', src, autoplay: '', playsinline: '' })

    // --- control elements ---
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

    const fmt = s => {
      if (!isFinite(s)) return '0:00'
      const h = Math.floor(s / 3600); const m = Math.floor(s % 3600 / 60); const sec = Math.floor(s % 60)
      return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0')
    }

    // --- header / navigation ---
    const prevBtn = U.el('a', {
      class: 'btn btn-ghost btn-sm' + (episode <= 1 ? ' hidden' : ''),
      href: `#/watch/${media.id}:${episode - 1}`,
      text: '‹ Ep ' + (episode - 1)
    })
    const nextBtn = U.el('a', {
      class: 'btn btn-ghost btn-sm' + (episode >= total ? ' hidden' : ''),
      href: `#/watch/${media.id}:${episode + 1}`,
      text: 'Ep ' + (episode + 1) + ' ›'
    })

    const controls = U.el('div', { class: 'player-controls' }, [
      seekBar,
      U.el('div', { class: 'player-controls-row' }, [
        playBtn, timeLabel,
        U.el('div', { style: 'flex-grow:1;' }),
        muteBtn, volSlider, speedBtn, pipBtn, fsBtn
      ])
    ])

    const shell = U.el('div', { class: 'player-shell' }, [
      video,
      U.el('div', { class: 'player-top' }, [
        U.el('a', { class: 'player-back', href: `#/anime/${media.id}`, text: '‹ ' + U.title(media) }),
        U.el('span', { class: 'player-ep-label', text: `Episode ${episode}${total ? ' / ' + total : ''}` }),
        U.el('div', { style: 'flex-grow:1;' }),
        prevBtn, nextBtn
      ]),
      skipBtn,
      controls
    ])
    root.append(shell)

    // --- state wiring ---
    const setPlayIcon = () => { playBtn.textContent = video.paused ? '▶' : '❚❚' }
    setPlayIcon()

    const togglePlay = () => { video.paused ? video.play() : video.pause() }
    playBtn.addEventListener('click', togglePlay)
    video.addEventListener('click', togglePlay)
    video.addEventListener('play', setPlayIcon)
    video.addEventListener('pause', setPlayIcon)

    video.addEventListener('error', () => {
      shell.replaceChildren(U.el('div', { class: 'error-state', style: 'margin:auto;', html:
        `Could not play this stream. The URL may be offline, region-locked or an unsupported codec.<br><br>` }),
      U.el('div', { style: 'text-align:center;' }, [
        U.el('a', { class: 'btn btn-secondary btn-sm', href: `#/watch/${media.id}:${episode}` }, [document.createTextNode('Pick another source')])
      ]))
    })

    // resume position
    const saved = Number(localStorage.getItem(posKey)) || 0
    video.addEventListener('loadedmetadata', () => {
      if (saved > 5 && saved < video.duration - 10) video.currentTime = saved
    })

    // time + seek + buffered
    let completedFired = false
    video.addEventListener('timeupdate', () => {
      const { currentTime, duration } = video
      timeLabel.textContent = `${fmt(currentTime)} / ${fmt(duration)}`
      if (duration) seekFill.style.width = (currentTime / duration * 100) + '%'
      if (video.buffered.length && duration) {
        seekBuffer.style.width = (video.buffered.end(video.buffered.length - 1) / duration * 100) + '%'
      }
      // 85% → progress tracked, same threshold as the backend
      if (!completedFired && duration && currentTime / duration >= 0.85) {
        completedFired = true
        Store.setProgress(media, episode)
        U.toast(`Episode ${episode} marked as watched`)
      }
      this._updateSkip(skipBtn, video)
    })

    // persist position every 5s while playing
    const saveTimer = setInterval(() => {
      if (!video.paused && video.currentTime > 5) localStorage.setItem(posKey, String(video.currentTime))
    }, 5000)
    // cleared when the page node is removed (hash navigation replaces content)
    const observer = new MutationObserver(() => {
      if (!document.body.contains(shell)) {
        clearInterval(saveTimer)
        observer.disconnect()
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    })
    observer.observe(root.parentElement ?? document.body, { childList: true, subtree: true })

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

    // volume / mute
    volSlider.addEventListener('input', () => {
      video.volume = Number(volSlider.value)
      video.muted = video.volume === 0
      muteBtn.textContent = video.muted ? '🔇' : '🔊'
    })
    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted
      muteBtn.textContent = video.muted ? '🔇' : '🔊'
    })

    // speed cycle
    const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
    speedBtn.addEventListener('click', () => {
      const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length]
      video.playbackRate = next
      speedBtn.textContent = next + '×'
    })

    // PiP / fullscreen
    pipBtn.addEventListener('click', () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture()
      else video.requestPictureInPicture?.().catch(() => U.toast('Picture-in-picture unavailable', 'error'))
    })
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen()
      else shell.requestFullscreen?.()
    })

    // keyboard shortcuts (active while the player is on screen)
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
    observer.observe(document.body, { childList: true, subtree: true })

    // auto-hide controls
    let hideTimer
    const poke = () => {
      shell.classList.remove('player-idle')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => { if (!video.paused) shell.classList.add('player-idle') }, 2800)
    }
    shell.addEventListener('pointermove', poke)
    poke()

    // skip segments via AniSkip (community intro/outro data, by MAL id)
    this._loadSkips(media, episode, video, skipBtn)
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
