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

  load () {
    if (this._tokens) return this._tokens
    try {
      const nyers = localStorage.getItem(TAR)
      this._tokens = nyers ? JSON.parse(nyers) : null
    } catch {
      // Privát ablak, letiltott tároló: a felület ilyenkor is működik, csak
      // minden megnyitásnál újra kell lépni.
      this._tokens = null
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

async function kerd (url, { method = 'GET', body = null, auth = true } = {}) {
  const fejlecek = {}
  if (body) fejlecek['content-type'] = 'application/json'
  if (auth) {
    const t = Auth.token()
    if (t) fejlecek.authorization = `Bearer ${t}`
  }

  const res = await fetch(url, {
    method,
    headers: fejlecek,
    ...(body ? { body: JSON.stringify(body) } : {})
  })

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

  status: () => kerd('/v1/discord/status'),
  linkStatus: () => kerd('/v1/discord/oauth/link'),
  linkStart: () => kerd('/v1/discord/oauth/start', { method: 'POST' }),
  unlink: () => kerd('/v1/discord/oauth/link', { method: 'DELETE' }),

  overview: g => kerd(`/v1/discord/guilds/${g}/overview`),
  channels: g => kerd(`/v1/discord/guilds/${g}/channels`),
  roles: g => kerd(`/v1/discord/guilds/${g}/roles`),
  health: g => kerd(`/v1/discord/guilds/${g}/health`),
  activity: (g, days = 30) => kerd(`/v1/discord/guilds/${g}/activity?days=${days}`),
  audit: g => kerd(`/v1/discord/guilds/${g}/audit?limit=100`),
  notifications: g => kerd(`/v1/discord/guilds/${g}/notifications?limit=25`),

  messages: g => kerd(`/v1/discord/guilds/${g}/persistent-messages`),
  createMessage: (g, body) => kerd(`/v1/discord/guilds/${g}/persistent-messages`, { method: 'POST', body }),
  updateMessage: (g, id, body) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}`, { method: 'PATCH', body }),
  removeMessage: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}`, { method: 'DELETE' }),
  resync: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/resync`, { method: 'POST' }),
  recreate: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/recreate`, { method: 'POST' }),
  preview: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/preview`),
  history: (g, id) => kerd(`/v1/discord/guilds/${g}/persistent-messages/${id}/history?limit=100`),
  diagnose: (g, c) => kerd(`/v1/discord/guilds/${g}/channels/${c}/diagnose`)
}
