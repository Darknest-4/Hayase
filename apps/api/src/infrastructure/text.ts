// Two small primitives that were written out separately in several places.
//
// Each copy was correct; the problem with copies is the next change, which
// reaches one of them. `sha256Hex` hashes tokens and tickets before they are
// stored or looked up; `escapeHtml` is the one escaper for text placed into
// server-rendered HTML (the SEO head, the status pages).

import { createHash } from 'node:crypto'

/** Hex SHA-256 — how refresh tokens, reset tokens and socket tickets are stored. */
export function sha256Hex (value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Escape text for an HTML element body or a double- or single-quoted
 * attribute. The apostrophe is included so nobody has to check which of those
 * a call site needs.
 */
export function escapeHtml (value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}
