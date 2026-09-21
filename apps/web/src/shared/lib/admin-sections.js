// Az adminpanel SZAKASZLISTÁJA — külön modulban, szándékosan.
//
// MIÉRT NEM AZ `admin.js`-BEN. A router a navigáció megrajzolásához tudni
// akarja, MELYIK jogosultságokra gátol a panel — a link csak annak
// jelenjen meg, aki legalább egy szakaszt lát. Ezt eddig
// `PageAdmin.SECTIONS`-ből olvasta, és emiatt a 279 kB-os adminpanelt MINDEN
// oldalbetöltés magával hozta: a belépőlapon is, a kezdőképernyőn is, ahol
// nincs is adminfelület.
//
// Mérve, a belépőlapon: 93 szkriptfájl, 1207 kB, ebből 279 kB ez az egy
// modul.
//
// A lista viszont NEM duplikálódhat. A router megjegyzése kimondja, miért:
// amikor a link egy külön feltételre gátolt, a kettő széttartott, és
//
//   az elemző  `analytics.view`-t tartott  → látta a linket, aztán falat
//   a moderátor `community.moderate`-et    → nem látta a linket sehol
//
// Ezért a lista IDE költözött, és mindkét oldal — a router és a panel —
// ugyanezt az egy példányt olvassa. Innentől az `admin.js` késleltetve
// tölthető be, a router pedig továbbra is tudja, mire gátoljon.
//
// A `render` mezők az `admin.js` metódusainak NEVEI, nem függvények: a lista
// így nem hivatkozik a panelre, tehát nem is rántja be.
//
// MIÉRT A `shared/` ALATT. A rétegszabály szerint egy lap nem importálhat
// másik lapot, és ezt a listát KÉT réteg olvassa: a router (`app/`) és a
// panel (`pages/`). Ami többnek kell, az lefelé megy — nem oldalra.

export const ADMIN_GROUPS = [
  { key: 'insight', label: 'Áttekintés' },
  { key: 'content', label: 'Katalógus' },
  { key: 'people', label: 'Közösség' },
  { key: 'ops', label: 'Üzemeltetés' },
  { key: 'look', label: 'Megjelenés' }
]

export const ADMIN_SECTIONS = [
  { key: 'overview', group: 'insight', label: 'Áttekintés', sub: 'A platform állapota és statisztikája', perm: 'admin.analytics.view', render: 'renderOverview', icon: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>' },
  { key: 'errors', group: 'ops', label: 'Hibák', sub: 'Csoportosított hibák és hívási láncok', perm: 'admin.analytics.view', render: 'renderErrors', icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0"/>' },
  { key: 'audit-log', group: 'ops', label: 'Műveleti napló', sub: 'Ki mit változtatott, és mikor', perm: 'admin.users.manage', render: 'renderAudit', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M9 11h2"/>' },
  { key: 'analytics', group: 'insight', label: 'Látogatottság', sub: 'Kik jártak itt, és mit csináltak', perm: 'analytics.view', render: 'renderAnalytics', icon: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>' },

  { key: 'users', group: 'people', label: 'Felhasználók', sub: 'Fiókok, felfüggesztések, kitiltások', perm: 'admin.users.manage', render: 'renderUsers', icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
  { key: 'roles', group: 'people', label: 'Szerepkörök', sub: 'Jogosultságok és szerepkörök', perm: 'roles.manage', render: 'renderRoles', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>' },
  { key: 'reports', group: 'people', label: 'Bejelentések', sub: 'Moderálási sor', perm: 'community.moderate', render: 'renderReports', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>' },

  { key: 'catalogue', group: 'content', label: 'Katalógus', sub: 'Animék, epizódok, publikálás', perm: 'anime.view', render: 'renderCatalogue', icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
  { key: 'metadata', group: 'content', label: 'Metaadatok', sub: 'AniList-lefedettség és szinkronfutások', perm: 'anime.edit', render: 'renderMetadata', icon: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><path d="M21 3v6h-6"/>' },
  { key: 'translations', group: 'content', label: 'Fordítások', sub: 'Magyar címek és leírások', perm: 'anime.edit', render: 'renderTranslations', icon: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>' },

  { key: 'monitoring', group: 'insight', label: 'Infrastruktúra', sub: 'A kiszolgáló állapota és szolgáltatásai', perm: 'system.metrics.view', render: 'renderMonitoring', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
  { key: 'announcements', group: 'people', label: 'Hírek', sub: 'Az egész oldalra szóló üzenetek', perm: 'announcement.manage', render: 'renderAnnouncements', icon: '<path d="M3 11v3a1 1 0 0 0 1 1h3l4 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19.5 6a8 8 0 0 1 0 12"/>' },
  { key: 'changelog', group: 'people', label: 'Fejlesztési napló', sub: 'Kiadások és a bennük lévő sorok', perm: 'changelog.manage', render: 'renderChangelog', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>' },
  { key: 'webhooks', group: 'ops', label: 'Webhookok', sub: 'Kimenő integrációk', perm: 'admin.webhooks.manage', render: 'renderWebhooks', icon: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>' },
  { key: 'themes', group: 'look', label: 'Témák', sub: 'Színek, amikből a látogatók választhatnak', perm: 'theme.publish', render: 'renderThemes', icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h2a4 4 0 0 0 4-4 10 10 0 0 0-10-11"/>' },
  { key: 'backups', group: 'ops', label: 'Mentések', sub: 'Mentés, ellenőrzés, visszaállítás', perm: 'backup.manage', render: 'renderBackups', icon: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>' },
  { key: 'maintenance', group: 'ops', label: 'Karbantartás', sub: 'Ütemezés, hatókör, mentességi jegyek', perm: 'security.manage', render: 'renderMaintenanceSection', icon: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>' },
  { key: 'security', group: 'ops', label: 'Biztonság', sub: 'Biztonsági állapot és vészkapcsolók', perm: 'security.manage', render: 'renderSecurity', icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>' },
  { key: 'edge', group: 'ops', label: 'Él', sub: 'Kockázati réteg, WAF, tiltások', perm: 'edge.view', render: 'renderEdge', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>' },
  // The code audit, which is not the audit *log* in Insight above — that one
  // is what people did, this one is what is wrong with the software. It took
  // the shorter key because /admin/audit is the address it was specified at;
  // the log moved to audit-log. See YUME-AUDIT-0013.
  { key: 'audit', group: 'insight', label: 'Kódaudit', sub: 'A legutóbbi kódátvizsgálás észrevételei', perm: 'audit.read', render: 'renderAuditStatus', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 11 2 2 4-4"/>' },
  { key: 'config', group: 'look', label: 'Beállítások', sub: 'Funkciókapcsolók és beállítások', perm: 'settings.system', render: 'renderConfig', icon: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>' }
]
