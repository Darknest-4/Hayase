/*
 * A vezérlőpult nézetei.
 *
 * EGY SZABÁLY TARTJA ŐKET EGYBEN: ami nincs megmérve, azt nem írjuk ki. Ahol
 * a Discord REST-en elérhető az adat (létszám, csatornák, szerepkörök), ott
 * valós adat van. Ahol gateway kellene hozzá (üzenetforgalom, tagmozgás,
 * parancshasználat), ott a nézet AZT mondja meg, mi hiányzik — nem mutat
 * nullát, és nem talál ki idősort.
 */

import { Api } from './api.js'
import { el, hianyzoForras, ido, kpi, panel, sorok, szam, toast } from './dom.js'

/** A Discord csatornatípusai, amennyire ez a felület használja őket. */
const CSATORNA_TIPUS = {
  0: 'szöveges',
  2: 'hang',
  4: 'kategória',
  5: 'közlemény',
  10: 'közlemény-szál',
  11: 'szál',
  12: 'privát szál',
  13: 'színpad',
  15: 'fórum'
}

const UZENET_TIPUS = {
  yume_statistics: 'YUME statisztika',
  latest_releases: 'Legfrissebb epizódok',
  provider_status: 'Forrásszolgáltatók',
  system_health: 'Rendszerállapot',
  server_statistics: 'Szerverstatisztika',
  anime_schedule: 'Adásmenetrend',
  popular_anime: 'Legnézettebb',
  bot_status: 'A bot állapota'
}

const KONFIG_MEZOK = {
  latest_releases: [['limit', 'Hány epizód', 5, '1–10']],
  anime_schedule: [['limit', 'Hány cím', 8, '1–15']],
  popular_anime: [['limit', 'Hány cím', 5, '1–10'], ['days', 'Hány nap', 7, '1–30']]
}

const ESEMENY = {
  created: 'létrehozva',
  edited: 'módosítva',
  skipped: 'nem változott',
  recreated: 'újra létrehozva',
  recreate_requested: 'kézi újraküldés',
  failed: 'hiba',
  locked_out: 'másik példány dolgozott rajta'
}

// ---------------------------------------------------------------- áttekintés

export async function overview (guildId) {
  const d = await Api.overview(guildId)
  const wrap = el('div')

  wrap.append(el('div', { class: 'dash-cards' }, [
    kpi('Tagok', d.guild?.memberCount, {
      tone: 'blue',
      icon: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/>',
      meta: d.guild ? null : 'a bot nem éri el a szervert'
    }),
    kpi('Online (kb.)', d.guild?.onlineCount, {
      tone: 'green',
      icon: '<circle cx="12" cy="12" r="10"/>',
      meta: 'közelítő érték'
    }),
    kpi('Csatorna', d.channels, { tone: 'blue', icon: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>' }),
    kpi('Szerepkör', d.roles, { tone: 'amber', icon: '<path d="M12 2 4 7v10l8 5 8-5V7z"/>' })
  ]))

  const m = d.messages ?? {}
  wrap.append(el('div', { class: 'dash-cards' }, [
    kpi('Tartós üzenet', m.total, { tone: 'blue', icon: '<path d="M4 4h16v12H5.17L4 17.17z"/>' }),
    kpi('Kint van', m.posted, { tone: 'green', icon: '<path d="M20 6 9 17l-5-5"/>' }),
    kpi('Hibás', m.failing, {
      tone: Number(m.failing) > 0 ? 'red' : 'green',
      icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>'
    }),
    kpi('YUME-fiókkal', d.linkedAccounts, { tone: 'amber', icon: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>' })
  ]))

  if (!d.configured) {
    wrap.append(hianyzoForras(
      'A bot nincs bekötve',
      'Nincs beállítva Discord bot token ezen a kiszolgálón, tehát a Discordtól semmit nem tudunk lekérdezni. ' +
      'A számok helyén ezért „—" áll, nem nulla.',
      ['DISCORD_BOT_TOKEN a kiszolgáló környezetében', 'a bot meghívása erre a szerverre']))
  } else if (!d.guild) {
    wrap.append(hianyzoForras(
      'A bot nem éri el ezt a szervert',
      'A token él, de erre a guildre nem kaptunk választ. A leggyakoribb ok, hogy a bot nincs meghívva ide.',
      ['a bot meghívása a szerverre', 'a szerverazonosító ellenőrzése']))
  }

  return wrap
}

// ---------------------------------------------------------------- csatornák

export async function channels (guildId) {
  const d = await Api.channels(guildId)
  if (!d.available) {
    return hianyzoForras('A csatornák nem kérdezhetők le', d.reason ?? 'ismeretlen ok',
      ['a bot legyen tagja a szervernek', 'legyen érvényes bot token'])
  }

  const lista = d.data ?? []
  const kategoriak = new Map(lista.filter(c => c.type === 4).map(c => [c.id, c.name]))
  const rendezett = lista
    .filter(c => c.type !== 4)
    .sort((a, b) => a.position - b.position)

  return el('div', {}, [
    el('div', { class: 'dash-cards' }, [
      kpi('Csatorna', rendezett.length, { tone: 'blue', icon: '<path d="M4 9h16M4 15h16"/>' }),
      kpi('Kategória', kategoriak.size, { tone: 'amber', icon: '<path d="M3 7h18v12H3z"/>' }),
      kpi('Szöveges', rendezett.filter(c => c.type === 0).length, { tone: 'green', icon: '<path d="M4 4h16v12H5.17L4 17.17z"/>' }),
      kpi('Hang', rendezett.filter(c => c.type === 2).length, { tone: 'blue', icon: '<path d="M11 5 6 9H2v6h4l5 4z"/>' })
    ]),
    panel('Csatornák', 'a Discord válasza szerint, pozíció sorrendjében',
      sorok(rendezett.map(c => ({
        label: '#' + c.name,
        tone: c.type === 0 ? 'ok' : '',
        detail: [
          CSATORNA_TIPUS[c.type] ?? ('típus ' + c.type),
          c.parentId ? 'kategória: ' + (kategoriak.get(c.parentId) ?? c.parentId) : null,
          c.id
        ].filter(Boolean).join(' · ')
      })), 'Ezen a szerveren nincs csatorna.')),
    /*
     * AMIT A CSATORNÁKRÓL NEM TUDUNK. A lista valós, de a FORGALOM nem
     * létezik gateway nélkül. Ezt itt mondjuk ki, a lista alatt — különben
     * az üzemeltető joggal várna üzenetstatisztikát.
     */
    hianyzoForras(
      'Csatornánkénti forgalom nincs',
      'Az üzenetek száma, a legaktívabb csatorna és a napi bontás folyamatos gateway-kapcsolatot igényel: ' +
      'a Discord ezeket eseményként küldi, visszamenőleg nem kérdezhetők le. Ami nincs összegyűjtve, azt kitalálni nem fogjuk.',
      ['futó gateway-szolgáltatás', 'MESSAGE_CONTENT intent csak akkor, ha tartalmat is néznénk — a puszta darabszámhoz nem kell'])
  ])
}

// ---------------------------------------------------------------- szerepkörök

export async function roles (guildId) {
  const d = await Api.roles(guildId)
  if (!d.available) {
    return hianyzoForras('A szerepkörök nem kérdezhetők le', d.reason ?? 'ismeretlen ok',
      ['a bot legyen tagja a szervernek', 'legyen érvényes bot token'])
  }

  const lista = (d.data ?? []).slice().sort((a, b) => b.position - a.position)
  const szin = c => c ? '#' + c.toString(16).padStart(6, '0') : null

  return el('div', {}, [
    el('div', { class: 'dash-cards' }, [
      kpi('Szerepkör', lista.length, { tone: 'blue', icon: '<path d="M12 2 4 7v10l8 5 8-5V7z"/>' }),
      kpi('Botok által kezelt', lista.filter(r => r.managed).length, {
        tone: 'amber', icon: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/>'
      })
    ]),
    panel('Szerepkörök', 'rangsor szerint, felülről',
      sorok(lista.map(r => ({
        label: r.name,
        tone: r.managed ? '' : 'ok',
        extra: r.managed ? 'bot kezeli' : null,
        detail: [
          'pozíció ' + r.position,
          szin(r.color) ? 'szín ' + szin(r.color) : 'nincs saját szín',
          r.id
        ].join(' · ')
      })), 'Ezen a szerveren nincs szerepkör.')),
    hianyzoForras(
      'Szerepkörönkénti tagszám nincs',
      'Ahhoz, hogy megmondjuk, hány tag visel egy szerepkört, a taglistát kellene ismernünk. ' +
      'Ez a Discordnál PRIVILEGIZÁLT adat: a fejlesztői portálon külön engedélyezni kell, és a bot csak akkor kapja meg.',
      ['GUILD_MEMBERS intent engedélyezése a fejlesztői portálon', 'futó gateway-szolgáltatás'])
  ])
}

// ---------------------------------------------------------------- tagok

/**
 * TAGOK — a gateway által gyűjtött létszám és mozgás.
 *
 * KÉT KÜLÖNBÖZŐ ADAT, két különböző feltétellel. A LÉTSZÁM napi
 * pillanatképként megvan, amint a gateway fut: a `GUILD_CREATE` küldi, és
 * abból a növekedés kirajzolható. A CSATLAKOZÁS ÉS KILÉPÉS viszont
 * privilegizált intentet igényel — enélkül nem kevesebb adat jön, hanem
 * semmi. A nézet ezt szétválasztva mondja meg.
 */
export async function members (guildId) {
  const d = await Api.activity(guildId, 30)
  // NEM `sorok`: az a listaépítő segédfüggvény neve, és egy helyi változó
  // elfedné — a nézet a rajzolásnál hasalna el, „sorok is not a function"
  // hibával. Ez a fajta elfedés lintre nem hibás, csak halálos.
  const tagSorok = (d.members ?? []).filter(m => m.member_count != null || m.joins != null || m.leaves != null)

  if (!d.live && !tagSorok.length) {
    return hianyzoForras(
      'Tagstatisztika: nincs adatforrás',
      'A tagnövekedés, a csatlakozások és a kilépések mind ESEMÉNY: a Discord akkor küldi el, amikor történik. ' +
      'Visszamenőleg nem kérdezhető le, tehát ami nem volt begyűjtve, az nem létezik. ' +
      'A szerver MAI összlétszáma az Áttekintésen szerepel — az az egy tagadat, amit REST-en is meg lehet kapni.',
      [
        'futó gateway-szolgáltatás (DISCORD_GATEWAY_ENABLED)',
        'a csatlakozásokhoz és kilépésekhez: GUILD_MEMBERS privilegizált intent a fejlesztői portálon',
        'és utána idő: az első értelmes idősor napokkal a bekapcsolás után lesz'
      ])
  }

  const utolso = tagSorok.filter(m => m.member_count != null).slice(-1)[0]
  const elso = tagSorok.filter(m => m.member_count != null)[0]
  const valtozas = utolso && elso ? Number(utolso.member_count) - Number(elso.member_count) : null
  const belepok = tagSorok.reduce((n, m) => n + (m.joins == null ? 0 : Number(m.joins)), 0)
  const kilepok = tagSorok.reduce((n, m) => n + (m.leaves == null ? 0 : Number(m.leaves)), 0)

  const wrap = el('div')
  wrap.append(el('div', { class: 'dash-cards' }, [
    kpi('Tagok most', utolso?.member_count ?? null, {
      tone: 'blue', icon: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0"/>'
    }),
    kpi('Változás (mért időszak)', valtozas, {
      tone: valtozas != null && valtozas < 0 ? 'red' : 'green',
      display: valtozas == null ? '—' : (valtozas > 0 ? '+' : '') + szam(valtozas),
      icon: '<path d="m3 17 6-6 4 4 8-8"/>'
    }),
    kpi('Csatlakozás', d.memberIntent ? belepok : null, {
      tone: 'green',
      icon: '<path d="M12 5v14M5 12h14"/>',
      meta: d.memberIntent ? null : 'privilegizált intent kell'
    }),
    kpi('Kilépés', d.memberIntent ? kilepok : null, {
      tone: 'amber',
      icon: '<path d="M5 12h14"/>',
      meta: d.memberIntent ? null : 'privilegizált intent kell'
    })
  ]))

  wrap.append(panel('Napi létszám', d.since ? 'mérés kezdete: ' + d.since : 'a gateway gyűjtéséből',
    sorok(sorokbolTagok(tagSorok), 'Még nincs napi pillanatkép.')))

  if (!d.memberIntent) {
    wrap.append(hianyzoForras(
      'A csatlakozás és a kilépés nincs mérve',
      'Ezekhez a `GUILD_MEMBERS` privilegizált intent kell, amit a Discord fejlesztői portálon kell engedélyezni. ' +
      'Amíg nincs, a napi LÉTSZÁM megvan (abból a növekedés látszik), a mozgás nem — és a nulla itt félrevezetne.',
      ['GUILD_MEMBERS engedélyezése a fejlesztői portálon',
        'DISCORD_GUILD_MEMBERS_INTENT=true a kiszolgáló környezetében, majd a gateway újraindítása']))
  }

  return wrap
}

/** A napi tagsorok listaalakban. Külön, hogy a fenti olvasható maradjon. */
function sorokbolTagok (lista) {
  return lista.slice().reverse().map(m => ({
    label: m.day,
    tone: '',
    detail: [
      m.member_count != null ? szam(m.member_count) + ' tag' : 'nincs pillanatkép',
      m.joins != null ? '+' + m.joins : null,
      m.leaves != null ? '−' + m.leaves : null
    ].filter(Boolean).join(' · ')
  }))
}

/**
 * AKTIVITÁS — üzenetszám az időben és csatornánként.
 *
 * Csak a gateway gyűjtéséből. Ami a bekapcsolás előtt történt, az nem
 * létezik; a „mérés kezdete" ezt ki is írja, hogy egy rövid görbe ne
 * hibának látsszon.
 */
export async function activity (guildId) {
  const d = await Api.activity(guildId, 30)
  const napok = d.days ?? []

  if (!napok.length) {
    return hianyzoForras(
      'Üzenetforgalom: még nincs mérés',
      d.live
        ? 'A gateway fut, de ebben a szerverben még nem látott üzenetet. Az első adat a következő üzenettel érkezik.'
        : 'Az üzenetek ESEMÉNYEK: a Discord akkor küldi el őket, amikor megtörténnek, és visszamenőleg nem ' +
          'kérdezhetők le. Ami nem volt begyűjtve, az nem létezik.',
      d.live ? [] : ['futó gateway-szolgáltatás (DISCORD_GATEWAY_ENABLED)'])
  }

  const osszes = napok.reduce((n, x) => n + Number(x.messages), 0)
  const botok = napok.reduce((n, x) => n + Number(x.bot_messages), 0)
  const csucs = napok.reduce((max, x) => Math.max(max, Number(x.messages)), 0)

  return el('div', {}, [
    el('div', { class: 'dash-cards' }, [
      kpi('Üzenet (30 nap)', osszes, { tone: 'blue', icon: '<path d="M4 4h16v12H5.17L4 17.17z"/>' }),
      kpi('Ebből boté', botok, { tone: 'amber', icon: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/>' }),
      kpi('Legaktívabb nap', csucs, { tone: 'green', icon: '<path d="m3 17 6-6 4 4 8-8"/>' })
    ]),
    panel('Naponta', d.since ? 'mérés kezdete: ' + d.since : null,
      sorok(napok.slice().reverse().map(x => ({
        label: x.day,
        tone: '',
        detail: `${szam(x.messages)} üzenet · ${szam(x.bot_messages)} bottól`
      })), 'Nincs napi adat.')),
    panel('Csatornánként', 'a mért időszakban',
      sorok((d.channels ?? []).map(c => ({
        label: '#' + c.channel_id,
        tone: '',
        detail: `${szam(c.messages)} üzenet · ${szam(c.bot_messages)} bottól`
      })), 'Nincs csatornaadat.'))
  ])
}

export function commands () {
  return hianyzoForras(
    'Parancsstatisztika: nincs mit mérni',
    'A botnak ma nincs egyetlen slash-parancsa sem. A használati statisztika nem azért üres, mert nem gyűjtjük — ' +
    'hanem mert nincs, amit használni lehetne.',
    ['regisztrált alkalmazásparancsok', 'interakció-kezelő végpont vagy gateway'])
}

// ---------------------------------------------------------------- értesítések

export async function notifications (guildId) {
  const d = await Api.notifications(guildId)
  const osszes = (d.summary ?? []).reduce((n, s) => n + Number(s.total), 0)
  const hibas = (d.summary ?? []).reduce((n, s) => n + Number(s.failed), 0)

  return el('div', {}, [
    el('div', { class: 'dash-cards' }, [
      kpi('Kézbesítés (7 nap)', osszes, { tone: 'blue', icon: '<path d="m22 2-7 20-4-9-9-4z"/>' }),
      kpi('Sikertelen', hibas, {
        tone: hibas > 0 ? 'red' : 'green',
        icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>'
      })
    ]),
    panel('Eseményenként', 'az elmúlt hét nap',
      sorok((d.summary ?? []).map(s => ({
        label: s.event,
        tone: Number(s.failed) > 0 ? 'warn' : 'ok',
        detail: `${szam(s.total)} kézbesítés · ${szam(s.failed)} sikertelen`
      })), 'Az elmúlt hét napban nem ment ki értesítés.')),
    panel('Legutóbbiak', 'a kézbesítés ténye és hibája — a tartalma nem',
      sorok((d.recent ?? []).map(r => ({
        label: r.event,
        tone: r.status_code && r.status_code < 400 ? 'ok' : 'bad',
        detail: [
          r.webhook,
          r.status_code ? 'HTTP ' + r.status_code : 'nem kapott választ',
          r.duration_ms != null ? r.duration_ms + ' ms' : null,
          r.error,
          ido(r.created_at)
        ].filter(Boolean).join(' · ')
      })), 'Nincs kézbesítés.'))
  ])
}

// ---------------------------------------------------------------- bot állapot

export async function health (guildId) {
  const d = await Api.health(guildId)
  const kepes = d.capabilities ?? {}

  const jel = s => s === 'green' ? 'ok' : s === 'not_configured' ? '' : s === 'unknown' ? 'warn' : 'bad'

  return el('div', {}, [
    el('div', { class: 'dash-cards' }, [
      kpi('Bot', 0, {
        tone: d.configured ? 'green' : 'red',
        display: d.configured ? 'be van kötve' : 'nincs token',
        icon: '<circle cx="12" cy="12" r="10"/>'
      }),
      kpi('Gateway', 0, {
        tone: kepes.gateway ? 'green' : 'amber',
        display: kepes.gateway ? 'fut' : 'nem fut',
        icon: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'
      }),
      kpi('Hibás üzenet', (d.failing ?? []).length, {
        tone: (d.failing ?? []).length > 0 ? 'red' : 'green',
        icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>'
      })
    ]),

    panel('Szondák', 'a kiszolgáló saját ellenőrzéseiből',
      sorok((d.probes ?? []).map(p => ({
        label: p.service,
        tone: jel(p.status),
        detail: [
          p.status,
          p.latency_ms != null ? Math.round(Number(p.latency_ms)) + ' ms' : null,
          p.detail,
          ido(p.checked_at)
        ].filter(Boolean).join(' · ')
      })), 'Nincs Discord-szonda.')),

    /*
     * A 24 ÓRA ESEMÉNYEI — és a `skipped` itt a LEGFONTOSABB szám, pedig az
     * tűnik a legunalmasabbnak. Az mutatja, hogy a tartalom nem változott,
     * tehát a bot NEM küldött felesleges kérést. Ha ez eltűnik, valami
     * minden körben módosul, és az napi több ezer hívás.
     */
    panel('Az elmúlt 24 óra', 'frissítési események — a „nem változott" a jó jel',
      sorok((d.events24h ?? []).map(e => ({
        label: ESEMENY[e.event] ?? e.event,
        tone: e.event === 'failed' ? 'bad' : e.event === 'skipped' ? 'ok' : '',
        detail: szam(e.n) + ' alkalom'
      })), 'Az elmúlt 24 órában nem futott frissítés.')),

    (d.failing ?? []).length
      ? panel('Ami elromlott', 'és mi a hiba',
        sorok(d.failing.map(f => ({
          label: UZENET_TIPUS[f.message_type] ?? f.message_type,
          tone: 'bad',
          detail: `${f.failure_count} sikertelen kísérlet · ${f.last_error ?? 'ismeretlen hiba'}`
        }))))
      : null
  ])
}

// ---------------------------------------------------------------- napló

export async function audit (guildId) {
  const d = await Api.audit(guildId)
  return el('div', {}, [
    el('p', {
      class: 'list-row-sub',
      style: 'margin-bottom:var(--space-3);max-width:46rem;',
      text: 'Ez a MI naplónk: ki mit csinált ezen a felületen. A Discord saját audit logja — ki bannolt, ki nevezett át ' +
        'csatornát — külön jogosultság, és nem ezen a felületen él.'
    }),
    panel('Műveletek', 'legfrissebb elöl',
      sorok((d.data ?? []).map(a => ({
        label: a.action.replace('discord.', ''),
        tone: a.action.includes('delete') ? 'bad' : 'ok',
        detail: [a.actor ?? 'ismeretlen', a.subject_id, ido(a.created_at)].filter(Boolean).join(' · ')
      })), 'Ebben a szerverben még nem történt művelet.'))
  ])
}

// ---------------------------------------------------------------- beállítások

export async function settings (guildId, ujra) {
  const link = await Api.linkStatus().catch(() => null)
  const wrap = el('div')

  /*
   * A BEÁLLÍTATLAN OAUTH NEM TÖRLI A MEGLÉVŐ ÖSSZEKÖTÉST. Először itt
   * álltam meg — és egy MÁR ÖSSZEKÖTÖTT fiók is azt az üzenetet kapta, hogy
   * „nincs beállítva", vagyis a saját összekötését sem látta. Az OAuth
   * hiánya csak ÚJ összekötést akadályoz; a régi attól még érvényes, és a
   * szétkapcsolásnak is működnie kell.
   */
  if (link && link.configured === false && !link.linked) {
    wrap.append(hianyzoForras(
      'A Discord-fiók összekötése nincs beállítva',
      'Ezen a kiszolgálón nincs OAuth-alkalmazás beállítva, tehát a Discord-fiókok nem köthetők össze. ' +
      'Amíg nincs, ide csak YUME-jogosultsággal (discord.manage) lehet belépni.',
      ['DISCORD_CLIENT_ID és DISCORD_CLIENT_SECRET a kiszolgáló környezetében',
        'a visszairányítási cím regisztrálása a Discord fejlesztői portálon']))
    return wrap
  }

  if (!link?.linked) {
    const gomb = el('button', { class: 'btn btn-primary' }, ['Összekötés a Discorddal'])
    gomb.addEventListener('click', async () => {
      gomb.disabled = true
      try {
        const { url } = await Api.linkStart()
        window.location.href = url
      } catch (e) {
        gomb.disabled = false
        toast(e.message, 'error')
      }
    })
    wrap.append(panel('Discord-fiók', 'még nincs összekötve', el('div', {}, [
      el('p', {
        class: 'list-row-sub',
        style: 'margin:0 0 var(--space-3);max-width:44rem;',
        text: 'Kösd össze a Discord-fiókodat, és a szervereidben meglévő „Szerver kezelése" jogod itt is érvényes lesz. ' +
          'Csak az azonosítódat és a szervereid listáját kérjük le — üzeneteket nem olvasunk.'
      }),
      gomb
    ])))
    return wrap
  }

  const bont = el('button', { class: 'btn btn-ghost btn-sm' }, ['Szétkapcsolás'])
  bont.addEventListener('click', async () => {
    if (!window.confirm('Bontod az összekötést? A Discordban meglévő jogaid ezután nem érvényesek itt.')) return
    bont.disabled = true
    try {
      await Api.unlink()
      toast('Az összekötés megszűnt.', 'success')
      await ujra()
    } catch (e) {
      bont.disabled = false
      toast(e.message, 'error')
    }
  })

  wrap.append(panel('Discord-fiók', link.username ?? 'összekötve', el('div', {}, [
    el('p', { class: 'list-row-sub', text: 'Összekötve: ' + ido(link.linkedAt) }),
    link.configured === false
      ? el('p', {
        class: 'list-row-sub',
        text: 'Az OAuth ezen a kiszolgálón nincs beállítva: a meglévő összekötés érvényes, de újat ' +
            'szétkapcsolás után nem tudsz létrehozni.'
      })
      : null,
    el('div', { style: 'margin-top:var(--space-3);' }, [bont])
  ])))

  wrap.append(panel('Szervereid', 'ahol „Szerver kezelése" jogod van',
    sorok((link.guilds ?? []).map(g => ({
      label: g.name ?? g.id,
      tone: g.id === guildId ? 'ok' : '',
      extra: g.owner ? 'tulajdonos' : null,
      detail: g.id + (g.id === guildId ? ' · most ezt nézed' : '')
    })), 'Egyetlen olyan szervered sincs, amiben „Szerver kezelése" jogod lenne.')))

  return wrap
}

export { UZENET_TIPUS, KONFIG_MEZOK, ESEMENY }
