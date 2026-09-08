// Put a freshly migrated database into the state the test suites are written
// for, and nothing more.
//
//   DATABASE_URL=… node --experimental-strip-types scripts/test-fixture.ts
//
// Only one thing is needed: an administrator has to exist.
//
// Registration promotes the first account on an instance that has no
// administrator (routes/auth.ts) — the deliberate bootstrap that stops a fresh
// deployment from being unreachable. On a virgin database that path is live,
// so whichever suite happens to register first gets an administrator instead
// of the ordinary account it asked for, and every assertion about what an
// ordinary account cannot see fails. Which suite wins is decided by the order
// the runner starts files in, so it is not even consistently wrong.
//
// The suites already assume this state — test/adversarial.test.ts says so in
// as many words: "These run against a database that already has
// administrators". This makes the assumption true instead of hoping for it.
//
// The account cannot be signed in to. `password_hash` is null, which no login
// path accepts, so this holds the role without being a usable account and
// without a password anybody would have to know. It is not an operator
// account and must never be created on a real deployment — that is what the
// bootstrap in registration is for.

import { pool } from '../src/db.ts'

const USERNAME = 'ci_fixture_admin'

async function main (): Promise<void> {
  const { rows: existing } = await pool.query(
    `SELECT count(*)::int AS n FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE r.slug = 'admin'`
  )
  if (Number(existing[0].n) > 0) {
    console.log('fixture: an administrator already exists, leaving it alone')
    await pool.end()
    return
  }

  const { rows } = await pool.query(
    `INSERT INTO users (email, username, password_hash)
     VALUES ($1, $2, NULL)
     ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
    [`${USERNAME}@invalid`, USERNAME]
  )
  await pool.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE slug = 'admin'
     ON CONFLICT DO NOTHING`,
    [rows[0].id]
  )
  console.log(`fixture: ${USERNAME} holds the admin role; the registration bootstrap is now closed`)
  await pool.end()
}

await main()
