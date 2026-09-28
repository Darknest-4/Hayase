// Mely jogosultságok nyitnak adminszakaszt — a router ennyit tud a panelről.
//
// A router a navigációban csak annak mutatja az „Adminisztráció" linket, aki
// legalább egy szakaszt lát. Ehhez eddig az egész szakaszlistát importálta
// (`admin-sections.js`: címkék, csoportok, ikonok, 10 KB), tehát minden
// látogató letöltötte — a kijelentkezett is, a sima néző is, pedig nekik
// ebből semmi nem kell.
//
// Itt csak a jogosultságnevek állnak. A lista NEM térhet el a szakaszokétól:
// a `test/admin-access.test.mjs` pontosan ugyanazt a halmazt várja, amit az
// `ADMIN_SECTIONS` `perm` mezői adnak — egy új szakasz új jogosultsága a
// teszten bukik el, nem egy láthatatlan linken.

export const ADMIN_PERMISSIONS = Object.freeze([
  'admin.analytics.view',
  'admin.users.manage',
  'analytics.view',
  'roles.manage',
  'community.moderate',
  'anime.view',
  'anime.edit',
  'system.metrics.view',
  'announcement.manage',
  'changelog.manage',
  'video_source.view',
  'admin.webhooks.manage',
  'theme.publish',
  'backup.manage',
  'security.manage',
  'edge.view',
  'audit.read',
  'settings.system'
])
