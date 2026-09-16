// Billentyűparancsok.
//
// A FELISMERÉS és a VÉGREHAJTÁS külön van. A `shortcutFor` egy eseményből egy
// nevet ad, DOM nélkül, és pont ezért tesztelhető; az `attachKeyboard` csak
// összeköti a nevet a lejátszóval.
//
// A LEGFONTOSABB SZABÁLY az, ami nem parancs: ha a fókusz beviteli mezőben
// van, EGYETLEN parancs sem sül el. A közös nézés csevegőmezőjébe beírt „f"
// nem teljes képernyő, hanem egy betű — és ez az a hiba, amit minden lejátszó
// elkövet egyszer.

/** Beviteli mezőben vagyunk? */
export function isTypingTarget (target) {
  if (!target) return false
  const tag = String(target.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable === true) return true
  // A `role="textbox"` ugyanúgy beviteli mező, csak nem `<input>`.
  if (typeof target.getAttribute === 'function' && target.getAttribute('role') === 'textbox') return true
  return false
}

/**
 * Egy billentyűeseményből parancsnév, vagy `null`.
 *
 * @returns {{action: string, value?: number}|null}
 */
export function shortcutFor (event) {
  if (!event) return null
  if (isTypingTarget(event.target)) return null
  // A módosítóval nyomott billentyű a BÖNGÉSZŐÉ: a Ctrl+F keresés, a Cmd+R
  // újratöltés. A Shift kivétel, mert a `<` és a `>` azzal érhető el.
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  const key = event.key

  // Számok: a videó adott százalékára. A `0` az elejére.
  if (/^[0-9]$/.test(key)) return { action: 'seek-percent', value: Number(key) * 10 }

  switch (key) {
    case ' ':
    case 'Spacebar':          // régebbi böngészők neve ugyanerre
    case 'k': case 'K':       return { action: 'toggle-play' }
    case 'ArrowLeft':         return { action: 'seek-by', value: -5 }
    case 'ArrowRight':        return { action: 'seek-by', value: 5 }
    case 'j': case 'J':       return { action: 'seek-by', value: -10 }
    case 'l': case 'L':       return { action: 'seek-by', value: 10 }
    case 'ArrowUp':           return { action: 'volume-by', value: 0.05 }
    case 'ArrowDown':         return { action: 'volume-by', value: -0.05 }
    case 'm': case 'M':       return { action: 'toggle-mute' }
    case 'f': case 'F':       return { action: 'toggle-fullscreen' }
    case 't': case 'T':       return { action: 'toggle-cinema' }
    // A 24. pont kiosztása szerint: P = kép a képben, B = előző rész. Az `I`
    // megmarad másodiknak, mert a YouTube azt használja, és az ujjak
    // megjegyzik — de az elsődleges a leírásé.
    case 'p': case 'P':
    case 'i': case 'I':       return { action: 'toggle-pip' }
    case 'b': case 'B':       return { action: 'previous-episode' }
    case 'c': case 'C':       return { action: 'toggle-subtitles' }
    case 's': case 'S':       return { action: 'skip-segment' }
    case 'n': case 'N':       return { action: 'next-episode' }
    case '<':                 return { action: 'rate-by', value: -1 }
    case '>':                 return { action: 'rate-by', value: 1 }
    case ',':                 return { action: 'frame-step', value: -1 }
    case '.':                 return { action: 'frame-step', value: 1 }
    case '?':                 return { action: 'show-shortcuts' }
    case 'Escape':            return { action: 'escape' }
    default:                  return null
  }
}

/** A parancsok felsorolása a súgópanelhez. Egy helyen, hogy ne csússzon szét. */
export const SHORTCUT_HELP = Object.freeze([
  { keys: ['Szóköz', 'K'], what: 'lejátszás / szünet' },
  { keys: ['←', '→'], what: '5 másodperc vissza / előre' },
  { keys: ['J', 'L'], what: '10 másodperc vissza / előre' },
  { keys: ['0–9'], what: 'ugrás a videó adott százalékára' },
  { keys: ['↑', '↓'], what: 'hangerő' },
  { keys: ['M'], what: 'némítás' },
  { keys: ['F'], what: 'teljes képernyő' },
  { keys: ['T'], what: 'mozi mód' },
  { keys: ['P', 'I'], what: 'kép a képben' },
  { keys: ['C'], what: 'felirat be / ki' },
  { keys: ['S'], what: 'intró vagy outró átugrása' },
  { keys: ['N', 'B'], what: 'következő / előző rész' },
  { keys: ['<', '>'], what: 'lejátszási sebesség' },
  { keys: [',', '.'], what: 'képkocka léptetés szünetben' },
  { keys: ['?'], what: 'ez a lista' }
])

/**
 * A parancsok rákötése egy lejátszóra.
 *
 * A `handlers` térkép adja meg, mi történjen; ami nincs benne, az nem
 * történik meg — így egy beágyazott lejátszó kihagyhatja a részváltást anélkül,
 * hogy a billentyűkezelőt újra kellene írni.
 */
export function attachKeyboard (player, handlers = {}, target = null) {
  const node = target ?? player.video?.ownerDocument ?? globalThis.document
  if (!node) return () => {}

  return player.listen(node, 'keydown', (event) => {
    const shortcut = shortcutFor(event)
    if (!shortcut) return
    const handler = handlers[shortcut.action]
    if (typeof handler !== 'function') return
    // A megakadályozás CSAK akkor, ha tényleg csinálunk vele valamit. Enélkül
    // a le-fel nyíl a nem kezelt esetben sem görgetne, és az nem a mi dolgunk.
    if (typeof event.preventDefault === 'function') event.preventDefault()
    handler(shortcut.value)
  })
}
