// The database package's public surface.
//
// Kept explicit rather than a `export *` barrel: a barrel here would let a
// module import the pool by accident when it meant to import an error helper,
// and the whole point of this package is to make reaching for the database a
// visible act.

export { createPool, helpers, type Db, type PoolOptions } from './client.ts'
export { Repository, countOf } from './repository.ts'
export {
  PG,
  isUniqueViolation,
  isForeignKeyViolation,
  violatedConstraint,
  onUniqueViolation,
  retryOnCollision
} from './errors.ts'
