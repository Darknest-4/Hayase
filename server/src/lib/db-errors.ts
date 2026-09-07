// Postgres error codes, named.
//
// Audit 13 found the same mistake in four places: registration, the like
// toggle and the watch-together room code both wrote to a
// column the database will not let them duplicate, and all four let the
// resulting 23505 escape as a 500 carrying the constraint name. Each was
// fixed individually, which is how a fifth one gets written next month.
//
// The pattern that produces it is worth naming, because both halves look
// correct in review:
//
//   check-then-insert   two callers pass the check before either inserts
//   insert-and-hope     no check at all, and the constraint is the check
//
// Neither is wrong about the data — the database keeps it consistent either
// way — they are wrong about the response. A conflict is a fact about
// concurrency, not about the request, so the caller should see the same status
// it would have got had the two requests arrived a millisecond apart.

/** Postgres SQLSTATE codes this application actually distinguishes. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502'
} as const

interface PgError { code?: string, constraint?: string }

/**
 * True when the error is a unique-constraint violation.
 *
 * `constraint` narrows it to one index by name, for a table with several: a
 * users insert can collide on either email or username, and telling the caller
 * which one collided is the difference between a usable error and "Conflict".
 */
export function isUniqueViolation (error: unknown, constraint?: string): boolean {
  const pg = error as PgError
  if (pg?.code !== PG.UNIQUE_VIOLATION) return false
  return constraint === undefined || pg.constraint === constraint
}

export function isForeignKeyViolation (error: unknown, constraint?: string): boolean {
  const pg = error as PgError
  if (pg?.code !== PG.FOREIGN_KEY_VIOLATION) return false
  return constraint === undefined || pg.constraint === constraint
}

/** The index a violation names, for callers that map several to one response. */
export function violatedConstraint (error: unknown): string | undefined {
  return (error as PgError)?.constraint
}

/**
 * Run a write, and answer a chosen value instead of throwing when it collides.
 *
 * For the common shape — insert, and if someone else got there first, report a
 * conflict rather than a crash:
 *
 *   const row = await onUniqueViolation(
 *     () => queryOne('INSERT INTO … RETURNING *', values),
 *     () => undefined
 *   )
 *   if (!row) return reply.code(409).send(conflict)
 *
 * Anything that is not a unique violation still throws, because it is a
 * different problem and hiding it here would be the same mistake in a new
 * costume.
 */
export async function onUniqueViolation<T> (
  write: () => Promise<T>,
  fallback: (constraint: string | undefined) => T | Promise<T>,
  constraint?: string
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!isUniqueViolation(error, constraint)) throw error
    return await fallback(violatedConstraint(error))
  }
}

/**
 * Retry a write that generates its own random key until it lands.
 *
 * The watch-together room code is the case: four random bytes into a UNIQUE
 * column, so a collision is a fact about the draw and never about the caller.
 * Retrying is the honest response — reporting a conflict would be blaming the
 * user for the dice.
 *
 * Only unique violations are retried, and only `attempts` times, so a genuinely
 * stuck generator fails loudly instead of spinning.
 */
export async function retryOnCollision<T> (
  write: () => Promise<T>,
  attempts = 5,
  constraint?: string
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      if (!isUniqueViolation(error, constraint) || attempt >= attempts) throw error
    }
  }
}
