/* global localStorage */
/*
 * A YUME Discord-vezérlőpultja — saját címen.
 *
 * MIÉRT KÜLÖN FELÜLET. A Discord-rész kikerült a YUME adminfelületéről, mert
 * más a közönsége és más a jogcíme: ide az is beléphet, akinek a YUME-ban
 * NINCS admin jogosultsága, csak a Discord-szerverén van „Szerver kezelése"
 * joga. Egy ilyen embernek nem kell — és nem is szabad — látnia a katalógust,
 * a felhasználókat vagy a moderációt.
 *
 * AZONOS EREDET, KÜLÖN TÁROLÓ. A kérések ugyanarra az alkalmazásra mennek
 * (a fordított proxy mindkét nevet ide irányítja), tehát nincs CORS. A
 * munkamenet viszont külön, mert a böngésző eredetenként tárol — ide külön
 * kell belépni, és ez így helyes: a két felület két különböző jogosultsági
 * kört szolgál.
 */

import { Api, ApiError, Auth } from './api.js'
import { el, svg, toast } from './dom.js'
import { messages } from './messages.js'
import * as Views from './views.js'

const NEZETEK = [
  ['overview', 'Áttekintés', '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'],
  ['messages', 'Tartós üzenetek', '<path d="M4 4h16v12H5.17L4 17.17z"/>'],
  ['members', 'Tagok', '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/>'],
  ['activity', 'Aktivitás', '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
  ['channels', 'Csatornák', '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'],
  ['roles', 'Szerepkörök', '<path d="M12 2 4 7v10l8 5 8-5V7z"/>'],
  ['commands', 'Parancsok', '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'],
  ['notifications', 'Értesítések', '<path d="m22 2-7 20-4-9-9-4z"/>'],
  ['health', 'Bot állapota', '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'],
  ['audit', 'Napló', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'],
  ['settings', 'Beállítások', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.62.65 1.09 1.29 1.1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>']
]

/** A `settings` guild nélkül is megnyitható — oda épp guildet választani megy az ember. */
const GUILD_NELKUL = ['settings']

const TAR_GUILD = 'yume-discord-guild'

const allapot = {
  nezet: 'overview',
  guildId: '',
  guildek: [],
  user: null
}

const gyoker = () => document.getElementById('app')

// ---------------------------------------------------------------- belépés

function belepoLap (uzenet = null) {
  // E-MAIL VAGY FELHASZNÁLÓNÉV. A kiszolgáló mindkettőt elfogadja ugyanazon a
  // mezőn; egy `type="email"` viszont a böngészővel utasíttatná el a
  // felhasználónevet, mielőtt a kérés elindulna.
  const email = el('input', { class: 'input', type: 'text', placeholder: 'e-mail vagy felhasználónév', autocomplete: 'username' })
  const jelszo = el('input', { class: 'input', type: 'password', placeholder: 'jelszó', autocomplete: 'current-password' })
  const hiba = el('div', { class: 'form-error', hidden: !uzenet, text: uzenet ?? '' })
  const gomb = el('button', { class: 'btn btn-primary', type: 'submit' }, ['Belépés'])

  const kuld = async e => {
    e.preventDefault()
    hiba.hidden = true
    gomb.disabled = true
    try {
      const valasz = await Api.login(email.value.trim(), jelszo.value)
      Auth.save(valasz)
      await indul()
    } catch (err) {
      /*
       * A HIBA SZÖVEGE NEM ÁRULJA EL, LÉTEZIK-E A FIÓK. A kiszolgáló sem
       * különbözteti meg a rossz jelszót a nem létező fióktól; a felület
       * sem tehet mást.
       */
      hiba.textContent = err.status === 401
        ? 'Hibás e-mail/felhasználónév vagy jelszó.'
        : 'A belépés nem sikerült: ' + err.message
      hiba.hidden = false
      gomb.disabled = false
    }
  }

  const urlap = el('form', { class: 'dc-login-card', onsubmit: kuld }, [
    el('div', { class: 'dc-brand' }, [svg('<circle cx="12" cy="12" r="9"/>', 20), 'YUME']),
    el('h1', { style: 'margin:0;font-size:var(--text-lg);', text: 'Discord vezérlőpult' }),
    el('p', {
      class: 'list-row-sub',
      style: 'margin:0;',
      text: 'A YUME-fiókoddal lépj be. A Discord-szervereidhez való jogod ' +
        'a fiók összekötése után érvényesül.'
    }),
    email, jelszo, hiba, gomb
  ])

  gyoker().replaceChildren(el('div', { class: 'dc-login' }, [urlap]))
  email.focus()
}

// ---------------------------------------------------------------- váz

function fejlec (ujraRajzol) {
  const valaszto = el('select', { class: 'input', 'aria-label': 'Discord szerver' })
  for (const g of allapot.guildek) {
    valaszto.append(el('option', { value: g.id, selected: g.id === allapot.guildId }, [g.name ?? g.id]))
  }
  if (!allapot.guildek.length) {
    valaszto.append(el('option', { value: '' }, ['nincs összekötött szerver']))
    valaszto.disabled = true
  }
  valaszto.addEventListener('change', () => {
    allapot.guildId = valaszto.value
    try { localStorage.setItem(TAR_GUILD, allapot.guildId) } catch { /* privát ablak */ }
    ujraRajzol()
  })

  const kilep = el('button', { class: 'btn btn-ghost btn-sm' }, ['Kilépés'])
  kilep.addEventListener('click', () => {
    Auth.clear()
    belepoLap()
  })

  return el('header', { class: 'dc-top' }, [
    el('div', { class: 'dc-brand' }, [
      svg('<circle cx="12" cy="12" r="9"/>', 20),
      'YUME',
      el('span', { class: 'dc-brand-sub', text: 'Discord vezérlőpult' })
    ]),
    el('div', { class: 'dc-spacer' }),
    el('div', { class: 'dc-guild' }, [
      el('span', { class: 'meta-row-sub', text: 'Szerver' }),
      valaszto
    ]),
    allapot.user ? el('span', { class: 'badge', text: allapot.user.username ?? '' }) : null,
    kilep
  ])
}

async function rajzol () {
  const app = gyoker()
  const ujraRajzol = () => { rajzol().catch(e => toast(e.message, 'error')) }

  const menu = el('nav', { class: 'dc-nav' }, NEZETEK.map(([kulcs, cimke, ikon]) => {
    const b = el('button', {
      class: 'dc-nav-item' + (allapot.nezet === kulcs ? ' on' : ''),
      type: 'button'
    }, [svg(ikon, 16), el('span', { text: cimke })])
    b.addEventListener('click', () => {
      allapot.nezet = kulcs
      window.location.hash = '#/' + kulcs
      ujraRajzol()
    })
    return b
  }))

  const fo = el('div', { class: 'dc-main' })
  app.replaceChildren(fejlec(ujraRajzol), el('div', { class: 'dc-body' }, [menu, fo]))

  const [kulcs, cimke] = NEZETEK.find(n => n[0] === allapot.nezet) ?? NEZETEK[0]
  fo.append(el('div', { class: 'dc-head' }, [
    el('h1', { text: cimke }),
    el('p', { text: LEIRAS[kulcs] ?? '' })
  ]))

  const doboz = el('div', { text: 'Betöltés…' })
  fo.append(doboz)

  if (!allapot.guildId && !GUILD_NELKUL.includes(kulcs)) {
    doboz.replaceChildren(el('div', { class: 'dc-gap' }, [
      el('h3', { text: 'Nincs kiválasztott szerver' }),
      el('p', {
        text: 'Ez a felület mindig EGY szerverről szól. Kösd össze a Discord-fiókodat a Beállításoknál, ' +
          'és a szervereid megjelennek a fenti választóban.'
      })
    ]))
    return
  }

  try {
    doboz.replaceChildren(await nezetTartalom(kulcs, ujraRajzol))
  } catch (e) {
    /*
     * A GUILD-KAPU OKA KIÍRVA. A kiszolgáló pontosan megmondja, mi hiányzik;
     * enélkül minden elutasítás „valami hiba" volna, és az üzemeltető a
     * rossz helyen keresné.
     */
    const okok = {
      no_link: 'Ehhez a fiókhoz nincs Discord-fiók kötve. A Beállításoknál kötheted össze.',
      not_member: 'Ez a fiók nem tagja ennek a szervernek.',
      stale: 'A tárolt jogosultság elavult — kösd össze újra a Discord-fiókodat.',
      insufficient: 'Ebben a szerverben nincs „Szerver kezelése" jogosultságod.'
    }
    const szoveg = (e instanceof ApiError && okok[e.detail]) ? okok[e.detail] : e.message
    doboz.replaceChildren(el('div', { class: 'dc-gap' }, [
      el('h3', { text: 'Nem tölthető be' }),
      el('p', { text: szoveg })
    ]))
  }
}

async function nezetTartalom (kulcs, ujraRajzol) {
  const g = allapot.guildId
  switch (kulcs) {
    case 'overview': return await Views.overview(g)
    case 'messages': return await messages(g, ujraRajzol)
    case 'members': return await Views.members(g)
    case 'activity': return await Views.activity(g)
    case 'channels': return await Views.channels(g)
    case 'roles': return await Views.roles(g)
    case 'commands': return Views.commands()
    case 'notifications': return await Views.notifications(g)
    case 'health': return await Views.health(g)
    case 'audit': return await Views.audit(g)
    case 'settings': return await Views.settings(g, ujraRajzol)
    default: return el('div', { text: 'Ismeretlen nézet.' })
  }
}

const LEIRAS = {
  overview: 'A szerver számai és a bot állapota egy helyen.',
  messages: 'Egy üzenet, ami frissül — nem szaporodik.',
  members: 'Tagmozgás és növekedés.',
  activity: 'Üzenetforgalom naponta és csatornánként.',
  channels: 'A szerver csatornái, ahogy a Discord látja őket.',
  roles: 'A szerepkörök rangsor szerint.',
  commands: 'A bot parancsainak használata.',
  notifications: 'A YUME kimenő értesítései és a kézbesítésük.',
  health: 'A bot szondái és a frissítések kimenetele.',
  audit: 'Ki mit csinált ezen a felületen.',
  settings: 'A Discord-fiók összekötése és a szervereid.'
}

// ---------------------------------------------------------------- indulás

/**
 * A VISSZAIRÁNYÍTÁS ÜZENETE. Az összekötés után a Discord ide hozza vissza a
 * böngészőt egy `?link=` jelzéssel; kiírjuk, majd letöröljük a címről, hogy
 * egy frissítés ne ismételje meg egy régen lezajlott művelet üzenetét.
 */
function osszekotesUzenet () {
  const talalat = /[?&]link=([a-z_]+)/.exec(window.location.hash || '') ??
    /[?&]link=([a-z_]+)/.exec(window.location.search || '')
  if (!talalat) return
  const uzenetek = {
    ok: ['A Discord-fiókod össze van kötve.', 'success'],
    cancelled: ['Az összekötést megszakítottad.', ''],
    invalid: ['A Discord válasza hiányos volt. Próbáld újra.', 'error'],
    expired: ['Az összekötés lejárt, vagy már felhasználtad. Indítsd újra.', 'error'],
    taken: ['Ez a Discord-fiók már egy MÁSIK YUME-fiókhoz van kötve.', 'error'],
    failed: ['Az összekötés nem sikerült.', 'error']
  }
  const [uzenet, tone] = uzenetek[talalat[1]] ?? ['Ismeretlen válasz az összekötésből.', '']
  toast(uzenet, tone)
  window.history.replaceState(null, '', window.location.pathname + '#/settings')
}

async function indul () {
  if (!Auth.token()) { belepoLap(); return }

  /*
   * A MUNKAMENET ELLENŐRZÉSE EGY VALÓDI KÉRÉSSEL. A tokenből kiolvasott név
   * nem bizonyít semmit — az aláírás vizsgálata a kiszolgáló dolga. A
   * `/status` hitelesítést kér, tehát ez az egy hívás megmondja, él-e még a
   * munkamenet, és közben azt is, be van-e kötve a bot.
   */
  allapot.user = Auth.user()
  try {
    await Api.status()
  } catch (e) {
    if (e.status === 401) { Auth.clear(); belepoLap('A munkameneted lejárt. Lépj be újra.'); return }
    throw e
  }

  osszekotesUzenet()

  const horgony = (window.location.hash || '').replace(/^#\//, '').split('?')[0]
  if (NEZETEK.some(n => n[0] === horgony)) allapot.nezet = horgony

  // A szerverek listája az összekötött fiókból. Ami nincs benne, ahhoz
  // nincs is jogosultság — a kiszolgáló ugyanezt ellenőrzi.
  try {
    const link = await Api.linkStatus()
    allapot.guildek = link?.guilds ?? []
  } catch {
    allapot.guildek = []
  }

  let tarolt = ''
  try { tarolt = localStorage.getItem(TAR_GUILD) ?? '' } catch { tarolt = '' }
  allapot.guildId = allapot.guildek.some(g => g.id === tarolt)
    ? tarolt
    : (allapot.guildek[0]?.id ?? '')

  await rajzol()
}

window.addEventListener('hashchange', () => {
  const horgony = (window.location.hash || '').replace(/^#\//, '').split('?')[0]
  if (NEZETEK.some(n => n[0] === horgony) && horgony !== allapot.nezet) {
    allapot.nezet = horgony
    rajzol().catch(e => toast(e.message, 'error'))
  }
})

indul().catch(e => {
  gyoker().replaceChildren(el('div', { class: 'dc-login' }, [
    el('div', { class: 'dc-login-card' }, [
      el('h1', { style: 'margin:0;font-size:var(--text-lg);', text: 'Nem indult el' }),
      el('p', { class: 'list-row-sub', text: String(e.message ?? e) })
    ])
  ]))
})
