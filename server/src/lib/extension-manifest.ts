// Extension manifest (v3) validation — the authoritative gate for what may
// enter the store. The format is specified in docs/extensions.md; this module
// is the single implementation of those rules, used by the publish endpoint
// and the review worker so they can never disagree.
//
// Validation is deliberately strict: an extension declares exactly what it can
// do, and the client sandbox enforces only what was declared here. Anything
// vague or undeclared is rejected at publish time rather than discovered at
// runtime.

export const MANIFEST_VERSION = 3

export const EXTENSION_TYPES = ['torrent', 'nzb', 'http', 'subtitle', 'metadata', 'theme'] as const
export const PERMISSIONS = ['net:fetch', 'query:ids', 'query:titles', 'query:media', 'storage:local', 'player:subtitles'] as const
export const ACCURACIES = ['high', 'medium', 'low'] as const
export const MEDIA_KINDS = ['sub', 'dub', 'both'] as const

export type ExtensionType = typeof EXTENSION_TYPES[number]
export type Permission = typeof PERMISSIONS[number]

const ID_PATTERN = /^[a-z0-9-]{3,64}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** Hostname only — no scheme, path, port, wildcard or credentials. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const OPTION_TYPES = ['boolean', 'string', 'number', 'select'] as const

export interface OptionSpec {
  type: typeof OPTION_TYPES[number]
  default?: unknown
  description?: string
  choices?: string[]
}

export interface ExtensionManifest {
  manifestVersion: number
  id: string
  name: string
  version: string
  type: ExtensionType
  summary: string
  description?: string
  icon?: string
  accuracy?: typeof ACCURACIES[number]
  media?: typeof MEDIA_KINDS[number]
  languages?: string[]
  minAppVersion?: string
  permissions?: Partial<Record<Permission, { hosts?: string[] }>>
  options?: Record<string, OptionSpec>
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  /** Normalised permission rows, ready to insert into extension_permissions. */
  permissions: Array<{ permission: Permission, hosts: string[] }>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate a manifest. Returns every problem at once so a developer can fix
 * them in one pass instead of one error per upload.
 */
export function validateManifest (input: unknown): ValidationResult {
  const errors: string[] = []
  const permissions: ValidationResult['permissions'] = []

  if (!isPlainObject(input)) {
    return { valid: false, errors: ['manifest must be a JSON object'], permissions }
  }
  const m = input as Partial<ExtensionManifest> & Record<string, unknown>

  // ---- identity ----
  if (m.manifestVersion !== MANIFEST_VERSION) {
    errors.push(`manifestVersion must be ${MANIFEST_VERSION} (got ${JSON.stringify(m.manifestVersion)})`)
  }
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
    errors.push('id must be 3-64 characters of lowercase letters, digits or hyphens')
  }
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) {
    errors.push('name is required and must be at most 80 characters')
  }
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) {
    errors.push('version must be semver (e.g. 1.2.3)')
  }
  if (typeof m.type !== 'string' || !(EXTENSION_TYPES as readonly string[]).includes(m.type)) {
    errors.push(`type must be one of: ${EXTENSION_TYPES.join(', ')}`)
  }
  if (typeof m.summary !== 'string' || !m.summary.trim() || m.summary.length > 200) {
    errors.push('summary is required and must be at most 200 characters')
  }

  // ---- optional descriptive fields ----
  if (m.accuracy !== undefined && !(ACCURACIES as readonly string[]).includes(m.accuracy)) {
    errors.push(`accuracy must be one of: ${ACCURACIES.join(', ')}`)
  }
  if (m.media !== undefined && !(MEDIA_KINDS as readonly string[]).includes(m.media)) {
    errors.push(`media must be one of: ${MEDIA_KINDS.join(', ')}`)
  }
  if (m.languages !== undefined) {
    if (!Array.isArray(m.languages) || m.languages.some(l => typeof l !== 'string')) {
      errors.push('languages must be an array of strings')
    } else if (m.languages.length > 40) {
      errors.push('languages may list at most 40 entries')
    }
  }
  if (m.minAppVersion !== undefined && (typeof m.minAppVersion !== 'string' || !SEMVER.test(m.minAppVersion))) {
    errors.push('minAppVersion must be semver')
  }

  // ---- permissions ----
  if (m.permissions !== undefined) {
    if (!isPlainObject(m.permissions)) {
      errors.push('permissions must be an object keyed by permission name')
    } else {
      for (const [name, config] of Object.entries(m.permissions)) {
        if (!(PERMISSIONS as readonly string[]).includes(name)) {
          errors.push(`unknown permission "${name}" (allowed: ${PERMISSIONS.join(', ')})`)
          continue
        }
        if (!isPlainObject(config)) {
          errors.push(`permission "${name}" must map to an object`)
          continue
        }

        let hosts: string[] = []
        if (name === 'net:fetch') {
          const declared = (config as { hosts?: unknown }).hosts
          // The whole point of net:fetch is the allowlist — an empty or absent
          // host list would mean "any host", which the sandbox must never grant.
          if (!Array.isArray(declared) || declared.length === 0) {
            errors.push('permission "net:fetch" requires a non-empty hosts array')
          } else if (declared.length > 20) {
            errors.push('permission "net:fetch" may declare at most 20 hosts')
          } else {
            for (const host of declared) {
              if (typeof host !== 'string' || !HOSTNAME.test(host)) {
                errors.push(`invalid host "${String(host)}" — use a bare hostname such as example.com (no scheme, port, path or wildcard)`)
              }
            }
            hosts = declared.filter((h): h is string => typeof h === 'string')
          }
        } else if (isPlainObject(config) && Array.isArray((config as { hosts?: unknown }).hosts)) {
          errors.push(`permission "${name}" does not take a hosts list`)
        }

        permissions.push({ permission: name as Permission, hosts })
      }
    }
  }

  // subtitle injection only makes sense for subtitle extensions
  if (permissions.some(p => p.permission === 'player:subtitles') && m.type !== 'subtitle') {
    errors.push('permission "player:subtitles" is only available to extensions of type "subtitle"')
  }

  // ---- options schema ----
  if (m.options !== undefined) {
    if (!isPlainObject(m.options)) {
      errors.push('options must be an object')
    } else {
      for (const [key, spec] of Object.entries(m.options)) {
        if (!/^[a-z0-9_]{1,40}$/.test(key)) {
          errors.push(`option key "${key}" must be lowercase letters, digits or underscores (max 40)`)
          continue
        }
        if (!isPlainObject(spec) || !(OPTION_TYPES as readonly string[]).includes(spec.type as string)) {
          errors.push(`option "${key}" needs a type of: ${OPTION_TYPES.join(', ')}`)
          continue
        }
        if (spec.type === 'select' && (!Array.isArray(spec.choices) || spec.choices.length === 0)) {
          errors.push(`option "${key}" of type select needs a non-empty choices array`)
        }
        if (spec.description !== undefined && typeof spec.description !== 'string') {
          errors.push(`option "${key}" description must be a string`)
        }
      }
      if (Object.keys(m.options).length > 30) errors.push('at most 30 options are allowed')
    }
  }

  return { valid: errors.length === 0, errors, permissions }
}

/** Compare two semver strings. Returns -1, 0 or 1. Pre-release tags are ignored. */
export function compareVersions (a: string, b: string): number {
  const parse = (v: string): number[] => v.split('-')[0]!.split('.').map(Number)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

/** Is `appVersion` new enough to run an extension requiring `minAppVersion`? */
export const satisfiesMinAppVersion = (appVersion: string, minAppVersion?: string | null): boolean =>
  !minAppVersion || compareVersions(appVersion, minAppVersion) >= 0

/**
 * A new version may not quietly gain permissions: escalations require explicit
 * user consent at update time, so the store flags them.
 */
export function escalatedPermissions (
  previous: Array<{ permission: string, hosts: string[] }>,
  next: Array<{ permission: string, hosts: string[] }>
): string[] {
  const before = new Map(previous.map(p => [p.permission, new Set(p.hosts)]))
  const added: string[] = []
  for (const perm of next) {
    const existing = before.get(perm.permission)
    if (!existing) { added.push(perm.permission); continue }
    const newHosts = perm.hosts.filter(host => !existing.has(host))
    if (newHosts.length) added.push(`${perm.permission} (+${newHosts.join(', ')})`)
  }
  return added
}
