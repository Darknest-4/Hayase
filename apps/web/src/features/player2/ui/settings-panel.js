/* global document */
// A teljes beállításpanel.
//
// NEM UGYANAZ, mint a lejátszó fogaskerék-menüje. Az a MOSTANI részről szól:
// melyik minőség menjen, melyik felirat látszódjon, milyen gyorsan. Ez a
// panel a TARTÓS döntésekről: mit csináljon a lejátszó mindig.
//
// A PANEL A SÉMÁBÓL ÉPÜL, nem kézzel felsorolt mezőkből. Egy kézzel írt lista
// és egy séma előbb-utóbb eltér egymástól — és a különbség csendben egy
// beállítás, amit senki nem tud átállítani, vagy ami nem csinál semmit.
// Ezért itt csak a CSOPORTOSÍTÁS és a MAGYAR NÉV van kézzel; a típus, a
// tartomány és az alapérték a sémából jön.

import { PLAYER_PREFERENCE_SCHEMA } from '../preferences/player-preferences.js'

/** A csoportok, a 25. pont sorrendjében. A kulcsok a sémából valók. */
export const SETTINGS_GROUPS = Object.freeze([
  {
    title: 'Lejátszás',
    keys: [
      ['player.autoplay', 'Automatikus indítás'],
      ['player.autoplayNext', 'Következő rész automatikusan'],
      ['player.ui.nextCountdownSec', 'Visszaszámlálás a következő részig (mp)'],
      ['player.rememberPosition', 'Megjegyzi, hol tartottam'],
      ['player.rememberRate', 'Megjegyzi a sebességet'],
      ['player.rememberVolume', 'Megjegyzi a hangerőt'],
      ['player.skip.introAuto', 'Intró átugrása magától'],
      ['player.skip.outroAuto', 'Stáblista átugrása magától']
    ]
  },
  {
    title: 'Minőség',
    keys: [
      ['player.quality.auto', 'Automatikus minőség'],
      ['player.quality.preferred', 'Kívánt minőség'],
      ['player.quality.mobile', 'Mobilhálózaton'],
      ['player.quality.wifi', 'Wifin'],
      ['player.quality.dataSaver', 'Adattakarékos mód']
    ]
  },
  {
    title: 'Felirat',
    keys: [
      ['player.subtitle.enabled', 'Felirat bekapcsolva'],
      ['player.subtitle.language', 'Nyelv'],
      ['player.subtitle.size', 'Méret (%)'],
      ['player.subtitle.weight', 'Vastagság'],
      ['player.subtitle.color', 'Szín'],
      ['player.subtitle.background', 'Háttér'],
      ['player.subtitle.backgroundOpacity', 'Háttér átlátszatlansága'],
      ['player.subtitle.outline', 'Körvonal'],
      ['player.subtitle.bottomOffset', 'Távolság az aljától (%)'],
      ['player.subtitle.delayMs', 'Késleltetés (ms)']
    ]
  },
  {
    title: 'Felület',
    keys: [
      ['player.ui.autoHide', 'Vezérlők elrejtése tétlenségre'],
      ['player.ui.autoHideMs', 'Elrejtés ideje (ms)'],
      ['player.ui.cinema', 'Mozi mód'],
      ['player.ui.ambient', 'Környezeti fény'],
      ['player.ui.ambientIntensity', 'Fény erőssége'],
      ['player.ui.miniPlayer', 'Kislejátszó'],
      ['player.ui.gestures', 'Érintéses mozdulatok'],
      ['player.ui.keyboard', 'Billentyűparancsok']
    ]
  }
])

/**
 * Egy mező vezérlőjének fajtája a séma alapján.
 *
 * `select` ott, ahol felsorolt értékek vannak; `range` ott, ahol
 * tartomány — egy szabadon írható szám mezőbe elgépelhető a tartományon
 * kívüli érték, és akkor a néző azt látja, hogy „nem fogadja el", de nem
 * tudja, miért.
 */
export function controlFor (key) {
  const spec = PLAYER_PREFERENCE_SCHEMA[key]
  if (!spec) return null
  if (spec.type === 'boolean') return 'switch'
  if (spec.values) return 'select'
  if (spec.type === 'number' && spec.min !== undefined && spec.max !== undefined) return 'range'
  if (spec.type === 'string' && /color|background$/i.test(key)) return 'color'
  return 'text'
}

/**
 * @param {object} prefs a `createPlayerPreferences` eredménye
 * @param {object} options `onChange(key, value)`
 */
export function createSettingsPanel (prefs, options = {}) {
  const node = document.createElement('div')
  node.className = 'yp-settings'

  const inputs = new Map()

  for (const group of SETTINGS_GROUPS) {
    const section = document.createElement('section')
    section.className = 'yp-settings-group'

    const heading = document.createElement('h3')
    heading.className = 'yp-settings-title'
    heading.textContent = group.title
    section.append(heading)

    for (const [key, label] of group.keys) {
      const spec = PLAYER_PREFERENCE_SCHEMA[key]
      // A SÉMÁBÓL HIÁNYZÓ KULCS KIMARAD, nem hibázik. Egy panel, ami egy
      // átnevezett beállítás miatt egészben elszáll, rosszabb, mint egy, ami
      // eggyel kevesebb sort mutat.
      if (!spec) continue

      const row = document.createElement('label')
      row.className = 'yp-settings-row'

      const text = document.createElement('span')
      text.className = 'yp-settings-label'
      text.textContent = label
      row.append(text)

      const kind = controlFor(key)
      const input = document.createElement(kind === 'select' ? 'select' : 'input')
      input.className = 'yp-settings-input'

      if (kind === 'switch') {
        input.type = 'checkbox'
        input.checked = prefs.get(key) === true
      } else if (kind === 'select') {
        for (const value of spec.values) {
          const option = document.createElement('option')
          option.value = String(value)
          option.textContent = String(value)
          input.append(option)
        }
        input.value = String(prefs.get(key))
      } else if (kind === 'range') {
        input.type = 'range'
        input.min = String(spec.min)
        input.max = String(spec.max)
        // A lépésköz a TARTOMÁNYBÓL jön: egy 0–1-es átlátszatlanság
        // egészekkel lépve három állást ismerne.
        input.step = String(spec.max - spec.min <= 2 ? 0.05 : 1)
        input.value = String(prefs.get(key))
      } else if (kind === 'color') {
        input.type = 'color'
        input.value = String(prefs.get(key))
      } else {
        input.type = 'text'
        input.value = String(prefs.get(key) ?? '')
      }

      const read = () => {
        if (kind === 'switch') return input.checked
        if (spec.type === 'number') return Number(input.value)
        return input.value
      }

      input.addEventListener('change', () => {
        // A MENTETT ÉRTÉK jön vissza, nem amit beírtak: az érvényesítés a
        // tartományra szoríthatta. A mező ezért felveszi, amit a séma
        // elfogadott — különben a panel mást mutatna, mint ami érvényes.
        const saved = prefs.set(key, read())
        if (saved !== undefined && kind !== 'switch') input.value = String(saved)
        if (saved !== undefined && kind === 'switch') input.checked = saved === true
        options.onChange?.(key, saved)
      })

      inputs.set(key, input)
      row.append(input)
      section.append(row)
    }
    node.append(section)
  }

  return {
    node,
    inputs,
    /** Minden mező újraolvasása a tárolóból — például áttérés után. */
    refresh () {
      for (const [key, input] of inputs) {
        const value = prefs.get(key)
        if (input.type === 'checkbox') input.checked = value === true
        else input.value = String(value ?? '')
      }
    }
  }
}
