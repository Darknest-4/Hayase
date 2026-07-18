import { filter, pipe, tap } from 'wonka'

import type { Exchange } from 'urql'

export const cacheOnErrorExchange = (): Exchange => {
  const keysWithData = new Set<number>()

  return ({ forward }) => ops$ =>
    pipe(
      ops$,
      forward,
      tap(result => {
        if (result.data && !result.error && result.operation.kind === 'query') {
          keysWithData.add(result.operation.key)
        }
      }),
      filter(result => {
        if (result.error && result.operation.kind === 'query' && keysWithData.has(result.operation.key)) {
          return false
        }
        return true
      })
    )
}
