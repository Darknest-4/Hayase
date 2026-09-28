// The path a request is routed on — the one every path-based decision must use.
//
// Fastify's router (find-my-way) does not match on the raw request target. It
// takes the path out of an absolute-form target, cuts the query string off and
// percent-decodes what is left. A gate that tests `request.url` against a
// prefix therefore sees a different string than the router routes on:
// `/%761/anime` is served by the `/v1/anime` route, but it does not start with
// `/v1`. Every prefix check written that way — the private-instance gate, the
// read-only switch, the maintenance scopes, the edge layer's fail-closed list —
// could be walked around with one encoded character.
//
// `routingPath` reproduces the router's normalisation step for step, so a
// decision made on its result is a decision about the route that will run.

/*
 * Percent-escapes that `decodeURI` leaves alone because they decode to a
 * reserved character. find-my-way keeps them encoded in the path as well.
 * `%25` is special-cased: it is re-encoded before `decodeURI` runs, so an
 * encoded percent sign is never decoded twice.
 */
const RESERVED_ESCAPES = new Set([
  '23', '24', '25', '26', '2b', '2c', '2f', '3a', '3b', '3d', '3f', '40'
])

/** The path of an absolute-form request target (`GET http://host/v1/x`). */
function pathFromAbsolute (target: string): string | null {
  const schemeEnd = target.indexOf('://')
  if (schemeEnd === -1) return target
  const scheme = target.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return target
  const pathStart = target.indexOf('/', schemeEnd + 3)
  const queryStart = target.indexOf('?', schemeEnd + 3)
  if (pathStart === -1 || (queryStart !== -1 && queryStart < pathStart)) return '/'
  return target.slice(pathStart)
}

/**
 * The decoded path the router matches for this request target, without the
 * query string. A target the router would refuse as malformed comes back
 * undecoded — it is answered with 400 before any route runs.
 */
export function routingPath (target: string): string {
  let path = target.charCodeAt(0) === 47 ? target : pathFromAbsolute(target)
  if (path === null) return target

  const end = path.search(/[?#]/)
  if (end !== -1) path = path.slice(0, end)
  if (!path.includes('%')) return path

  let shouldDecode = false
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) !== 37) continue
    const pair = path.slice(i + 1, i + 3).toLowerCase()
    if (!RESERVED_ESCAPES.has(pair)) {
      shouldDecode = true
      continue
    }
    if (pair === '25') {
      shouldDecode = true
      path = path.slice(0, i + 1) + '25' + path.slice(i + 1)
      i += 2
    }
    i += 2
  }
  if (!shouldDecode) return path
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

/** `routingPath` of a Fastify request. */
export function pathOf (request: { url: string }): string {
  return routingPath(request.url)
}

/** True when the request is for the API surface: `/v1/…` or `/graphql`. */
export function isApiPath (path: string): boolean {
  return /^\/(v1|graphql)(\/|$)/.test(path)
}
