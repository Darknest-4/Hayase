/* global document */
// A lejátszó felülete — a DOM EGYETLEN belépési pontja.
//
// Ami itt van: elemek létrehozása, feliratkozás az állapotra, és a böngésző
// azon képességei, amiknek nincs értelmük DOM nélkül (teljes képernyő, kép a
// képben). Ami NINCS itt: minden döntés. A `actions` térkép köti össze a
// gombokat a lejátszóval, és a térkép hívója dönti el, mi történjen.
//
// A RÉTEGEK SORRENDJE a `z-index` helyett a DOM sorrendje: videó, ambiens
// fény, felirat, gesztusfelület, átugrás gomb, vezérlők, menü, betöltő, hiba.
// Egy `z-index: 9999` ugyanis mindig talál magánál nagyobbat; egy DOM-sorrend
// nem.

import { createControls } from './controls.js'
import { createLoadingOverlay } from './loading-overlay.js'
import { createSeekBar } from './seek-bar.js'
import { createSettingsMenu } from './settings-menu.js'
import { createVisibility } from './controls-visibility.js'
import { attachGestures } from './gestures.js'
import { attachKeyboard } from './keyboard.js'
import { icon } from './icons.js'
import { subtitleStyle } from '../subtitles/subtitle-manager.js'

/**
 * @param {object} player a `createPlayer` eredménye
 * @param {object} actions a gombok viselkedése
 * @param {object} options `logoSrc`, `title`, `prefs`
 */
export function createPlayerUI (player, actions = {}, options = {}) {
  const { video, state, bus } = player

  const shell = document.createElement('div')
  shell.className = 'yp'
  // A lejátszó egy MEGNEVEZETT régió: egy felolvasó így meg tudja mondani,
  // hol van a néző, és a „régióra ugrás" paranccsal ide lehet jönni.
  shell.setAttribute('role', 'region')
  shell.setAttribute('aria-label', options.title ? `${options.title} — lejátszó` : 'Videólejátszó')
  shell.tabIndex = -1

  // ---- rétegek ----
  const ambient = document.createElement('canvas')
  ambient.className = 'yp-ambient'
  ambient.setAttribute('aria-hidden', 'true')

  const subtitleLayer = document.createElement('div')
  subtitleLayer.className = 'yp-subtitles'
  subtitleLayer.setAttribute('aria-hidden', 'true')  // a szöveg a `<track>`-ből jön

  const surface = document.createElement('div')
  surface.className = 'yp-surface'

  const skipButton = document.createElement('button')
  skipButton.type = 'button'
  skipButton.className = 'yp-skip yp-hidden'
  skipButton.addEventListener('click', () => actions.skipSegment?.())

  const errorLayer = document.createElement('div')
  errorLayer.className = 'yp-error yp-hidden'
  errorLayer.setAttribute('role', 'alert')

  const seekBar = createSeekBar(player, {
    onScrubbing: (active) => visibility.setPinned(active || menu.open)
  })
  const controls = createControls(player, actions, { seekBar })
  const menu = createSettingsMenu(player, actions)
  const loader = createLoadingOverlay(player, options)

  shell.append(video, ambient, subtitleLayer, surface, skipButton, controls.node, menu.node, loader.node, errorLayer)

  // ---- a vezérlők láthatósága ----
  const visibility = createVisibility({
    onChange: (visible) => {
      controls.setVisible(visible)
      shell.classList.toggle('yp-idle', !visible)
      bus.emit(visible ? 'ui:controls-show' : 'ui:controls-hide')
      state.patch({ ui: { controlsVisible: visible } })
    }
  })

  player.interval(() => visibility.tick(), 500)
  player.listen(shell, 'pointermove', () => visibility.activity('mouse'))
  player.listen(shell, 'pointerdown', () => visibility.activity('mouse'))
  // Az egér kilépésekor azonnal — a sáv a képet takarja, és ha a néző
  // elhúzta az egeret, már nem használja.
  player.listen(shell, 'pointerleave', () => visibility.hideNow())
  player.listen(shell, 'focusin', () => visibility.activity('keyboard'))

  // ---- gesztusok ----
  attachGestures(player, surface, {
    tap: () => { visibility.activity('touch') },
    doubleTap: (side) => {
      if (side === 'left') actions.seekBy?.(-10)
      else if (side === 'right') actions.seekBy?.(10)
      else actions.toggleFullscreen?.()
      visibility.activity('touch')
    },
    swipe: (gesture) => {
      if (gesture.axis === 'x') actions.seekBy?.(Math.round(gesture.delta / 6))
      else if (gesture.side === 'right') actions.setVolume?.(state.get().playback.volume + gesture.delta / 300)
      visibility.activity('touch')
    },
    longPressStart: () => actions.setRate?.(2),
    longPressEnd: () => actions.setRate?.(options.prefs?.get('player.playback.rate') ?? 1)
  })

  // Egérrel a felület kattintása lejátszás/szünet — érintésen a koppintás a
  // vezérlőket hozza elő, ezért ott NEM. A `pointerType` mondja meg, melyik.
  player.listen(surface, 'click', (event) => {
    if (event.pointerType === 'touch') return
    actions.togglePlay?.()
  })
  player.listen(surface, 'dblclick', () => actions.toggleFullscreen?.())

  // ---- billentyűzet ----
  attachKeyboard(player, {
    ...actions,
    'toggle-play': actions.togglePlay,
    'seek-by': actions.seekBy,
    'seek-percent': (percent) => actions.seekToPercent?.(percent),
    'volume-by': (delta) => actions.setVolume?.(state.get().playback.volume + delta),
    'toggle-mute': actions.toggleMute,
    'toggle-fullscreen': actions.toggleFullscreen,
    'toggle-cinema': actions.toggleCinema,
    'toggle-pip': actions.togglePip,
    'toggle-subtitles': actions.toggleSubtitles,
    'skip-segment': actions.skipSegment,
    'next-episode': actions.nextEpisode,
    'previous-episode': actions.previousEpisode,
    'rate-by': (direction) => actions.stepRate?.(direction),
    'frame-step': (direction) => actions.frameStep?.(direction),
    'show-shortcuts': () => actions.showShortcuts?.(),
    escape: () => {
      // Az Escape SORRENDBEN bont: előbb a menü, aztán a teljes képernyő.
      // Fordítva a menü nyitva maradna egy ablakos lejátszó fölött.
      if (menu.open) { menu.close(); visibility.setPinned(false); return }
      if (state.get().ui.fullscreen) actions.toggleFullscreen?.()
    }
  }, shell)

  // A menü nyitva tartja a vezérlőket. Enélkül a menü a semmi fölött lebegne,
  // miután a sáv alatta eltűnt.
  const wrapMenu = (fn) => (...args) => { const open = fn.apply(menu, args); visibility.setPinned(open); return open }
  menu.show = wrapMenu(menu.show)
  menu.close = wrapMenu(menu.close)

  // ---- állapotból következő megjelenés ----
  const render = (current) => {
    shell.classList.toggle('yp-playing', current.playback.playing)
    shell.classList.toggle('yp-fullscreen', current.ui.fullscreen)
    shell.classList.toggle('yp-cinema', current.ui.cinema)
    shell.classList.toggle('yp-pip', current.ui.pip)
    shell.classList.toggle('yp-mini', current.ui.miniPlayer)
    visibility.setPaused(!current.playback.playing)

    const segment = current.ui.skipSegment
    skipButton.classList.toggle('yp-hidden', !segment)
    if (segment) {
      const label = segment.kind === 'outro' ? 'Stáblista átugrása' : 'Intró átugrása'
      skipButton.textContent = label
      skipButton.setAttribute('aria-label', label)
    }

    if (current.error) {
      errorLayer.classList.remove('yp-hidden')
      errorLayer.innerHTML =
        `<div class="yp-error-box">${icon('warning', 28)}` +
        `<p class="yp-error-text"></p>` +
        '<div class="yp-error-actions"></div></div>'
      errorLayer.querySelector('.yp-error-text').textContent = current.error.message ?? 'Ismeretlen hiba'
      const buttons = errorLayer.querySelector('.yp-error-actions')
      if (current.error.retryable !== false) {
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'yp-btn-text'
        retry.textContent = 'Újra'
        retry.addEventListener('click', () => actions.retry?.())
        buttons.append(retry)
      }
    } else {
      errorLayer.classList.add('yp-hidden')
    }
  }

  render(state.get())
  player.own(state.subscribe(render))

  // ---- a felirat megjelenése ----
  const applySubtitleStyle = (prefs) => {
    for (const [name, value] of Object.entries(subtitleStyle(prefs))) shell.style.setProperty(name, value)
  }
  applySubtitleStyle(options.prefs?.all?.() ?? {})

  // ---- teljes képernyő és kép a képben ----
  // A `fullscreenchange` az IGAZSÁG, nem a saját kapcsolónk: az Escape, az F11
  // és a rendszer gesztusa is kiléptet, és a saját nyilvántartás ilyenkor
  // hazudna. Ezért az állapotot MINDIG az esemény írja.
  const doc = shell.ownerDocument ?? globalThis.document
  player.listen(doc, 'fullscreenchange', () => {
    state.patch({ ui: { fullscreen: doc.fullscreenElement === shell } })
  })
  player.listen(video, 'enterpictureinpicture', () => state.patch({ ui: { pip: true } }))
  player.listen(video, 'leavepictureinpicture', () => state.patch({ ui: { pip: false } }))

  player.own(() => shell.remove())

  return {
    node: shell,
    surface,
    subtitleLayer,
    ambient,
    controls,
    menu,
    seekBar,
    loader,
    visibility,
    applySubtitleStyle,
    /** Teljes képernyő be/ki. Ígéretet ad vissza — a böngésző elutasíthatja. */
    async toggleFullscreen () {
      if (doc.fullscreenElement === shell) return doc.exitFullscreen?.()
      // Az `iOS` `<video>`-ja nem tud elemet teljes képernyőre tenni, csak
      // saját magát — és akkor a mi vezérlőink eltűnnek, helyettük a rendszeré
      // jön. Ez nem hiba, hanem az egyetlen lehetőség azon a rendszeren.
      if (typeof shell.requestFullscreen === 'function') return shell.requestFullscreen()
      if (typeof video.webkitEnterFullscreen === 'function') return video.webkitEnterFullscreen()
      return undefined
    },
    async togglePip () {
      if (doc.pictureInPictureElement === video) return doc.exitPictureInPicture?.()
      if (typeof video.requestPictureInPicture === 'function') return video.requestPictureInPicture()
      return undefined
    }
  }
}
