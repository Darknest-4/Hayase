// /v1/admin — the administration surface, composed from the modules that own
// each part of it.
//
// This file was 779 lines and four unrelated jobs: account management, the
// moderation queue, platform analytics with error triage, and the audit trail.
// Nothing tied them together except the URL prefix they happened to share, and
// a file that has four reasons to change is one that gets edited by four
// people who each read a quarter of it.
//
// The prefix is the only thing that belonged here, so it is the only thing
// left. Every URL is exactly where it was — the split is internal, and
// apps/web calls none of it differently.

import userRoutes from '../users/routes.ts'
import moderationQueue from '../moderation/admin-routes.ts'
import analyticsRoutes from '../analytics/routes.ts'

import type { FastifyPluginAsync } from 'fastify'

const routes: FastifyPluginAsync = async fastify => {
  // Registered without a further prefix: each module declares its own paths
  // (/users, /reports, /analytics, /errors, /audit) exactly as before.
  await fastify.register(userRoutes)
  await fastify.register(moderationQueue)
  await fastify.register(analyticsRoutes)
}

export default routes
