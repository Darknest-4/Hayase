// A mentés a panelről: mit enged meg, és főleg mit nem.
//
// Ez a felület az egyetlen a platformon, aminek van egy gombja, ami minden
// mást felülír. A visszaállítás nem „veszélyes művelet" abban az értelemben,
// ahogy egy törlés az: egy törlést vissza lehet állítani mentésből, a rossz
// visszaállítást nem lehet semmiből.
//
// Ezért a fájl súlypontja nem az, hogy a kérés létrejön-e, hanem hogy a négy
// akadály mindegyike a helyén van-e:
//
//   * jogosultság (`backup.manage`), és a felület rejtett: 404, nem 403;
//   * a fájlnevet be kell gépelni, betűre;
//   * a példánynak csak olvasható módban kell lennie;
//   * egyszerre egy kérés futhat.
//
// Amit ez a suite szándékosan NEM csinál: nem sorol be visszaállítást és nem
// sorol be ellenőrzést. A tesztek ugyanazon az adatbázison futnak, amin a
// mentőkonténer ciklusa figyel — egy beírt `restore` sort húsz másodpercen
// belül végre is HAJTANA. Ezért a sikeres úton egy „fut már valami" őrszem
// sorral megyünk végig: a 409 bizonyítja, hogy a kérés túljutott a
// megerősítésen, a csak olvasható módon és a fájl létezésén, anélkül hogy
// bármi elindulna.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, mock, test } from 'node:test'

import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

const HAS_DB = Boolean(process.env.DATABASE_URL)
process.env.JWT_SECRET ??= 'backups-secret-long-enough-0123456789'

/** Egy név, ami átmegy a séma mintáján, de sosem lesz igazi mentés neve. */
const FAKE = 'yume-19700101T000000Z.dump'

describe('the backup panel', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: FastifyInstance
  let pool: pg.Pool
  let siteSettings: { readOnly: () => Promise<boolean> }
  const usernames: string[] = []
  let admin = ''
  let plain = ''
  let sentinel = ''

  async function account (role?: string): Promise<string> {
    const username = 'bk_' + randomBytes(5).toString('hex')
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
      const auth = await import('../src/middleware/auth.ts')
      auth.invalidatePermissions()
    }
    return (res.json() as { accessToken: string }).accessToken
  }

  const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })
  const json = (t: string): Record<string, string> => ({ ...as(t), 'content-type': 'application/json' })

  before(async () => {
    const [{ buildApp }, db, ss] = await Promise.all([
      import('../src/app.ts'),
      import('../src/infrastructure/database/index.ts'),
      import('../src/modules/settings/site-settings.ts')
    ])
    app = await buildApp()
    pool = db.pool
    siteSettings = ss.settings as never
    await app.ready()
    admin = await account('admin')
    plain = await account()
    // Egy leltársor, ami mögött nincs fájl. A létezés-ellenőrzés a táblát
    // kérdezi, nem a lemezt — az API nem is látja a kötetet.
    await pool.query(
      "INSERT INTO backups (filename, bytes, taken_at, verified) VALUES ($1, 1024, now(), false) ON CONFLICT DO NOTHING",
      [FAKE])
  })

  after(async () => {
    try {
      mock.restoreAll()
      if (sentinel) await pool.query('DELETE FROM backup_requests WHERE id = $1', [sentinel])
      await pool.query('DELETE FROM backups WHERE filename = $1', [FAKE])
      if (usernames.length) await pool.query('DELETE FROM users WHERE username = ANY($1)', [usernames])
    } finally {
      await app?.close()
      await pool?.end()
    }
  })

  test('the whole surface is hidden without the permission', async () => {
    for (const [method, url, payload] of [
      ['GET', '/v1/admin/backups', undefined],
      ['PATCH', '/v1/admin/backups/schedule', { enabled: true, reason: 'probe' }],
      ['POST', '/v1/admin/backups', { reason: 'probe' }],
      ['POST', '/v1/admin/backups/verify', { filename: FAKE, reason: 'probe' }],
      ['POST', '/v1/admin/backups/restore', { filename: FAKE, confirm: FAKE, reason: 'probe' }]
    ] as const) {
      const res = await app.inject({ method, url, headers: json(plain), payload })
      // 404, nem 403: aki nem jogosult, annak ez a végpont nem létezik.
      assert.equal(res.statusCode, 404, `${method} ${url} → ${res.statusCode}`)
    }
  })

  test('the panel says what is on disk, what is scheduled, and whether it leaves the machine', async () => {
    const res = await app.inject({ url: '/v1/admin/backups', headers: as(admin) })
    assert.equal(res.statusCode, 200, res.body)
    const body = res.json() as {
      backups: Array<{ filename: string, bytes: string, verified: boolean }>
      requests: unknown[]
      schedule: { enabled: boolean, hourUtc: number, keepDays: number }
      offsite: boolean
      readOnly: boolean
    }
    assert.ok(body.backups.some(b => b.filename === FAKE), 'the inventory row is listed')
    assert.equal(typeof body.schedule.enabled, 'boolean')
    assert.ok(Number.isFinite(body.schedule.hourUtc) && Number.isFinite(body.schedule.keepDays))
    assert.equal(typeof body.offsite, 'boolean')
    assert.equal(typeof body.readOnly, 'boolean')
    // A méret szövegként jön: a bytes bigint, és a JSON száma nem az.
    assert.equal(typeof body.backups[0]?.bytes, 'string')
  })

  test('every request needs a reason', async () => {
    for (const [url, payload] of [
      ['/v1/admin/backups', {}],
      ['/v1/admin/backups/verify', { filename: FAKE }],
      ['/v1/admin/backups/restore', { filename: FAKE, confirm: FAKE }]
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: json(admin), payload })
      assert.equal(res.statusCode, 400, `${url} accepted a request with no reason`)
    }
  })

  test('a filename that is not a backup name is refused by the schema', async () => {
    // Ez a név egy shell-szkriptbe kerül. A minta nem kényelmi ellenőrzés.
    for (const filename of ['../../etc/passwd', 'yume-1.dump; rm -rf /', 'anything.dump']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/backups/verify',
        headers: json(admin),
        payload: { filename, reason: 'probe' }
      })
      assert.equal(res.statusCode, 400, `${filename} passed the schema`)
    }
  })

  test('a backup we have never heard of cannot be verified or restored', async () => {
    const unknown = 'yume-20200101T000000Z.dump'
    for (const url of ['/v1/admin/backups/verify', '/v1/admin/backups/restore']) {
      mock.method(siteSettings, 'readOnly', async () => true)
      const res = await app.inject({
        method: 'POST', url, headers: json(admin),
        payload: { filename: unknown, confirm: unknown, reason: 'probe' }
      })
      mock.restoreAll()
      assert.equal(res.statusCode, 404, `${url} → ${res.statusCode}`)
    }
  })

  test('a restore with the wrong confirmation is refused before anything else is checked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/backups/restore',
      headers: json(admin),
      payload: { filename: FAKE, confirm: 'yes', reason: 'probe' }
    })
    assert.equal(res.statusCode, 400, res.body)
  })

  test('a restore is refused while the site is still taking writes', async () => {
    // Nem óvatoskodás: a visszaállítás alatt érkező írás vagy elvész, vagy egy
    // félig visszaállított adatbázisba megy, és utólag a kettő nem
    // megkülönböztethető.
    mock.method(siteSettings, 'readOnly', async () => false)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/backups/restore',
      headers: json(admin),
      payload: { filename: FAKE, confirm: FAKE, reason: 'probe' }
    })
    mock.restoreAll()
    assert.equal(res.statusCode, 409, res.body)
    assert.match((res.json() as { detail: string }).detail, /csak olvasható/)
  })

  test('one at a time — and the queue is what stops the second', async t => {
    // Az őrszem: „fut" állapotú, tehát a mentőkonténer ciklusa nem veszi fel
    // (az csak a `pending` sorokat keresi), de a részleges egyedi index miatt
    // mellé másik aktív kérés nem írható.
    const { rows } = await pool.query(
      `INSERT INTO backup_requests (kind, filename, status, reason, started_at)
       VALUES ('backup', NULL, 'running', 'teszt őrszem', now()) RETURNING id::text`)
    sentinel = String(rows[0].id)
    // Elhasaló állítás után is el kell tűnnie: egy beragadt aktív sor minden
    // további kérést 409-cel dobna vissza, és a következő teszt hibája már
    // ennek a következménye lenne, nem önálló lelet.
    t.after(async () => {
      await pool.query('DELETE FROM backup_requests WHERE id = $1', [sentinel])
      sentinel = ''
    })

    const listed = await app.inject({ url: '/v1/admin/backups', headers: as(admin) })
    assert.equal((listed.json() as { busy: { id: string } | null }).busy?.id, sentinel, 'the panel shows what is running')

    const now = await app.inject({ method: 'POST', url: '/v1/admin/backups', headers: json(admin), payload: { reason: 'probe' } })
    assert.equal(now.statusCode, 409, now.body)

    const verify = await app.inject({
      method: 'POST', url: '/v1/admin/backups/verify', headers: json(admin), payload: { filename: FAKE, reason: 'probe' }
    })
    assert.equal(verify.statusCode, 409, verify.body)

    // És a visszaállítás is — ami itt a lényeg: ez a kérés jó fájlnévvel, jó
    // megerősítéssel és csak olvasható módban érkezik, tehát mind a három
    // korábbi akadályon túljutott. Az utolsó fogja meg.
    mock.method(siteSettings, 'readOnly', async () => true)
    const restore = await app.inject({
      method: 'POST', url: '/v1/admin/backups/restore', headers: json(admin),
      payload: { filename: FAKE, confirm: FAKE, reason: 'probe' }
    })
    mock.restoreAll()
    assert.equal(restore.statusCode, 409, restore.body)
  })

  test('the panel stays reachable while the site is frozen', async () => {
    // A két szabály egyszer szembement egymással: a visszaállítás csak
    // olvasható módot követel, a csak olvasható mód pedig minden írást
    // visszautasított — így a gomb, aminek pont ilyenkor kell működnie, soha
    // nem volt megnyomható. A mentés felülete kivétel a fagyasztás alól.
    mock.method(siteSettings, 'readOnly', async () => true)
    const res = await app.inject({
      method: 'PATCH', url: '/v1/admin/backups/schedule', headers: json(admin),
      payload: { enabled: true, reason: 'fagyasztás alatt is' }
    })
    mock.restoreAll()
    assert.notEqual(res.statusCode, 503, 'the read-only gate swallowed a backup control')
    assert.equal(res.statusCode, 200, res.body)
  })

  test('a queued backup is a row the container can see, and it is audited', async () => {
    // Ez az egyetlen eset, ahol tényleg keletkezik kérés. Szándékosan
    // `backup`: ha a ciklus a törlésünk előtt felkapja, a legrosszabb, ami
    // történhet, egy fölösleges mentés.
    const res = await app.inject({ method: 'POST', url: '/v1/admin/backups', headers: json(admin), payload: { reason: 'suite probe' } })
    assert.equal(res.statusCode, 200, res.body)
    const { id } = res.json() as { id: string }

    const { rows } = await pool.query(
      'SELECT kind, status, reason, filename FROM backup_requests WHERE id = $1', [id])
    assert.deepEqual(rows[0], { kind: 'backup', status: 'pending', reason: 'suite probe', filename: null })
    await pool.query('DELETE FROM backup_requests WHERE id = $1', [id])

    const audit = await pool.query(
      `SELECT after FROM audit_logs
        WHERE action = 'backup.request' AND subject_id = 'backup:backup'
        ORDER BY created_at DESC LIMIT 1`)
    assert.equal(audit.rows[0]?.after?.reason, 'suite probe')
  })

  test('the schedule can be switched off and back on, with a reason on the record', async () => {
    const before = (await app.inject({ url: '/v1/admin/backups', headers: as(admin) })
      .then(r => r.json() as { schedule: { enabled: boolean } })).schedule.enabled

    const off = await app.inject({
      method: 'PATCH', url: '/v1/admin/backups/schedule', headers: json(admin),
      payload: { enabled: false, reason: 'teszt' }
    })
    assert.equal(off.statusCode, 200, off.body)
    const seen = await app.inject({ url: '/v1/admin/backups', headers: as(admin) })
    assert.equal((seen.json() as { schedule: { enabled: boolean } }).schedule.enabled, false)

    const { rows } = await pool.query(
      `SELECT after FROM audit_logs
        WHERE subject_type = 'config' AND subject_id = 'backup_schedule_enabled'
        ORDER BY created_at DESC LIMIT 1`)
    assert.equal(rows[0]?.after?.reason, 'teszt')

    // Vissza, ahogy találtuk. Egy kikapcsolva felejtett éjszakai mentés
    // csöndben rossz: semmi nem hibázik, csak nem készül mentés.
    const back = await app.inject({
      method: 'PATCH', url: '/v1/admin/backups/schedule', headers: json(admin),
      payload: { enabled: before, reason: 'teszt vége' }
    })
    assert.equal(back.statusCode, 200, back.body)
  })

  test('a schedule change with no reason changes nothing', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/admin/backups/schedule', headers: json(admin), payload: { enabled: false }
    })
    assert.equal(res.statusCode, 400, res.body)
  })
})
