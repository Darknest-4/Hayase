/*
 * SZERVER-BEÁLLÍTÁSOK — nyelv, hírfolyam, moderálás, rangok.
 *
 * Minden mentés a kiszolgálón ellenőrzött: a csatorna és a rang ehhez a
 * szerverhez tartozik-e, a műfaj és a YUME-szerepkör létezik-e. A felület
 * csak abból kínál választást, amit a kiszolgáló és a Discord visszaadott —
 * nem kitalált listából.
 */

import { Api } from './api.js'
import { el, hianyzoForras, panel, sorok, toast } from './dom.js'

const NYELV = {
  hu: 'Magyar',
  en: 'English',
  auto: 'A Discord-szerver nyelve szerint'
}

/** Egy mentő gomb: lenyomva letiltva, hiba esetén a hiba szövegével. */
function mento (felirat, fn) {
  const gomb = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, [felirat])
  gomb.addEventListener('click', async () => {
    gomb.disabled = true
    try {
      await fn()
      toast('Mentve.', 'success')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      gomb.disabled = false
    }
  })
  return gomb
}

/** Egy lenyíló lista: az üres elem „nincs". */
function valaszto (elemek, kivalasztott, ures = '— nincs —') {
  const s = el('select', { class: 'input' })
  s.append(el('option', { value: '' }, [ures]))
  for (const [ertek, felirat] of elemek) {
    s.append(el('option', { value: ertek, selected: ertek === kivalasztott }, [felirat]))
  }
  return s
}

const sor = (cimke, mezo, sugo = null) => el('label', { class: 'dc-field', style: 'display:grid;gap:4px;margin-bottom:var(--space-3);max-width:34rem;' }, [
  el('span', { class: 'meta-row-sub', text: cimke }),
  mezo,
  sugo ? el('span', { class: 'list-row-sub', style: 'margin:0;', text: sugo }) : null
])

export async function configView (guildId, ujra) {
  const [d, csatornakV, rangokV] = await Promise.all([
    Api.config(guildId),
    Api.channels(guildId).catch(() => null),
    Api.roles(guildId).catch(() => null)
  ])
  const s = d.settings
  const szovegesCsatornak = (csatornakV?.data ?? []).filter(c => c.type === 0 || c.type === 5)
    .sort((a, b) => a.position - b.position)
  // Kezelhető rang: nem az @everyone (azonosítója a szerveré), és nem integrációé.
  const rangok = (rangokV?.data ?? []).filter(r => r.id !== guildId && !r.managed)
    .sort((a, b) => b.position - a.position)
  const rangNev = id => rangok.find(r => r.id === id)?.name ?? id
  const nincsDiscord = !csatornakV?.available || !rangokV?.available

  const wrap = el('div')

  if (nincsDiscord) {
    wrap.append(hianyzoForras('A Discord most nem kérdezhető le',
      'A csatornák és a rangok listája nélkül a moderálás és a rangok nem állíthatók be — a nyelv és a hírfolyam igen.',
      ['bot token a kiszolgálón', 'a bot legyen tagja ennek a szervernek']))
  }

  // ---- nyelv ----
  const nyelv = valaszto(Object.entries(NYELV).map(([k, v]) => [k, v]), s.language, 'Magyar')
  nyelv.firstChild.remove() // itt nincs „nincs": mindig van nyelv
  wrap.append(panel('Nyelv', 'a szerverre kimenő üzenetek nyelve (a parancsválasz a hívó Discord-nyelvén megy)', el('div', {}, [
    sor('A bot nyelve ezen a szerveren', nyelv,
      s.preferredLocale ? `A Discord-szerver nyelve most: ${s.preferredLocale}` : null),
    mento('Nyelv mentése', async () => { await Api.saveConfig(guildId, { language: nyelv.value }) })
  ])))

  // ---- hírfolyam ----
  const mufajDobozok = (d.options.genres ?? []).map(g => {
    const doboz = el('input', { type: 'checkbox', value: g.slug, checked: s.feedGenres.includes(g.slug) })
    return { doboz, elem: el('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin:0 12px 6px 0;' }, [doboz, g.name]) }
  })
  const szezon = el('input', { type: 'checkbox', checked: s.feedCurrentSeason })
  wrap.append(panel('Az új epizódok hírfolyama', 'mely címek új része kerüljön a hírfolyam-csatornába', el('div', {}, [
    el('p', { class: 'list-row-sub', style: 'margin:0 0 var(--space-2);', text: 'Ha egy műfaj sincs bejelölve, minden cím bekerül.' }),
    el('div', { style: 'margin-bottom:var(--space-3);' }, mufajDobozok.map(m => m.elem)),
    el('label', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:var(--space-3);' }, [szezon, 'Csak az aktuális szezon címei']),
    mento('Hírfolyam mentése', async () => {
      await Api.saveConfig(guildId, {
        feedGenres: mufajDobozok.filter(m => m.doboz.checked).map(m => m.doboz.value),
        feedCurrentSeason: szezon.checked
      })
    })
  ])))

  // ---- animénkénti rang ----
  const keres = el('input', { class: 'input', type: 'search', placeholder: 'cím keresése…' })
  const talalatok = el('select', { class: 'input' }, [el('option', { value: '' }, ['— előbb keress —'])])
  const animeRang = valaszto(rangok.map(r => [r.id, r.name]), '')
  let idozito = null
  keres.addEventListener('input', () => {
    clearTimeout(idozito)
    idozito = setTimeout(async () => {
      const q = keres.value.trim()
      if (q.length < 2) return
      const r = await Api.searchAnime(q).catch(() => null)
      talalatok.replaceChildren(...(r?.data ?? []).slice(0, 20).map(a =>
        el('option', { value: a.id }, [a.canonical_title + (a.season_year ? ` (${a.season_year})` : '')])))
      if (!talalatok.children.length) talalatok.append(el('option', { value: '' }, ['nincs találat']))
    }, 300)
  })
  wrap.append(panel('Animénként megszólítható rang', 'az új rész bejelentése megemlíti a címhez rendelt rangot — csak azt', el('div', {}, [
    sorok((d.animeMentions ?? []).map(m => {
      const torol = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ['Törlés'])
      torol.addEventListener('click', async () => {
        try { await Api.removeAnimeMention(guildId, m.animeId); await ujra() } catch (e) { toast(e.message, 'error') }
      })
      return { label: m.title, tone: 'ok', detail: '@' + rangNev(m.discordRoleId), action: torol }
    }), 'Még egy címhez sincs rang rendelve.'),
    el('div', { style: 'margin-top:var(--space-3);' }, [
      sor('Cím', keres), sor('Találat', talalatok), sor('Rang', animeRang),
      mento('Hozzárendelés', async () => {
        if (!talalatok.value || !animeRang.value) throw new Error('Válassz címet és rangot.')
        await Api.setAnimeMention(guildId, talalatok.value, animeRang.value)
        await ujra()
      })
    ])
  ])))

  // ---- moderálás ----
  const modCsatorna = valaszto(szovegesCsatornak.map(c => [c.id, '#' + c.name]), s.moderationChannelId, '— kikapcsolva —')
  wrap.append(panel('Moderálás Discordból', 'a YUME-bejelentések a moderátori csatornába, döntés gombokkal', el('div', {}, [
    el('p', {
      class: 'list-row-sub',
      style: 'margin:0 0 var(--space-3);max-width:44rem;',
      text: 'A csatornába a bejelentett tartalom részlete kerül — PRIVÁT csatornát válassz, amit csak a moderátorok látnak. ' +
        'Dönteni csak az tud, akinek a Discord-fiókja YUME-fiókhoz van kötve, és annak YUME-moderátori joga van; ' +
        'a Discordon lévő rang nem számít. A döntés a YUME moderálási naplójába kerül.'
    }),
    sor('Moderátori csatorna', modCsatorna),
    mento('Moderálás mentése', async () => { await Api.saveConfig(guildId, { moderationChannelId: modCsatorna.value || null }) })
  ])))

  // ---- rangok ----
  const kotottRang = valaszto(rangok.map(r => [r.id, r.name]), s.linkedRoleId)
  const megfeleltetes = (d.options.yumeRoles ?? []).map(y => {
    const most = (d.roleMappings ?? []).find(m => m.yumeRole === y.slug)?.discordRoleId ?? ''
    return { yume: y, mezo: valaszto(rangok.map(r => [r.id, r.name]), most) }
  })
  wrap.append(panel('Szerepkör-szinkron', 'YUME-fiók → Discord-rang, tízpercenként', el('div', {}, [
    el('p', {
      class: 'list-row-sub',
      style: 'margin:0 0 var(--space-3);max-width:44rem;',
      text: 'A beállított rangokat a bot KEZELI: akinek nem jár, attól leveszi — akkor is, ha kézzel kapta. Csak erre ' +
        'használt rangot állíts be. A bot csak a saját rangja ALATT álló rangot adhatja.'
    }),
    sor('Az összekötött YUME-fiókú tagok rangja', kotottRang),
    mento('Mentés', async () => { await Api.saveConfig(guildId, { linkedRoleId: kotottRang.value || null }) }),
    el('h4', { style: 'margin:var(--space-4) 0 var(--space-2);', text: 'YUME-szerepkörök' }),
    ...megfeleltetes.map(m => sor(m.yume.name, m.mezo)),
    mento('Megfeleltetés mentése', async () => {
      await Api.saveRoleMappings(guildId, megfeleltetes
        .filter(m => m.mezo.value)
        .map(m => ({ yumeRole: m.yume.slug, discordRoleId: m.mezo.value })))
    })
  ])))

  return wrap
}
