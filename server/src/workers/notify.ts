// Notification worker: writes inbox rows and pushes them over WebSocket.
// Push/email delivery hangs off the same job via device adapters later —
// the inbox write is the source of truth either way.
// Job payload: { userId, type, data }

import { query } from '../db.ts'
import { publish } from '../lib/ws.ts'

import type { Job } from '../lib/queue.ts'

export async function notify (userId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const rows = await query<{ id: string, created_at: string }>(
    `INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [userId, type, data]
  )
  const row = rows[0]!
  // live push to any connected session of this user
  publish(`user:${userId}`, { type: 'notification', notification: { id: row.id, type, payload: data, createdAt: row.created_at } })
}

export async function handleNotifyJob (job: Job): Promise<void> {
  const { userId, type, data } = job.payload as { userId: string, type: string, data: Record<string, unknown> }
  await notify(userId, type, data ?? {})
}
