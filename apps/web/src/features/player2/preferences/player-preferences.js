// A lejátszó beállításai.
//
// NEM ÚJ RENDSZER. A YUME-nak van beállításkezelője (`shared/state/preferences.js`):
// alapértékekkel, megengedett értékekkel, szerveroldali spec-kel és
// profil-szinkronnal. A 26. pont pont ezt kéri — és a 45. pont szerint amit a
// rendszer már jól csinál, azt használni kell, nem lecserélni.
//
// Ez a modul tehát ADAPTER: a lejátszó-specifikus kulcsokat, alapértékeket és
// sémát adja hozzá, a tárolást és a szinkront a meglévőre bízza.
//
// VERZIÓZÁS. A 26. pont kéri, és jó okkal: ha egy későbbi verzió átnevez vagy
// átalakít egy kulcsot, a régi beállítás nem veszhet el és nem is romolhat el.
// A `migrate()` ezt intézi, és a verziószám maga is beállítás.

/** A séma. Minden kulcs: alapérték + érvényesség. */
export const PLAYER_PREFERENCE_SCHEMA = Object.freeze({
  // --- lejátszás ---
  'player.autoplay': { default: true, type: 'boolean' },
  'player.autoplayNext': { default: true, type: 'boolean' },
  'player.rememberPosition': { default: true, type: 'boolean' },
  'player.rememberRate': { default: false, type: 'boolean' },
  'player.rememberVolume': { default: true, type: 'boolean' },
  'player.rate': { default: 1, type: 'number', values: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
  'player.volume': { default: 1, type: 'number', min: 0, max: 1 },
  'player.muted': { default: false, type: 'boolean' },

  // --- minőség ---
  'player.quality.auto': { default: true, type: 'boolean' },
  'player.quality.preferred': { default: 'auto', type: 'string', values: ['auto', '360', '480', '720', '1080', '1440', '2160'] },
  'player.quality.mobile': { default: '720', type: 'string', values: ['auto', '360', '480', '720', '1080'] },
  'player.quality.wifi': { default: '1080', type: 'string', values: ['auto', '480', '720', '1080', '1440', '2160'] },
  'player.quality.dataSaver': { default: false, type: 'boolean' },

  // --- felirat ---
  'player.subtitle.enabled': { default: true, type: 'boolean' },
  'player.subtitle.size': { default: 100, type: 'number', min: 50, max: 200 },
  'player.subtitle.weight': { default: 600, type: 'number', values: [400, 600, 800] },
  'player.subtitle.color': { default: '#ffffff', type: 'string' },
  'player.subtitle.background': { default: '#000000', type: 'string' },
  'player.subtitle.backgroundOpacity': { default: 0.35, type: 'number', min: 0, max: 1 },
  'player.subtitle.outline': { default: true, type: 'boolean' },
  'player.subtitle.bottomOffset': { default: 8, type: 'number', min: 0, max: 40 },
  'player.subtitle.delayMs': { default: 0, type: 'number', min: -10000, max: 10000 },

  // --- átugrás ---
  'player.skip.introAuto': { default: false, type: 'boolean' },
  'player.skip.outroAuto': { default: false, type: 'boolean' },

  // --- felület ---
  'player.ui.autoHide': { default: true, type: 'boolean' },
  'player.ui.autoHideMs': { default: 2800, type: 'number', min: 1000, max: 10000 },
  'player.ui.cinema': { default: false, type: 'boolean' },
  'player.ui.ambient': { default: true, type: 'boolean' },
  'player.ui.ambientIntensity': { default: 60, type: 'number', min: 0, max: 100 },
  'player.ui.miniPlayer': { default: true, type: 'boolean' },
  'player.ui.gestures': { default: true, type: 'boolean' },
  'player.ui.keyboard': { default: true, type: 'boolean' },
  'player.ui.nextCountdownSec': { default: 5, type: 'number', min: 0, max: 30 },

  // A séma verziója. Nem a felhasználó állítja — a `migrate` írja.
  'player.schemaVersion': { default: 1, type: 'number' }
})

export const PLAYER_SCHEMA_VERSION = 1

/**
 * Egy érték érvényesítése a séma szerint.
 *
 * Érvénytelen érték esetén az ALAPÉRTÉK jön vissza, nem kivétel. Egy elrontott
 * beállítás nem akadályozhatja meg a lejátszást — a legrosszabb, ami történhet,
 * hogy a néző alapértelmezéssel néz filmet.
 */
export function validate (key, value) {
  const spec = PLAYER_PREFERENCE_SCHEMA[key]
  if (!spec) return undefined
  if (value === undefined || value === null) return spec.default

  if (spec.type === 'boolean') return typeof value === 'boolean' ? value : spec.default
  if (spec.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) return spec.default
    if (spec.values && !spec.values.includes(number)) return spec.default
    if (spec.min !== undefined && number < spec.min) return spec.min
    if (spec.max !== undefined && number > spec.max) return spec.max
    return number
  }
  if (spec.type === 'string') {
    const text = String(value)
    if (spec.values && !spec.values.includes(text)) return spec.default
    return text
  }
  return spec.default
}

/** A teljes alapértelmezett készlet. */
export function defaults () {
  return Object.fromEntries(
    Object.entries(PLAYER_PREFERENCE_SCHEMA).map(([key, spec]) => [key, spec.default]))
}

/**
 * Régi beállításkészlet felhozása a mai sémára.
 *
 * ADAT NEM VESZHET EL: amit ismerünk, azt átvesszük; amit nem, azt ÉRINTETLENÜL
 * hagyjuk (egy későbbi verzió kulcsa lehet, és egy visszaállítás után még kelleni
 * fog). Ami hiányzik, az alapértéket kap.
 */
export function migrate (stored = {}) {
  const from = Number(stored['player.schemaVersion']) || 0
  const out = { ...stored }

  // Jövőbeli migrációk helye. Egy példa a szerződésre, nem üres ág:
  //   if (from < 2) out['player.ui.theater'] = out['player.ui.cinema'] ?? false

  for (const [key, spec] of Object.entries(PLAYER_PREFERENCE_SCHEMA)) {
    out[key] = key in stored ? validate(key, stored[key]) : spec.default
  }
  out['player.schemaVersion'] = PLAYER_SCHEMA_VERSION
  return { values: out, migratedFrom: from }
}

/**
 * A lejátszó beállításai, a MEGLÉVŐ `Prefs` fölé.
 *
 * @param {object} prefs a `shared/state/preferences.js` `Prefs` objektuma
 */
export function createPlayerPreferences (prefs) {
  const local = new Map()

  const get = (key) => {
    if (local.has(key)) return local.get(key)
    const spec = PLAYER_PREFERENCE_SCHEMA[key]
    if (!spec) return undefined
    let raw
    try { raw = prefs?.get?.(key) } catch { raw = undefined }
    return validate(key, raw ?? spec.default)
  }

  const set = (key, value) => {
    const spec = PLAYER_PREFERENCE_SCHEMA[key]
    if (!spec) return undefined
    const clean = validate(key, value)
    local.set(key, clean)
    try { prefs?.set?.(key, clean) } catch { /* a tárolás hibája nem kiesés */ }
    return clean
  }

  return {
    get,
    set,
    all: () => Object.fromEntries(Object.keys(PLAYER_PREFERENCE_SCHEMA).map(k => [k, get(k)])),
    schema: PLAYER_PREFERENCE_SCHEMA
  }
}
