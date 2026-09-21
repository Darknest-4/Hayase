/* global document */

import {
  createMaintenancePlayer,
  prefersReducedMotion
} from '../video/maintenance-player.js'

/*
 * A JELVÉNY SZÖVEGE MONDJA MEG A MÓDOT, nem a színe — „no color-only
 * information". Ezért kell MINDEN módnak saját felirat: a `READ_ONLY` és az
 * `EMERGENCY` kimaradásával mindkettő „Karbantartás" lett volna, vagyis a
 * rendkívüli üzem megkülönböztethetetlen a szokásostól.
 */
const MODE_LABEL = {
  ACTIVE: 'Teljes karbantartás',
  DEGRADED: 'Részleges karbantartás',
  READ_ONLY: 'Csak olvasható üzem',
  EMERGENCY: 'Rendkívüli karbantartás',
  SCHEDULED: 'Tervezett karbantartás',
  OFF: 'Rendszer elérhető',
  operational: 'Rendszer elérhető'
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
 * YUME maintenance page.
 *
 * A videó valódi foreground playerként jelenik meg.
 * Nincs háttérvideó.
 *
 * @param {object} status
 * @param {object} options
 */
export function createMaintenancePage (
  status = {},
  options = {}
) {
  const teardown = []

  const node = document.createElement('main')

  node.className = 'mnt-page'

  node.setAttribute(
    'role',
    'region'
  )

  node.setAttribute(
    'aria-live',
    'polite'
  )

  node.setAttribute(
    'aria-label',
    'YUME karbantartás'
  )

  const card = document.createElement('section')

  card.className = 'mnt-card'

  /*
   * ----------------------------------------
   * HEADER
   * ----------------------------------------
   */

  const header = document.createElement('div')

  header.className = 'mnt-header'

  const logo = document.createElement('p')

  logo.className = 'mnt-logo'
  logo.textContent = 'YUME'

  const badge = document.createElement('span')

  badge.className = 'mnt-badge'

  header.append(
    logo,
    badge
  )

  /*
   * ----------------------------------------
   * CONTENT
   * ----------------------------------------
   */

  const title = document.createElement('h1')

  title.className = 'mnt-title'

  const message = document.createElement('p')

  message.className = 'mnt-message'

  const when = document.createElement('p')

  when.className = 'mnt-when'

  /*
   * ----------------------------------------
   * VIDEO PLAYER
   * ----------------------------------------
   *
   * FONTOS:
   *
   * Nem hozunk létre background playert.
   * A maintenance-player foreground módját
   * használjuk közvetlenül.
   */

  let player = {
    node: null,
    destroy: () => {}
  }

  if (status.video?.url) {
    player = createMaintenancePlayer(
      status.video,
      {
        mode: 'foreground',
        enabled: true
      }
    )

    if (player.node) {
      player.node.classList.add(
        'mnt-maintenance-player'
      )
    }

    teardown.push(
      player.destroy
    )
  }

  /*
   * ----------------------------------------
   * PROGRESS
   * ----------------------------------------
   */

  const progressWrapper =
    document.createElement('div')

  progressWrapper.className =
    'mnt-progress-wrapper'

  const bar =
    document.createElement('div')

  bar.className =
    'mnt-progress'

  bar.setAttribute(
    'role',
    'progressbar'
  )

  bar.setAttribute(
    'aria-label',
    'A karbantartásból hátralévő idő'
  )

  bar.setAttribute(
    'aria-valuemin',
    '0'
  )

  bar.setAttribute(
    'aria-valuemax',
    '100'
  )

  const fill =
    document.createElement('div')

  fill.className =
    'mnt-progress-fill'

  bar.append(fill)

  progressWrapper.append(bar)

  /*
   * ----------------------------------------
   * ACTIONS
   * ----------------------------------------
   */

  const actions =
    document.createElement('div')

  actions.className =
    'mnt-actions'

  const retry =
    document.createElement('button')

  retry.type = 'button'

  retry.className =
    'mnt-retry'

  retry.textContent =
    'Újrapróbálom'

  actions.append(retry)

  /*
   * A KÁRTYA TARTALMA, EGY HELYEN ÖSSZEÁLLÍTVA.
   *
   * A lejátszó korábban itt fentebb került a kártyába, vagyis a fejléc és a
   * cím ELÉ — a videó állt legfelül, a „Karbantartás alatt vagyunk" pedig
   * alatta. Ez a sorrend a kért felépítés fordítottja volt.
   *
   * Innentől egyetlen `append` mondja meg a sorrendet, és az olvasható:
   * fejléc, cím, üzenet, időpont, majd a lejátszó, végül a folyamatjelző és a
   * gomb. Két külön beszúrási hely ugyanabba a kártyába pont az a fajta
   * szerkezet, amiből észrevétlenül lesz rossz sorrend.
   */

  card.append(
    ...[
      header,
      title,
      message,
      when,
      // Videó nélkül `null` — és az `append(null)` a VALÓDI DOM-ban a „null"
      // szót szúrná be szövegcsomópontként a kártyába. Kiszűrjük.
      player.node,
      progressWrapper,
      actions
    ].filter(Boolean)
  )

  node.append(card)

  /*
   * ----------------------------------------
   * STATE
   * ----------------------------------------
   */

  let total = null

  const update = (
    next = status
  ) => {
    const mode =
      next.mode ?? 'ACTIVE'

    badge.textContent =
      MODE_LABEL[mode] ??
      'Karbantartás'

    badge.dataset.mode =
      mode

    title.textContent =
      next.title ||
      'Karbantartás alatt vagyunk'

    message.textContent =
      next.message ||
      'A YUME jelenleg karbantartás alatt áll. Hamarosan újra elérhető lesz.'

    const left =
      options.service?.secondsLeft?.() ??
      next.retryAfter ??
      null

    const readable =
      humanCountdown(left)

    if (readable) {
      when.textContent =
        `Várható befejezés: ${readable} múlva`

      if (total === null) {
        total = Number(left)
      }
    } else {
      when.textContent =
        'A befejezés időpontja egyelőre nem ismert.'
    }

    const measurable =
      readable &&
      Number.isFinite(Number(total)) &&
      Number(total) > 0

    bar.hidden =
      !measurable

    if (measurable) {
      const numericLeft =
        Number(left)

      const done =
        Math.max(
          0,
          Math.min(
            100,
            (
              (Number(total) -
                numericLeft) /
              Number(total)
            ) * 100
          )
        )

      fill.style.width =
        `${done}%`

      bar.setAttribute(
        'aria-valuenow',
        String(
          Math.round(done)
        )
      )
    }
  }

  /*
   * ----------------------------------------
   * RETRY
   * ----------------------------------------
   */

  const onRetry = async () => {
    retry.disabled = true

    retry.textContent =
      'Ellenőrzés…'

    try {
      const fresh =
        await options.service?.refresh?.()

      if (fresh) {
        update(fresh)

        if (
          fresh.mode === 'OFF' ||
          fresh.status === 'operational'
        ) {
          options.onRetry?.()
        }
      }
    } catch {
      // A retry hiba nem döntheti le
      // a karbantartási oldalt.
    } finally {
      retry.disabled = false

      retry.textContent =
        'Újrapróbálom'
    }
  }

  retry.addEventListener(
    'click',
    onRetry
  )

  teardown.push(() => {
    retry.removeEventListener(
      'click',
      onRetry
    )
  })

  /*
   * ----------------------------------------
   * COUNTDOWN
   * ----------------------------------------
   */

  const tick =
    setInterval(() => {
      update(
        options.service?.status ??
        status
      )
    }, 1000)

  teardown.push(() => {
    clearInterval(tick)
  })

  /*
   * ----------------------------------------
   * SERVICE SUBSCRIPTION
   * ----------------------------------------
   */

  if (
    options.service?.subscribe
  ) {
    const unsubscribe =
      options.service.subscribe(
        next => update(next)
      )

    if (
      typeof unsubscribe ===
      'function'
    ) {
      teardown.push(
        unsubscribe
      )
    }
  }

  /*
   * ----------------------------------------
   * ACCESSIBILITY
   * ----------------------------------------
   */

  if (
    prefersReducedMotion()
  ) {
    node.dataset.reducedMotion =
      'true'
  }

  /*
   * ----------------------------------------
   * INITIAL RENDER
   * ----------------------------------------
   */

  update()

  /*
   * ----------------------------------------
   * API
   * ----------------------------------------
   */

  return {
    node,

    update,

    destroy () {
      while (
        teardown.length
      ) {
        try {
          teardown.pop()()
        } catch {
          // A teardown hiba nem
          // állítja meg a többit.
        }
      }

      node.remove()
    }
  }
}

export default createMaintenancePage
