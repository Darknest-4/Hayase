// /v1/admin/roles — roles & permission assignment (RBAC management).
// Permission-gated (roles.manage). The full permission catalogue and every
// role's granted slugs are readable here; individual grants toggle live.

import { query, queryOne } from '../db.ts'
import { invalidatePermissions } from '../plugins/auth.ts'
import { audit } from '../lib/audit.ts'
import { emitEvent } from '../lib/webhooks.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', fastify.requirePermission('roles.manage'))

  // all roles with their granted permission slugs + how many users hold them
  fastify.get('/', async () => {
    const data = await query(
      `SELECT r.id, r.slug, r.name, r.description, r.is_system,
              (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
              COALESCE(array_agg(p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.slug`
    )
    return { data }
  })

  // the full permission catalogue, grouped for the UI
  fastify.get('/permissions', async () => {
    const data = await query('SELECT slug, "group", description, status FROM permissions ORDER BY "group", slug')
    return { data }
  })

  // grant / revoke a single permission on a role
  fastify.post('/:roleId/permissions', {
    schema: {
      params: { type: 'object', properties: { roleId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['slug', 'granted'],
        properties: { slug: { type: 'string', maxLength: 80 }, granted: { type: 'boolean' } }
      }
    }
  }, async (request, reply) => {
    const { roleId } = request.params as { roleId: string }
    const { slug, granted } = request.body as { slug: string, granted: boolean }

    const role = await queryOne<{ slug: string }>('SELECT slug FROM roles WHERE id = $1', [roleId])
    if (!role) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Role not found' })
    if (role.slug === 'admin') {
      return reply.code(400).send({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'The admin role always has every permission' })
    }

    const perm = await queryOne<{ id: string }>('SELECT id FROM permissions WHERE slug = $1', [slug])
    if (!perm) return reply.code(404).send({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'Permission not found' })

    if (granted) {
      await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, perm.id])
    } else {
      await query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2', [roleId, perm.id])
    }
    // Cached permission sets are now wrong for everyone holding this role.
    invalidatePermissions()

    // Who may do what is exactly the change that must be reconstructable
    // later; before this, only user status changes were audited at all.
    await audit(request.user.sub, granted ? 'role.permission.grant' : 'role.permission.revoke', 'role', roleId,
      { role: role.slug }, { permission: slug, granted })

    void emitEvent('config.changed', { key: `role:${role.slug}`, value: `${granted ? '+' : '−'} ${slug}`, by: request.user.username })
    return { ok: true, roleId, slug, granted }
  })
}

export default routes
