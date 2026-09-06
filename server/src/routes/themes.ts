// Themes.
//   GET   /v1/themes              — what a viewer may choose from
//   GET   /v1/admin/themes        — the editor's view, including disabled rows
//   POST  /v1/admin/themes        — create
//   PATCH /v1/admin/themes/:id    — edit, enable/disable, make default
//   DELETE /v1/admin/themes/:id   — remove (built-ins excepted)
//
// A theme is data: a base, an accent, and optional token overrides. It used to
// be an extension — a package in a store, sandboxed in a worker, asked over a
// message channel for a list of colours. That is a great deal of machinery for
// twelve hex values, and it meant an operator could not put their own palette
// in front of their own viewers without publishing a package.

import { query, queryOne, transaction } from '../db.ts'
import { audit } from '../lib/audit.ts'
import { badToken, validColour } from '../lib/colour.ts'

import type { FastifyPluginAsync } from 'fastify'

const THEME_FIELDS = {
  slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,40}$' },
  name: { type: 'string', minLength: 1, maxLength: 60 },
  base: { enum: ['dark', 'light'] },
  accent: { type: ['string', 'null'], maxLength: 140 },
  tint: { type: 'boolean' },
  tokens: { type: 'object' },
  enabled: { type: 'boolean' },
  isDefault: { type: 'boolean' },
  sort: { type: 'integer', minimum: -32768, maximum: 32767 }
} as const

interface ThemeBody {
  slug?: string
  name?: string
  base?: string
  accent?: string | null
  tint?: boolean
  tokens?: Record<string, unknown>
  enabled?: boolean
  isDefault?: boolean
  sort?: number
}

/** Whatever is wrong with the colours in this body, or null. */
function badColours (body: ThemeBody): string | null {
  if (body.accent !== undefined && body.accent !== null && !validColour(body.accent)) {
    return 'The accent is not a colour this can use — try a hex value like #7c5cff or hsl(248 72% 68%)'
  }
  return badToken(body.tokens)
}

// ---- public ----
export const publicThemes: FastifyPluginAsync = async fastify => {
  /**
   * What a viewer may pick.
   *
   * No authentication: the theme list is chrome, it is the same for everyone,
   * and requiring a token would mean a signed-out visitor gets the wrong
   * colours until they sign in.
   */
  fastify.get('/', async () => {
    const data = await query(
      `SELECT slug, name, base, accent, tint, tokens, is_default
         FROM themes WHERE enabled ORDER BY sort, name`
    )
    return { data }
  })
}

// ---- admin ----
export const adminThemes: FastifyPluginAsync = async fastify => {
  fastify.addHook('onRequest', fastify.requirePermission('theme.publish', { hide: true }))

  fastify.get('/', async () => {
    const data = await query(
      `SELECT t.id, t.slug, t.name, t.base, t.accent, t.tint, t.tokens,
              t.enabled, t.is_default, t.sort, t.built_in, t.updated_at,
              u.username AS created_by
         FROM themes t
         LEFT JOIN users u ON u.id = t.created_by
        ORDER BY t.sort, t.name`
    )
    return { data }
  })

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['slug', 'name', 'base'],
        additionalProperties: false,
        properties: THEME_FIELDS
      }
    }
  }, async (request, reply) => {
    const body = request.body as ThemeBody
    const bad = badColours(body)
    if (bad) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: bad })

    let row
    try {
      row = await queryOne<{ id: string }>(
        `INSERT INTO themes (slug, name, base, accent, tint, tokens, enabled, sort, created_by)
         VALUES ($1, $2, $3, $4, coalesce($5, false), coalesce($6, '{}'::jsonb), coalesce($7, true), coalesce($8, 100), $9)
         RETURNING id`,
        [body.slug, body.name, body.base, body.accent ?? null, body.tint ?? null,
          JSON.stringify(body.tokens ?? {}), body.enabled ?? null, body.sort ?? null, request.user.sub]
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({
          type: 'about:blank', title: 'Conflict', status: 409, detail: 'A theme with that slug already exists'
        })
      }
      throw err
    }

    if (body.isDefault) await makeDefault(row?.id ?? '')
    await audit(request.user.sub, 'theme.create', 'theme', row?.id ?? null, null, { slug: body.slug, name: body.name })
    return reply.code(201).send({ id: row?.id, slug: body.slug })
  })

  fastify.patch('/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: THEME_FIELDS }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as ThemeBody
    const bad = badColours(body)
    if (bad) return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: bad })

    const existing = await queryOne<{ built_in: boolean, is_default: boolean }>(
      'SELECT built_in, is_default FROM themes WHERE id = $1', [id])
    if (!existing) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })

    // A built-in may be renamed, recoloured, reordered and disabled — but not
    // renamed out of existence: the slug is what a viewer's saved choice
    // points at, and changing it would silently reset everyone using it.
    if (existing.built_in && body.slug !== undefined) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'A built-in theme keeps its slug — viewers who chose it are pointing at that name'
      })
    }
    // Disabling the default would leave viewers who never chose with a theme
    // that is not offered. Make another one default first.
    if (existing.is_default && body.enabled === false) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'This is the default theme — make another one default before disabling it'
      })
    }

    const columns: Array<[keyof ThemeBody, string]> = [
      ['slug', 'slug'], ['name', 'name'], ['base', 'base'], ['accent', 'accent'],
      ['tint', 'tint'], ['enabled', 'enabled'], ['sort', 'sort']
    ]
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, column] of columns) {
      if (body[key] === undefined) continue
      values.push(body[key])
      sets.push(`${column} = $${values.length}`)
    }
    if (body.tokens !== undefined) {
      values.push(JSON.stringify(body.tokens))
      sets.push(`tokens = $${values.length}::jsonb`)
    }

    if (sets.length) {
      values.push(id)
      sets.push('updated_at = now()')
      const updated = await queryOne<{ id: string }>(
        `UPDATE themes SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`, values)
      if (!updated) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    } else if (body.isDefault === undefined) {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'No changes' })
    }

    if (body.isDefault) await makeDefault(id)
    await audit(request.user.sub, 'theme.update', 'theme', id, null, body as Record<string, unknown>)
    return { id }
  })

  fastify.delete('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const theme = await queryOne<{ built_in: boolean, is_default: boolean, slug: string }>(
      'SELECT built_in, is_default, slug FROM themes WHERE id = $1', [id])
    if (!theme) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404 })
    if (theme.built_in) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'A built-in theme ships with the deployment and cannot be deleted — disable it instead'
      })
    }
    if (theme.is_default) {
      return reply.code(400).send({
        type: 'about:blank', title: 'Bad Request', status: 400,
        detail: 'This is the default theme — make another one default first'
      })
    }
    await query('DELETE FROM themes WHERE id = $1', [id])
    await audit(request.user.sub, 'theme.delete', 'theme', id, { slug: theme.slug }, null)
    return { id, deleted: true }
  })
}

/**
 * Move the default to one theme.
 *
 * In a transaction because the partial unique index allows exactly one: clear
 * then set, and the two statements have to be one act or a failure between
 * them leaves a deployment with no default at all.
 */
async function makeDefault (id: string): Promise<void> {
  await transaction(async client => {
    await client.query('UPDATE themes SET is_default = false WHERE is_default AND id <> $1', [id])
    await client.query('UPDATE themes SET is_default = true, enabled = true, updated_at = now() WHERE id = $1', [id])
  })
}
