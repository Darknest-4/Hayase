// Where an episode can be played from.
//
// `video_sources` has been in the schema since migration 0003 and nothing ever
// wrote to it: it was designed for an extension to fill. That left the
// platform two ways to play anything — a loaded extension, or a URL the viewer
// pastes into the player — so an operator had no way to curate what their own
// catalogue plays, and an episode with nothing behind it was indistinguishable
// from one that worked until somebody clicked it.
//
// The platform stores references, never media. These tests are about the two
// properties that follow from that: only an operator with the permission may
// write one, and what is written can be handed to a browser safely.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'sources-secret-long-enough-0123456789'
process.env.AUTH_RATE_LIMIT_MAX ??= '200'

describe('video sources', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  const usernames: string[] = []
  const tag = 'vs_' + randomBytes(4).toString('hex')
  let editor = ''
  let plain = ''
  let animeId = ''
  let episodeId = ''
  let hiddenEpisodeId = ''

  async function account (role?: string): Promise<string> {
    const username = 'vs_' + randomBytes(5).toString('hex')
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${username}@test.invalid`, username, password: 'a-long-enough-test-password-1' }
    })
    assert.equal(res.statusCode, 201, res.body)
    usernames.push(username)
    if (role) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.username = $1 AND r.slug = $2
         ON CONFLICT DO NOTHING`, [username, role])
      const auth = await import('../src/plugins/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  const as = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')])
    app = await buildApp()
    pool = db.pool as never
    await app.ready()

    editor = await account('admin')
    plain = await account()

    animeId = (await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV'::anime_format, 'FINISHED', 'public') RETURNING id`, [`${tag} show`]
    )).rows[0].id
    episodeId = (await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 1, 'One', 'public') RETURNING id",
      [animeId]
    )).rows[0].id
    hiddenEpisodeId = (await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 2, 'Two', 'hidden') RETURNING id",
      [animeId]
    )).rows[0].id
  })

  after(async () => {
    await pool?.query('DELETE FROM anime WHERE canonical_title LIKE $1', [tag + ' %'])
    if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    await app?.close()
    await pool?.end()
  })

  async function addSource (body: Record<string, unknown>, token = editor): Promise<{ status: number, id?: string, body: string }> {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/catalogue/episodes/${episodeId}/sources`,
      headers: as(token),
      payload: body
    })
    return { status: res.statusCode, id: (res.json() as { id?: string })?.id, body: res.body }
  }

  test('an operator can register a source from any provider', async () => {
    // Free text on purpose: "any provider" means the set is not ours to
    // enumerate, and an enum would need a migration per mirror.
    for (const provider of ['Some Provider', 'a self-hosted mirror', 'Plex']) {
      const res = await addSource({
        kind: 'http',
        ref: `https://example.invalid/${randomBytes(4).toString('hex')}/index.m3u8`,
        provider,
        resolution: '1080',
        variant: 'sub'
      })
      assert.equal(res.status, 201, res.body)
    }
    const rows = (await pool.query('SELECT provider FROM video_sources WHERE episode_id = $1', [episodeId])).rows
    assert.equal(rows.length, 3)
  })

  test('the same reference twice is not two sources', async () => {
    const ref = 'https://example.invalid/duplicate.m3u8'
    assert.equal((await addSource({ kind: 'http', ref })).status, 201)
    const again = await addSource({ kind: 'http', ref })
    assert.equal(again.status, 409, again.body)
  })

  test('a reference the browser must never be handed is refused', async () => {
    // The stored string ends up in a <video src>, an href or an iframe. A
    // javascript: or data: URL in that position is script execution in the
    // site's own origin, and the check belongs where the value is written
    // rather than at each of the places it is later read.
    for (const ref of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      // Plain http is a mixed-content error on a TLS site: it would be
      // recorded as working and then not play.
      'http://example.invalid/video.mp4'
    ]) {
      const res = await addSource({ kind: 'http', ref })
      assert.equal(res.status, 400, `${ref} was accepted`)
    }
  })

  test('a torrent source may be a magnet link or an info hash', async () => {
    assert.equal((await addSource({ kind: 'torrent', ref: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) })).status, 201)
    assert.equal((await addSource({ kind: 'torrent', ref: 'b'.repeat(40) })).status, 201)
    assert.equal((await addSource({ kind: 'torrent', ref: 'not a torrent' })).status, 400)
  })

  test('an account without the permission cannot see or write sources', async () => {
    // 404 rather than 403: the administration surface does not confirm its own
    // existence to somebody who has no business in it.
    const list = await app.inject({ url: `/v1/admin/catalogue/episodes/${episodeId}/sources`, headers: as(plain) })
    assert.equal(list.statusCode, 404)
    const write = await addSource({ kind: 'http', ref: 'https://example.invalid/x.m3u8' }, plain)
    assert.equal(write.status, 404, write.body)
    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/admin/catalogue/episodes/${episodeId}/sources`,
      payload: { kind: 'http', ref: 'https://example.invalid/y.m3u8' }
    })
    assert.equal(anonymous.statusCode, 401)
  })

  test('a disabled source stays in the editor and leaves playback', async () => {
    const { id } = await addSource({
      kind: 'http', ref: 'https://example.invalid/dead.m3u8', provider: 'Dead Mirror'
    })
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/admin/catalogue/sources/${id}`, headers: as(editor), payload: { enabled: false }
    })
    assert.equal(patch.statusCode, 200, patch.body)

    const editorList = await app.inject({ url: `/v1/admin/catalogue/episodes/${episodeId}/sources`, headers: as(editor) })
    const inEditor = (editorList.json() as { data: Array<{ id: string }> }).data.some(s => s.id === id)
    assert.ok(inEditor, 'a disabled source vanished from the editor that has to fix it')

    const publicList = await app.inject({ url: `/v1/anime/episodes/${episodeId}/sources` })
    const inPlayback = (publicList.json() as { data: Array<{ id: string }> }).data.some(s => s.id === id)
    assert.equal(inPlayback, false, 'a disabled source is still offered to viewers')
  })

  test('playback gets the enabled sources in priority order', async () => {
    const fresh = (await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 7, 'Seven', 'public') RETURNING id",
      [animeId])).rows[0].id
    for (const [priority, provider] of [[2, 'third'], [0, 'first'], [1, 'second']] as Array<[number, string]>) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/catalogue/episodes/${fresh}/sources`,
        headers: as(editor),
        payload: { kind: 'http', ref: `https://example.invalid/${provider}.m3u8`, provider, priority }
      })
      assert.equal(res.statusCode, 201, res.body)
    }
    const res = await app.inject({ url: `/v1/anime/episodes/${fresh}/sources` })
    assert.deepEqual((res.json() as { data: Array<{ provider: string }> }).data.map(s => s.provider),
      ['first', 'second', 'third'])
  })

  test('an unpublished episode has no public sources', async () => {
    await app.inject({
      method: 'POST',
      url: `/v1/admin/catalogue/episodes/${hiddenEpisodeId}/sources`,
      headers: as(editor),
      payload: { kind: 'http', ref: 'https://example.invalid/hidden.m3u8' }
    })
    const res = await app.inject({ url: `/v1/anime/episodes/${hiddenEpisodeId}/sources` })
    assert.equal(res.statusCode, 404)
  })

  test('an episode under a hidden anime has no public sources either', async () => {
    // Publishing an episode under an unpublished entry must not make it
    // reachable — the check is on the pair, not on the episode alone.
    const hiddenAnime = (await pool.query(
      `INSERT INTO anime (canonical_title, format, status, visibility)
       VALUES ($1, 'TV'::anime_format, 'FINISHED', 'hidden') RETURNING id`, [`${tag} unlisted`])).rows[0].id
    const ep = (await pool.query(
      "INSERT INTO episodes (anime_id, number, title, visibility) VALUES ($1, 1, 'One', 'public') RETURNING id",
      [hiddenAnime])).rows[0].id
    await pool.query(
      "INSERT INTO video_sources (episode_id, kind, ref, provider) VALUES ($1, 'http', 'https://example.invalid/a.m3u8', 'x')",
      [ep])

    const res = await app.inject({ url: `/v1/anime/episodes/${ep}/sources` })
    assert.equal(res.statusCode, 404)
  })

  test('the episode list says which episodes can be played', async () => {
    // What the client gates on. Without it the only way to know an episode is
    // a dead end is to open it.
    const res = await app.inject({ url: `/v1/anime/${animeId}/episodes` })
    assert.equal(res.statusCode, 200, res.body)
    // `number` comes back as a numeric string ("1.0"): episodes can be
    // fractional — 6.5 is a real episode number — so the column is numeric and
    // pg does not narrow that to a float.
    const rows = (res.json() as { data: Array<{ number: string, source_count: number }> }).data
    const first = rows.find(e => Number(e.number) === 1)
    const seven = rows.find(e => Number(e.number) === 7)
    assert.ok(first && first.source_count > 0, 'an episode with sources reports none')
    assert.ok(seven && seven.source_count === 3, `episode seven reports ${seven?.source_count}`)
  })

  test('deleting a source removes it and records who did', async () => {
    const { id } = await addSource({ kind: 'http', ref: 'https://example.invalid/gone.m3u8', provider: 'Gone' })
    const res = await app.inject({ method: 'DELETE', url: `/v1/admin/catalogue/sources/${id}`, headers: as(editor) })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((await pool.query('SELECT 1 FROM video_sources WHERE id = $1', [id])).rowCount, 0)

    const trail = await pool.query(
      "SELECT 1 FROM audit_logs WHERE action = 'episode.source.remove' AND subject_id = $1", [episodeId])
    assert.ok(trail.rowCount, 'removing a source left no audit trail')

    // Gone means gone: a second delete is not a second act.
    const again = await app.inject({ method: 'DELETE', url: `/v1/admin/catalogue/sources/${id}`, headers: as(editor) })
    assert.equal(again.statusCode, 404)
  })
})
