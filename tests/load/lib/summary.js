// Közös összegzés-kiírás.
//
// A k6 alapértelmezett összegzése a képernyőre megy, és ott is marad. Egy
// mérés viszont akkor ér valamit, ha össze lehet hasonlítani a következővel —
// tehát fájlba kell tenni, gépi formában, és a jelentést abból építeni.
//
// A `SUMMARY_OUT` környezeti változó mondja meg, hova.
//
// A képernyős rész saját kezűleg készül, nem a jslib távoli
// `textSummary`-jával: egy mérőszkript, aminek az összegzéshez internet kell,
// zárt hálózaton nem fut le, és pont akkor derül ki, amikor már fut a mérés.

function ms (v) { return v == null ? '—' : (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v.toFixed(0) + ' ms') }

function line (name, m) {
  const v = m.values ?? {}
  if (v.p95 !== undefined || v['p(95)'] !== undefined) {
    const p = k => v[`p(${k})`] ?? v[`p${k}`]
    return `  ${name.padEnd(28)} med ${ms(v.med).padStart(9)}  p90 ${ms(p(90)).padStart(9)}  p95 ${ms(p(95)).padStart(9)}  p99 ${ms(p(99)).padStart(9)}  max ${ms(v.max).padStart(9)}`
  }
  if (v.rate !== undefined && v.passes !== undefined) {
    return `  ${name.padEnd(28)} ${(v.rate * 100).toFixed(2)}%  (${v.passes}/${v.passes + v.fails})`
  }
  if (v.count !== undefined) return `  ${name.padEnd(28)} ${v.count}${v.rate ? `  (${v.rate.toFixed(2)}/s)` : ''}`
  if (v.value !== undefined) return `  ${name.padEnd(28)} ${v.value}`
  return null
}

export function summaryTo (result, extraNote) {
  const m = result.metrics ?? {}
  const rows = []

  rows.push('── kérések ' + '─'.repeat(60))
  for (const key of ['http_reqs', 'http_req_duration', 'http_req_waiting', 'http_req_failed', 'iterations', 'vus_max']) {
    if (m[key]) { const l = line(key, m[key]); if (l) rows.push(l) }
  }

  rows.push('── lépések ' + '─'.repeat(60))
  for (const key of Object.keys(m).filter(k => k.startsWith('step_') || k.startsWith('play_') || k.startsWith('ws_')).sort()) {
    const l = line(key, m[key]); if (l) rows.push(l)
  }

  rows.push('── kimenet ' + '─'.repeat(60))
  for (const key of Object.keys(m).filter(k => k.startsWith('yume_')).sort()) {
    const l = line(key, m[key]); if (l) rows.push(l)
  }

  const failed = Object.entries(result.metrics ?? {})
    .flatMap(([name, metric]) => Object.entries(metric.thresholds ?? {})
      .filter(([, t]) => t.ok === false).map(([expr]) => `${name}: ${expr}`))
  rows.push('── küszöbök ' + '─'.repeat(59))
  rows.push(failed.length ? failed.map(f => '  ELBUKOTT  ' + f).join('\n') : '  mind rendben')

  const out = { stdout: (extraNote ? extraNote + '\n\n' : '') + rows.join('\n') + '\n' }
  const path = __ENV.SUMMARY_OUT
  if (path) out[path] = JSON.stringify(result, null, 1)
  return out
}
