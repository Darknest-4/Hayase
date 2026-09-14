// LibreTranslate, on the same Docker network.
//
// Chosen because it is the only option that is genuinely free *and* genuinely
// unlimited: it runs on this box, so the only budget is CPU time. DeepL's free
// tier is 500 000 characters a month against the 7.6M this catalogue needs,
// MyMemory is smaller still, and Google's unofficial endpoint blocks an IP
// long before twenty thousand requests.
//
// Measured on this VPS (4 cores): ~335 characters a second with a batch of 50.
// The whole catalogue is therefore about six and a quarter hours at full pace.
// That number is why the worker exists rather than a loop in a route handler.
//
// One thing it does badly, and no setting fixes: proper nouns. "Monkey D.
// Luffy" comes back as "Majom D. Luffy". That is why only synopses are
// translated and titles are left alone — a mangled title is worse than an
// English one, while a slightly stiff synopsis is still an improvement on a
// synopsis nobody can read.

const ENDPOINT = process.env.LIBRETRANSLATE_URL ?? 'http://libretranslate:5000'

export class TranslatorUnavailable extends Error {
  constructor (detail: string) { super(`LibreTranslate is not reachable: ${detail}`) }
}

/** The language pairs the container actually loaded, for a readiness check. */
export async function languages (signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${ENDPOINT}/languages`, signal ? { signal } : {})
    if (!res.ok) throw new TranslatorUnavailable(`HTTP ${res.status}`)
    const body = await res.json() as Array<{ code: string }>
    return body.map(l => l.code)
  } catch (e) {
    if (e instanceof TranslatorUnavailable) throw e
    throw new TranslatorUnavailable(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Translate a batch, preserving order.
 *
 * LibreTranslate accepts an array and answers with one, which is the whole
 * reason batches are worth it: fifty texts in one request cost a fraction of
 * fifty requests. It also caches identical strings, so a batch of repeats
 * returns almost instantly — which makes it very easy to measure throughput
 * wrongly. The worker sends distinct rows, so that does not flatter it here.
 *
 * Returns `null` in a slot the service could not translate rather than
 * throwing the batch away: one bad synopsis should cost one row, not fifty.
 */
export async function translateBatch (
  texts: string[],
  opts: { source?: string, target: string, signal?: AbortSignal }
): Promise<Array<string | null>> {
  if (!texts.length) return []

  let res: Response
  try {
    res = await fetch(`${ENDPOINT}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, source: opts.source ?? 'en', target: opts.target, format: 'text' }),
      ...(opts.signal ? { signal: opts.signal } : {})
    })
  } catch (e) {
    throw new TranslatorUnavailable(e instanceof Error ? e.message : String(e))
  }

  if (!res.ok) {
    // 400 usually means one input was rejected; the caller decides whether to
    // split the batch or drop it. Anything else is the service itself.
    const detail = await res.text().catch(() => '')
    if (res.status >= 500) throw new TranslatorUnavailable(`HTTP ${res.status} ${detail.slice(0, 200)}`)
    return texts.map(() => null)
  }

  const body = await res.json() as { translatedText?: string | string[] }
  const out = body.translatedText
  if (Array.isArray(out)) {
    // Length has to match or the rows would be written against the wrong
    // anime, which is a worse outcome than translating nothing.
    return out.length === texts.length ? out.map(t => (typeof t === 'string' && t.trim() ? t : null)) : texts.map(() => null)
  }
  if (typeof out === 'string' && texts.length === 1) return [out.trim() ? out : null]
  return texts.map(() => null)
}
