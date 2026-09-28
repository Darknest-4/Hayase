// Az osztályhasználat egyszavas osztálynevekre vonatkozó szabálya (route-styles.test.mjs).
// Osztálykörnyezetben álló szövegek egy JS-forrásban: `class: …`, `className …`,
// `classList.add/remove/toggle/contains(…)`, `setAttribute('class', …)`,
// `class="…"` (HTML-sablon), és a szelektorok (`querySelector('.x')`, `closest`).
// Egyszavas osztálynévnél (`comment`, `on`, `card`) csak ez számít használatnak:
// a puszta szóegyezés adatot is talál (`subject_type === 'comment'`).
export function classTokens (text) {
  const out = new Set()
  const addFrom = span => {
    for (const m of span.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
      const str = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')
      for (const tok of str.split(/[\s.]+/)) if (/^[a-zA-Z_][\w-]*$/.test(tok)) out.add(tok)
    }
  }
  const lineAfter = i => text.slice(i, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i))
  for (const m of text.matchAll(/\bclass(Name)?\s*[:=]|classList\.(add|remove|toggle|contains|replace)\s*\(|setAttribute\(\s*['"]class['"]\s*,|\bclass=/g)) {
    addFrom(lineAfter(m.index + m[0].length))
    if (m[0] === 'class=') {
      const q = text.slice(m.index + 6).match(/^["']([^"']*)["']/)
      if (q) for (const tok of q[1].split(/\s+/)) if (tok) out.add(tok)
    }
  }
  for (const m of text.matchAll(/(querySelector(All)?|closest|matches)\(\s*(['"`])([^'"`]*)\3/g)) {
    for (const c of m[4].matchAll(/\.([a-zA-Z_][\w-]*)/g)) out.add(c[1])
  }
  return out
}
