// The store's denormalised rating columns (`extensions.rating_avg` /
// `rating_count`) and the one function allowed to write them.

/** The little of a pg client these helpers need; both a pool and a transaction client fit. */
interface Queryable { query: (sql: string, params: unknown[]) => Promise<unknown> }

/**
 * Recompute the denormalised rating on the listing.
 *
 * Derived from the reviews rather than adjusted incrementally: an incremental
 * update has to be right about every path that changes a review — insert,
 * replace, delete, moderator hide, account deletion — and being wrong once
 * leaves an average nothing will ever correct.
 *
 * Hidden reviews and deleted accounts are excluded, so hiding a brigade of
 * one-star reviews actually moves the number.
 */
export async function recomputeRating (client: Queryable, extensionId: string): Promise<void> {
  await client.query(
    `UPDATE extensions e
        SET rating_avg = agg.avg, rating_count = agg.count
       FROM (
         SELECT round(avg(r.rating)::numeric, 2) AS avg, count(*)::int AS count
           FROM extension_reviews r
           JOIN users u ON u.id = r.user_id
          WHERE r.extension_id = $1 AND r.hidden_at IS NULL AND u.deleted_at IS NULL
       ) agg
      WHERE e.id = $1`,
    [extensionId]
  )
}

/**
 * The same recompute, addressed by review instead of by extension.
 *
 * Moderation hides a review by id and has no reason to know which extension it
 * belongs to; without this the average would keep counting a review nobody can
 * read any more.
 */
export async function recomputeRatingForReview (client: Queryable, reviewId: string): Promise<void> {
  await client.query(
    `UPDATE extensions e
        SET rating_avg = agg.avg, rating_count = agg.count
       FROM extension_reviews target
       CROSS JOIN LATERAL (
         SELECT round(avg(r.rating)::numeric, 2) AS avg, count(*)::int AS count
           FROM extension_reviews r
           JOIN users u ON u.id = r.user_id
          WHERE r.extension_id = target.extension_id AND r.hidden_at IS NULL AND u.deleted_at IS NULL
       ) agg
      WHERE target.id = $1 AND e.id = target.extension_id`,
    [reviewId]
  )
}
