// A videóelem EGYETLEN gazdája.
//
// A mai lejátszóban a hangerő-csúszka közvetlenül írja a `video.volume`-ot, a
// billentyűkezelő is, a közös nézés is, és a mozdulatkezelő is. Négy hely,
// négyféle mellékhatás, és a „mekkora most a hangerő" kérdésre a `video` meg a
// csúszka külön válaszol.
//
// Itt a `video`-hoz CSAK ez a modul nyúl. Mindenki más szándékot jelez, és az
// állapotfából olvas. Ettől lesz a billentyűzet, a mozdulat, a közös nézés és
// a távoli vezérlés ugyanannak az útnak négy bemenete — nem négy út.

import { EV } from '../core/player-events.js'

/** Sebességfokozatok. A 12. pont listája. */
export const RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function createPlaybackController (player, options = {}) {
  const { video, state, bus } = player
  const seekStep = options.seekStep ?? 5

  /*
   * A videóelem eseményei → állapotfa.
   *
   * Az elem az IGAZSÁG a lejátszás tényeiről (hol tart, mennyi a hossz), de
   * nem ő a nyilvántartás: amit itt olvasunk, azt a fába írjuk, és az UI onnan
   * veszi. Enélkül minden vezérlőelem maga kérdezné az elemet, és
   * megszaporodnának a `video.currentTime` olvasások — másodpercenként
   * négyszer, elemenként.
   */
  const sync = () => {
    state.patch({
      playback: {
        playing: !video.paused && !video.ended,
        currentTime: video.currentTime || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        volume: video.volume ?? 1,
        muted: Boolean(video.muted),
        rate: video.playbackRate ?? 1
      }
    })
  }

  /** Mennyi van pufferelve az aktuális pozíció körül, másodpercben. */
  const bufferedAhead = () => {
    try {
      const ranges = video.buffered
      const now = video.currentTime
      for (let i = 0; i < (ranges?.length ?? 0); i++) {
        if (ranges.start(i) <= now && now <= ranges.end(i)) return ranges.end(i)
      }
    } catch { /* a puffer lekérdezése némelyik állapotban dob */ }
    return 0
  }

  player.listen(video, 'play', () => { sync(); bus.emit(EV.PLAY) })
  player.listen(video, 'pause', () => { sync(); bus.emit(EV.PAUSE) })
  player.listen(video, 'timeupdate', () => {
    sync()
    bus.emit(EV.TIME_UPDATE, video.currentTime)
  })
  player.listen(video, 'durationchange', () => { sync(); bus.emit(EV.DURATION, video.duration) })
  player.listen(video, 'ratechange', () => { sync(); bus.emit(EV.RATE_CHANGED, video.playbackRate) })
  player.listen(video, 'volumechange', () => { sync(); bus.emit(EV.VOLUME_CHANGED, video.volume) })
  player.listen(video, 'ended', () => { sync(); bus.emit(EV.ENDED) })
  player.listen(video, 'seeking', () => {
    state.patch({ playback: { seeking: true } })
    bus.emit(EV.SEEK_START, video.currentTime)
  })
  player.listen(video, 'seeked', () => {
    state.patch({ playback: { seeking: false } })
    bus.emit(EV.SEEK_END, video.currentTime)
  })
  player.listen(video, 'progress', () => {
    state.patch({ playback: { buffered: bufferedAhead() } })
    bus.emit(EV.BUFFERED, state.get().playback.buffered)
  })
  player.listen(video, 'waiting', () => bus.emit(EV.BUFFERING_START))
  player.listen(video, 'playing', () => bus.emit(EV.BUFFERING_END))

  const api = {
    /**
     * Lejátszás.
     *
     * A `play()` ígéretet ad, és MOBILON ELUTASÍTHATJA az automatikus
     * lejátszás tiltása. Ez nem hiba, amit jelenteni kell: a néző majd
     * megnyomja a gombot. Elnyeljük, de az állapotot szinkronban tartjuk,
     * különben a vezérlősáv „megy" állapotot mutatna egy álló videóhoz.
     */
    async play () {
      try {
        await video.play()
      } catch (error) {
        sync()
        return { ok: false, reason: error?.name ?? 'NotAllowedError' }
      }
      sync()
      return { ok: true }
    },

    pause () { video.pause(); sync() },

    toggle () { return video.paused ? api.play() : (api.pause(), { ok: true }) },

    /** Ugrás abszolút pozícióra, a hosszon belülre szorítva. */
    seekTo (seconds) {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const target = clamp(Number(seconds) || 0, 0, duration || Number(seconds) || 0)
      video.currentTime = target
      bus.emit(EV.SEEK, target)
      return target
    },

    /** Relatív ugrás. A billentyűzet és a mozdulatok ezt hívják. */
    seekBy (delta) { return api.seekTo((video.currentTime || 0) + Number(delta || seekStep)) },

    setVolume (value) {
      const level = clamp(Number(value) || 0, 0, 1)
      video.volume = level
      // A hangerő állítása FELOLDJA a némítást. Enélkül a csúszka húzása
      // némán történne, és a néző azt hinné, elromlott.
      if (level > 0 && video.muted) video.muted = false
      sync()
      return level
    },

    toggleMute () { video.muted = !video.muted; sync(); return video.muted },

    /** Sebesség, csak a megengedett fokozatokra. */
    setRate (value) {
      const rate = RATES.includes(Number(value)) ? Number(value) : 1
      video.playbackRate = rate
      sync()
      return rate
    },

    /**
     * Lépés a sebességfokozatok között.
     *
     * A `<` és a `>` billentyű ezt hívja. A fokozatok listáján lép, nem
     * szorzással: egy `rate * 1.25` előbb-utóbb olyan értéket adna, ami nincs
     * a menüben, és a beállítás soha többé nem lenne visszaállítható kézzel.
     */
    stepRate (direction) {
      const step = Number(direction) > 0 ? 1 : -1
      const index = RATES.indexOf(video.playbackRate)
      // Ismeretlen aktuális érték: az egyszeresről indulunk, mert az a
      // biztosan létező fokozat.
      const from = index === -1 ? RATES.indexOf(1) : index
      return api.setRate(RATES[clamp(from + step, 0, RATES.length - 1)])
    },

    sync,
    get bufferedAhead () { return bufferedAhead() }
  }

  sync()
  return api
}
