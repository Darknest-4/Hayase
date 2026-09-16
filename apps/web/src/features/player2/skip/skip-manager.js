// Intró és outró átugrása.
//
// Az intervallumok a `skip_segments` táblából jönnek, közösségi beküldésből,
// SZAVAZAT SZERINT rangsorolva: az számít, amivel a legtöbben egyetértettek.
//
// A tábla ma ÜRES. Ez a modul tehát egységteszttel igazolható, élesben viszont
// nem bizonyítható — és a záró jelentésben ezért `PARTIAL`-ként fog szerepelni,
// nem `PASS`-ként.

export const SKIP_KIND = Object.freeze({
  INTRO: 'intro',
  OUTRO: 'outro',
  RECAP: 'recap',
  PREVIEW: 'preview'
})

/** Ennyivel a vége előtt már nem ajánlunk átugrást — úgyis jön a következő rész. */
export const TAIL_MARGIN_SEC = 2

/**
 * Nyers sorok → intervallumok.
 *
 * A hibás sor kimarad, nem dob: egy elrontott beküldés nem viheti magával a
 * többit.
 */
export function normaliseSegments (rows = []) {
  return rows
    .map(row => ({
      kind: String(row?.kind ?? '').toLowerCase(),
      start: Number(row?.start_sec ?? row?.start),
      end: Number(row?.end_sec ?? row?.end),
      votes: Number(row?.votes ?? 0)
    }))
    .filter(segment =>
      Object.values(SKIP_KIND).includes(segment.kind) &&
      Number.isFinite(segment.start) && Number.isFinite(segment.end) &&
      segment.end > segment.start)
    // Fajtánként a legtöbb szavazatot kapott intervallum. Több beküldés
    // ugyanarra a részre nem három gomb, hanem egy — az, amiben a nézők
    // egyetértettek.
    .sort((a, b) => b.votes - a.votes)
    .filter((segment, index, all) => all.findIndex(s => s.kind === segment.kind) === index)
}

/** Melyik intervallumban vagyunk éppen. `null`, ha egyikben sem. */
export function segmentAt (segments = [], currentTime = 0, duration = 0) {
  const now = Number(currentTime) || 0
  return segments.find(segment => {
    if (now < segment.start || now >= segment.end) return false
    // A legvégén nincs mit ajánlani: az outró átugrása a stáblista utolsó
    // másodperceiben már csak egy villanó gomb.
    if (duration && segment.end > duration - TAIL_MARGIN_SEC && now > duration - TAIL_MARGIN_SEC) return false
    return true
  }) ?? null
}

/**
 * @param {object} player
 * @param {object} options `prefs` (`player.skip.introAuto`, `…outroAuto`), `onSkip`
 */
export function createSkipManager (player, options = {}) {
  const { video, state, bus } = player
  const prefs = options.prefs ?? { get: () => false }
  let segments = []
  /** Amit már átugrottunk — az automatika ne ugorjon kétszer ugyanoda. */
  const done = new Set()
  let active = null

  const autoFor = (kind) => {
    if (kind === SKIP_KIND.INTRO) return prefs.get('player.skip.introAuto') === true
    if (kind === SKIP_KIND.OUTRO) return prefs.get('player.skip.outroAuto') === true
    return false
  }

  const skip = (segment = active) => {
    if (!segment) return false
    done.add(`${segment.kind}:${segment.start}`)
    video.currentTime = segment.end
    active = null
    state.patch({ ui: { skipSegment: null } })
    bus.emit(segment.kind === SKIP_KIND.OUTRO ? 'episode:skip-outro' : 'episode:skip-intro', segment)
    return true
  }

  const check = () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const found = segmentAt(segments, video.currentTime, duration)
    if (found === active) return

    active = found
    state.patch({ ui: { skipSegment: found ? { kind: found.kind, end: found.end } : null } })

    if (found && autoFor(found.kind) && !done.has(`${found.kind}:${found.start}`)) skip(found)
  }

  player.listen(video, 'timeupdate', check)
  // A tekerés visszahozhat egy már átugrott szakaszt: aki szándékosan
  // visszatekert az intróra, az látni akarja.
  player.listen(video, 'seeked', () => { done.clear(); check() })

  return {
    load (rows) { segments = normaliseSegments(rows); done.clear(); active = null; return segments.length },
    skip,
    get active () { return active },
    get segments () { return [...segments] }
  }
}
