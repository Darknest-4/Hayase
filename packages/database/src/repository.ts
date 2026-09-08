// The repository base.
//
// Why this exists: before it, `src/db.ts` had 77 direct importers. Route
// handlers wrote SQL inline, which meant three things at once —
//
//   * the same query existed in several spellings in several files, and only
//     some of them had the `visibility <> 'hidden'` clause;
//   * nothing that touched data could be tested without a live database;
//   * "where is anime read from" had no answer shorter than a grep.
//
// A repository is the answer to that third question. One type owns the SQL for
// one table or aggregate, the rest of the application asks it for rows, and
// the rule an architecture check can then enforce is simply: nothing outside
// `infrastructure/` constructs SQL.
//
// It is deliberately thin. There is no query builder here, no unit of work and
// no identity map — this project uses raw `pg` on purpose, and a repository
// that hid the SQL would trade a readable query for an unreadable abstraction.
// What it provides is an address, a transaction scope, and the two or three
// helpers every concrete repository would otherwise rewrite.

import type pg from 'pg'

import type { Db } from './client.ts'

export abstract class Repository {
  protected readonly db: Db

  constructor (db: Db) {
    this.db = db
  }

  protected query<Row extends pg.QueryResultRow = pg.QueryResultRow> (
    text: string, params: unknown[] = []
  ): Promise<Row[]> {
    return this.db.query<Row>(text, params)
  }

  protected queryOne<Row extends pg.QueryResultRow = pg.QueryResultRow> (
    text: string, params: unknown[] = []
  ): Promise<Row | undefined> {
    return this.db.queryOne<Row>(text, params)
  }

  /**
   * Run several statements as one unit.
   *
   * Exposed rather than protected: a use case that has to write to two
   * repositories atomically — creating an account and granting it a role — is
   * the ordinary reason to reach for a transaction, and it lives above the
   * repositories, not inside one.
   */
  transaction<T> (fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.db.transaction(fn)
  }
}

/**
 * A single-column count, as a number.
 *
 * `count(*)` comes back from `pg` as a string, because a bigint does not fit
 * in a JS number and the driver refuses to lose that quietly. Every call site
 * was writing `Number(rows[0].n)`, and the ones that forgot compared a string
 * to a number and silently took the wrong branch.
 */
export function countOf (row: { n?: string | number } | undefined): number {
  return Number(row?.n ?? 0)
}
