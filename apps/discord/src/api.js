/* global atob, localStorage */
/*
 * A vezérlőpult API-kliense.
 *
 * AZONOS EREDET. Ez a felület a `discord.animehub.hu` alatt él, de a kéréseit
 * ugyanarra a gépre küldi — a fordított proxy mindkét nevet ugyanannak az
 * alkalmazásnak adja. Ezért nincs CORS, nincs külön API-cím, és a
 * munkamenet ugyanaz a JWT, mint a főoldalon (csak külön tárolva, mert a
 * böngésző a tárolót eredetenként választja szét).
 *
 * A TOKENT NEM ÍRJUK NAPLÓBA ÉS NEM TESSZÜK CÍMBE. Csak fejlécben utazik.
 */

const TAR = 'yume-discord-auth'

export const Auth = {
  _tokens: null,

  /** A munkamenet végleg lejárt (a frissítés sem sikerült). Az `app.js` állítja be. */
  onExpired: null,

  /*
   * MINDIG A TÁROLÓBÓL OLVAS, nem a memóriából: egy másik fül frissítése vagy
   * kilépése a tárolóban látszik, és a frissítés ebből tudja, hogy már nem
   * neki kell forgatnia a sütit (lásd `frissit`).
   */
  load () {
    try {
      const nyers = localStorage.getItem(TAR)
      this._tokens = nyers ? JSON.parse(nyers) : null
    } catch {
      // Privát ablak, letiltott tároló: a memóriában tartott példány marad —
      // a felület így is működik, csak minden megnyitásnál újra kell lépni.
    }
    return this._tokens
  },

  save (tokens) {
    this._tokens = tokens
    try { localStorage.setItem(TAR, JSON.stringify(tokens)) } catch { /* privát ablak */ }
  },

  clear () {
    this._tokens = null
    try { localStorage.removeItem(TAR) } catch { /* privát ablak */ }
  },

  token () {
    return this.load()?.accessToken ?? null
  },

  /*
   * KI VAGYOK — a tokenből, nem egy külön kérésből.
   *
   * A JWT törzse base64url, és a nevet meg az azonosítót már tartalmazza; egy
   * külön „ki vagyok" hívás ugyanezt kérdezné meg még egyszer. A tokent NEM
   * ELLENŐRIZZÜK itt: az aláírás vizsgálata a kiszolgáló dolga, és a felület
   * úgysem hisz a saját olvasatának — minden adat mögött hitelesített kérés
   * áll. Ez csak a fejlécben megjelenő névhez kell.
   */
  user () {
    const t = this.token()
    if (!t) return null
    try {
      const torzs = t.split('.')[1]
      if (!torzs) return null
      const json = atob(torzs.replace(/-/g, '+').replace(/_/g, '/'))
      const payload = JSON.parse(json)
      return { id: payload.sub, username: payload.username ?? null }
    } catch {
      return null
    }
  }
}

export class ApiError extends Error {
  constructor (message, status, detail) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

/*
 * A MUNKAMENET FRISSÍTÉSE — ugyanúgy, mint a főoldalon
 * (apps/web/src/shared/api/yume.js `_refresh`).
 *
 * A hozzáférési token tizenöt percig él. Eddig a vezérlőpult nem frissített:
 * a lejárat után minden kérés 401-et kapott, és negyedóránként újra kellett
 * lépni. A frissítő süti pedig ott volt — a belépés ezen a néven is beállítja
 * (HttpOnly, csak a `/v1/auth` útvonalra) —, csak senki nem használta.
 *
 * EGYSZERRE EGY FRISSÍTÉS, fülek között is (a böngésző zárja alatt): a süti
 * forog, és egy második frissítés ugyanazzal a sütivel már egy visszavont
 * munkamenetet mutatna fel. Aki a zárra várt, előbb megnézi, kicserélte-e már
 * más a tokent — ha igen, azt használja.
 */
let frissites = null

async function csere () {
  const res = await fetch('/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: '{}'
  })
  let torzs = null
  try { torzs = await res.json() } catch { torzs = null }
  if (!res.ok || !torzs?.accessToken) {
    const e = new ApiError(torzs?.detail ?? `HTTP ${res.status}`, res.status, torzs?.detail ?? null)
    e.code = torzs?.code ?? null
    throw e
  }
  return torzs
}

function kizarolag (fn) {
  const zar = globalThis.navigator?.locks
  return typeof zar?.request === 'function' ? zar.request('yume-discord-auth-refresh', fn) : fn()
}

async function frissit () {
  if (frissites) return await frissites
  const regi = Auth.token()
  frissites = (async () => {
    try {
      await kizarolag(async () => {
        const most = Auth.token()
        if (regi && most && most !== regi) return // egy másik fül már frissített
        let uj
        try {
          uj = await csere()
        } catch (e) {
          // Zár nélküli böngészőben egy másik fül megelőzhetett: a kiszolgáló
          // ilyenkor `refresh_rotated`-del felel, és a böngésző már az új sütit
          // tartja — egy második próba azzal sikerül.
          if (e.status !== 401 || e.code !== 'refresh_rotated') throw e
          await new Promise(resolve => setTimeout(resolve, 300))
          uj = await csere()
        }
        Auth.save({ accessToken: uj.accessToken, expiresAt: uj.expiresAt })
      })
    } catch (e) {
      // Csak a SAJÁT, elbukott tokenünket töröljük: ha közben egy másik fül
      // újat tett le, az él.
      if (Auth.token() === regi) Auth.clear()
      throw e
    } finally {
      frissites = null
    }
  })()
  return await frissites
}

async function kerd (url, { method = 'GET', body = null, auth = true, ujra = true } = {}) {
  const fejlecek = {}
  if (body) fejlecek['content-type'] = 'application/json'
  const elkuldott = auth ? Auth.token() : null
  if (elkuldott) fejlecek.authorization = `Bearer ${elkuldott}`

  const res = await fetch(url, {
    method,
    headers: fejlecek,
    ...(body ? { body: JSON.stringify(body) } : {})
  })

  /*
   * LEJÁRT TOKEN → EGY FRISSÍTÉS, EGY ÚJRAPRÓBA. Ha a tárolt token közben már
   * kicserélődött (egy párhuzamos kérés frissített), nem forgatunk újra —
   * csak megismételjük az újjal.
   */
  if (res.status === 401 && elkuldott && ujra) {
    if (Auth.token() === elkuldott) await frissit().catch(() => {})
    if (Auth.token()) return await kerd(url, { method, body, auth, ujra: false })
    // A frissítés sem sikerült: a munkamenet véget ért — a felület a
    // belépőlapra lép, nem egy „nem tölthető be" hibát mutat nézetenként.
    Auth.onExpired?.()
  }

  if (res.status === 204) return null

  let torzs = null
  try { torzs = await res.json() } catch { torzs = null }

  if (!res.ok) {
    /*
     * A HIBA RÉSZLETE MEGY TOVÁBB, nem csak a státusz. A guild-kapu pontosan
     * megmondja, mi hiányzik (`no_link`, `not_member`, `stale`,
     * `insufficient`), és ezt a felület kiírja — enélkül minden elutasítás
     * „valami hiba" volna, és az üzemeltető a rossz helyen keresné.
     */
    throw new ApiError(torzs?.detail ?? torzs?.title ?? `HTTP ${res.status}`, res.status, torzs?.detail ?? null)
  }
  return torzs
}

export const Api = {
  /*
   * A MEZŐ NEVE `identifier`, NEM `email` — és ez nem szőrszálhasogatás: a
   * kiszolgáló e-mailt ÉS felhasználónevet is elfogad ugyanazon a néven. Az
   * `email` kulccsal a séma elutasítja a kérést, és a felületen egy angol
   * validációs üzenet jelenik meg magyar szöveg helyett. Élesben mérve:
   * „body must have required property 'identifier'".
   */
  login: (identifier, password) => kerd('/v1/auth/login', { method: 'POST', auth: false, body: { identifier, password } }),
  // A KILÉPÉS A KISZOLGÁLÓN IS véget vet a munkamenetnek, és törli a frissítő
  // sütit — enélkül egy harmincnapos süti maradna annak a böngészőjében, aki
  // épp kilépett.
  logout: () => kerd('/v1/auth/logout', { method: 'POST', body: {} }),

  status: () => kerd('/v1/discord/status'),
  guilds: () => kerd('/v1/discord/guilds'),
  linkStatus: () => kerd('/v1/discord/oauth/link'),
  linkStart: () => kerd('/v1/discord/oauth/start', { method: 'POST' }),
  unlink: () => kerd('/v1/discord/oauth/link', { method: 'DELETE' }),

  overview: g => kerd(`/v1/discord/guilds/${g}/overview`),
  channels: g => kerd(`/v1/discord/guilds/${g}/channels`),
  roles: g => kerd(`/v1/discord/guilds/${g}/roles`),
  health: g => kerd(`/v1/discord/guilds/${g}/health`),
  activity: (g, days = 30) => kerd(`/v1/discord/guilds/${g}/activity?days=${days}`),
  audit: g => kerd(`/v1/discord/guilds/${g}/audit?limit=100`),
  messageFailures: g => kerd(`/v1/discord/guilds/${g}/message-failures?days=14`),
  notifications: g => kerd(`/v1/discord/guilds/${g}/notifications?limit=25`),

  messages: g => kerd(`/v1/discord/guilds/${g}/persistent-messages`),
  createMessage: (g, body) => kerd(`/v1/discord/guilds/${g}/persistent-messages`, { method: 'POST', body }),
  updateMessage: (g, id, body) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}`, { method: 'PATCH', body }),
  removeMessage: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}`, { method: 'DELETE' }),
  resync: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/resync`, { method: 'POST' }),
  recreate: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/recreate`, { method: 'POST' }),
  preview: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/preview`),
  history: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/history?limit=100`),
  diagnose: (g, c) => kerd(`/v1/discord/guilds/${g}/channels/${c}/diagnose`),

  // ---- setup és automatizálás ----
  setupStatus: g => kerd(`/v1/discord/guilds/${g}/setup/status`),
  setupPreview: g => kerd(`/v1/discord/guilds/${g}/setup/preview`),
  setupRun: g => kerd(`/v1/discord/guilds/${g}/setup/run`, { method: 'POST' }),
  setupRepair: g => kerd(`/v1/discord/guilds/${g}/setup/repair`, { method: 'POST' }),
  setupResync: g => kerd(`/v1/discord/guilds/${g}/setup/resync`, { method: 'POST' }),
  // A GYÁRI VISSZAÁLLÍTÁS KÉT LÉPÉS. Az első megmutatja, mit törölne, és ad
  // egy jegyet; a második enélkül nem indul.
  resetPrepare: g => kerd(`/v1/discord/guilds/${g}/setup/reset/prepare`, { method: 'POST' }),
  resetRun: (g, token) => kerd(`/v1/discord/guilds/${g}/setup/reset`, { method: 'POST', body: { token } }),
  setupAudit: g => kerd(`/v1/discord/guilds/${g}/setup/audit?limit=100`),
  registerCommands: g => kerd(`/v1/discord/guilds/${g}/commands/register`, { method: 'POST' }),
  commands: g => kerd(`/v1/discord/guilds/${g}/commands`),

  // ---- szerver-beállítások ----
  config: g => kerd(`/v1/discord/guilds/${g}/config`),
  saveConfig: (g, body) => kerd(`/v1/discord/guilds/${g}/config`, { method: 'PATCH', body }),
  saveRoleMappings: (g, mappings) => kerd(`/v1/discord/guilds/${g}/config/role-mappings`, { method: 'PUT', body: { mappings } }),
  setAnimeMention: (g, animeId, discordRoleId) =>
    kerd(`/v1/discord/guilds/${g}/config/anime-mentions/${animeId}`, { method: 'PUT', body: { discordRoleId } }),
  removeAnimeMention: (g, animeId) => kerd(`/v1/discord/guilds/${g}/config/anime-mentions/${animeId}`, { method: 'DELETE' }),
  searchAnime: q => kerd(`/v1/anime/search?${new URLSearchParams({ q })}`),

  // ---- köszöntő ----
  welcome: g => kerd(`/v1/discord/guilds/${g}/welcome`),
  saveWelcome: (g, body) => kerd(`/v1/discord/guilds/${g}/welcome`, { method: 'PATCH', body }),
  welcomePreview: g => kerd(`/v1/discord/guilds/${g}/welcome/preview`),
  welcomeTest: g => kerd(`/v1/discord/guilds/${g}/welcome/test`, { method: 'POST' }),
  welcomeLog: g => kerd(`/v1/discord/guilds/${g}/welcome/log`)
}
