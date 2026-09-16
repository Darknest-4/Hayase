// Közös nézés — a lejátszó oldala.
//
// A protokoll adott (`{type:'w2g', action, position}`), és a szerver dönti el,
// ki vezethet: CSAK A HÁZIGAZDA. Ami itt bonyolult, az nem a hálózat, hanem
// két dolog, ami mindkettő visszacsatolás:
//
//   * VISSZHANG. A távoli „szünet" alkalmazása helyben `pause` eseményt vált
//     ki, amit ha kiküldünk, a másik oldal újra alkalmazza, és így tovább.
//     Ezért az alkalmazás ideje alatt a kimenő üzenetek NÉMÁK;
//   * ELSODRÓDÁS. Két lejátszó sosem megy pontosan egyszerre: más a puffer,
//     más a hálózat. Az apró eltérést KIHAGYJUK — egy fél másodpercért
//     ugrálni rosszabb, mint együtt élni vele.
//
// A vendég oldalán a lejátszó nem „le van tiltva": továbbra is szüneteltethet
// magának. A következő helyzetjelentés visszahozza a többiekhez, és ez
// szándékos — aki kimegy egy pohár vízért, ne kelljen újracsatlakoznia.

/** Ekkora eltérés alatt nem nyúlunk hozzá. */
export const DRIFT_TOLERANCE_SEC = 1.5
/** Ekkora eltérés fölött nem tekerünk, hanem újraszinkronizálunk. */
export const DRIFT_JUMP_SEC = 30
/** A házigazda ilyen sűrűn mondja meg, hol tart. */
export const POSITION_INTERVAL_MS = 4000

/**
 * Mit kell tenni egy beérkező helyzetjelentés után.
 *
 * Külön függvény, mert ez a modul egyetlen valódi döntése — és mert egy
 * hálózati kapcsolat mögé rejtve nem lehetne megmérni.
 *
 * @returns {{action: 'none'|'seek', to?: number, why: string}}
 */
export function reconcile (localTime, remoteTime, { playing = true } = {}) {
  const drift = Number(remoteTime) - Number(localTime)
  const distance = Math.abs(drift)

  if (!Number.isFinite(drift)) return { action: 'none', why: 'értelmezhetetlen helyzet' }
  if (distance <= DRIFT_TOLERANCE_SEC) return { action: 'none', why: 'a különbség a tűréshatáron belül' }

  // SZÜNETBEN MINDIG IGAZODUNK. Ott nincs mit „behozni" — a kép áll, és egy
  // ugrás nem szakít meg semmit.
  if (!playing) return { action: 'seek', to: remoteTime, why: 'szünetben az igazodás ingyen van' }

  return {
    action: 'seek',
    to: remoteTime,
    why: distance > DRIFT_JUMP_SEC ? 'nagy eltérés: újraszinkronizálás' : 'elsodródás behozása'
  }
}

/**
 * @param {object} player
 * @param {object} options `send(message)`, `isHost()`, `onEvent(text)`
 */
export function createWatchParty (player, options = {}) {
  const { video, state, bus } = player
  // A KAPCSOLAT KÉSŐBB IS MEGJÖHET. A szoba akkor nyílik, amikor a néző
  // beírja a kódot — addigra a lejátszó rég fut. Ezért ezek változók, és a
  // `connect` írja őket: egy létrehozáskor rögzített függvényre később hiába
  // írnánk rá kívülről, a lezárás az eredetit tartaná.
  let send = options.send ?? (() => {})
  /*
   * ÉRDEMES-E EGYÁLTALÁN KÜLDENI.
   *
   * Nem ez jogosít: a szerver dönti el, ki vezetheti a lejátszást, és a
   * vendég üzenetét visszautasítja (`only the host controls playback`). Ez
   * csak a fölösleges forgalmat spórolja meg ott, ahol a hívó biztosan tudja.
   *
   * Az alapértelmezés ezért IGEN, nem nem: egy hamis alapértelmezés mellett
   * az a házigazda sem vezetne, akiről a kliens nem tudja, hogy az.
   */
  let canBroadcast = options.canBroadcast ?? (() => true)

  /**
   * Amíg igaz, semmit nem küldünk ki.
   *
   * Nem logikai érték, hanem SZÁMLÁLÓ: két egymásba érő alkalmazás (egy
   * `seek` közben érkező `pause`) a logikai változót az első befejezésekor
   * hamisra állítaná, és a második már kiküldené magát.
   */
  let applying = 0
  let joined = false

  const quietly = (fn) => {
    applying++
    try { fn() } finally {
      // A videóelem eseményei a KÖVETKEZŐ körben érkeznek meg, nem azonnal.
      // Az egy körrel későbbi feloldás nélkül a saját `pause`-unk már a némítás
      // után futna le, és visszhangot csinálna.
      player.timer(() => { applying = Math.max(0, applying - 1) }, 0)
    }
  }

  const broadcast = (action, position = video.currentTime) => {
    if (applying > 0 || !joined || !canBroadcast()) return false
    send({ type: 'w2g', action, position: Number(position) || 0 })
    return true
  }

  /** Egy beérkező üzenet alkalmazása. */
  const receive = (message) => {
    if (!message || message.type !== 'w2g') return null
    const position = Number(message.position) || 0

    switch (message.action) {
      case 'play':
        quietly(() => { video.currentTime = position; void video.play?.() })
        return { applied: 'play', position }
      case 'pause':
        quietly(() => { video.pause?.(); video.currentTime = position })
        return { applied: 'pause', position }
      case 'seek':
        quietly(() => { video.currentTime = position })
        return { applied: 'seek', position }
      case 'position': {
        const decision = reconcile(video.currentTime, position, { playing: !video.paused })
        if (decision.action === 'seek') quietly(() => { video.currentTime = decision.to })
        return { applied: decision.action, position, why: decision.why }
      }
      case 'episode':
        options.onEpisode?.(message.episode)
        return { applied: 'episode', episode: message.episode }
      default:
        return null
    }
  }

  player.listen(video, 'play', () => broadcast('play'))
  player.listen(video, 'pause', () => broadcast('pause'))
  player.listen(video, 'seeked', () => broadcast('seek'))

  // A HÁZIGAZDA HELYZETJELENTÉSE. Nem `timeupdate`-re: az másodpercenként
  // négyszer jön, és negyvenezer üzenet egy részen olyan forgalom, aminek
  // semmi haszna — négy másodperc bőven elég az elsodródás behozásához.
  player.interval(() => {
    if (!video.paused) broadcast('position')
  }, POSITION_INTERVAL_MS)

  return {
    receive,
    reconcile,

    /**
     * A szoba csatornájának bekötése.
     *
     * Egyben csatlakoztat is: enélkül két lépés lenne, és a kettő közötti
     * résben a lejátszó már küldene egy néma csatornára.
     */
    connect ({ send: sendFn, canBroadcast: canFn } = {}) {
      if (typeof sendFn === 'function') send = sendFn
      if (typeof canFn === 'function') canBroadcast = canFn
      this.join()
      return true
    },

    join () {
      joined = true
      state.patch({ ui: { party: true } })
      bus.emit('party:joined')
    },
    leave () {
      joined = false
      state.patch({ ui: { party: false } })
      bus.emit('party:left')
    },
    get joined () { return joined },
    get applying () { return applying > 0 }
  }
}
