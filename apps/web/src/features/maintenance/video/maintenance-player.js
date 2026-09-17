/* global document */
// A karbantartási videó lejátszója — a 16., 17., 18. és 19. pont.
//
// KÜLÖNVÁLASZTVA az anime-lejátszótól, és ez szándékos. Ide nem kell
// forrásfelderítés, epizódrendszer, előzmény, közös nézés, forrásváltás — egy
// fájl megy, egy helyről. Ami viszont KELL, az a saját YUME felület: egy
// csupasz `<video controls>` idegen test lenne a lapon.
//
// A lejátszó a Player 2.0 ELVEIT követi (állapot az igazság, a felület csak
// megjelenít, minden figyelő takarítva), de nem a kódját: ez húsz sornyi
// dolog, nem egy platform.
//
// KÉT MEGJELENÉSI MÓD (17. pont):
//
//   * HÁTTÉR — némán, ismételve, vezérlők nélkül. Ez a díszlet;
//   * ELŐTÉR — a karbantartási kártyában, vezérlőkkel. Ezt a néző indítja.
//
// AMIT NEM CSINÁLUNK: nem kerüljük meg a böngésző automatikus indítási
// szabályát. Ha nemet mond, megjelenik a poszter és egy lejátszás gomb — és
// ez nem hiba, hanem a platform szabálya.

const ICON = {
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/>'
}

const svg = (name, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
  `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`

/** Másodperc → `1:23`. */
export function formatTime (seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Kéri-e a rendszer a mozgás mérséklését. */
export function prefersReducedMotion () {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
  } catch {
    return false
  }
}

/**
 * @param {object} asset `{ url, type, poster }`
 * @param {object} options `mode` ('foreground' | 'background'), `enabled`
 * @returns {{node: HTMLElement|null, video: HTMLVideoElement|null, destroy: function}}
 */
export function createMaintenancePlayer (asset, options = {}) {
  const teardown = []
  const destroy = () => { while (teardown.length) { try { teardown.pop()() } catch { /* lebontás */ } } }

  // NINCS VIDEÓ — és ez nem hiba. A 18. pont tartaléka: állókép, vagy semmi.
  if (!asset?.url || options.enabled === false) return { node: null, video: null, destroy }

  const background = options.mode === 'background'

  // MOZGÁSMENTES MÓDBAN a háttérvideó teljesen elmarad (19. pont): egy
  // hurokban futó mozgókép pont az, amitől valakinek rosszul lehet. Az
  // előtérben maradhat, mert azt a néző indítja el.
  if (background && prefersReducedMotion()) return { node: null, video: null, destroy }

  const video = document.createElement('video')
  video.className = background ? 'mnt-video-bg' : 'mnt-video'
  video.playsInline = true
  video.preload = 'metadata'
  if (asset.poster) video.poster = asset.poster
  if (background) {
    video.muted = true
    video.loop = true
    video.autoplay = true
    video.setAttribute('aria-hidden', 'true')
    video.tabIndex = -1
  }

  const source = document.createElement('source')
  source.src = asset.url
  source.type = asset.type ?? 'video/mp4'
  video.append(source)

  if (background) {
    // A háttérnek nincs felülete. Ha a böngésző nem indítja el, a poszter
    // marad — és a lap ugyanúgy teljes.
    teardown.push(() => { video.remove() })
    return { node: video, video, destroy }
  }

  // ---- előtér: saját vezérlők ----
  const shell = document.createElement('div')
  shell.className = 'mnt-player'
  shell.setAttribute('role', 'region')
  shell.setAttribute('aria-label', 'Karbantartási videó')

  const controls = document.createElement('div')
  controls.className = 'mnt-controls'

  const button = (name, label, onClick) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'mnt-btn'
    node.setAttribute('aria-label', label)
    node.title = label
    node.innerHTML = svg(name)
    node.addEventListener('click', onClick)
    return node
  }

  const play = button('play', 'Lejátszás', () => {
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  })
  const mute = button('volume', 'Némítás', () => { video.muted = !video.muted; render() })

  const seek = document.createElement('input')
  seek.type = 'range'
  seek.className = 'mnt-seek'
  seek.min = '0'
  seek.max = '1000'
  seek.value = '0'
  seek.setAttribute('aria-label', 'Videó pozíciója')

  const volume = document.createElement('input')
  volume.type = 'range'
  volume.className = 'mnt-volume'
  volume.min = '0'
  volume.max = '1'
  volume.step = '0.05'
  volume.value = '1'
  volume.setAttribute('aria-label', 'Hangerő')

  const time = document.createElement('span')
  time.className = 'mnt-time'
  time.setAttribute('aria-hidden', 'true')

  const state = document.createElement('p')
  state.className = 'mnt-state'
  state.setAttribute('role', 'status')

  const right = document.createElement('div')
  right.className = 'mnt-controls-right'

  const fullscreen = button('fullscreen', 'Teljes képernyő', () => {
    if (document.fullscreenElement === shell) document.exitFullscreen?.()
    else shell.requestFullscreen?.().catch(() => {})
  })
  right.append(fullscreen)

  // A kép a képben CSAK ha a böngésző tudja. Egy tétlen gomb rosszabb, mint
  // egy hiányzó.
  if (typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
    right.append(button('pip', 'Kép a képben', () => {
      if (document.pictureInPictureElement === video) document.exitPictureInPicture?.()
      else video.requestPictureInPicture().catch(() => {})
    }))
  }

  controls.append(play, mute, volume, seek, time, right)
  shell.append(video, controls, state)

  let scrubbing = false

  const render = () => {
    play.innerHTML = svg(video.paused ? 'play' : 'pause')
    play.setAttribute('aria-label', video.paused ? 'Lejátszás' : 'Szünet')
    mute.innerHTML = svg(video.muted || video.volume === 0 ? 'muted' : 'volume')
    mute.setAttribute('aria-label', video.muted ? 'Némítás feloldása' : 'Némítás')
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    time.textContent = duration ? `${formatTime(video.currentTime)} / ${formatTime(duration)}` : '—'
    // FOGÁS KÖZBEN NEM RAJZOLUNK: az ujj alól ugrana el a csúszka.
    if (!scrubbing && duration) seek.value = String(Math.round((video.currentTime / duration) * 1000))
  }

  const on = (target, type, handler) => {
    target.addEventListener(type, handler)
    teardown.push(() => target.removeEventListener(type, handler))
  }

  on(video, 'loadedmetadata', render)
  on(video, 'timeupdate', render)
  on(video, 'play', render)
  on(video, 'pause', render)
  on(video, 'volumechange', render)
  on(video, 'waiting', () => { state.textContent = 'Töltés…' })
  on(video, 'playing', () => { state.textContent = '' })
  on(video, 'error', () => {
    // HIBAÁLLAPOT. A videó elhasalt — a karbantartási oldal viszont nem: a
    // lejátszó eltűnik, a mondanivaló marad.
    state.textContent = 'A videó nem játszható le.'
    shell.classList.add('mnt-player-failed')
  })

  on(seek, 'pointerdown', () => { scrubbing = true })
  on(seek, 'pointerup', () => {
    scrubbing = false
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration) video.currentTime = (Number(seek.value) / 1000) * duration
  })
  on(seek, 'change', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration) video.currentTime = (Number(seek.value) / 1000) * duration
  })
  on(volume, 'input', () => { video.volume = Number(volume.value); video.muted = Number(volume.value) === 0 })

  render()
  teardown.push(() => { try { video.pause() } catch { /* már eldobva */ } shell.remove() })

  return { node: shell, video, destroy, render }
}
