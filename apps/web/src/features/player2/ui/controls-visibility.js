// Mikor látszanak a vezérlők.
//
// Egy időzítő és egy `mousemove` — elsőre ennyinek tűnik, és ettől lett a régi
// lejátszóban több hiba is:
//
//   * a vezérlők elrejtőztek, MIKÖZBEN a néző a hangerőcsúszkát fogta;
//   * érintőképernyőn az „egérmozgás" sosem jött, így az első koppintás után
//     örökre kint maradtak;
//   * szünetben is eltűntek, pedig szünetben nincs mit takarniuk.
//
// Ezért állapotgép, külön a DOM-tól: a bemenete négy tény, a kimenete egy
// logikai érték, és mind a hat szabály látszik egy képernyőn.

export const HIDE_DELAY_MS = 3000
/** Érintésnél hosszabb: ott nincs „egeret elmozdítok" gesztus a visszahozásra. */
export const TOUCH_HIDE_DELAY_MS = 4000

export function createVisibility (options = {}) {
  const onChange = options.onChange ?? (() => {})
  const now = options.now ?? (() => Date.now())
  let visible = true
  let lastActivity = now()
  let pinned = false     // menü nyitva, csúszka fogva — ilyenkor nem tűnhet el
  let paused = true
  let touch = false

  const evaluate = () => {
    // SZÜNETBEN MINDIG LÁTSZIK. A vezérlősáv a képet takarja; szünetben
    // viszont nincs mozgókép, amit takarhatna, és a néző épp azért állította
    // meg, hogy csináljon valamit.
    const should = pinned || paused || withinWindow()
    if (should !== visible) {
      visible = should
      onChange(visible)
    }
    return visible
  }

  const delay = () => (touch ? TOUCH_HIDE_DELAY_MS : HIDE_DELAY_MS)
  /** Az utolsó mozdulat óta eltelt idő MÉG a türelmi időn belül van? */
  const withinWindow = () => now() - lastActivity < delay()

  return {
    /** A néző csinált valamit: mozgatta az egeret, koppintott, gombot nyomott. */
    activity (source = 'mouse') {
      if (source === 'touch') touch = true
      lastActivity = now()
      return evaluate()
    },
    /** Menü nyílt vagy csúszkát fogtak. Amíg igaz, nem rejtjük el. */
    setPinned (value) { pinned = !!value; return evaluate() },
    setPaused (value) { paused = !!value; return evaluate() },
    /** Az időzítő ütése. A hívó dolga meghívni; itt nincs `setInterval`. */
    tick () { return evaluate() },
    /** Azonnali elrejtés — például amikor az egér elhagyja a lejátszót. */
    hideNow () {
      if (pinned || paused) return evaluate()
      lastActivity = now() - delay() - 1
      return evaluate()
    },
    get visible () { return visible },
    get pinned () { return pinned }
  }
}
