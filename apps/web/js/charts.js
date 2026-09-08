/* global window, document */
// Tiny dependency-free SVG chart helpers used by the Analytics page.
// Theme-aware (uses design tokens via currentColor/var()), accessible
// (title + role), responsive (viewBox scales).

const Charts = {
  _svg (w, h, children, label) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.setAttribute('role', 'img')
    svg.setAttribute('class', 'chart')
    if (label) {
      const t = document.createElementNS(ns, 'title')
      t.textContent = label
      svg.append(t)
    }
    for (const c of children) svg.append(c)
    return svg
  },

  _el (tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v)
    return el
  },

  // vertical bar chart: data = [{label, value}]
  bars (data, { label = 'Bar chart', accent = 'var(--accent)' } = {}) {
    const W = 640; const H = 220; const pad = 28; const gap = 8
    const max = Math.max(1, ...data.map(d => d.value))
    const bw = (W - pad * 2) / data.length
    const children = []
    data.forEach((d, i) => {
      const h = (H - pad * 2) * (d.value / max)
      const x = pad + i * bw
      const y = H - pad - h
      children.push(this._el('rect', { x: x + gap / 2, y, width: bw - gap, height: h, rx: 3, fill: accent }))
      // (An earlier version pushed a second, unlabelled <text> here as well —
      // the label element built below is the only one that should exist.)
      const lbl = this._el('text', { x: x + bw / 2, y: H - pad + 14, 'text-anchor': 'middle' })
      lbl.setAttribute('class', 'chart-tick'); lbl.textContent = d.label
      children[children.length - 1] = lbl
      if (d.value) {
        const val = this._el('text', { x: x + bw / 2, y: y - 5, 'text-anchor': 'middle' })
        val.setAttribute('class', 'chart-value'); val.textContent = d.display ?? d.value
        children.push(val)
      }
    })
    return this._svg(W, H, children, label)
  },

  // compact sparkline for a metric's recent history: data = [numbers]
  // Scaled to its own min/max so small variations stay visible; when a
  // ceiling is known (percentages) pass max to keep the scale honest.
  sparkline (values, { label = 'Trend', accent = 'var(--accent)', max = null, height = 44 } = {}) {
    const W = 240; const H = height; const pad = 3
    if (!values.length) return this._svg(W, H, [], label)
    const hi = max ?? Math.max(...values)
    const lo = max != null ? 0 : Math.min(...values)
    const span = hi - lo || 1
    const step = values.length > 1 ? (W - pad * 2) / (values.length - 1) : 0
    const y = v => H - pad - ((v - lo) / span) * (H - pad * 2)
    const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

    const area = this._el('polygon', {
      points: `${pad},${H - pad} ${points} ${(pad + (values.length - 1) * step).toFixed(1)},${H - pad}`,
      fill: accent,
      opacity: '0.14'
    })
    const line = this._el('polyline', {
      points,
      fill: 'none',
      stroke: accent,
      'stroke-width': '2',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    })
    return this._svg(W, H, [area, line], label)
  },

  /**
   * Multi-series line chart with axes: series = [{ name, values[], color }].
   *
   * The module had bars, a sparkline, ranked rows and a donut — nothing that
   * could put three measures on one time axis, which is what "did content
   * activity move together with users" needs. A sparkline cannot answer it:
   * no axis, no scale, no second series.
   *
   * Everything is drawn from the data. The y-axis is rounded up to a readable
   * step rather than to the maximum, so the top gridline is a number a person
   * would say out loud, and a series that is flat at zero still gets a line on
   * the baseline instead of disappearing.
   */
  lines (series, { labels = [], label = 'Trend', height = 190, area = null } = {}) {
    const W = 380
    const H = height
    const padL = 26
    const padR = 8
    const padT = 10
    const padB = 20
    const plotW = W - padL - padR
    const plotH = H - padT - padB

    const all = series.flatMap(s => s.values)
    if (!all.length) return this._svg(W, H, [], label)

    // A "nice" ceiling: 1, 2 or 5 × a power of ten, so the gridline labels are
    // round numbers. A max of 37 draws to 40, not to 37.
    const peak = Math.max(1, ...all)
    const magnitude = 10 ** Math.floor(Math.log10(peak))
    const top = [1, 2, 5, 10].find(m => peak <= m * magnitude) * magnitude
    const ticks = [4, 5, 3, 2, 1].find(n => top % n === 0) ?? 4

    const x = i => padL + (series[0].values.length > 1 ? (i * plotW) / (series[0].values.length - 1) : plotW / 2)
    const y = v => padT + plotH - (v / top) * plotH

    const children = []

    // gridlines + y labels
    for (let t = 0; t <= ticks; t++) {
      const value = (top / ticks) * t
      const yy = y(value)
      children.push(this._el('line', {
        x1: padL,
        x2: W - padR,
        y1: yy.toFixed(1),
        y2: yy.toFixed(1),
        class: 'chart-grid'
      }))
      const text = this._el('text', { x: padL - 5, y: (yy + 3).toFixed(1), 'text-anchor': 'end', class: 'chart-axis' })
      text.textContent = value >= 1000 ? (value / 1000) + 'k' : String(Math.round(value))
      children.push(text)
    }

    // x labels — thinned so they never collide on a narrow card
    const every = Math.ceil(labels.length / 6)
    labels.forEach((name, i) => {
      if (i % every !== 0 && i !== labels.length - 1) return
      const text = this._el('text', { x: x(i).toFixed(1), y: H - 5, 'text-anchor': 'middle', class: 'chart-axis' })
      text.textContent = name
      children.push(text)
    })

    for (const line of series) {
      const points = line.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
      // A filled area only when there is one series: overlapping translucent
      // fills read as a third colour that means nothing.
      if (area ?? series.length === 1) {
        children.push(this._el('polygon', {
          points: `${padL},${padT + plotH} ${points} ${x(line.values.length - 1).toFixed(1)},${padT + plotH}`,
          fill: line.color ?? 'var(--accent)',
          opacity: '0.12'
        }))
      }
      children.push(this._el('polyline', {
        points,
        fill: 'none',
        stroke: line.color ?? 'var(--accent)',
        'stroke-width': '2',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round'
      }))
      line.values.forEach((v, i) => {
        const dot = this._el('circle', {
          cx: x(i).toFixed(1),
          cy: y(v).toFixed(1),
          r: '2.6',
          fill: 'var(--bg)',
          stroke: line.color ?? 'var(--accent)',
          'stroke-width': '2'
        })
        // The value itself, on hover. No tooltip machinery: a <title> is what
        // the browser already knows how to show, and it works on touch too.
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'title')
        t.textContent = `${line.name ? line.name + ' · ' : ''}${labels[i] ?? i}: ${v}`
        dot.append(t)
        children.push(dot)
      })
    }

    return this._svg(W, H, children, label)
  },

  // horizontal ranked bars: data = [{label, value, display}]
  ranked (data, { label = 'Ranking', accent = 'var(--accent)' } = {}) {
    const rowH = 30; const W = 640; const H = data.length * rowH + 10; const labelW = 150
    const max = Math.max(1, ...data.map(d => d.value))
    const children = []
    data.forEach((d, i) => {
      const y = i * rowH + 5
      const name = this._el('text', { x: 0, y: y + rowH / 2 + 4, class: 'chart-name' })
      name.textContent = d.label.length > 22 ? d.label.slice(0, 21) + '…' : d.label
      children.push(name)
      const trackW = W - labelW - 50
      children.push(this._el('rect', { x: labelW, y: y + 6, width: trackW, height: rowH - 14, rx: 4, fill: 'var(--bg-raised)' }))
      children.push(this._el('rect', { x: labelW, y: y + 6, width: Math.max(2, trackW * (d.value / max)), height: rowH - 14, rx: 4, fill: accent }))
      const val = this._el('text', { x: W - 4, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'chart-value' })
      val.textContent = d.display ?? d.value
      children.push(val)
    })
    return this._svg(W, H, children, label)
  },

  // donut chart: data = [{label, value, color}]
  /**
   * Donut. `legend: false` returns the ring alone, for a caller that draws its
   * own — the built-in one is positioned for a 200px canvas and collides with
   * anything laid out around a smaller ring.
   */
  donut (data, { label = 'Distribution', size = 200, legend: withLegend = true } = {}) {
    const total = data.reduce((s, d) => s + d.value, 0) || 1
    const r = size / 2; const inner = r * 0.62; const cx = r; const cy = r
    const children = []
    let angle = -Math.PI / 2
    for (const d of data) {
      const frac = d.value / total
      const a2 = angle + frac * Math.PI * 2
      const large = frac > 0.5 ? 1 : 0
      const x1 = cx + r * Math.cos(angle); const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(a2); const y2 = cy + r * Math.sin(a2)
      const xi2 = cx + inner * Math.cos(a2); const yi2 = cy + inner * Math.sin(a2)
      const xi1 = cx + inner * Math.cos(angle); const yi1 = cy + inner * Math.sin(angle)
      children.push(this._el('path', {
        d: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${inner} ${inner} 0 ${large} 0 ${xi1} ${yi1} Z`,
        fill: d.color
      }))
      angle = a2
    }
    const svg = this._svg(size, size, children, label)
    if (!withLegend) return svg

    const wrap = document.createElement('div')
    wrap.className = 'donut-wrap'
    wrap.append(svg)
    const legend = document.createElement('div')
    legend.className = 'donut-legend'
    for (const d of data) {
      if (!d.value) continue
      const row = document.createElement('div')
      row.className = 'donut-legend-row'
      row.innerHTML = `<span class="donut-swatch" style="background:${d.color}"></span><span>${d.label}</span><b>${Math.round(d.value / total * 100)}%</b>`
      legend.append(row)
    }
    wrap.append(legend)
    return wrap
  }
}

window.Charts = Charts
