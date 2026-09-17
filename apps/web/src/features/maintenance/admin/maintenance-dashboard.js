/* global document */
// A karbantartás admin felülete — a 10. és 11. pont.
//
// SAJÁT MODUL, nem az `admin.js`-be írva: az a fájl már így is ötezer sor, és
// a 36. pont kifejezetten tiltja az óriásfájlokat. Az `admin.js` csak
// meghívja.
//
// A KÉPERNYŐ SORRENDJE a felhasználásból következik. Aki ezt megnyitja, két
// helyzet egyikében van:
//
//   * MOST akar bekapcsolni valamit — neki a szerkesztő kell, és előtte az,
//     hogy lássa, mi történne (előnézet);
//   * KÖZBEN néz rá — neki az állapot kell: mi megy, meddig, ki fér be.
//
// Ezért van elöl az állapot, utána a szerkesztő, és a végén a jegyek meg a
// történet.

import { AP } from '../../../shared/ui/admin-ui.js'
import { U } from '../../../shared/lib/dom.js'
import { YumeAPI } from '../../../shared/api/yume.js'

const MODE_LABEL = {
  OFF: 'Kikapcsolva',
  SCHEDULED: 'Ütemezve',
  ACTIVE: 'Teljes karbantartás',
  DEGRADED: 'Részleges',
  READ_ONLY: 'Csak olvasható',
  EMERGENCY: 'Vészhelyzet'
}

const MODE_TONE = {
  OFF: 'ok', SCHEDULED: 'warn', ACTIVE: 'bad',
  DEGRADED: 'warn', READ_ONLY: 'warn', EMERGENCY: 'bad'
}

const MODE_HELP = {
  OFF: 'Minden működik.',
  SCHEDULED: 'Be van ütemezve. A látogatók visszaszámlálót látnak, de minden működik.',
  ACTIVE: 'A hatókörbe eső kérések 503-at kapnak. Az üzemeltetők bemehetnek.',
  DEGRADED: 'Csak a megadott terület áll le, a többi megy.',
  READ_ONLY: 'Böngészni lehet, módosítani nem.',
  EMERGENCY: 'Azonnali teljes lezárás. Itt a puszta admin szerep NEM elég a belépéshez — csak a helyreállítási útvonalak és a jegyek.'
}

/** Másodperc → „2 óra 5 perc”. */
function human (seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return null
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours) return `${hours} óra ${minutes} perc`
  if (minutes) return `${minutes} perc`
  return `${Math.round(total)} másodperc`
}

/** `Date` → az `<input type="datetime-local">` alakja, HELYI időben. */
function toLocalInput (iso) {
  if (!iso) return ''
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** Az `<input type="datetime-local">` értéke → ISO. Üresből `null`. */
function fromLocalInput (value) {
  if (!value) return null
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? at.toISOString() : null
}

/**
 * A karbantartási képernyő.
 *
 * @param {HTMLElement} content ide rajzol
 * @param {object} deps `api` (teszthez), `toast`
 */
export async function renderMaintenance (content, deps = {}) {
  const api = deps.api ?? YumeAPI.admin
  const toast = deps.toast ?? U.toast ?? (() => {})

  const load = async () => {
    content.replaceChildren(AP.stack([AP.note('Betöltés…')]))
    let data
    try {
      data = await api.maintenance()
    } catch (error) {
      content.replaceChildren(AP.empty('A karbantartás állapota nem elérhető', error.message))
      return
    }
    draw(data)
  }

  const draw = (data) => {
    const stack = AP.stack([])
    content.replaceChildren(stack)

    const config = data.config ?? {}
    const effective = data.effectiveMode ?? 'OFF'
    const left = human(data.secondsUntilChange)

    // ---- 1. MI VAN MOST ----
    stack.append(AP.card({
      title: 'Jelenlegi állapot',
      sub: MODE_HELP[effective] ?? '',
      actions: AP.tag(MODE_LABEL[effective] ?? effective, MODE_TONE[effective] ?? ''),
      body: AP.kv([
        ['Beállított mód', MODE_LABEL[config.mode] ?? config.mode],
        ['Hatókör', config.scope ?? 'global'],
        ['Bekapcsolva', config.enabled ? 'igen' : 'nem'],
        ['Kezdés', data.startsAtLocal ?? '—'],
        ['Befejezés', data.endsAtLocal ?? '—'],
        ['Hátralévő', left ?? '—'],
        ['Verzió', String(config.version ?? 0)],
        // A gyorsítótár állapota itt látszik, mert egy „miért nem lépett
        // életbe" kérdésre ez az első válasz.
        ['Gyorsítótár kora', data.cache?.ageMs >= 0 ? `${Math.round(data.cache.ageMs / 1000)} mp` : '—'],
        ['Utolsó hiba', data.cache?.lastError ?? 'nincs']
      ])
    }))

    // ---- 2. SZERKESZTŐ ----
    const form = document.createElement('div')
    form.className = 'mnt-admin-form'

    const field = (label, control, hint = null) => {
      const wrap = U.el('label', { class: 'mnt-admin-field' }, [
        U.el('span', { class: 'mnt-admin-label', text: label }),
        control
      ])
      if (hint) wrap.append(U.el('span', { class: 'mnt-admin-hint', text: hint }))
      return wrap
    }

    const select = (options, value) => {
      const node = document.createElement('select')
      for (const option of options) {
        const item = document.createElement('option')
        item.value = option
        item.textContent = MODE_LABEL[option] ?? option
        if (option === value) item.selected = true
        node.append(item)
      }
      return node
    }

    const modeInput = select(data.modes ?? Object.keys(MODE_LABEL), config.mode)
    const scopeInput = select(data.scopes ?? ['global'], config.scope)
    const enabledInput = U.el('input', { type: 'checkbox', ...(config.enabled ? { checked: '' } : {}) })
    const startsInput = U.el('input', { type: 'datetime-local', value: toLocalInput(config.window?.startsAt) })
    const endsInput = U.el('input', { type: 'datetime-local', value: toLocalInput(config.window?.endsAt) })
    const titleInput = U.el('input', { type: 'text', maxlength: '120', value: config.title ?? '' })
    const messageInput = U.el('textarea', { rows: '3', maxlength: '2000' })
    messageInput.value = config.publicMessage ?? ''
    const timezoneInput = U.el('input', { type: 'text', value: config.timezone ?? 'Europe/Budapest' })
    const drainToggle = U.el('input', { type: 'checkbox', ...(config.allowExistingSessions ? { checked: '' } : {}) })
    const drainInput = U.el('input', { type: 'number', min: '0', max: '3600', value: String(config.drainSeconds ?? 0) })

    form.append(
      field('Mód', modeInput, MODE_HELP[config.mode] ?? ''),
      field('Hatókör', scopeInput, 'A `global` mindent jelent; a többi egy-egy területet.'),
      field('Bekapcsolva', enabledInput, 'Enélkül a beállítás mentve van, de nem hat.'),
      field('Kezdés', startsInput, 'Üresen: azonnal érvényes.'),
      field('Befejezés', endsInput, 'Üresen: amíg ki nem kapcsolod. Lejárat után MAGÁTÓL véget ér.'),
      field('Időzóna', timezoneInput, 'Csak a kiíráshoz. A tárolt időpont abszolút.'),
      field('Cím', titleInput),
      field('Üzenet a látogatóknak', messageInput, 'Ez jelenik meg a karbantartási oldalon. Belső részletet ne írj bele.'),
      field('A bent lévők maradhatnak', drainToggle),
      field('Kiürítési idő (mp)', drainInput, 'A karbantartás kezdetétől számolva.')
    )

    const body = () => ({
      mode: modeInput.value,
      scope: scopeInput.value,
      enabled: enabledInput.checked,
      startsAt: fromLocalInput(startsInput.value),
      endsAt: fromLocalInput(endsInput.value),
      timezone: timezoneInput.value,
      title: titleInput.value,
      publicMessage: messageInput.value,
      allowExistingSessions: drainToggle.checked,
      drainSeconds: Number(drainInput.value || 0)
    })

    const previewBox = document.createElement('div')
    previewBox.className = 'mnt-admin-preview'

    const previewButton = U.el('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      text: 'Előnézet',
      onclick: async () => {
        previewBox.replaceChildren(AP.note('Számolás…'))
        try {
          const result = await api.previewMaintenance(body())
          previewBox.replaceChildren(AP.list((result.results ?? []).map(row => AP.row({
            title: row.label,
            tags: AP.tag(row.kind === 'ALLOW' ? 'bemehet' : row.kind === 'READ_ONLY' ? 'csak olvashat' : 'kizárva',
              row.kind === 'ALLOW' ? 'ok' : row.kind === 'READ_ONLY' ? 'warn' : 'bad'),
            meta: row.reason
          }))))
        } catch (error) {
          previewBox.replaceChildren(AP.note(`Az előnézet nem futott le: ${error.message}`))
        }
      }
    })

    const saveButton = U.el('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      text: 'Mentés',
      onclick: async () => {
        const wanted = body()
        // A VÉSZHELYZET KÜLÖN KÉRDÉS. Ez az egyetlen mód, ahol a puszta admin
        // szerep sem elég a belépéshez — érdemes tudni, mire nyomunk.
        if (wanted.mode === 'EMERGENCY' && wanted.enabled &&
            !globalThis.confirm?.('Vészhelyzeti lezárás: ilyenkor a sima admin szerep NEM enged be. Kilépni csak a helyreállítási útvonalakon és mentességi jeggyel lehet. Biztosan?')) {
          return
        }
        saveButton.disabled = true
        try {
          await api.setMaintenance(wanted)
          toast('Mentve', 'success')
          await load()
        } catch (error) {
          toast(`Nem sikerült menteni: ${error.message}`, 'error')
        } finally {
          saveButton.disabled = false
        }
      }
    })

    stack.append(AP.section('Beállítás'))
    stack.append(AP.card({ body: form, actions: AP.toolbar([previewButton, saveButton]) }))
    stack.append(AP.card({ title: 'Előnézet — mi történne', sub: 'Nem aktivál semmit.', body: previewBox }))

    // ---- 3. MENTESSÉGI JEGYEK ----
    const bypassBox = document.createElement('div')
    const drawBypasses = (rows) => {
      bypassBox.replaceChildren(rows.length
        ? AP.list(rows.map(row => AP.row({
          title: row.label || '(névtelen)',
          tags: AP.tag(row.scope, row.scope === 'global' ? 'warn' : ''),
          meta: `lejár: ${new Date(row.expires_at).toLocaleString('hu-HU')} · használat: ${row.use_count}`,
          trail: U.el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: 'Visszavonás',
            onclick: async () => {
              try {
                await api.revokeMaintenanceBypass(row.id)
                toast('Visszavonva', 'success')
                await load()
              } catch (error) { toast(error.message, 'error') }
            }
          })
        })))
        : AP.empty('Nincs élő jegy', 'A jegy rövid életű, aláírt, és bármikor visszavonható.'))
    }
    drawBypasses(data.bypasses ?? [])

    const minutesInput = U.el('input', { type: 'number', min: '1', max: '1440', value: '15' })
    const labelInput = U.el('input', { type: 'text', maxlength: '120', placeholder: 'mire kell' })
    stack.append(AP.section('Mentességi jegyek', { note: 'A jegy CSAK a létrehozáskor látható.' }))
    stack.append(AP.card({
      body: AP.stack([
        U.el('div', { class: 'mnt-admin-form' }, [
          U.el('label', { class: 'mnt-admin-field' }, [U.el('span', { class: 'mnt-admin-label', text: 'Megnevezés' }), labelInput]),
          U.el('label', { class: 'mnt-admin-field' }, [U.el('span', { class: 'mnt-admin-label', text: 'Percek' }), minutesInput])
        ]),
        bypassBox
      ]),
      actions: U.el('button', {
        class: 'btn btn-secondary btn-sm',
        type: 'button',
        text: 'Új jegy',
        onclick: async () => {
          try {
            const issued = await api.createMaintenanceBypass({
              label: labelInput.value, minutes: Number(minutesInput.value || 15)
            })
            // A jegy EGYSZER látszik. Ezért nem toastban jelenik meg, hanem
            // egy kijelölhető mezőben — egy eltűnő buborékból nem lehet
            // kimásolni.
            bypassBox.prepend(AP.card({
              title: 'Az új jegy — most másold ki',
              sub: `Fejléc: ${issued.header} · lejár: ${new Date(issued.expiresAt).toLocaleString('hu-HU')}`,
              body: U.el('textarea', { rows: '2', readonly: '', class: 'mnt-admin-token' }, [
                document.createTextNode(issued.token)
              ])
            }))
          } catch (error) { toast(error.message, 'error') }
        }
      })
    }))

    // ---- 4. TÖRTÉNET ----
    stack.append(AP.section('Változástörténet', { note: 'Minden mentés új verzió; a régiek megmaradnak.' }))
    stack.append(AP.card({
      body: (data.history ?? []).length
        ? AP.list(data.history.map(row => AP.row({
          title: `#${row.version} — ${MODE_LABEL[row.mode] ?? row.mode}`,
          tags: AP.tag(row.enabled ? 'bekapcsolva' : 'kikapcsolva', row.enabled ? 'bad' : 'ok'),
          meta: `${row.created_by ?? 'rendszer'} · ${new Date(row.created_at).toLocaleString('hu-HU')}`
        })))
        : AP.empty('Nincs még változás')
    }))

    // ---- 5. VIDEÓ ----
    stack.append(AP.section('Karbantartási videó', { note: 'Az assets/videos könyvtárból, magától.' }))
    stack.append(AP.card({
      body: (data.videos ?? []).length
        ? AP.list(data.videos.map(video => AP.row({
          title: video.name,
          tags: video.preferred ? AP.tag('karbantartásra szánt', 'ok') : null,
          meta: `${video.type} · ${(video.sizeBytes / 1048576).toFixed(1)} MB`
        })))
        : AP.empty('Nincs videó', 'Másolj egy maintenance.mp4-et az assets/videos könyvtárba. Nem kötelező.')
    }))
  }

  await load()
}
