// Az ÖSSZESZERELÉS.
//
// Eddig minden modul külön élt, és ez szándékos volt: a mag nem tud a DOM-ról,
// a felület nem tud a forrásokról, a beállítások nem tudnak a hálózatról. Ez a
// fájl az egyetlen, ami MINDEGYIKET ismeri — és ezért ez az egyetlen, ami egy
// résznyi videóból működő lejátszót csinál.
//
// Itt sincs üzleti döntés. Ami itt van, az huzalozás: melyik modul melyik
// másiknak szól. Ahol mégis dönteni kell (melyik minőség, melyik felirat), a
// döntést a megfelelő modul hozza, és ez a fájl csak megkérdezi.

import { createPlayer } from '../core/player.js'
import { createPlaybackController } from '../playback/playback-controller.js'
import { createPlayerUI } from '../ui/player-ui.js'
import { createLoadingPhase } from '../playback/loading-phase.js'
import { createProgressTracker } from '../playback/progress.js'
import { createResume } from '../playback/resume.js'
import { createSkipManager } from '../skip/skip-manager.js'
import { createWatchParty } from '../party/watch-party.js'
import { createAmbientLight } from '../ambient/ambient-light.js'
import { createMediaSession } from '../integration/media-session.js'
import { createMiniPlayer } from '../mini/mini-player.js'
import { createDebugOverlay } from '../debug/debug-overlay.js'
import { createTelemetry } from '../telemetry/player-telemetry.js'
import { createSourceManager } from '../engine/source-manager.js'
import { chooseQuality, availableQualities } from '../quality/quality-manager.js'
import { selectTrack } from '../subtitles/subtitle-manager.js'
import { loadSubtitleTrack } from '../subtitles/subtitle-loader.js'
import { createPlayerPreferences } from '../preferences/player-preferences.js'
import { createFlagEvaluator } from '../flags/player-feature-flags.js'
import { EV } from '../core/player-events.js'
import { SHORTCUT_HELP } from '../ui/keyboard.js'
import { LOADING_PHASE } from '../core/player-state.js'

/**
 * Egy rész lejátszója.
 *
 * @param {object} options
 *   `video` — a videóelem; `sources` — a jelöltek; `episode` — a rész adatai;
 *   `media` — a cím adatai (logó, név); `prefs` — a beállítástár;
 *   `skipSegments` — az átugorható szakaszok; `subtitles` — a feliratsávok;
 *   `onProgress`, `onCompleted`, `onNextEpisode` — a lap felé menő jelzések.
 * @returns {{node: HTMLElement, player: object, destroy: function}}
 */
export function createEpisodePlayer (options = {}) {
  const video = options.video
  if (!video) throw new Error('createEpisodePlayer: videóelem kell')

  const player = createPlayer({ video, logger: options.logger })
  const prefs = createPlayerPreferences(options.prefs)
  const flags = createFlagEvaluator({ prefs, featureOn: options.featureOn })
  const playback = createPlaybackController(player, { prefs })

  // ---- a hálózat, amiről a minőség dönt ----
  const network = () => {
    const connection = globalThis.navigator?.connection
    if (!connection) return {}
    return {
      type: connection.type === 'cellular' ? 'cellular' : connection.type === 'wifi' ? 'wifi' : connection.type,
      saveData: connection.saveData === true
    }
  }

  let manualQuality = null

  const applyQuality = () => {
    const available = availableQualities(options.sources ?? [])
    const chosen = chooseQuality({ available, prefs: prefs.all(), network: network(), manual: manualQuality })
    player.state.patch({ quality: { available, current: chosen.quality ?? 'auto', auto: chosen.auto } })
    return chosen
  }

  // ---- a betöltőképernyő fázisa ----
  // A videóelem saját eseményeiből. Enélkül a `setPhase`-t senki nem hívta, és
  // a betöltő soha nem tűnt el — a videó ment alatta, láthatatlanul.
  const loading = createLoadingPhase(player)

  // ---- források ----
  const sources = createSourceManager(player, { prefs: prefs.all(), timeoutMs: options.timeoutMs })
  sources.load(options.sources ?? [], prefs.all())

  // ---- felirat ----
  const applySubtitles = () => {
    const tracks = options.subtitles ?? []
    const enabled = prefs.get('player.subtitle.enabled') !== false && tracks.length > 0
    const chosen = selectTrack(tracks, { language: prefs.get('player.subtitle.language'), enabled })
    player.state.patch({ subtitles: { tracks, enabled: !!chosen, current: chosen } })
    // A `<track>` DEFAULT NÉLKÜL LETILTVA töltődik be. A sáv ott van a
    // DOM-ban, és láthatatlan marad — ez a régi lejátszó egyik valódi hibája
    // volt. A `mode` az, ami tényleg kapcsol.
    for (const track of video.textTracks ?? []) {
      track.mode = chosen && track.language === (chosen.language ?? chosen.lang) ? 'showing' : 'disabled'
    }
    if (chosen) void attachTrack(chosen)
    return chosen
  }

  /** A már felcsatolt sávok, cím szerint — egy sávot ne töltsünk le kétszer. */
  const attached = new Map()

  /**
   * A választott sáv felcsatolása a videóra.
   *
   * A böngésző `<track>`-je CSAK WebVTT-t ért; az `.srt` némán nem jelenik
   * meg. A betöltő ezért beolvassa és átalakítja — és ha ez nem megy, a
   * felirat marad kikapcsolva, de a KÉP MEGY TOVÁBB. Egy hiányzó felirat nem
   * ok arra, hogy a rész ne induljon el.
   */
  async function attachTrack (chosen) {
    if (!chosen?.url || attached.has(chosen.url)) return
    try {
      const loaded = await loadSubtitleTrack({ ...chosen, delayMs: prefs.get('player.subtitle.delayMs') })
      if (!loaded) return
      attached.set(chosen.url, loaded)
      player.own(loaded.revoke)

      const element = video.ownerDocument.createElement('track')
      element.kind = 'subtitles'
      element.srclang = chosen.language ?? chosen.lang ?? ''
      element.label = chosen.label ?? chosen.language ?? 'Felirat'
      element.src = loaded.url
      element.default = true
      video.append(element)
      // A `default` attribútum csak a KEZDETI állapotot adja meg; egy már
      // betöltött videóhoz utólag hozzáadott sávot a `mode` kapcsol be.
      if (element.track) element.track.mode = 'showing'
    } catch (error) {
      player.logger?.warn?.('a felirat nem tölthető be:', error.message)
      player.state.patch({ subtitles: { enabled: false } })
    }
  }

  // ---- átugrás, haladás, folytatás ----
  const skip = createSkipManager(player, { prefs })
  skip.load(options.skipSegments ?? [])

  const progress = createProgressTracker(player, {
    onProgress: options.onProgress,
    onCompleted: options.onCompleted
  })
  const resume = createResume(player, { store: options.store, key: options.resumeKey })

  // A FOLYTATÁS a metaadat megérkezése után dől el: a hossz nélkül nem lehet
  // megmondani, hogy a tárolt pozíció a legvégén van-e — és a legvégére
  // visszaugrani rosszabb, mint elölről kezdeni.
  player.own(player.bus.on(EV.DURATION, () => {
    if (resume.apply()) progress.restore(resume.saved())
  }))

  // ---- felület ----
  const actions = {
    togglePlay: () => playback.toggle(),
    seekBy: seconds => playback.seekBy(seconds),
    seekToPercent: percent => {
      const duration = player.state.get().playback.duration
      if (duration) playback.seekTo((percent / 100) * duration)
    },
    setVolume: value => playback.setVolume(value),
    toggleMute: () => playback.toggleMute(),
    setRate: value => playback.setRate(value),
    stepRate: direction => playback.stepRate(direction),
    frameStep: direction => {
      // Képkocka-léptetés CSAK SZÜNETBEN. Menet közben a videó úgyis halad,
      // és a lépés egy alig észrevehető rándulás lenne.
      if (player.state.get().playback.playing) return
      playback.seekBy(direction * (1 / 24))
    },
    toggleSubtitles: () => {
      const enabled = !player.state.get().subtitles.enabled
      prefs.set('player.subtitle.enabled', enabled)
      applySubtitles()
    },
    selectSubtitle: track => {
      prefs.set('player.subtitle.enabled', !!track)
      if (track?.language) prefs.set('player.subtitle.language', track.language)
      applySubtitles()
    },
    selectQuality: value => {
      manualQuality = value === 'auto' ? null : value
      const chosen = applyQuality()
      if (!chosen.quality) return
      // A forráskezelő AZONOSÍTÓRA vált, nem felbontásra: több jelölt is
      // lehet ugyanazon a felbontáson, és közülük a rangsor dönt — ugyanaz a
      // rangsor, ami az első indításnál is.
      const match = (options.sources ?? []).find(candidate => Number(candidate.quality) === chosen.quality)
      if (match) sources.switchTo(match.id)
    },
    selectRate: value => { playback.setRate(value); prefs.set('player.rate', value) },
    selectAudio: track => {
      player.state.patch({ audio: { current: track } })
      for (const audio of video.audioTracks ?? []) audio.enabled = audio.id === track?.id
    },
    skipSegment: () => skip.skip(),
    retry: () => { player.state.patch({ error: null }); sources.start() },
    nextEpisode: () => options.onNextEpisode?.(),
    previousEpisode: () => options.onPreviousEpisode?.(),
    toggleFullscreen: () => ui.toggleFullscreen(),
    togglePip: () => ui.togglePip(),
    toggleCinema: () => {
      const cinema = !player.state.get().ui.cinema
      player.state.patch({ ui: { cinema } })
      prefs.set('player.ui.cinema', cinema)
      options.onCinema?.(cinema)
    },
    openSettings: panel => ui.menu.show(panel ?? 'root'),
    openSubtitleStyle: () => options.onSubtitleStyle?.(),
    showShortcuts: () => options.onShortcuts?.(SHORTCUT_HELP)
  }

  const ui = createPlayerUI(player, actions, {
    logoSrc: options.media?.logoImage ?? null,
    title: options.media?.title ?? null,
    prefs
  })

  // ---- huzalozás ----
  applyQuality()
  applySubtitles()
  player.state.patch({
    episode: {
      current: options.episode ?? null,
      next: options.nextEpisode ?? null,
      previous: options.previousEpisode ?? null
    }
  })
  ui.seekBar.setMarkers(skip.segments.map(segment => ({
    start: segment.start, kind: segment.kind,
    label: segment.kind === 'outro' ? 'Stáblista' : 'Intró'
  })))

  // A rész VÉGE nem ugyanaz, mint a „lejátszás vége": a stáblista után jön a
  // következő rész, de csak akkor, ha a néző ezt kérte. Automatikus továbblépés
  // kikapcsolva ne történjen semmi — a videó maradjon a végén.
  player.own(player.bus.on(EV.ENDED, () => {
    loading.set(LOADING_PHASE.READY)
    if (prefs.get('player.autoplayNext') === true) options.onNextEpisode?.()
  }))

  // A forrás kimerülése a lejátszó legvégső hibája: itt már nincs mit
  // megpróbálni, és ezt meg kell mondani, nem pörögni tovább.
  player.own(player.bus.on(EV.SOURCES_EXHAUSTED, () => {
    player.state.patch({
      error: { message: 'Ezt a részt egyik elérhető forrásból sem sikerült lejátszani.', retryable: true }
    })
  }))

  // ---- közös nézés ----
  // Mindig létrejön, de CSATLAKOZÁS NÉLKÜL néma: se nem küld, se nem fogad.
  // Így a nézőoldalnak nem kell két útvonalat vezetnie aszerint, hogy van-e
  // szoba — csak `join()`-ol, amikor lesz.
  const partyOptions = options.party ?? {}
  const party = createWatchParty(player, {
    send: partyOptions.send ?? (() => {}),
    canBroadcast: partyOptions.canBroadcast,
    onEpisode: number => options.onEpisodeChange?.(number)
  })

  // ---- környezeti fény ----
  // Csak ha a kapcsoló és a néző is engedi. Kikapcsolva egyetlen képkockát
  // sem másolunk — a modul létrejön, de nem indul el.
  const ambient = createAmbientLight(player, ui.ambient, {
    prefs,
    enabled: flags.isOn('player.ambient'),
    // A borító, a bannerkép vagy a logó — ebben a sorrendben. Ami van.
    imageSrc: options.media?.coverImage ?? options.media?.bannerImage ?? options.media?.logoImage ?? null
  })

  // ---- kislejátszó ----
  const mini = createMiniPlayer(player, ui.node, { prefs })
  actions.toggleMini = () => (flags.isOn('player.mini_player') ? mini.toggle() : false)

  // ---- zárolt képernyő ----
  const mediaSession = flags.isOn('player.media_session')
    ? createMediaSession(player, {
      title: options.media?.title ?? null,
      artwork: options.media?.coverImage ? [{ src: options.media.coverImage }] : [],
      onNext: options.onNextEpisode ? () => options.onNextEpisode() : undefined,
      onPrevious: options.onPreviousEpisode ? () => options.onPreviousEpisode() : undefined
    })
    : { supported: false, update () {} }

  // ---- fejlesztői réteg ----
  // A kapcsoló nélkül LÉTRE SEM JÖN: egy rejtett, de fél másodpercenként
  // frissülő táblázat ugyanúgy dolgozik, mint egy látható.
  const debug = flags.isOn('player.debug') ? createDebugOverlay(player) : null
  if (debug) {
    ui.node.append(debug.node)
    actions.toggleDebug = () => debug.toggle()
  }

  // ---- telemetria ----
  // Küldőfüggvény nélkül NÉMA: összegyűjt, de nem küld sehova.
  const telemetry = createTelemetry(player, { send: options.onTelemetry })

  sources.start()

  return {
    node: ui.node,
    player,
    party,
    loading,
    ambient,
    mini,
    mediaSession,
    debug,
    telemetry,
    ui,
    prefs,
    flags,
    sources,
    skip,
    destroy () {
      // A `true` KIKÉNYSZERÍTI a mentést: a rendes ütemezés eldobná, ha az
      // előző mentés óta kevés idő telt el, és pont a bezáráskor elveszett
      // utolsó néhány másodperc az, amit a néző észrevesz.
      progress.save(true)
      resume.remember(player.state.get().playback.currentTime, {
        duration: player.state.get().playback.duration
      })
      player.destroy()
    }
  }
}
