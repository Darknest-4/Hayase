// S3-kompatibilis tárhely — annyi belőle, amennyi kell.
//
// MIÉRT NEM AZ AWS SDK: az `@aws-sdk/client-s3` több tucat csomag és tíz
// megabájt fölötti telepítés, azért, hogy három műveletet végezzünk —
// feltöltés, lekérdezés, létezés-ellenőrzés. A SigV4 aláírás nyolcvan sor
// `node:crypto`-val, és az egyetlen része, ami elromolhat, az itt van, nem egy
// függőség mélyén.
//
// A CÉL A CLOUDFLARE R2, de semmi sem köti ide: az aláírás a szabvány szerinti,
// a végpont és a régió beállítás. Ha egyszer másik szolgáltatóhoz megy, a
// környezeti változók változnak, nem ez a fájl.

import { createHash, createHmac } from 'node:crypto'

export interface S3Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

/**
 * A beállítás a környezetből, vagy `null`, ha nincs beállítva.
 *
 * A VÖDÖR VÁLASZTHATÓ, és ez nem kényelmi kérdés. A mentések vödre az
 * adatbázis teljes tartalmát őrzi; a médiavödröt viszont egy olyan útvonal
 * olvassa, ami a kulcsot a KÉRÉS URL-jéből veszi. A kettő elválasztása azt
 * jelenti, hogy a kiszolgáló útvonal egyetlen hibája sem érheti el a
 * mentéseket — a hitelesítő adat ugyan közös, de a kód sosem mutat rá a másik
 * vödörre.
 */
export function s3FromEnv (bucketOverride?: string): S3Config | null {
  const endpoint = process.env.R2_ENDPOINT?.trim()
  const bucket = bucketOverride?.trim() || process.env.R2_BUCKET?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.R2_REGION?.trim() ?? 'auto' }
}

/** A médiavödör beállítása. Külön a mentésekétől — lásd `s3FromEnv`. */
export function mediaStorage (): S3Config | null {
  return s3FromEnv(process.env.R2_MEDIA_BUCKET?.trim() || 'yume-media')
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string): Buffer => createHmac('sha256', key).update(value).digest()

/**
 * Az útvonal kódolása az aláíráshoz.
 *
 * Az S3 a kanonikus kérésben a `/`-t NEM kódolja, minden mást igen — és ez a
 * részlet az, amin egy kézzel írt aláírás elhasal: egy szóközt vagy egy
 * ékezetet tartalmazó kulcs érvénytelen aláírást kap, és a hibaüzenet csak
 * annyi, hogy `SignatureDoesNotMatch`.
 */
const encodePath = (key: string): string =>
  key.split('/').map(segment => encodeURIComponent(segment)).join('/')

/**
 * Egy aláírt kérés összeállítása.
 *
 * A törzs hasított értéke (`x-amz-content-sha256`) kötelező: az S3 ezzel
 * ellenőrzi, hogy a törzs útközben nem változott. Üres törzsnél is ki kell
 * számolni — az „üres sztring hash-e" nem hagyható el.
 */
function sign (
  config: S3Config,
  method: string,
  key: string,
  body: Buffer | undefined,
  extraHeaders: Record<string, string> = {}
): { url: string, headers: Record<string, string> } {
  const url = new URL(`${config.endpoint.replace(/\/$/, '')}/${config.bucket}/${encodePath(key)}`)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256(body ?? Buffer.alloc(0))

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders
  }

  const sortedKeys = Object.keys(headers).map(h => h.toLowerCase()).sort()
  const canonicalHeaders = sortedKeys
    .map(h => `${h}:${String(headers[Object.keys(headers).find(k => k.toLowerCase() === h)!]).trim()}\n`)
    .join('')
  const signedHeaders = sortedKeys.join(';')

  const canonicalRequest = [
    method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash
  ].join('\n')

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp),
    config.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex')

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope},` +
    ` SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { url: url.toString(), headers }
}

/** Feltöltés. A `contentType` azért kell, mert a böngésző ebből tudja, mi az. */
export async function putObject (
  config: S3Config, key: string, body: Buffer, contentType: string
): Promise<void> {
  const { url, headers } = sign(config, 'PUT', key, body, { 'content-type': contentType })
  const res = await fetch(url, { method: 'PUT', headers, body })
  if (!res.ok) {
    throw new Error(`a feltöltés elhasalt (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}

/** Letöltés. `null`, ha nincs ott — a hívónak ez nem hiba, hanem válasz. */
export async function getObject (
  config: S3Config, key: string
): Promise<{ body: Buffer, contentType: string } | null> {
  const { url, headers } = sign(config, 'GET', key, undefined)
  const res = await fetch(url, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`a letöltés elhasalt (${res.status})`)
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream'
  }
}

/**
 * Ott van-e, és mekkora. Nem tölti le — egy tükrözés ebből tudja, hogy kész.
 *
 * A MÉRET LEHET `null`, és ez nem hanyagság. A Cloudflare tömörítheti a
 * választ útközben (`content-encoding: gzip`), és ilyenkor NEM küld
 * `content-length`-et — mérve egy `text/plain` objektumon, ahol emiatt nullát
 * kaptunk volna méretnek. Képeknél ez nem fordul elő (a jpeg és a png már
 * tömörített, a Cloudflare nem nyúl hozzájuk), de egy „0 bájt" válasz, ami
 * valójában „nem tudom", pont az a fajta hazugság, amiből később hibás
 * újratükrözés lesz.
 *
 * A LÉTEZÉS viszont mindig biztos: az a státuszkódon múlik, nem a fejléceken.
 */
export async function headObject (
  config: S3Config, key: string
): Promise<{ size: number | null, etag: string | null } | null> {
  const { url, headers } = sign(config, 'HEAD', key, undefined)
  // `identity`: ha a szolgáltató megteszi, ne tömörítsen — így megkapjuk a
  // valódi méretet. Nem aláírt fejléc, tehát az aláírást nem érinti.
  const res = await fetch(url, { method: 'HEAD', headers: { ...headers, 'accept-encoding': 'identity' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`a lekérdezés elhasalt (${res.status})`)
  const length = res.headers.get('content-length')
  return {
    size: length === null || res.headers.has('content-encoding') ? null : Number(length),
    etag: res.headers.get('etag')
  }
}
