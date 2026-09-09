// The three paths this application resolves at runtime, relative to a source
// file rather than to a working directory.
//
// They are invisible to the type checker, they are correct in a checkout and
// in the container only because the image mirrors the repository layout, and
// they break by *moving a file* rather than by editing one — so nothing in a
// diff looks wrong.
//
// That is not hypothetical. The migration runner moved one directory deeper in
// the module restructure and its `../../../../` stayed as it was. Every test
// kept passing, because every database in use had already been migrated; what
// it actually broke was the first start of a fresh install, where the
// container runs the migrations before the API. This file is the check that
// was missing.

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Resolve a specifier the way the file that contains it would at runtime. */
function resolveFrom (sourceFile: string, specifier: string): string {
  return join(dirname(join(SRC, sourceFile)), specifier)
}

describe('paths resolved from a source file', () => {
  test('the migration runner finds the migrations', () => {
    const source = readFileSync(join(SRC, 'infrastructure/migrations/migrate.ts'), 'utf8')
    const spec = /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '([^']+)'\)/.exec(source)?.[1]
    assert.ok(spec, 'migrate.ts no longer resolves its directory this way — update this test')

    const resolved = resolveFrom('infrastructure/migrations/migrate.ts', spec)
    assert.ok(existsSync(resolved), `migrations resolve to ${resolved}, which does not exist`)

    const files = readdirSync(resolved).filter(f => f.endsWith('.sql'))
    assert.ok(files.length > 20, `only ${files.length} migrations found at ${resolved}`)
    assert.ok(files.includes('0001_users_auth.sql'), 'that directory is not the migrations')
  })

  test('the default web root finds the client', () => {
    const source = readFileSync(join(SRC, 'app.ts'), 'utf8')
    const spec = /WEB_ROOT \?\? join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '([^']+)'\)/.exec(source)?.[1]
    assert.ok(spec, 'app.ts no longer resolves the web root this way — update this test')

    const resolved = resolveFrom('app.ts', spec)
    assert.ok(existsSync(join(resolved, 'index.html')),
      `the web root resolves to ${resolved}, which has no index.html`)
  })

  test('the container mirrors the layout these paths assume', () => {
    // The paths above are relative, so they are only correct in the image if
    // the image has the same shape. A COPY that flattened apps/ would leave
    // the container starting and then failing to find its own migrations.
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../infrastructure/docker/Dockerfile', import.meta.url)), 'utf8')
    for (const line of ['COPY apps/api/ apps/api/', 'COPY apps/web/ apps/web/', 'COPY database/ database/']) {
      assert.ok(dockerfile.includes(line), `the image no longer does: ${line}`)
    }
    assert.match(dockerfile, /WORKDIR \/app\/apps\/api/)
  })
})

describe('every script a container is told to run exists', () => {
  // The second one of these, so it gets a check rather than another fix.
  //
  // The restructure moved the migration runner and left two callers behind
  // pointing at where it used to be. One was the worker's healthcheck, which
  // showed up as a permanently unhealthy worker. The other was the `seed`
  // service, whose command still read `src/lib/migrate.ts` — so
  // `docker compose --profile seed run --rm seed` failed on its first word,
  // and nothing in the repository noticed, because a compose file is a string
  // to every tool here.
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8')

  /**
   * Paths a compose command names, as the container would resolve them.
   *
   * Every service built from our Dockerfile has WORKDIR /app/apps/api, and the
   * image mirrors the repository — so a relative path in a command is a path
   * under apps/api here. Only `.ts` and `.js` are considered: an npm script
   * name or a shell builtin is not this test's business.
   */
  const referenced = [...compose.matchAll(/(?:^|[\s'"])((?:src|scripts)\/[\w./-]+\.(?:ts|js))/g)]
    .map(match => match[1] as string)

  test('the compose file names some scripts at all', () => {
    // Without this the loop below would pass by finding nothing, which is the
    // failure mode a check like this actually has.
    assert.ok(referenced.length >= 3, `only ${referenced.length} script paths found in docker-compose.yml`)
  })

  for (const path of [...new Set(referenced)]) {
    test(`docker-compose.yml → apps/api/${path}`, () => {
      assert.ok(existsSync(join(ROOT, 'apps/api', path)),
        `docker-compose.yml runs ${path}, which does not exist under apps/api`)
    })
  }

  test('the npm scripts it calls exist too', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'apps/api/package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const match of compose.matchAll(/'npm', 'run', '([\w:-]+)'/g)) {
      const name = match[1] as string
      assert.ok(name in manifest.scripts, `docker-compose.yml runs \`npm run ${name}\`, which apps/api does not define`)
    }
  })
})
