// A betöltőképernyő fázisa, a videóelem saját eseményeiből.
//
// SAJÁT MODUL, mert enélkül nem létezett: a `setPhase` megvolt, a
// betöltőképernyő olvasta is — de SENKI NEM HÍVTA. A betöltő tehát felállt az
// anime logójával, végigfuttatta rajta a színt, és soha többé nem tűnt el. A
// videó közben ment alatta, láthatatlanul.
//
// Ezt egyetlen egységteszt sem fogta meg, és nem is foghatta: a DOM-csonkban
// nincs `<video>`, ami eseményeket adna. A böngészős futás első perce viszont
// azonnal kiírta.
//
// A FÁZIS NEM UGYANAZ, MINT AZ ÁLLAPOT. A `status` azt mondja meg, mi a
// lejátszó helyzete; ez azt, MIT LÁT a néző a betöltőn. Forrásváltás közben a
// lejátszó `playing` marad — a néző szerint megy a film —, miközben a betöltő
// „váltás másik forrásra"-t mutat.

import { EV } from '../core/player-events.js'
import { LOADING_PHASE } from '../core/player-state.js'

/**
 * Ennyi ideig tartó akadás alatt nem hozzuk vissza a betöltőt.
 *
 * A `waiting` esemény a hálózat minden apró zökkenőjére elsül, és gyakran a
 * következő ezredmásodpercben már jön is a kép. A betöltő felvillantása
 * ilyenkor zavaróbb, mint az akadás maga.
 */
export const BUFFER_GRACE_MS = 400

export function createLoadingPhase (player) {
  const { video } = player
  let bufferTimer = null
  let ready = false

  const clearBuffer = () => {
    if (bufferTimer) { bufferTimer(); bufferTimer = null }
  }

  const set = (phase) => {
    clearBuffer()
    if (phase === LOADING_PHASE.READY) ready = true
    player.setPhase(phase)
  }

  player.listen(video, 'loadstart', () => { ready = false; set(LOADING_PHASE.LOADING_SOURCE) })
  player.listen(video, 'loadedmetadata', () => set(LOADING_PHASE.LOADING_METADATA))

  // KÉSZ: három esemény közül bármelyik. A `canplay` az elvi jelzés, de
  // mobilon a némított, automatikus lejátszás tiltása mellett előfordul, hogy
  // csak a `loadeddata` érkezik meg — a régi lejátszó ezen bukott el
  // telefonon, és a néző egy örök betöltőt látott.
  for (const type of ['canplay', 'loadeddata', 'playing']) {
    player.listen(video, type, () => set(LOADING_PHASE.READY))
  }

  player.listen(video, 'waiting', () => {
    // Csak akkor hozzuk vissza, ha az akadás KITART. A türelmi idő nélkül a
    // betöltő minden hálózati zökkenőre felvillanna.
    clearBuffer()
    bufferTimer = player.timer(() => {
      if (video.readyState < 3) player.setPhase(LOADING_PHASE.BUFFERING)
    }, BUFFER_GRACE_MS)
  })

  // A tekerés utáni újratöltés nem „betöltés": a néző maga kérte, és a
  // vezérlősáv úgyis mutatja. Egy teljes képernyős betöltő minden tekerésre
  // felvillanva használhatatlanná tenné a tekerést.
  player.listen(video, 'seeked', () => { if (ready) set(LOADING_PHASE.READY) })

  player.own(player.bus.on(EV.SOURCE_SWITCHED, () => { ready = false; set(LOADING_PHASE.SWITCHING_SOURCE) }))
  player.own(player.bus.on(EV.SOURCE_FAILED, () => { ready = false; set(LOADING_PHASE.SWITCHING_SOURCE) }))

  return {
    set,
    get ready () { return ready }
  }
}
