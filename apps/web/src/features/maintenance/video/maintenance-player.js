/* global document */

const ICON = {
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 1 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/>'
}

const svg = (name, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name] ?? ''}</svg>`

export function formatTime (seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function prefersReducedMotion () {
  try {
    return Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    )
  } catch {
    return false
  }
}

/**
 * YUME maintenance video player.
 *
 * Ez kizárólag a maintenance oldal videójához tartozik.
 * A page.js foreground módban használja.
 */
export function createMaintenancePlayer (asset, options = {}) {
  const teardown = []

  const destroy = () => {
    while (teardown.length) {
      try {
        teardown.pop()()
      } catch {
        // cleanup
      }
    }
  }

  if (!asset?.url || options.enabled === false) {
    return {
      node: null,
      video: null,
      destroy
    }
  }

  /*
   * A maintenance page foreground playert használ.
   * Background mód nincs használva.
   */
  const video = document.createElement('video')

  video.className = 'mnt-video'
  video.playsInline = true
  video.preload = 'metadata'
  video.controls = false
  video.volume = 1

  if (asset.poster) {
    video.poster = asset.poster
  }

  const source = document.createElement('source')
  source.src = asset.url
  source.type = asset.type || 'video/mp4'

  video.append(source)

  /*
   * Player shell
   */
  const shell = document.createElement('div')

  shell.className = 'mnt-player'

  shell.setAttribute(
    'role',
    'region'
  )

  shell.setAttribute(
    'aria-label',
    'Karbantartási videó lejátszó'
  )

  /*
   * Video wrapper
   */
  const viewport = document.createElement('div')

  viewport.className = 'mnt-player-video'

  viewport.append(video)

  /*
   * Controls
   */
  const controls = document.createElement('div')

  controls.className = 'mnt-controls'

  const button = (name, label, onClick) => {
    const element = document.createElement('button')

    element.type = 'button'
    element.className = 'mnt-btn'
    element.setAttribute('aria-label', label)
    element.title = label
    element.innerHTML = svg(name)

    element.addEventListener('click', onClick)

    teardown.push(() => {
      element.removeEventListener('click', onClick)
    })

    return element
  }

  /*
   * Play / pause
   */
  const play = button(
    'play',
    'Lejátszás',
    () => {
      if (video.paused) {
        video.play().catch(() => {})
      } else {
        video.pause()
      }
    }
  )

  /*
   * Mute
   */
  const mute = button(
    'volume',
    'Némítás',
    () => {
      video.muted = !video.muted
      render()
    }
  )

  /*
   * Volume
   */
  const volume = document.createElement('input')

  volume.type = 'range'
  volume.className = 'mnt-volume'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.value = '1'
  volume.setAttribute('aria-label', 'Hangerő')

  /*
   * Seek
   */
  const seek = document.createElement('input')

  seek.type = 'range'
  seek.className = 'mnt-seek'
  seek.min = '0'
  seek.max = '1000'
  seek.step = '1'
  seek.value = '0'
  seek.setAttribute('aria-label', 'Videó pozíciója')

  /*
   * Time
   */
  const time = document.createElement('span')

  time.className = 'mnt-time'
  time.setAttribute('aria-hidden', 'true')
  time.textContent = '0:00 / 0:00'

  /*
   * Right side controls
   */
  const right = document.createElement('div')

  right.className = 'mnt-controls-right'

  /*
   * Fullscreen
   */
  const fullscreen = button(
    'fullscreen',
    'Teljes képernyő',
    async () => {
      try {
        if (document.fullscreenElement === shell) {
          await document.exitFullscreen?.()
        } else {
          await shell.requestFullscreen?.()
        }
      } catch {
        // fullscreen unsupported / denied
      }
    }
  )

  right.append(fullscreen)

  /*
   * Picture in Picture
   */
  if (
    typeof video.requestPictureInPicture === 'function' &&
    document.pictureInPictureEnabled
  ) {
    const pip = button(
      'pip',
      'Kép a képben',
      async () => {
        try {
          if (document.pictureInPictureElement === video) {
            await document.exitPictureInPicture?.()
          } else {
            await video.requestPictureInPicture()
          }
        } catch {
          // PiP unsupported / denied
        }
      }
    )

    right.append(pip)
  }

  /*
   * Status
   */
  const state = document.createElement('p')

  state.className = 'mnt-state'
  state.setAttribute('role', 'status')
  state.setAttribute('aria-live', 'polite')

  /*
   * Final layout
   */
  controls.append(
    play,
    mute,
    volume,
    seek,
    time,
    right
  )

  shell.append(
    viewport,
    controls,
    state
  )

  let scrubbing = false

  /*
   * UI render
   */
  const render = () => {
    play.innerHTML = svg(
      video.paused ? 'play' : 'pause'
    )

    play.setAttribute(
      'aria-label',
      video.paused ? 'Lejátszás' : 'Szünet'
    )

    play.title =
      video.paused ? 'Lejátszás' : 'Szünet'

    const muted =
      video.muted ||
      video.volume === 0

    mute.innerHTML = svg(
      muted ? 'muted' : 'volume'
    )

    mute.setAttribute(
      'aria-label',
      muted ? 'Némítás feloldása' : 'Némítás'
    )

    mute.title =
      muted ? 'Némítás feloldása' : 'Némítás'

    volume.value = String(video.volume)

    const duration =
      Number.isFinite(video.duration)
        ? video.duration
        : 0

    time.textContent = duration
      ? `${formatTime(video.currentTime)} / ${formatTime(duration)}`
      : `${formatTime(video.currentTime)} / 0:00`

    if (!scrubbing && duration > 0) {
      seek.value = String(
        Math.round(
          (video.currentTime / duration) * 1000
        )
      )
    }
  }

  /*
   * Event helper
   */
  const on = (target, type, handler) => {
    target.addEventListener(type, handler)

    teardown.push(() => {
      target.removeEventListener(type, handler)
    })
  }

  /*
   * Video events
   */
  on(video, 'loadedmetadata', render)
  on(video, 'durationchange', render)
  on(video, 'timeupdate', render)
  on(video, 'play', render)
  on(video, 'pause', render)
  on(video, 'volumechange', render)

  on(video, 'waiting', () => {
    state.textContent = 'Töltés…'
    shell.classList.add('mnt-player-loading')
  })

  on(video, 'canplay', () => {
    state.textContent = ''
    shell.classList.remove('mnt-player-loading')
  })

  on(video, 'playing', () => {
    state.textContent = ''
    shell.classList.remove('mnt-player-loading')
    shell.classList.remove('mnt-player-failed')
  })

  on(video, 'ended', render)

  on(video, 'error', () => {
    state.textContent = 'A videó nem játszható le.'
    shell.classList.remove('mnt-player-loading')
    shell.classList.add('mnt-player-failed')
  })

  /*
   * Seek events
   */
  on(seek, 'pointerdown', () => {
    scrubbing = true
  })

  on(seek, 'pointerup', () => {
    scrubbing = false

    const duration =
      Number.isFinite(video.duration)
        ? video.duration
        : 0

    if (duration > 0) {
      video.currentTime =
        (Number(seek.value) / 1000) * duration
    }

    render()
  })

  on(seek, 'input', () => {
    const duration =
      Number.isFinite(video.duration)
        ? video.duration
        : 0

    if (duration > 0) {
      const preview =
        (Number(seek.value) / 1000) * duration

      time.textContent =
        `${formatTime(preview)} / ${formatTime(duration)}`
    }
  })

  on(seek, 'change', () => {
    const duration =
      Number.isFinite(video.duration)
        ? video.duration
        : 0

    if (duration > 0) {
      video.currentTime =
        (Number(seek.value) / 1000) * duration
    }

    scrubbing = false
    render()
  })

  /*
   * Volume
   */
  on(volume, 'input', () => {
    video.volume = Number(volume.value)
    video.muted = video.volume === 0
    render()
  })

  /*
   * Keyboard shortcuts
   */
  on(video, 'keydown', event => {
    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault()

        if (video.paused) {
          video.play().catch(() => {})
        } else {
          video.pause()
        }

        break

      case 'ArrowLeft':
        event.preventDefault()
        video.currentTime = Math.max(
          0,
          video.currentTime - 5
        )
        break

      case 'ArrowRight':
        event.preventDefault()

        if (Number.isFinite(video.duration)) {
          video.currentTime = Math.min(
            video.duration,
            video.currentTime + 5
          )
        }

        break

      case 'm':
      case 'M':
        event.preventDefault()
        video.muted = !video.muted
        render()
        break

      case 'f':
      case 'F':
        event.preventDefault()

        if (document.fullscreenElement === shell) {
          document.exitFullscreen?.()
        } else {
          shell.requestFullscreen?.().catch(() => {})
        }

        break

      default:
        break
    }
  })

  /*
   * Cleanup
   */
  teardown.push(() => {
    try {
      video.pause()
    } catch {
      // noop
    }

    video.removeAttribute('src')

    while (video.firstChild) {
      video.firstChild.remove()
    }

    shell.remove()
  })

  render()

  return {
    node: shell,
    video,
    destroy,
    render
  }
}

export default createMaintenancePlayer
