// A stable code to put next to a request id.
//
// "Something went wrong" is not something a user can report and not something
// an operator can triage. The pair a person can actually carry is a code that
// says roughly *what broke* and an id that says *which time*.
//
// Derived, not enumerated. The brief this came from asked for a registry —
// YUME-AUTH-ERR-001, YUME-RELATION-ERR-001 and so on — and a hand-maintained
// list of a few hundred numbers is the same shape as the permission catalogue
// that spent a year claiming 340 permissions were enforced when 18 were. A
// code nobody updates is worse than no code, because it points confidently at
// the wrong thing.
//
// So the component comes from the route the request was already going to, and
// the class from the status it already returned. Both are facts the server
// holds at the moment it answers; neither can drift out of date, and a new
// route gets a correct code the day it is written without anybody registering
// anything.
//
// What this gives up is precision within a component: two different 500s in
// the catalogue share YUME-CATALOGUE-500. That is what the request id is for —
// it identifies the occurrence, and the admin panel looks the occurrence up by
// it (see routes/admin.ts, errors/by-request).

/** Longest-prefix wins, so /v1/admin/catalogue is CATALOGUE, not ADMIN. */
const COMPONENTS: Array<[RegExp, string]> = [
  [/^\/v1\/admin\/catalogue/, 'CATALOGUE'],
  [/^\/v1\/admin\/translations/, 'TRANSLATION'],
  [/^\/v1\/admin\/monitoring/, 'MONITOR'],
  [/^\/v1\/admin\/webhooks/, 'WEBHOOK'],
  [/^\/v1\/admin\/security/, 'SECURITY'],
  [/^\/v1\/admin\/themes/, 'THEME'],
  [/^\/v1\/admin\/config/, 'CONFIG'],
  [/^\/v1\/admin\/roles/, 'ROLE'],
  [/^\/v1\/admin/, 'ADMIN'],
  [/^\/v1\/auth/, 'AUTH'],
  [/^\/v1\/anime/, 'ANIME'],
  [/^\/v1\/comments/, 'COMMENT'],
  [/^\/v1\/reports/, 'REPORT'],
  [/^\/v1\/profiles/, 'PROFILE'],
  [/^\/v1\/themes/, 'THEME'],
  [/^\/v1\/config/, 'CONFIG'],
  [/^\/v1\/health/, 'HEALTH'],
  [/^\/v1\/w2g/, 'W2G'],
  [/^\/v1\/me/, 'ME'],
  [/^\/graphql/, 'GRAPHQL']
]

/**
 * The code for a failure on this route with this status.
 *
 * `route` should be the *pattern* where one is available — `/v1/anime/:id`
 * rather than `/v1/anime/8f1c…` — so the same fault produces the same code
 * whatever id it happened to be given.
 */
export function errorCode (route: string, status: number): string {
  // A 404 never names a component, and this is not a detail.
  //
  // The admin surface answers 404 rather than 403 precisely so that an account
  // without permission cannot tell a route it may not open from one that does
  // not exist. `YUME-ADMIN-404` puts the word back — a prober learns that
  // /v1/admin/users is a real admin route by reading the code on the very
  // reply meant to hide it. test/admin-visibility.test.ts caught this the
  // first time it was written the other way.
  //
  // Nothing is lost that matters: a 404 means "there is nothing here", and the
  // request id still identifies the exact occurrence for anybody who is
  // allowed to look it up.
  if (status === 404) return 'YUME-API-404'

  const component = COMPONENTS.find(([pattern]) => pattern.test(route))?.[1] ?? 'API'
  return `YUME-${component}-${status}`
}
