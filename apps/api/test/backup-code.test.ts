// A weboldal kódjának mentése (scripts/database/backup-code.sh), és az R2-szkript
// darabszám szerinti megőrzése (scripts/database/sync-r2.sh).
//
// Amit ez rögzít:
//
//   * a mentésbe bekerül MINDEN, ami a weboldalt adja — a nem commitolt
//     változás és a gitből szándékosan kihagyott videó is —, a titkok
//     (.env, .env.*) és a node_modules viszont nem;
//   * a git-előzmény bundle-je visszaklónozható;
//   * változatlan kódnál nincs új példány, egy elbukott feltöltést viszont a
//     következő futás pótol;
//   * a darabszám szerinti megőrzés csak a saját mintájára illő fájlokat törli
//     — az adatbázis-mentésekhez nem nyúl.
//
// Adatbázis nem kell hozzá: egy ideiglenes git-repón és egy rclone-utánzaton fut.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(here, '..', '..', '..', 'scripts', 'database')

const has = (cmd: string, args: string[], expect: RegExp): boolean => {
  const run = spawnSync(cmd, args, { encoding: 'utf8' })
  return run.status === 0 && expect.test(run.stdout)
}
const REASON = !has('git', ['--version'], /git version/)
  ? 'git is not installed'
  : !has('tar', ['--version'], /GNU tar/)
      ? 'GNU tar is not installed'
      : false

function write (root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

describe('the site code backup', { skip: REASON }, () => {
  let root = ''
  let repo = ''
  let out = ''
  let remote = ''
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

  const backup = (extra: Record<string, string> = {}) => spawnSync('sh', [join(SCRIPTS, 'backup-code.sh')], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      BACKUP_CODE_DIR: repo,
      BACKUP_DIR: out,
      // A „gépen kívüli" cél itt egy könyvtár; a horog ugyanúgy kapja a fájlt $1-ként.
      BACKUP_SYNC_CMD: `cp "$1" "${remote}/"`,
      ...extra
    }
  })
  const uploaded = (suffix: string): string[] => readdirSync(remote).filter(name => name.endsWith(suffix)).sort()

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'yume-code-backup-'))
    repo = join(root, 'site')
    out = join(root, 'backups')
    remote = join(root, 'remote')
    mkdirSync(repo)
    mkdirSync(out)
    mkdirSync(remote)

    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'backup-test@example.test')
    git('config', 'user.name', 'Backup Test')
    write(repo, 'package.json', '{ "name": "site" }\n')
    write(repo, 'src/app.js', 'export const version = 1\n')
    write(repo, '.gitignore', 'node_modules\n.env\n.env.*\n!.env.example\nassets/videos/*\n')
    write(repo, '.env.example', 'JWT_SECRET=\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')

    // Ami a gitben nincs, de a weboldalhoz tartozik — és ami titok.
    write(repo, 'assets/videos/clip.mp4', 'not really a video')
    write(repo, 'notes-uncommitted.txt', 'work in progress\n')
    write(repo, '.env', 'JWT_SECRET=the-real-one\n')
    write(repo, 'apps/api/.env.local', 'JWT_SECRET=nested\n')
    write(repo, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  })

  after(() => { rmSync(root, { recursive: true, force: true }) })

  it('uploads the whole site, without secrets or node_modules', () => {
    const run = backup()
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.equal(uploaded('.bundle').length, 1, 'one history bundle')
    assert.equal(uploaded('.tar.gz').length, 1, 'one tree archive')

    const listing = execFileSync('tar', ['--list', '--gzip', '--file', join(remote, uploaded('.tar.gz')[0])], { encoding: 'utf8' })
      .split('\n').filter(Boolean)
    for (const wanted of ['./package.json', './src/app.js', './.gitignore', './.env.example',
      './notes-uncommitted.txt', './assets/videos/clip.mp4']) {
      assert.ok(listing.includes(wanted), `${wanted} is missing from the archive`)
    }
    for (const line of listing) {
      assert.ok(!/(^|\/)\.env(\.local)?$/.test(line), `a secret made it into the archive: ${line}`)
      assert.ok(!line.includes('node_modules'), `node_modules made it into the archive: ${line}`)
      assert.ok(!line.startsWith('./.git/'), `.git made it into the archive: ${line}`)
    }
  })

  it('writes a bundle that clones back with the history', () => {
    const clone = join(root, 'restored')
    execFileSync('git', ['clone', '--quiet', join(remote, uploaded('.bundle')[0]), clone])
    assert.equal(execFileSync('git', ['-C', clone, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim(), 'first')
    assert.equal(readFileSync(join(clone, 'src/app.js'), 'utf8'), 'export const version = 1\n')
  })

  it('does not upload again when nothing changed', () => {
    const run = backup()
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /nem változott/)
    assert.equal(uploaded('.bundle').length, 1)
    assert.equal(uploaded('.tar.gz').length, 1)
  })

  it('an uncommitted change is a new archive, not a new bundle', async () => {
    write(repo, 'src/app.js', 'export const version = 2\n')
    await new Promise(resolve => setTimeout(resolve, 1100)) // új időbélyeg a fájlnévben
    const run = backup()
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.equal(uploaded('.tar.gz').length, 2)
    assert.equal(uploaded('.bundle').length, 1, 'the refs did not change, so the history is not re-uploaded')
  })

  it('a failed upload is retried by the next run', async () => {
    git('commit', '-q', '-am', 'second')
    await new Promise(resolve => setTimeout(resolve, 1100))
    const failed = backup({ BACKUP_SYNC_CMD: 'exit 1' })
    assert.equal(failed.status, 3, failed.stdout + failed.stderr)
    assert.equal(uploaded('.bundle').length, 1, 'nothing new may appear when the upload failed')

    await new Promise(resolve => setTimeout(resolve, 1100))
    const retried = backup()
    assert.equal(retried.status, 0, retried.stdout + retried.stderr)
    assert.equal(uploaded('.bundle').length, 2, 'the retry uploads the new history')
  })

  it('refuses a nonsensical keep count', () => {
    const run = backup({ BACKUP_CODE_KEEP: '0', BACKUP_CODE_FORCE: '1' })
    assert.equal(run.status, 1, run.stdout + run.stderr)
  })
})

describe('the R2 script keeps the newest N when asked', () => {
  let root = ''
  let bin = ''
  let r2 = ''

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'yume-r2-keep-'))
    bin = join(root, 'bin')
    r2 = join(root, 'r2')
    mkdirSync(bin)
    mkdirSync(r2)
    // Egy rclone-utánzat: az R2:<vödör>/<út> címeket egy helyi könyvtárra képezi,
    // és csak azokat a parancsokat tudja, amiket a sync-r2.sh használ.
    writeFileSync(join(bin, 'rclone'), `#!/bin/sh
root="$FAKE_R2_ROOT"
path () { echo "$root/\${1#R2:}"; }
cmd="$1"; shift
case "$cmd" in
  copyto) mkdir -p "$(dirname "$(path "$2")")"; cp "$1" "$(path "$2")" ;;
  size) p="$(path "$1")"
        if [ -f "$p" ]; then echo "{\\"count\\":1,\\"bytes\\":$(wc -c < "$p" | tr -d ' ')}"
        else echo "{\\"count\\":$(find "$p" -type f 2>/dev/null | wc -l | tr -d ' '),\\"bytes\\":0}"; fi ;;
  lsf) p="$(path "$1")"; shift; inc='*'
       while [ $# -gt 0 ]; do case "$1" in --include) inc="$2"; shift 2 ;; *) shift ;; esac; done
       for f in "$p"/*; do [ -f "$f" ] || continue; b=$(basename "$f"); case "$b" in $inc) echo "$b" ;; esac; done ;;
  deletefile) rm -f "$(path "$1")" ;;
  delete) exit 0 ;;
  *) echo "fake rclone: $cmd" >&2; exit 9 ;;
esac
`)
    chmodSync(join(bin, 'rclone'), 0o755)
  })

  after(() => { rmSync(root, { recursive: true, force: true }) })

  const sync = (file: string, env: Record<string, string>) => spawnSync('sh', [join(SCRIPTS, 'sync-r2.sh'), file], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_R2_ROOT: r2,
      R2_BUCKET: 'bucket',
      R2_ENDPOINT: 'https://example.invalid',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      ...env
    }
  })

  it('deletes only the older files of its own pattern', () => {
    const prefix = join(r2, 'bucket', 'yume-code')
    mkdirSync(prefix, { recursive: true })
    // Ugyanabban az útvonalban egy adatbázis-mentés és egy archívum: a bundle-ök
    // megőrzése egyikhez sem nyúlhat.
    writeFileSync(join(prefix, 'yume-20260101T000000Z.dump'), 'db')
    writeFileSync(join(prefix, 'yume-code-20260101T000000Z.tar.gz'), 'tree')

    for (const stamp of ['20260901T000000Z', '20260902T000000Z', '20260903T000000Z', '20260904T000000Z']) {
      const file = join(root, `yume-code-${stamp}.bundle`)
      writeFileSync(file, `bundle ${stamp}`)
      const run = sync(file, { R2_PREFIX: 'yume-code', R2_KEEP_LAST: '2', R2_KEEP_INCLUDE: 'yume-code-*.bundle' })
      assert.equal(run.status, 0, run.stdout + run.stderr)
    }

    assert.deepEqual(readdirSync(prefix).sort(), [
      'yume-20260101T000000Z.dump',
      'yume-code-20260101T000000Z.tar.gz',
      'yume-code-20260903T000000Z.bundle',
      'yume-code-20260904T000000Z.bundle'
    ])
  })

  it('refuses a keep count without a pattern', () => {
    const file = join(root, 'yume-code-20260905T000000Z.bundle')
    writeFileSync(file, 'bundle')
    const run = sync(file, { R2_PREFIX: 'yume-code', R2_KEEP_LAST: '2' })
    assert.equal(run.status, 1, run.stdout + run.stderr)
  })
})

describe('the daily backup takes the code with it', () => {
  const script = readFileSync(join(SCRIPTS, 'backup.sh'), 'utf8')

  it('calls the code backup, and a failure there does not fail the database backup', () => {
    assert.match(script, /if ! "\$\(dirname "\$0"\)\/backup-code\.sh"; then\s+log "WARNING/)
  })
})
