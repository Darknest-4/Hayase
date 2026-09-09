// Fill the founder's library, by hand.
//
// The queue does this for an account registering on a fresh instance. This is
// for the instance that already exists: the account was created before the
// feature was, so nothing ever enqueued the job for it.
//
//   npm run seed:founder --workspace @yume/api
//   npm run seed:founder --workspace @yume/api -- --username alice
//   npm run seed:founder --workspace @yume/api -- --only-public
//   npm run seed:founder --workspace @yume/api -- --dry-run
//
// Idempotent, like the job it shares its code with: running it twice is not a
// mistake and does not double anything.

import { pool, queryOne } from '../src/infrastructure/database/index.ts'
import { founderProfile, seedFounderLibrary } from '../src/modules/library/founder.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const at = args.indexOf('--' + name)
  return at >= 0 ? (args[at + 1] ?? '') : null
}
const has = (name: string): boolean => args.includes('--' + name)

const onlyPublic = has('only-public')
const dryRun = has('dry-run')
const username = flag('username')

try {
  const target = (username
    ? await queryOne<{ userId: string, profileId: string, username: string }>(
      `SELECT u.id AS "userId", p.id AS "profileId", u.username
         FROM users u JOIN user_profiles p ON p.user_id = u.id
        WHERE u.username = $1 AND u.deleted_at IS NULL`,
      [username]
    )
    : await founderProfile()) ?? null

  if (!target) {
    console.error(username ? `no account named ${username}` : 'no administrator account found — has anybody registered?')
    process.exitCode = 1
  } else {
    // What is about to happen, before it happens. This writes hundreds of
    // thousands of rows to somebody's account; it should say whose.
    const scope = await queryOne<{ anime: string, episodes: string, achievements: string }>(
      `SELECT (SELECT count(*) FROM anime a ${onlyPublic ? "WHERE a.visibility = 'public'" : ''})           AS anime,
              (SELECT count(*) FROM episodes e JOIN anime a ON a.id = e.anime_id
                ${onlyPublic ? "WHERE a.visibility = 'public'" : ''})                                        AS episodes,
              (SELECT count(*) FROM achievements)                                                            AS achievements`
    )
    console.log(`account:      ${target.username} (profile ${target.profileId})`)
    console.log(`titles:       ${Number(scope?.anime ?? 0).toLocaleString('en-GB')}${onlyPublic ? ' (published only)' : ' (published and hidden)'}`)
    console.log(`episodes:     ${Number(scope?.episodes ?? 0).toLocaleString('en-GB')}`)
    console.log(`achievements: ${Number(scope?.achievements ?? 0).toLocaleString('en-GB')}`)

    if (dryRun) {
      console.log('\n--dry-run: nothing written')
    } else {
      const started = Date.now()
      // A third of a million rows takes long enough that silence looks like a
      // hang. One line, rewritten in place, so a log file does not fill up.
      const tty = process.stdout.isTTY
      const result = await seedFounderLibrary(target.profileId, {
        onlyPublic,
        onProgress: (what, done) => {
          const line = `  ${what}: ${done.toLocaleString('en-GB')}`
          if (tty) process.stdout.write('\r' + line.padEnd(40))
          else if (done % 50_000 === 0) console.log(line)
        }
      })
      if (tty) process.stdout.write('\r'.padEnd(42) + '\r')
      console.log(`\nwritten in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      console.log(`  library entries touched: ${result.library.toLocaleString('en-GB')}`)
      console.log(`  episodes marked watched: ${result.episodes.toLocaleString('en-GB')}`)
      console.log(`  achievements unlocked:   ${result.achievements.toLocaleString('en-GB')}`)
      console.log(`  watch time:              ${Math.round(result.minutesWatched / 60).toLocaleString('en-GB')} hours`)
      console.log(`  xp:                      ${result.xp.toLocaleString('en-GB')}`)
    }
  }
} finally {
  await pool.end()
}
