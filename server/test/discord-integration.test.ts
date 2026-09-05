// The routes the bot depends on.
//
// The bot has no database — deliberately, so it carries no `pg` dependency and
// no credential for one. It therefore asks the API to remember which Discord
// message is which, and these are the only routes that answer.
//
// Two things are worth guarding: the service token really gates them (they are
// unauthenticated as far as the JWT layer is concerned), and the upsert really
// is one row per key however many times it runs.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'discord-test-secret-long-enough-0123456789'
const TOKEN = 'service-token-for-tests-0123456789'
process.env.YUME_SERVICE_TOKEN = TOKEN

describe('Discord integration routes', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const keys: string[] = []

  const key = (): string => { const k = `itest:${randomUUID()}`; keys.push(k); return k }
  const auth = { 'x-service-token': TOKEN }

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()
  })

  after(async () => {
    if (keys.length) await pool.query('DELETE FROM discord_messages WHERE key = ANY($1)', [keys])
    await pool.query("DELETE FROM audit_logs WHERE subject_type = 'discord' AND after->>'subject' LIKE 'itest%'")
    await app?.close()
    await pool?.end()
  })

  describe('the service token', () => {
    test('every route refuses a caller without it', async () => {
      // These sit outside the JWT layer entirely, so this is the only gate.
      const k = key()
      for (const [method, url] of [
        ['GET', `/v1/integrations/discord/messages/${k}`],
        ['PUT', `/v1/integrations/discord/messages/${k}`],
        ['DELETE', `/v1/integrations/discord/messages/${k}`],
        ['POST', '/v1/integrations/discord/audit']
      ] as const) {
        const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} })
        assert.equal(res.statusCode, 401, `${method} ${url}`)
      }
    })

    test('a wrong token is refused as firmly as no token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/discord/messages/${key()}`,
        headers: { 'x-service-token': 'not-the-token' }
      })
      assert.equal(res.statusCode, 401)
    })
  })

  describe('message identity', () => {
    test('an unknown key is a 404, so the bot knows to post', async () => {
      const res = await app.inject({ url: `/v1/integrations/discord/messages/${key()}`, headers: auth })
      assert.equal(res.statusCode, 404)
    })

    test('a key round-trips', async () => {
      const k = key()
      const put = await app.inject({
        method: 'PUT',
        url: `/v1/integrations/discord/messages/${k}`,
        headers: auth,
        payload: { guildId: 'g1', channelId: 'c1', messageId: 'm1', contentHash: 'a'.repeat(64) }
      })
      assert.equal(put.statusCode, 200)

      const got = (await app.inject({ url: `/v1/integrations/discord/messages/${k}`, headers: auth })).json() as Record<string, unknown>
      assert.equal(got.message_id, 'm1')
      assert.equal(got.channel_id, 'c1')
      assert.equal(got.content_hash, 'a'.repeat(64))
    })

    test('writing the same key again replaces rather than duplicates', async () => {
      // The primary key already guarantees this; the test guards the upsert
      // clause, which is what would silently start inserting on a rewrite.
      const k = key()
      for (const messageId of ['m1', 'm2', 'm3']) {
        await app.inject({
          method: 'PUT',
          url: `/v1/integrations/discord/messages/${k}`,
          headers: auth,
          payload: { guildId: 'g1', channelId: 'c1', messageId, contentHash: 'b'.repeat(64) }
        })
      }
      const { rows } = await pool.query('SELECT message_id FROM discord_messages WHERE key = $1', [k])
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.message_id, 'm3')
    })

    test('edit_count counts edits and not first posts', async () => {
      // A static page with a high edit count means something renders
      // non-deterministically; that signal is only useful if it is accurate.
      const k = key()
      const put = async (edited: boolean, hash: string): Promise<void> => {
        await app.inject({
          method: 'PUT',
          url: `/v1/integrations/discord/messages/${k}`,
          headers: auth,
          payload: { guildId: 'g1', channelId: 'c1', messageId: 'm1', contentHash: hash, edited }
        })
      }
      await put(false, 'c'.repeat(64))
      let row = (await app.inject({ url: `/v1/integrations/discord/messages/${k}`, headers: auth })).json() as { edit_count: number }
      assert.equal(row.edit_count, 0, 'posting is not editing')

      await put(true, 'd'.repeat(64))
      await put(true, 'e'.repeat(64))
      row = (await app.inject({ url: `/v1/integrations/discord/messages/${k}`, headers: auth })).json() as { edit_count: number }
      assert.equal(row.edit_count, 2)
    })

    test('a forgotten key makes the next sync post afresh', async () => {
      const k = key()
      await app.inject({
        method: 'PUT',
        url: `/v1/integrations/discord/messages/${k}`,
        headers: auth,
        payload: { guildId: 'g1', channelId: 'c1', messageId: 'm1', contentHash: 'f'.repeat(64) }
      })
      assert.equal((await app.inject({ method: 'DELETE', url: `/v1/integrations/discord/messages/${k}`, headers: auth })).statusCode, 204)
      assert.equal((await app.inject({ url: `/v1/integrations/discord/messages/${k}`, headers: auth })).statusCode, 404)
    })
  })

  describe('audit', () => {
    test('a moderation action lands in the same trail as the admin panel', async () => {
      const subject = `itest-${randomUUID()}`
      const res = await app.inject({
        method: 'POST',
        url: '/v1/integrations/discord/audit',
        headers: auth,
        payload: { action: 'discord.ban', actor: '1234567890', subject, detail: { reason: 'testing' } }
      })
      assert.equal(res.statusCode, 202)

      const { rows } = await pool.query(
        "SELECT actor_id, action, subject_type, after FROM audit_logs WHERE subject_type = 'discord' AND after->>'subject' = $1",
        [subject]
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.action, 'discord.ban')
      // A Discord id is not a Yume account id and must not be written into a
      // uuid column that references users.
      assert.equal(rows[0]!.actor_id, null)
      assert.equal((rows[0]!.after as Record<string, unknown>).discordActorId, '1234567890')
    })

    test('an action outside the allowed list is refused, not recorded', async () => {
      // Otherwise the trail could be seeded with invented verbs by anything
      // holding the token.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/integrations/discord/audit',
        headers: auth,
        payload: { action: 'discord.nuke', actor: '1', subject: 'itest-x' }
      })
      assert.equal(res.statusCode, 400)
    })
  })
})
