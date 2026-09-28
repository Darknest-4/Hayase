// Az adminfelület API-hívásai — csak az adminpanel tölti be.
//
// Eddig a `yume.js` része voltak, tehát minden látogató minden oldalon
// letöltötte őket (~25 KB forrás), a kijelentkezett kezdőlapon is. A panel és
// a karbantartási irányítópult importálja ezt a modult; a hívások alakja nem
// változott (`YumeAPI.admin.*`), mert a modul a betöltésekor maga köti be
// magát a közös kliensbe.
//
// A jogosultságot továbbra is a KISZOLGÁLÓ ellenőrzi minden hívásnál: ez a
// szétválasztás a letöltött bájtokról szól, nem a hozzáférésről.

import { YumeAPI } from './yume.js'

export const AdminAPI = {
  // ---- announcements ----
  // Authoring lives under /v1/announcements rather than /v1/admin, because
  // the resource is the same one the read serves; only the permission
  // differs. `allAnnouncements` is the authoring view — it includes messages
  // whose window has not opened yet and ones that have closed.
  allAnnouncements: () => YumeAPI._request('/v1/announcements/all', { auth: true }),
  createAnnouncement: body => YumeAPI._request('/v1/announcements', { method: 'POST', auth: true, body }),
  updateAnnouncement: (id, body) => YumeAPI._request(`/v1/announcements/${id}`, { method: 'PATCH', auth: true, body }),
  deleteAnnouncement: id => YumeAPI._request(`/v1/announcements/${id}`, { method: 'DELETE', auth: true }),

  users: ({ query, status, role, sort, limit, offset } = {}) => {
    const params = new URLSearchParams()
    if (query) params.set('query', query)
    if (status) params.set('status', status)
    if (role) params.set('role', role)
    if (sort) params.set('sort', sort)
    if (limit) params.set('limit', String(limit))
    if (offset) params.set('offset', String(offset))
    return YumeAPI._request('/v1/admin/users?' + params.toString(), { auth: true })
  },
  // Everything recorded about one account, in one request.
  user: id => YumeAPI._request(`/v1/admin/users/${id}`, { auth: true }),
  setUserStatus: (id, status, reason) =>
    YumeAPI._request(`/v1/admin/users/${id}/status`, { method: 'POST', auth: true, body: { status, reason } }),
  setUserRole: (id, role, granted, reason) =>
    YumeAPI._request(`/v1/admin/users/${id}/roles`, { method: 'POST', auth: true, body: { role, granted, reason } }),
  revokeUserSessions: (id, reason) =>
    YumeAPI._request(`/v1/admin/users/${id}/sessions/revoke`, { method: 'POST', auth: true, body: { reason } }),
  reports: ({ status = 'open', subjectType, limit = 50, offset = 0 } = {}) => {
    const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) })
    if (subjectType) params.set('subjectType', subjectType)
    return YumeAPI._request('/v1/admin/reports?' + params.toString(), { auth: true })
  },
  resolveReport: (id, action, reason) =>
    YumeAPI._request(`/v1/admin/reports/${id}/resolve`, { method: 'POST', auth: true, body: { action, reason } }),
  overview: () =>
    YumeAPI._request('/v1/admin/analytics/overview', { auth: true }),

  /*
   * Látogatottság. Külön a fenti `overview`-tól, ami a platform egészéről
   * szól (felhasználók, hibák, sorok) — ez arról, hogy kik jártak itt.
   *
   * Minden tartományos hívás a napi összesítőkből olvas, nem nyers
   * eseménytáblából; a `realtime` az egyetlen kivétel, és az öt percet néz.
   */
  /*
   * Az él: kockázati réteg, WAF, tiltások.
   *
   * Három jogosultság mögött — olvasás, tiltás, szabálymódosítás —, mert
   * három különböző döntés. Lásd modules/edge/admin-routes.ts.
   */
  edge: {
    overview: (range = '24h') => YumeAPI._request(`/v1/admin/edge?range=${range}`, { auth: true }),
    rules: () => YumeAPI._request('/v1/admin/edge/rules', { auth: true }),
    defaults: () => YumeAPI._request('/v1/admin/edge/defaults', { auth: true }),
    ip: address => YumeAPI._request(`/v1/admin/edge/ip/${encodeURIComponent(address)}`, { auth: true }),
    ban: body => YumeAPI._request('/v1/admin/edge/bans', { method: 'POST', auth: true, body }),
    unban: (id, reason) =>
      YumeAPI._request(`/v1/admin/edge/bans/${id}`, { method: 'DELETE', auth: true, body: { reason } }),
    config: body => YumeAPI._request('/v1/admin/edge/config', { method: 'PATCH', auth: true, body })
  },

  /*
   * A DISCORD-KLIENS ELKÖLTÖZÖTT. A vezérlőpult saját címen él
   * (`discord.animehub.hu`), és saját, önálló API-kliense van
   * (`apps/discord/src/api.js`) — a webkliensnek nincs többé dolga a
   * `/v1/discord/...` végpontokkal.
   *
   * A kiszolgálóoldal változatlan; csak a hívó került át.
   */

  analytics: {
    visitors: range => YumeAPI._request(`/v1/admin/analytics/visitors?range=${range}`, { auth: true }),
    providers: range => YumeAPI._request(`/v1/admin/analytics/providers?range=${range}`, { auth: true }),
    systemHealth: () => YumeAPI._request('/v1/admin/analytics/system-health', { auth: true }),
    // `/summary`, nem `/overview`: az utóbbi ezen az előtagon már foglalt
    // (a platform egészéről szóló nézet, fent).
    summary: range => YumeAPI._request(`/v1/admin/analytics/summary?range=${range}`, { auth: true }),
    timeseries: (range, metric, granularity) =>
      YumeAPI._request(`/v1/admin/analytics/timeseries?range=${range}&metric=${metric}&granularity=${granularity}`, { auth: true }),
    dataQuality: () => YumeAPI._request('/v1/admin/analytics/data-quality', { auth: true }),
    breakdown: (dimension, range, limit = 20) =>
      YumeAPI._request(`/v1/admin/analytics/breakdown?dimension=${dimension}&range=${range}&limit=${limit}`, { auth: true }),
    realtime: () => YumeAPI._request('/v1/admin/analytics/realtime', { auth: true }),
    anime: (range, limit = 50) =>
      YumeAPI._request(`/v1/admin/analytics/anime?range=${range}&limit=${limit}`, { auth: true }),
    animeDetail: (id, range) =>
      YumeAPI._request(`/v1/admin/analytics/anime/${id}?range=${range}`, { auth: true }),
    search: range => YumeAPI._request(`/v1/admin/analytics/search?range=${range}`, { auth: true }),
    performance: range => YumeAPI._request(`/v1/admin/analytics/performance?range=${range}`, { auth: true }),
    users: range => YumeAPI._request(`/v1/admin/analytics/users?range=${range}`, { auth: true }),
    account: (userId, params = {}) => {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))
      const tail = q.toString() ? '?' + q.toString() : ''
      return YumeAPI._request(`/v1/admin/analytics/accounts/${userId}${tail}`, { auth: true })
    }
  },

  // The counts the section rail puts on its own items. Each figure is null
  // when this account holds no permission over it.
  badges: () => YumeAPI._request('/v1/admin/badges', { auth: true }),

  // ---- forrásszolgáltatók ----
  // A listában a KIKAPCSOLTAK is benne vannak: a panelnek azt kell
  // mutatnia, ami VAN, nem azt, ami épp fut — különben pont az a kapcsoló
  // tűnne el, amivel vissza lehetne kapcsolni.
  providers: () => YumeAPI._request('/v1/admin/providers', { auth: true }),
  providerEvents: (slug, limit = 20) =>
    YumeAPI._request(`/v1/admin/providers/${encodeURIComponent(slug)}/events?limit=${limit}`, { auth: true }),
  updateProvider: (slug, patch) =>
    YumeAPI._request(`/v1/admin/providers/${encodeURIComponent(slug)}`, { method: 'PATCH', body: patch, auth: true }),

  // Everything the overview screen draws, in one round trip. `days` is the
  // window every comparison on it is measured over, so the captions on the
  // cards are all true of the same period.
  dashboard: (days = 7) =>
    YumeAPI._request(`/v1/admin/analytics/dashboard?days=${days}`, { auth: true }),

  // Hungarian catalogue text. `queue` is the only one an editor opens
  // deliberately — everything else follows from picking something in it.
  translations: {
    progress: () => YumeAPI._request('/v1/admin/translations/progress', { auth: true }),
    queue: ({ limit = 25, offset = 0, publishedOnly = true } = {}) =>
      YumeAPI._request(`/v1/admin/translations/queue?limit=${limit}&offset=${offset}&publishedOnly=${publishedOnly}`, { auth: true }),
    get: id => YumeAPI._request(`/v1/admin/translations/anime/${id}`, { auth: true }),
    put: (id, language, body) =>
      YumeAPI._request(`/v1/admin/translations/anime/${id}/${language}`, { method: 'PUT', auth: true, body }),
    remove: (id, language) =>
      YumeAPI._request(`/v1/admin/translations/anime/${id}/${language}`, { method: 'DELETE', auth: true })
  },
  // webhooks
  webhookEvents: () => YumeAPI._request('/v1/admin/webhooks/events', { auth: true }),
  webhooks: () => YumeAPI._request('/v1/admin/webhooks', { auth: true }),
  createWebhook: body => YumeAPI._request('/v1/admin/webhooks', { method: 'POST', auth: true, body }),
  updateWebhook: (id, body) => YumeAPI._request(`/v1/admin/webhooks/${id}`, { method: 'PATCH', auth: true, body }),
  deleteWebhook: id => YumeAPI._request(`/v1/admin/webhooks/${id}`, { method: 'DELETE', auth: true }),
  testWebhook: id => YumeAPI._request(`/v1/admin/webhooks/${id}/test`, { method: 'POST', auth: true, body: {} }),
  webhookDeliveries: id => YumeAPI._request(`/v1/admin/webhooks/${id}/deliveries`, { auth: true }),
  // site config / feature flags
  config: () => YumeAPI._request('/v1/admin/config', { auth: true }),
  setFlag: (key, body) => YumeAPI._request(`/v1/admin/config/flags/${encodeURIComponent(key)}`, { method: 'PATCH', auth: true, body }),
  setSetting: (key, value) => YumeAPI._request(`/v1/admin/config/settings/${encodeURIComponent(key)}`, { method: 'PATCH', auth: true, body: { value } }),
  // roles & permissions
  roles: () => YumeAPI._request('/v1/admin/roles', { auth: true }),
  permissionCatalog: () => YumeAPI._request('/v1/admin/roles/permissions', { auth: true }),
  setRolePermission: (roleId, slug, granted) => YumeAPI._request(`/v1/admin/roles/${roleId}/permissions`, { method: 'POST', auth: true, body: { slug, granted } }),
  // VPS health & monitoring (system.metrics.view)
  monitoring: {
    current: () => YumeAPI._request('/v1/admin/monitoring/current', { auth: true }),
    history: (metric, hours = 24) => YumeAPI._request(`/v1/admin/monitoring/history?metric=${encodeURIComponent(metric)}&hours=${hours}`, { auth: true }),
    thresholds: () => YumeAPI._request('/v1/admin/monitoring/thresholds', { auth: true }),
    queues: () => YumeAPI._request('/v1/admin/monitoring/queues', { auth: true }),
    // The component registry: what the platform is made of, what each part
    // depends on, and a measured status for each.
    components: () => YumeAPI._request('/v1/admin/monitoring/components', { auth: true }),
    alerts: () => YumeAPI._request('/v1/admin/monitoring/alerts', { auth: true }),
    diagnostics: () => YumeAPI._request('/v1/admin/monitoring/diagnostics', { auth: true }),
    diagnostic: id => YumeAPI._request('/v1/admin/monitoring/diagnostics/' + id, { auth: true }),
    runDiagnostic: () => YumeAPI._request('/v1/admin/monitoring/diagnostics', { method: 'POST', auth: true, body: {} })
  },
  // catalogue management (anime + episodes, sees hidden entries)
  catalogue: {
    list: (params = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v)
      return YumeAPI._request('/v1/admin/catalogue?' + qs.toString(), { auth: true })
    },
    get: id => YumeAPI._request(`/v1/admin/catalogue/${id}`, { auth: true }),
    create: body => YumeAPI._request('/v1/admin/catalogue', { method: 'POST', auth: true, body }),
    update: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}`, { method: 'PATCH', auth: true, body }),
    remove: id => YumeAPI._request(`/v1/admin/catalogue/${id}`, { method: 'DELETE', auth: true }),
    episodes: id => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes`, { auth: true }),
    addEpisode: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes`, { method: 'POST', auth: true, body }),
    updateEpisode: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}`, { method: 'PATCH', auth: true, body }),
    removeEpisode: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}`, { method: 'DELETE', auth: true }),
    // Publish or take down a whole range at once: { visibility, from?, to? }
    episodeVisibility: (id, body) => YumeAPI._request(`/v1/admin/catalogue/${id}/episodes/visibility`, { method: 'POST', auth: true, body }),
    // Ugyanaz az egész katalógusra: { visibility }. Csak publikus címek
    // epizódjait érinti.
    episodeVisibilityAll: body => YumeAPI._request('/v1/admin/catalogue/episodes/visibility/all', { method: 'POST', auth: true, body }),
    // metadata provenance & duplicate handling
    unlock: (id, fields) => YumeAPI._request(`/v1/admin/catalogue/${id}/unlock`, { method: 'POST', auth: true, body: { fields } }),
    // `exact` by default, matching the server. The `similar` pass compares
    // every title against every other in its year and format, which takes a
    // minute on a catalogue this size — so it is a button somebody presses,
    // not what happens when the tab opens.
    duplicates: ({ mode = 'exact', threshold = 0.86, limit = 50 } = {}) =>
      YumeAPI._request(`/v1/admin/catalogue/duplicates?mode=${mode}&threshold=${threshold}&limit=${limit}`, { auth: true }),
    merge: (id, sourceId) => YumeAPI._request(`/v1/admin/catalogue/${id}/merge`, { method: 'POST', auth: true, body: { sourceId } }),

    // where an episode plays from — registered by an operator, any provider
    sources: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/sources`, { auth: true }),
    addSource: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/sources`, { method: 'POST', auth: true, body }),
    updateSource: (sid, body) => YumeAPI._request(`/v1/admin/catalogue/sources/${sid}`, { method: 'PATCH', auth: true, body }),
    removeSource: sid => YumeAPI._request(`/v1/admin/catalogue/sources/${sid}`, { method: 'DELETE', auth: true }),

    // the rest of what an episode needs to play well: skip intervals and
    // subtitle tracks, both of which the catalogue now holds itself
    skips: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/skips`, { auth: true }),
    addSkip: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/skips`, { method: 'POST', auth: true, body }),
    removeSkip: sid => YumeAPI._request(`/v1/admin/catalogue/skips/${sid}`, { method: 'DELETE', auth: true }),
    subtitles: eid => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/subtitles`, { auth: true }),
    addSubtitle: (eid, body) => YumeAPI._request(`/v1/admin/catalogue/episodes/${eid}/subtitles`, { method: 'POST', auth: true, body }),
    removeSubtitle: sid => YumeAPI._request(`/v1/admin/catalogue/subtitles/${sid}`, { method: 'DELETE', auth: true })
  },

  // metadata synchronisation — coverage, runs, and the id collisions the
  // importers could not resolve on their own
  metadata: {
    status: () => YumeAPI._request('/v1/admin/catalogue/metadata', { auth: true }),
    start: body => YumeAPI._request('/v1/admin/catalogue/metadata/runs', { method: 'POST', auth: true, body }),
    cancel: id => YumeAPI._request(`/v1/admin/catalogue/metadata/runs/${id}/cancel`, { method: 'POST', auth: true, body: {} }),
    conflicts: () => YumeAPI._request('/v1/admin/catalogue/metadata/conflicts', { auth: true }),
    resolveConflict: (id, resolution) =>
      YumeAPI._request(`/v1/admin/catalogue/metadata/conflicts/${id}/resolve`, { method: 'POST', auth: true, body: { resolution } })
  },

  // themes — the colours viewers may choose from
  themes: {
    list: () => YumeAPI._request('/v1/admin/themes', { auth: true }),
    create: body => YumeAPI._request('/v1/admin/themes', { method: 'POST', auth: true, body }),
    update: (id, body) => YumeAPI._request(`/v1/admin/themes/${id}`, { method: 'PATCH', auth: true, body }),
    remove: id => YumeAPI._request(`/v1/admin/themes/${id}`, { method: 'DELETE', auth: true })
  },

  // error triage — list groups, open one for its stack, change its status
  errors: (status = 'open') => YumeAPI._request(`/v1/admin/errors?status=${status}&limit=100`, { auth: true }),
  error: id => YumeAPI._request(`/v1/admin/errors/${id}`, { auth: true }),
  // Look up the failure a user is quoting. The 500 they saw told them to
  // quote the request id; this is where it is quoted to.
  errorByRequest: requestId =>
    YumeAPI._request(`/v1/admin/errors/by-request/${encodeURIComponent(requestId)}`, { auth: true }),
  setErrorStatus: (id, status) => YumeAPI._request(`/v1/admin/errors/${id}`, { method: 'PATCH', auth: true, body: { status } }),

  // Emergency controls. Each switch has an enforcement point in the server
  // and the GET says which — see apps/api/src/modules/security/routes.ts.
  security: () => YumeAPI._request('/v1/admin/security', { auth: true }),

  // ---- karbantartási mód ----
  // A `security.manage` jogosultsághoz kötve, ugyanoda, ahova a
  // csak-olvasható üzem: nem tartalmi szerkesztés, hanem üzemeltetés.
  maintenance: () => YumeAPI._request('/v1/admin/maintenance', { auth: true }),
  setMaintenance: body => YumeAPI._request('/v1/admin/maintenance', { method: 'PUT', auth: true, body }),
  /** Előnézet: NEM aktivál semmit, csak megmondja, mi történne. */
  previewMaintenance: body =>
    YumeAPI._request('/v1/admin/maintenance/preview', { method: 'POST', auth: true, body }),
  createMaintenanceBypass: body =>
    YumeAPI._request('/v1/admin/maintenance/bypass', { method: 'POST', auth: true, body }),
  revokeMaintenanceBypass: id =>
    YumeAPI._request(`/v1/admin/maintenance/bypass/${encodeURIComponent(id)}`, { method: 'DELETE', auth: true }),
  /** A nyilvános státusz — az admin előnézethez is ezt kérdezzük. */
  publicStatus: () => YumeAPI._request('/v1/status'),
  // The posture: every entry inspects something and says what it found.
  posture: () => YumeAPI._request('/v1/admin/security/posture', { auth: true }),
  // A sebességkorlátok átírása. Ugyanaz a jogosultság, ami a
  // vészkapcsolókat is nyitja, és ugyanúgy auditált.
  setRateLimits: body => YumeAPI._request('/v1/admin/security/limits', { method: 'PATCH', auth: true, body }),
  // Mentések. Az API nem látja a kötetet — ezek a hívások kérést írnak egy
  // táblába, amit a mentőkonténer ciklusa vesz fel.
  backups: () => YumeAPI._request('/v1/admin/backups', { auth: true }),
  backupNow: reason => YumeAPI._request('/v1/admin/backups', { method: 'POST', auth: true, body: { reason } }),
  backupSchedule: body => YumeAPI._request('/v1/admin/backups/schedule', { method: 'PATCH', auth: true, body }),
  backupVerify: body => YumeAPI._request('/v1/admin/backups/verify', { method: 'POST', auth: true, body }),
  backupRestore: body => YumeAPI._request('/v1/admin/backups/restore', { method: 'POST', auth: true, body }),
  setControl: (key, value, reason) =>
    YumeAPI._request(`/v1/admin/security/${encodeURIComponent(key)}`, {
      method: 'POST', auth: true, body: { value, reason }
    }),
  revokeAllSessions: reason =>
    YumeAPI._request('/v1/admin/security/revoke-all-sessions', {
      method: 'POST', auth: true, body: { reason }
    }),

  // audit trail — who changed what, and when
  audit: ({ subjectType, subjectId, actorId, actor, action, since, limit = 50, offset = 0 } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (subjectType) params.set('subjectType', subjectType)
    if (subjectId) params.set('subjectId', subjectId)
    if (actorId) params.set('actorId', actorId)
    if (actor) params.set('actor', actor)
    if (action) params.set('action', action)
    if (since) params.set('since', since)
    return YumeAPI._request('/v1/admin/audit?' + params.toString(), { auth: true })
  },

  /**
   * The code audit — findings, severities, and where each one lives.
   *
   * A different thing from `audit` above, which is the trail of what people
   * did. The route is /audit/report rather than /audit because that name was
   * already this one's; see YUME-AUDIT-0013.
   *
   * Deliberately not caught here. The page has to be able to tell "no report
   * has been generated" (503) from "the report is not readable" (500) from
   * "you may not see this" (404), and it renders a different thing for each,
   * so swallowing the failure into an empty result would be the one outcome
   * a page like this must never produce.
   */
  auditReport: () => YumeAPI._request('/v1/admin/audit/report', { auth: true })
}

YumeAPI.admin = AdminAPI
