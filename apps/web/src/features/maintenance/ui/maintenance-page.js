/* global document */
// A karbantartási oldal — a 14. pont.
//
// NEM egy „503 Site under maintenance" felirat. Ami itt van, az ugyanaz a
// YUME, csak épp nem szolgál ki: a saját tervezési tokenjei, a saját
// tipográfiája, és egy videó, ha van.
//
// AMIT A NÉZŐ TUDNI AKAR, ebben a sorrendben:
//   1. mi történik (cím és üzenet);
//   2. meddig tart (visszaszámláló, becsült befejezés);
//   3. mit tehet (újrapróbálás).
//
// Minden más dísz — és a dísz nem előzheti meg a választ.

import { createMaintenancePlayer, prefersReducedMotion } from '../video/maintenance-player.js'

const MODE_LABEL = {
  ACTIVE: 'Teljes karbantartás',
  DEGRADED: 'Részleges karbantartás',
  READ_ONLY: 'Csak olvasható üzem',
  EMERGENCY: 'Rendkívüli karbantartás',
  SCHEDULED: 'Tervezett karbantartás'
}

/** Másodperc → „2 perc 30 másodperc". A `null` azt jelenti: nem tudjuk. */
export function humanCountdown (seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return null
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = Math.floor(total % 60)
  if (hours) return `${hours} óra ${minutes} perc`
  if (minutes) return `${minutes} perc ${String(rest).padStart(2, '0')} mp`
  return `${rest} másodperc`
}

/**
 * @param {object} status a `/v1/status` válasza
 * @param {object} options `onRetry`, `service`
 * @returns {{node: HTMLElement, destroy: function, update: function}}
 */
export function createMaintenancePage (status, options = {}) {
  const teardown = []
  const node = document.createElement('div')
  node.className = 'mnt-page'

  // A LAP EGY ÉLŐ RÉGIÓ: a felolvasó így bemondja, amikor a helyzet változik
  // (például lejár a visszaszámláló), anélkül, hogy elvenné a fókuszt.
  node.setAttribute('role', 'region')
  node.setAttribute('aria-live', 'polite')
  node.setAttribute('aria-label', 'Karbantartás')

  // ---- háttérvideó ----
  const background = createMaintenancePlayer(status.video, { mode: 'background' })
  if (background.node) node.append(background.node)
  teardown.push(background.destroy)

  const card = document.createElement('div')
  card.className = 'mnt-card'

  const logo = document.createElement('p')
  logo.className = 'mnt-logo'
  logo.textContent = 'YUME'

  const badge = document.createElement('span')
  badge.className = 'mnt-badge'

  const title = document.createElement('h1')
  title.className = 'mnt-title'

  const message = document.createElement('p')
  message.className = 'mnt-message'

  const when = document.createElement('p')
  when.className = 'mnt-when'

  const bar = document.createElement('div')
  bar.className = 'mnt-progress'
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-label', 'A karbantartásból hátralévő idő')
  const fill = document.createElement('div')
  fill.className = 'mnt-progress-fill'
  bar.append(fill)

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'mnt-retry'
  retry.textContent = 'Újrapróbálom'

  const actions = document.createElement('div')
  actions.className = 'mnt-actions'
  actions.append(retry)

  card.append(logo, badge, title, message, when, bar, actions)
  node.append(card)

  // ---- előtérvideó, ha van ----
  // A háttér és az előtér KÖZÜL EGY: két példány ugyanabból a fájlból
  // kétszeres letöltés, és a 18. pont kifejezetten tiltja.
  let foreground = { node: null, destroy: () => {} }
  if (status.video && !background.node) {
    foreground = createMaintenancePlayer(status.video, { mode: 'foreground' })
    if (foreground.node) card.append(foreground.node)
    teardown.push(foreground.destroy)
  }

  let total = null

  const update = (next = status) => {
    const mode = next.mode ?? 'ACTIVE'
    badge.textContent = MODE_LABEL[mode] ?? 'Karbantartás'
    badge.dataset.mode = mode
    title.textContent = next.title || 'Karbantartás alatt vagyunk'
    message.textContent = next.message || 'A YUME rövidesen újra elérhető lesz.'

    const left = options.service?.secondsLeft?.() ?? next.retryAfter ?? null
    const readable = humanCountdown(left)
    when.textContent = readable
      ? `Várható befejezés: ${readable} múlva`
      : 'A befejezés időpontja egyelőre nem ismert.'

    // A SÁV CSAK AKKOR JELENIK MEG, ha van mit mérni. Egy haladásjelző, ami
    // semmit nem jelez, hamis pontosságot mutat.
    if (readable && total === null) total = left
    const measurable = readable && total
    bar.hidden = !measurable
    if (measurable) {
      const done = Math.max(0, Math.min(100, ((total - left) / total) * 100))
      fill.style.width = `${done}%`
      bar.setAttribute('aria-valuenow', String(Math.round(done)))
      bar.setAttribute('aria-valuemin', '0')
      bar.setAttribute('aria-valuemax', '100')
    }
  }

  retry.addEventListener('click', async () => {
    retry.disabled = true
    retry.textContent = 'Ellenőrzés…'
    try {
      const fresh = await options.service?.refresh?.()
      if (fresh) update(fresh)
      // HA VÉGE, ÚJRATÖLTÜNK. Nincs átirányítási hurok: az újratöltés után a
      // szerver dönt, és ha még mindig karbantartás van, ugyanide jutunk.
      if (fresh && (fresh.mode === 'OFF' || fresh.status === 'operational')) {
        options.onRetry?.()
      }
    } finally {
      retry.disabled = false
      retry.textContent = 'Újrapróbálom'
    }
  })

  /*
   * A VISSZASZÁMLÁLÓ MÁSODPERCENKÉNT FRISSÜL, DE NEM KÉRDEZ SEMMIT.
   *
   * A 25. pont kifejezetten kéri: ne legyen agresszív végtelen lekérdezés. A
   * kijelzés helyben számol, a szervert a szolgáltatás kérdezi a maga
   * ütemében — és mozgásmentes módban a másodperces frissítés is elmarad.
   */
  if (!prefersReducedMotion()) {
    const tick = setInterval(() => update(options.service?.status ?? status), 1000)
    teardown.push(() => clearInterval(tick))
  }

  if (options.service?.subscribe) {
    teardown.push(options.service.subscribe(next => update(next)))
  }

  update()

  return {
    node,
    update,
    destroy () { while (teardown.length) { try { teardown.pop()() } catch { /* lebontás */ } } }
  }
}
