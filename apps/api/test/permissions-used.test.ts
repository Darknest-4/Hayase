// Minden jogosultságot ellenőriz valahol a kód — nincs „tervezett" jogosultság.
//
// 2026-09-ig a katalógus 369 jogosultságából 319-et semmi nem ellenőrzött. A
// szerepkör-szerkesztőben mégis ott álltak, nem létező funkciók nevével
// („piactér", „AI-adatkészlet"…) — mintha lennének. A 0083-as migráció kivette
// őket; ez a teszt azt őrzi, hogy ne gyűljenek újra: egy új jogosultság akkor
// kerüljön a katalógusba, amikor a hozzá tartozó ellenőrzés is megvan.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HAS_DB = Boolean(process.env.DATABASE_URL)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CODE = ['apps/api/src', 'apps/web/src', 'apps/discord/src']

function * files (dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'vendor' && name !== 'node_modules') yield * files(path)
    } else if (/\.(ts|js|mjs)$/.test(name)) {
      yield path
    }
  }
}

describe('the permission catalogue', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let end: (() => Promise<void>) | undefined
  after(async () => { await end?.() })

  it('holds only permissions the code actually checks', async () => {
    const db = await import('../src/infrastructure/database/index.ts')
    end = () => db.pool.end()
    const { rows } = await db.pool.query<{ slug: string }>('SELECT slug FROM permissions ORDER BY slug')
    assert.ok(rows.length > 0, 'the catalogue is empty — the check would pass on nothing')

    const source = CODE.flatMap(dir => [...files(join(ROOT, dir))]).map(path => readFileSync(path, 'utf8')).join('\n')
    const unchecked = rows.map(r => r.slug).filter(slug => !source.includes(`'${slug}'`) && !source.includes(`"${slug}"`))
    assert.deepEqual(unchecked, [], 'permissions that no code checks — a role editor would offer features that do not exist')
  })
})
