import type { FullMedia, MediaEdgeFrag, RecrusiveRelations } from './queries'
import type { ResultOf } from 'gql.tada'

export type Media = ResultOf<typeof FullMedia>

export type MediaEdge = ResultOf<typeof MediaEdgeFrag>

export type RelationTreeMedia = NonNullable<NonNullable<ResultOf<typeof RecrusiveRelations>['Page']>['media']>[0]
