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
      children.push(this._el('text', { x: x + bw / 2, y: H - pad + 14, 'text-anchor': 'middle', class: 'chart-label', fill: 'var(--fg-faint)' })).lastChild
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
  donut (data, { label = 'Distribution', size = 200 } = {}) {
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
    const wrap = document.createElement('div')
    wrap.className = 'donut-wrap'
    wrap.append(this._svg(size, size, children, label))
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
