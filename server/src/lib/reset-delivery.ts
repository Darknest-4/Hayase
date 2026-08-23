// Delivery of password reset tokens.
//
// This deliberately does NOT use the general webhook system, and the reason is
// worth stating because reusing it looked like the obvious move:
//
//   * webhooks are managed from the admin UI by anyone holding
//     `admin.webhooks.manage`, so a moderator could point password reset
//     tokens at a Discord channel by filling in a form;
//   * the webhook layer has a Discord embed formatter, so the token would then
//     be *rendered into chat* rather than merely sent somewhere odd;
//   * fan-out means every subscriber to the event receives every token.
//
// A password reset token is a full account credential. It goes to exactly one
// endpoint, chosen by whoever deploys the service, and nothing in the product
// can redirect it.
//
// This platform has no mail sender. Adding one would mean a dependency, SMTP
// credentials to hold, and a deployment surface, for a single feature — so the
// token is handed to an endpoint the operator runs, and they send the mail
// with whatever they already use. Until PASSWORD_RESET_WEBHOOK_URL is set the
// flow is complete and inert: tokens are minted and recorded, nothing is
// delivered, and the log says so on every attempt rather than once at startup.

import { checkOutboundUrl } from './ssrf.ts'

const TARGET = process.env.PASSWORD_RESET_WEBHOOK_URL
const SECRET = process.env.PASSWORD_RESET_WEBHOOK_SECRET
const TIMEOUT_MS = Number(process.env.PASSWORD_RESET_TIMEOUT_MS ?? 5_000)

export interface ResetDelivery {
  email: string
  username: string
  token: string
  expiresAt: string
}

/** Whether an operator has configured somewhere for reset mail to come from. */
export function configured (): boolean {
  return Boolean(TARGET)
}

/**
 * Hand a reset token to the operator's mailer.
 *
 * Failure is never reported to the caller: /forgot answers 204 whether or not
 * the account exists, and a delivery error must not become the one case that
 * answers differently — that would rebuild the account enumeration oracle the
 * blanket 204 exists to prevent. Failures go to the log, which is where an
 * operator debugging "no reset mail arrived" will look.
 */
export async function deliverReset (
  delivery: ResetDelivery,
  log: (message: string, error?: unknown) => void
): Promise<void> {
  if (!TARGET) {
    log('password reset requested but PASSWORD_RESET_WEBHOOK_URL is not set — no mail can be sent')
    return
  }

  // The operator's endpoint may legitimately be an internal service on the
  // same network, which the SSRF guard refuses by default. WEBHOOK_ALLOWED_HOSTS
  // is how they say so — the same switch the admin-managed webhooks use.
  const verdict = await checkOutboundUrl(TARGET)
  if (!verdict.ok) {
    log(`PASSWORD_RESET_WEBHOOK_URL cannot be used: it ${verdict.reason}. Add its host to WEBHOOK_ALLOWED_HOSTS if that is deliberate.`)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    const response = await fetch(TARGET, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SECRET ? { 'X-Yume-Signature': SECRET } : {})
      },
      body: JSON.stringify({ type: 'password_reset', ...delivery }),
      signal: controller.signal
    })
    if (!response.ok) log(`password reset delivery returned HTTP ${response.status}`)
  } catch (error) {
    log('password reset delivery failed', error)
  } finally {
    clearTimeout(timer)
  }
}
