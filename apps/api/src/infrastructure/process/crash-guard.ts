// What a stray promise rejection does to a long-running process.
//
// Node 22 ends the process on an unhandled rejection. For the API that turned
// a single request whose fire-and-forget follow-up failed — a malformed
// X-Profile-Id header reaching Postgres from the search statistics — into a
// restart of the whole service, for every user, on demand.
//
// The individual call sites are fixed; this is the net under them. A rejection
// nobody waited for is a bug, and it is logged and recorded as one, but it is
// not a reason to drop every other request in flight.
//
// Uncaught *exceptions* are left alone on purpose: those can leave the process
// in a state nobody reasoned about, and restarting is the safe answer there.

import { recordError, type ErrorSource } from '../../errors/reporting.ts'

let installed = false

export function guardUnhandledRejections (
  source: ErrorSource,
  log: (message: string, error: Error) => void = (message, error) => { console.error(message, error) }
): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    log('unhandled promise rejection — logged, the process keeps running', error)
    void recordError(source, error, { route: 'unhandledRejection' }).catch(() => {})
  })
}
