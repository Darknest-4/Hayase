/* global document */
// A vezérlősáv.
//
// Csak DOM és feliratkozás: MINDEN döntés máshol születik. Ha egy gomb
// megnyomása itt számolna ki valamit, az a számítás csak kattintással lenne
// tesztelhető — a lejátszó minden logikája ezért kívül van.

import { formatRate, formatTime, ratioFromPointer } from './format.js'
import { icon } from './icons.js'

function button (name, label, onClick, extraClass = '') {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = `yp-btn ${extraClass}`.trim()
  // Ikonos gomb szöveg nélkül: az `aria-label` az EGYETLEN, amiből egy
  // felolvasó megmondja, mit csinál. Enélkül „gomb, gomb, gomb" hangzik el.
  node.setAttribute('aria-label', label)
  node.title = label
  node.innerHTML = icon(name)
  node.addEventListener('click', onClick)
  return node
}

/**
 * @param {object} player
 * @param {object} actions `togglePlay`, `seekBy`, `setVolume`, `toggleMute`,
 *   `toggleSubtitles`, `openSettings`, `togglePip`, `toggleCinema`,
 *   `toggleFullscreen`, `nextEpisode`, `previousEpisode`
 */
export function createControls (player, actions = {}, options = {}) {
  const { state } = player
  const call = name => () => actions[name]?.()

  const node = document.createElement('div')
  node.className = 'yp-controls'

  const seek = options.seekBar
  const row = document.createElement('div')
  row.className = 'yp-controls-row'

  const play = button('play', 'Lejátszás', call('togglePlay'), 'yp-btn-play')
  const back = button('back10', '10 másodperc vissza', () => actions.seekBy?.(-10))
  const forward = button('forward10', '10 másodperc előre', () => actions.seekBy?.(10))
  const previous = button('previous', 'Előző rész', call('previousEpisode'))
  const next = button('next', 'Következő rész', call('nextEpisode'))

  // ---- hangerő ----
  const mute = button('volume', 'Némítás', call('toggleMute'))
  const volume = document.createElement('div')
  volume.className = 'yp-volume'
  volume.setAttribute('role', 'slider')
  volume.setAttribute('tabindex', '0')
  volume.setAttribute('aria-label', 'Hangerő')
  volume.setAttribute('aria-valuemin', '0')
  volume.setAttribute('aria-valuemax', '100')
  volume.innerHTML = '<div class="yp-volume-rail"><div class="yp-volume-fill"></div></div>'
  const volumeFill = volume.querySelector('.yp-volume-fill')

  let volumeDragging = false
  const applyVolume = (clientX) => actions.setVolume?.(ratioFromPointer(clientX, volume.getBoundingClientRect()))
  player.listen(volume, 'pointerdown', (event) => { volumeDragging = true; applyVolume(event.clientX); volume.setPointerCapture?.(event.pointerId) })
  player.listen(volume.ownerDocument ?? globalThis.document, 'pointermove', (event) => { if (volumeDragging) applyVolume(event.clientX) })
  player.listen(volume.ownerDocument ?? globalThis.document, 'pointerup', () => { volumeDragging = false })
  player.listen(volume, 'keydown', (event) => {
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowUp: 0.05 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    actions.setVolume?.(state.get().playback.volume + step)
  })

  // ---- idő ----
  const time = document.createElement('div')
  time.className = 'yp-time'
  // A `time` felolvasva zajos lenne: másodpercenként változik, és egy
  // felolvasó minden változást bemondana. A pozíciót a tekerősáv közli.
  time.setAttribute('aria-hidden', 'true')

  // ---- jobb oldal ----
  const rate = document.createElement('button')
  rate.type = 'button'
  rate.className = 'yp-btn yp-btn-rate'
  rate.setAttribute('aria-label', 'Lejátszási sebesség')
  rate.addEventListener('click', () => actions.openSettings?.('rate'))

  const subtitles = button('subtitles', 'Felirat', call('toggleSubtitles'), 'yp-btn-sub')
  const settings = button('settings', 'Beállítások', () => actions.openSettings?.(), 'yp-btn-settings')
  const pip = button('pip', 'Kép a képben', call('togglePip'))
  const cinema = button('cinema', 'Mozi mód', call('toggleCinema'))
  const fullscreen = button('fullscreen', 'Teljes képernyő', call('toggleFullscreen'), 'yp-btn-fs')

  const left = document.createElement('div')
  left.className = 'yp-controls-left'
  left.append(previous, back, play, forward, next, mute, volume, time)

  const right = document.createElement('div')
  right.className = 'yp-controls-right'
  right.append(rate, subtitles, settings, pip, cinema, fullscreen)

  row.append(left, right)
  if (seek?.node) node.append(seek.node)
  node.append(row)

  const render = (current) => {
    const { playing, currentTime, duration, volume: level, muted, rate: speed } = current.playback

    play.innerHTML = icon(playing ? 'pause' : 'play', 26)
    const playLabel = playing ? 'Szünet' : 'Lejátszás'
    play.setAttribute('aria-label', playLabel)
    play.title = playLabel

    time.textContent = duration
      ? `${formatTime(currentTime)} / ${formatTime(duration)}`
      : formatTime(currentTime)

    const effective = muted ? 0 : level
    mute.innerHTML = icon(effective === 0 ? 'muted' : effective < 0.5 ? 'volumeLow' : 'volume')
    mute.setAttribute('aria-label', muted ? 'Némítás feloldása' : 'Némítás')
    volumeFill.style.width = `${effective * 100}%`
    volume.setAttribute('aria-valuenow', String(Math.round(effective * 100)))

    rate.textContent = formatRate(speed)
    // A nem egyszeres sebesség KIEMELVE. Ez a leggyakoribb „miért beszél
    // ilyen furcsán" ok, és a néző nem tudja, hogy ő állította el.
    rate.classList.toggle('yp-on', speed !== 1)

    subtitles.classList.toggle('yp-on', current.subtitles.enabled)
    subtitles.setAttribute('aria-pressed', String(current.subtitles.enabled))
    // Felirat nélküli résznél a gomb LÁTSZIK, de tiltott — eltüntetve a néző
    // azt hinné, a lejátszó nem tud feliratot.
    subtitles.disabled = current.subtitles.tracks.length === 0
    subtitles.title = subtitles.disabled ? 'Ehhez a részhez nincs felirat' : 'Felirat'

    fullscreen.innerHTML = icon(current.ui.fullscreen ? 'exitFullscreen' : 'fullscreen')
    fullscreen.setAttribute('aria-label', current.ui.fullscreen ? 'Kilépés a teljes képernyőből' : 'Teljes képernyő')
    pip.classList.toggle('yp-on', current.ui.pip)
    cinema.classList.toggle('yp-on', current.ui.cinema)

    previous.disabled = !current.episode.previous
    next.disabled = !current.episode.next
  }

  render(state.get())
  player.own(state.subscribe(render))

  return {
    node,
    setVisible (visible) {
      node.classList.toggle('yp-hidden', !visible)
      // A REJTETT VEZÉRLŐK NEM FÓKUSZÁLHATÓK. Enélkül a Tab végigmegy a nem
      // látszó gombokon, és a fókusz eltűnik a képernyőről.
      node.setAttribute('aria-hidden', String(!visible))
      for (const control of node.querySelectorAll('button, [tabindex]')) {
        if (visible) {
          // VISSZA az eredetire, nem törölve. A tekerősáv és a hangerő
          // `tabindex="0"`-val fókuszálható; ha az elrejtés után törölnénk,
          // örökre kiesnének a Tab sorrendjéből — egy `<div role="slider">`
          // alapból nem fókuszálható.
          const original = control.dataset.ypTabindex
          // A `nincs` külön érték, nem üres szöveg: egy `tabindex=""` nem
          // ugyanaz, mint a hiányzó attribútum — érvénytelen, és a gombot
          // több böngészőben kiveszi a Tab sorrendjéből.
          if (original === undefined || original === 'nincs') control.removeAttribute('tabindex')
          else control.setAttribute('tabindex', original)
        } else {
          if (control.dataset.ypTabindex === undefined) {
            control.dataset.ypTabindex = control.getAttribute('tabindex') ?? 'nincs'
          }
          control.setAttribute('tabindex', '-1')
        }
      }
    },
    get buttons () { return { play, mute, subtitles, settings, fullscreen, pip, cinema, next, previous, rate } }
  }
}
