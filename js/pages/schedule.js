/* global window, U, C, API */
// Schedule page — airing calendar for the coming week, grouped by day,
// like the original app/schedule route.

const PageSchedule = {
  async render (root) {
    const pad = U.el('div', { class: 'page-pad' })
    pad.append(U.el('h1', { class: 'section-title', style: 'font-size:1.6rem;', text: 'Airing Schedule' }))
    root.append(pad)

    const container = U.el('div', {}, [U.el('div', { class: 'spinner' })])
    pad.append(container)

    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(+start + 7 * 86400000)

    let schedules
    try {
      schedules = await API.schedule(start, end)
    } catch (e) {
      container.replaceChildren(U.el('div', { class: 'error-state', text: 'Failed to load schedule: ' + e.message }))
      return
    }

    container.replaceChildren()

    if (!schedules.length) {
      container.append(U.el('div', { class: 'empty-state', text: 'Nothing airing this week.' }))
      return
    }

    // group by calendar day
    const byDay = new Map()
    for (const item of schedules) {
      const day = new Date(item.airingAt * 1000)
      const key = day.toDateString()
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key).push(item)
    }

    const todayKey = new Date().toDateString()
    const tomorrowKey = new Date(Date.now() + 86400000).toDateString()

    for (const [key, items] of byDay) {
      const date = new Date(key)
      let label = date.toLocaleDateString(undefined, { weekday: 'long' })
      if (key === todayKey) label = 'Today'
      else if (key === tomorrowKey) label = 'Tomorrow'

      const group = U.el('div', { class: 'day-group' }, [
        U.el('h2', { class: 'day-title', style: 'padding-left:0;', html: '' }, [
          document.createTextNode(label),
          U.el('span', { text: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) })
        ])
      ])

      const row = U.el('div', { class: 'hscroll', style: 'padding-left:0;padding-right:0;' })
      for (const item of items) {
        const time = new Date(item.airingAt * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        row.append(C.card(item.media, {
          subline: null,
          // custom subline via wrapper below
        }))
        const card = row.lastChild
        const sub = card.querySelector('.card-sub')
        sub.replaceChildren(
          U.el('span', { class: 'sched-time', text: time + ' • ' }),
          U.el('span', { class: 'sched-ep', text: 'Ep ' + item.episode })
        )
      }
      group.append(row)
      container.append(group)
    }
  }
}

window.PageSchedule = PageSchedule
