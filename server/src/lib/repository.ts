// Importing extensions from an external repository index.
//
// ---------------------------------------------------------------------------
// What a repository is
// ---------------------------------------------------------------------------
// A JSON document listing packages, each with a URL to its source. It is how
// extensions are distributed outside this deployment — the packages that ship
// with the project reach the store through scripts/publish-extensions.ts, and
// until now that was the *only* way anything could get in. An operator could
// not host their own set, and neither could anybody else.
//
// ---------------------------------------------------------------------------
// The rule that makes it safe to import a stranger's code
// ---------------------------------------------------------------------------
// The index never gets to say what its packages hash to. The bytes are fetched
// here, hashed here, and stored under the hash this server computed — the same
// rule the publish endpoint follows, for the same reason: a recorded hash is
// only worth checking if the recorder produced it. An index that lies about a
// hash therefore cannot make a client run something that was not reviewed; the
// hash simply comes out different and the client rejects it.
//
// Everything else follows from treating the index as hostile input: every URL
// goes through the SSRF guard, every response is size-capped, the declared
// network hosts are derived from the code that was actually fetched rather
// than from whatever the index claimed, and nothing is executed on the server.

import { checkOutboundUrl } from './ssrf.ts'
import { looksLikeSource, MAX_PACKAGE_BYTES } from './package-store.ts'

import type { ExtensionType } from './extension-manifest.ts'

/** An index is a list of packages, not a payload. 512 KB is generous for that. */
export const MAX_INDEX_BYTES = Number(process.env.MAX_INDEX_BYTES ?? 512_000)
const FETCH_TIMEOUT_MS = Number(process.env.REPOSITORY_TIMEOUT_MS ?? 15_000)

const TYPES = new Set(['torrent', 'nzb', 'http', 'subtitle', 'metadata', 'theme'])
const ACCURACIES = new Set(['high', 'medium', 'low'])
const MEDIA = new Set(['sub', 'dub', 'both'])

export interface IndexEntry {
  id: string
  name: string
  version: string
  type: ExtensionType
  code: string
  summary?: string | undefined
  accuracy?: string | undefined
  media?: string | undefined
  languages?: string[] | undefined
  nsfw?: boolean | undefined
  icon?: string | undefined
}

export interface ImportProblem {
  entry: string
  reason: string
}

/**
 * A slug this store can hold.
 *
 * Repository ids are namespaced in ways the store's slug column will not take
 * (`hayase.extension.nyaa`), so they are flattened rather than rejected — the
 * id is the publisher's name for the thing, not ours.
 */
export function slugify (id: string): string {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Read an index document into entries, dropping anything unusable.
 *
 * Both shapes seen in the wild are accepted: a bare array, or an object with
 * an `extensions` array. Anything without an id, a version, a usable type and
 * a code URL is not a package this store can hold, and is reported rather than
 * silently skipped — an operator importing ten and getting seven wants to know
 * which three did not make it.
 */
export function parseIndex (body: unknown): { entries: IndexEntry[], problems: ImportProblem[] } {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { extensions?: unknown })?.extensions)
      ? (body as { extensions: unknown[] }).extensions
      : null

  const entries: IndexEntry[] = []
  const problems: ImportProblem[] = []
  if (!list) return { entries, problems: [{ entry: '(index)', reason: 'not a list of packages' }] }

  for (const raw of list) {
    const e = raw as Record<string, unknown>
    const name = String(e?.name ?? e?.id ?? 'unnamed')
    if (!e || typeof e !== 'object') { problems.push({ entry: name, reason: 'not an object' }); continue }
    if (typeof e.id !== 'string' || !slugify(e.id)) { problems.push({ entry: name, reason: 'missing a usable id' }); continue }
    if (typeof e.version !== 'string' || !/^\d+\.\d+\.\d+/.test(e.version)) {
      problems.push({ entry: name, reason: 'version must be semver' }); continue
    }
    if (typeof e.type !== 'string' || !TYPES.has(e.type)) {
      problems.push({ entry: name, reason: `type must be one of: ${[...TYPES].join(', ')}` }); continue
    }
    if (typeof e.code !== 'string' || !/^https:\/\//.test(e.code)) {
      problems.push({ entry: name, reason: 'code must be an https URL' }); continue
    }
    entries.push({
      id: e.id,
      name: typeof e.name === 'string' && e.name ? e.name.slice(0, 120) : e.id,
      version: e.version,
      type: e.type as ExtensionType,
      code: e.code,
      summary: typeof e.summary === 'string' ? e.summary.slice(0, 200) : undefined,
      accuracy: typeof e.accuracy === 'string' && ACCURACIES.has(e.accuracy) ? e.accuracy : undefined,
      media: typeof e.media === 'string' && MEDIA.has(e.media) ? e.media : undefined,
      languages: Array.isArray(e.languages) ? e.languages.filter(l => typeof l === 'string').slice(0, 20) as string[] : undefined,
      nsfw: e.nsfw === true,
      icon: typeof e.icon === 'string' ? e.icon.slice(0, 300) : undefined
    })
  }
  return { entries, problems }
}

/**
 * The hosts a package actually reaches, read out of its source.
 *
 * The index's own claim is not used: it is the thing being checked. Literal
 * URLs in the code are what the sandbox will be asked to allow, so they are
 * what gets declared — and because the allowlist is enforced host-side, a
 * package that builds a URL dynamically simply fails to reach it rather than
 * escaping the list.
 *
 * That is a real limitation and it is the safe direction to fail in: an
 * under-declared host breaks the extension, an over-declared one would widen
 * the sandbox.
 */
export function hostsFrom (source: string): string[] {
  const hosts = new Set<string>()
  for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/'"`\s)]|$)/gi)) {
    const host = match[1]!.toLowerCase().replace(/\.+$/, '')
    // A host with no dot, or one that is plainly a placeholder, is not worth
    // declaring — it would only widen the allowlist for nothing.
    if (host.includes('.') && !host.endsWith('.example.com')) hosts.add(host)
  }
  return [...hosts].sort().slice(0, 20)
}

/** Fetch a URL that came from outside, with every guard applied. */
export async function fetchExternal (url: string, maxBytes: number): Promise<Buffer> {
  const verdict = await checkOutboundUrl(url)
  if (!verdict.ok) throw new Error(`refused to fetch ${url}: it ${verdict.reason}`)

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)

    // Content-Length is a claim; the body is the fact. Both are checked, the
    // first so an oversized download is refused before it starts.
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new Error(`${url} is ${declared} bytes, over the ${maxBytes} byte limit`)

    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > maxBytes) throw new Error(`${url} is over the ${maxBytes} byte limit`)
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build the manifest this store validates against, from an index entry and the
 * code that was actually fetched.
 *
 * `compat: 'hayase'` because a package distributed through one of these
 * indexes is written against Hayase's API — it calls the bare global `fetch`,
 * which this sandbox removed. The alias is declared here rather than applied
 * silently, so it is visible to anybody reviewing the version.
 */
export function manifestFor (entry: IndexEntry, source: string, repositoryUrl: string): Record<string, unknown> {
  const hosts = hostsFrom(source)
  const permissions: Record<string, { hosts?: string[] }> = {
    'query:ids': {},
    'query:titles': {}
  }
  if (hosts.length) permissions['net:fetch'] = { hosts }

  return {
    manifestVersion: 3,
    id: slugify(entry.id),
    name: entry.name,
    version: entry.version,
    type: entry.type,
    summary: entry.summary ?? `${entry.name} — imported from a third-party repository.`,
    description: [
      `Imported from ${repositoryUrl}.`,
      '',
      'This package was not written for this store: it comes from a third-party',
      'repository and runs in compatibility mode. Its network access is limited',
      'to the hosts found in its own source, and this deployment vouches for',
      'neither its behaviour nor what it returns.',
      entry.nsfw ? '' : null,
      entry.nsfw ? 'The publisher marks this package as NSFW.' : null
    ].filter(l => l !== null).join('\n'),
    icon: entry.icon,
    accuracy: entry.accuracy ?? 'low',
    media: entry.media ?? 'both',
    languages: entry.languages ?? [],
    compat: 'hayase',
    permissions
  }
}

export { MAX_PACKAGE_BYTES, looksLikeSource }
