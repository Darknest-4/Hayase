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
 * Egy bájtsorozat kódolása az aláíráshoz.
 *
 * NEM ugyanaz, mint az `encodeURIComponent`. Az AWS a fenntartatlan
 * karakterek körét szűkebben húzza meg (`A-Za-z0-9-_.~`), a JavaScript
 * viszont a `!'()*` hatot érintetlenül hagyja — egy ilyen karakter a kulcsban
 * vagy a lekérdezésben tehát eltérő kanonikus kérést ad, mint amit a
 * szolgáltató számol, és a válasz mindössze annyi, hogy
 * `SignatureDoesNotMatch`.
 */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * Az útvonal kódolása az aláíráshoz.
 *
 * Az S3 a kanonikus kérésben a `/`-t NEM kódolja, minden mást igen — és ez a
 * részlet az, amin egy kézzel írt aláírás elhasal: egy szóközt vagy egy
 * ékezetet tartalmazó kulcs érvénytelen aláírást kap, és a hibaüzenet csak
 * annyi, hogy `SignatureDoesNotMatch`.
 */
const encodePath = (key: string): string =>
  key.split('/').map(encodeRfc3986).join('/')

/**
 * A kanonikus lekérdezés.
 *
 * Kulcs szerint rendezve, minden darab külön kódolva, az üres érték is
 * kiírva (`?uploads` → `uploads=`). A többrészes feltöltés MINDEN hívása
 * lekérdezésben hordozza az azonosítóját, tehát enélkül a fájl második fele
 * nem is íródik alá.
 */
const canonicalQuery = (params: Record<string, string>): string =>
  Object.keys(params).sort()
    .map(k => `${encodeRfc3986(k)}=${encodeRfc3986(params[k]!)}`)
    .join('&')

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
  extraHeaders: Record<string, string> = {},
  params: Record<string, string> = {}
): { url: string, headers: Record<string, string> } {
  // ÜRES KULCS = MAGA A VÖDÖR. A vödörszintű műveletek (`?cors`) útvonala
  // `/vodor`, záró perjel NÉLKÜL — a `/vodor/` egy üres nevű objektum lenne,
  // és az aláírás azt írná alá.
  const path = key === '' ? `/${config.bucket}` : `/${config.bucket}/${encodePath(key)}`
  const search = canonicalQuery(params)
  const url = new URL(`${config.endpoint.replace(/\/$/, '')}${path}${search ? `?${search}` : ''}`)

  /*
   * AMIT ALÁÍRUNK, AZ MENJEN KI.
   *
   * A `URL` normalizálja az útvonalat: egy `a/../b` kulcsból `/vodor/b` lesz a
   * kérés sorában, miközben az aláírás a normalizálatlan alakra készült. A
   * szolgáltató válasza erre mindössze annyi, hogy `SignatureDoesNotMatch` —
   * amiből senki nem találja ki, hogy a KULCCSAL van baj.
   *
   * Itt derüljön ki, és mondja meg, mi a baj.
   */
  if (url.pathname !== path) {
    throw new Error(
      `a kulcs nem használható így: „${key}" — az útvonala ${path} helyett ` +
      `${url.pathname} lenne. Kerüld a ".." szakaszt és a dupla perjelet a kulcsban.`)
  }

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

  // Az ÚTVONALAT a magunk kódolásából vesszük, nem a `URL.pathname`-ből: a
  // `URL` a százalékos jelöléseket a saját szabályai szerint normalizálja, és
  // az eltérhet attól, amit aláírtunk.
  const canonicalRequest = [
    method, path, search, canonicalHeaders, signedHeaders, payloadHash
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
 * Egy objektum törlése.
 *
 * NINCS A KÉRÉSI ÚTON, és ez szándékos: se a kiszolgáló útvonal, se az
 * adminfelület nem hívja. Üzemeltetői művelet — egy elgépelt kulcsra
 * feltöltött fájl, egy lecserélt karbantartási videó —, amit szkriptből
 * indítunk. Egy törlés, ami HTTP-kérésből elérhető, előbb-utóbb el is fog
 * sülni valakinek a kezében.
 *
 * A hiányzó objektum NEM hiba: a kívánt állapot az, hogy ne legyen ott.
 */
export async function deleteObject (config: S3Config, key: string): Promise<void> {
  const { url, headers } = sign(config, 'DELETE', key, undefined)
  const res = await fetch(url, { method: 'DELETE', headers })
  if (!res.ok && res.status !== 404) throw new Error(`a törlés elhasalt (${res.status})`)
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

// ---------------------------------------------------------------------------
// TÖBBRÉSZES FELTÖLTÉS
// ---------------------------------------------------------------------------
//
// A `putObject` egyetlen kérésben küldi a törzset, memóriából. Képekre ez
// pontosan jó: egy borító néhány száz kilobájt. VIDEÓRA NEM JÓ, két külön
// okból, és mindkettő kemény korlát, nem ízlés kérdése:
//
//   * az S3 egyetlen `PUT`-ja 5 GB-ig megy, fölötte a szolgáltató utasítja
//     vissza;
//   * a `Buffer` a Node-ban ~2 GB-nál elfogy, és jóval előbb megfekteti a
//     gépet — egy 1,4 GB-os epizód a teljes RAM-ot kérné, mielőtt egyetlen
//     bájt is elindulna.
//
// A többrészes út mindkettőt megoldja: a fájl darabokban megy, egyszerre csak
// néhány darab van a memóriában, és a szolgáltató rakja össze a végén.
//
// A DARABMÉRET NEM SZABADON VÁLASZTHATÓ:
//
//   * legalább 5 MiB (az utolsó darab kivételével) — ez az S3 szabálya;
//   * legfeljebb 10 000 darab lehet egy feltöltésben;
//   * az R2 ezen felül azt is MEGKÖVETELI, hogy az utolsó darabon kívül
//     minden darab PONTOSAN egyforma legyen. Az AWS ezt megengedi, az R2 nem
//     — ezért gyűjt a darabolónk teli darabokat, és ezért nem küldi ki azt,
//     ami épp a kezében van, amikor a forrás szünetet tart.
//
// A 64 MiB alapérték ebből jön ki: 10 000 darabbal 640 GB a plafon, ami
// minden epizódra elég, és négy párhuzamos darab is csak 256 MiB memória.

/** Egy kész darab: a sorszáma és amit a szolgáltató visszaadott róla. */
export interface UploadedPart { partNumber: number, etag: string }

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
}
const escapeXml = (value: string): string => value.replace(/[&<>"']/g, c => XML_ESCAPES[c]!)

/**
 * Egy elem tartalma a válasz XML-jéből.
 *
 * Nem XML-elemző, és nem is akar az lenni: az S3 válaszai lapos, névtér
 * nélküli dokumentumok, amikből egyetlen mezőt olvasunk. Egy elemzőnyi
 * függőség ezért nem ára, hanem felesleg — viszont a hiányzó elem HIBA, nem
 * üres sztring, mert abból csendes, fél-feltöltött objektum lenne.
 */
function xmlValue (body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body)
  return match ? match[1]!.trim() : null
}

/** Beszédes hiba a válaszból. Az S3 a hiba OKÁT is XML-ben küldi. */
async function storageError (res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  const code = xmlValue(body, 'Code')
  const message = xmlValue(body, 'Message')
  const detail = code ? `${code}${message ? `: ${message}` : ''}` : body.slice(0, 200)
  return new Error(`${what} elhasalt (${res.status})${detail ? ` — ${detail}` : ''}`)
}

/** A feltöltés megnyitása. A visszaadott azonosító köti össze a darabokat. */
export async function createMultipartUpload (
  config: S3Config, key: string, contentType: string
): Promise<string> {
  const { url, headers } = sign(
    config, 'POST', key, Buffer.alloc(0), { 'content-type': contentType }, { uploads: '' })
  const res = await fetch(url, { method: 'POST', headers })
  if (!res.ok) throw await storageError(res, 'a feltöltés megnyitása')
  const uploadId = xmlValue(await res.text(), 'UploadId')
  if (!uploadId) throw new Error('a feltöltés megnyitása nem adott azonosítót')
  return uploadId
}

/** Egy darab. A visszaadott ETag kell a lezáráshoz — enélkül nincs összerakás. */
export async function uploadPart (
  config: S3Config, key: string, uploadId: string, partNumber: number, body: Buffer
): Promise<string> {
  const { url, headers } = sign(
    config, 'PUT', key, body, {}, { partNumber: String(partNumber), uploadId })
  const res = await fetch(url, { method: 'PUT', headers, body })
  if (!res.ok) throw await storageError(res, `a(z) ${partNumber}. darab feltöltése`)
  const etag = res.headers.get('etag')
  if (!etag) throw new Error(`a(z) ${partNumber}. darab nem kapott ETag-et`)
  return etag
}

/**
 * A lezárás: ebből lesz az objektum.
 *
 * A darabok SORREND SZERINT mennek, mert a szolgáltató ebben a sorrendben
 * fűzi össze őket — egy párhuzamos feltöltés befejezési sorrendje nem
 * ugyanaz, és a különbség egy néma módon sérült videó lenne.
 *
 * Ez a hívás akkor is 200-at adhat, ha a törzsben hiba van: az S3 azért
 * válaszol korán, hogy a hosszú összefűzés alatt ne szakadjon meg a
 * kapcsolat. A választ ezért MEGNÉZZÜK.
 */
export async function completeMultipartUpload (
  config: S3Config, key: string, uploadId: string, parts: UploadedPart[]
): Promise<void> {
  if (parts.length === 0) throw new Error('nincs mit lezárni: egy darab sem készült el')
  const xml = '<CompleteMultipartUpload>' +
    [...parts].sort((a, b) => a.partNumber - b.partNumber)
      .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber>` +
        `<ETag>${escapeXml(p.etag)}</ETag></Part>`)
      .join('') +
    '</CompleteMultipartUpload>'
  const body = Buffer.from(xml, 'utf8')
  const { url, headers } = sign(
    config, 'POST', key, body, { 'content-type': 'application/xml' }, { uploadId })
  const res = await fetch(url, { method: 'POST', headers, body })
  if (!res.ok) throw await storageError(res, 'a feltöltés lezárása')
  const text = await res.text()
  if (xmlValue(text, 'Code')) {
    throw new Error(`a feltöltés lezárása elhasalt — ${xmlValue(text, 'Code')}: ` +
      `${xmlValue(text, 'Message') ?? ''}`.trim())
  }
}

/**
 * A feltöltés eldobása.
 *
 * FONTOS, hogy egy megszakadt feltöltés után lefusson: a már feltöltött
 * darabok addig helyet foglalnak — és pénzbe kerülnek —, amíg vagy le nem
 * zárják, vagy el nem dobják őket. Egy megszakított 1 GB-os videó enélkül
 * láthatatlanul ott marad a vödörben.
 */
export async function abortMultipartUpload (
  config: S3Config, key: string, uploadId: string
): Promise<void> {
  const { url, headers } = sign(config, 'DELETE', key, undefined, {}, { uploadId })
  const res = await fetch(url, { method: 'DELETE', headers })
  // 404: a szolgáltató szerint már nincs ilyen feltöltés. Ez a kívánt állapot.
  if (!res.ok && res.status !== 404) throw await storageError(res, 'a feltöltés eldobása')
}

/** A darabméret alapértéke és a szabályok, amiket be kell tartania. */
export const MIN_PART_BYTES = 5 * 1024 * 1024
export const MAX_PARTS = 10_000
const DEFAULT_PART_BYTES = 64 * 1024 * 1024

export interface UploadOptions {
  /** Darabméret bájtban. Legalább 5 MiB. */
  partBytes?: number
  /** Egyszerre hány darab legyen úton. */
  concurrency?: number
  /** Hányszor próbálja újra egy darab feltöltését, mielőtt feladja. */
  attempts?: number
  /** Előrehaladás — a hívó ebből rajzol. Nem dobhat. */
  onProgress?: (bytes: number, parts: number) => void
}

/** Egy darab újrapróbálva. A hálózat elszakad; egy 12 GB-os feltöltés ne bukjon el ettől. */
async function uploadPartWithRetry (
  config: S3Config, key: string, uploadId: string,
  partNumber: number, body: Buffer, attempts: number
): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await uploadPart(config, key, uploadId, partNumber, body)
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        // Növekvő várakozás: 1s, 2s, 4s. Egy átmeneti 500-as vagy egy
        // eldobott kapcsolat ennyi alatt általában rendbe jön.
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Egy folyam feltöltése többrészes úton.
 *
 * Ez az, amit a hívó használ: darabol, párhuzamosít, újrapróbál, és HIBA
 * ESETÉN ELDOBJA a félkész feltöltést. A méretet nem kell előre tudni — a
 * folyam végéig olvas.
 *
 * A PÁRHUZAMOSSÁG korlátos, és ez nem a szolgáltató miatt van, hanem a
 * memória miatt: `concurrency × partBytes` bájt van egyszerre a kezünkben.
 * Négy darab 64 MiB-tal 256 MiB — egy VPS-en ez már érezhető, nyolc darab
 * pedig megfektetné.
 */
export async function uploadStream (
  config: S3Config,
  key: string,
  source: AsyncIterable<Uint8Array>,
  contentType: string,
  options: UploadOptions = {}
): Promise<{ bytes: number, parts: number }> {
  const partBytes = Math.max(MIN_PART_BYTES, Math.floor(options.partBytes ?? DEFAULT_PART_BYTES))
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4))
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3))

  const uploadId = await createMultipartUpload(config, key, contentType)
  const parts: UploadedPart[] = []
  const inFlight = new Set<Promise<void>>()
  let bytes = 0
  let partNumber = 0

  /*
   * A HIBÁT FÉLRETESSZÜK, NEM ELDOBJUK.
   *
   * Egy darab elhasalhat akkor is, amikor épp senki nem várja a promise-át —
   * és egy elkapatlan promise-hiba a Node-ban leállítja a folyamatot. Ezért
   * minden darab a saját hibáját IDE írja, a dobás pedig a fő szálon,
   * ellenőrzött ponton történik. Az első hiba számít: az mondja meg, mi
   * romlott el, a többi már csak a következménye.
   */
  let failure: unknown
  const check = (): void => {
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure))
  }

  const send = async (body: Buffer): Promise<void> => {
    check()
    partNumber++
    if (partNumber > MAX_PARTS) {
      throw new Error(`a fájl ${MAX_PARTS} darabnál is több lenne ` +
        `${partBytes} bájtos darabokkal; nagyobb darabméret kell`)
    }
    const number = partNumber
    const tracked: Promise<void> = uploadPartWithRetry(
      config, key, uploadId, number, body, attempts)
      .then(etag => {
        parts.push({ partNumber: number, etag })
        bytes += body.length
        options.onProgress?.(bytes, parts.length)
      })
      .catch(error => { failure ??= error })
      .finally(() => inFlight.delete(tracked))
    inFlight.add(tracked)
    if (inFlight.size >= concurrency) await Promise.race([...inFlight])
    check()
  }

  try {
    // A GYŰJTÉS azért van, mert a folyam tetszőleges méretű darabokat ad —
    // egy fájlolvasó 64 KiB-ot, a hálózat amit épp kapott. Az R2 viszont
    // egyforma darabokat vár, tehát teli darabokat küldünk.
    let held: Buffer[] = []
    let heldBytes = 0
    for await (const chunk of source) {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      while (heldBytes + buffer.length >= partBytes) {
        const need = partBytes - heldBytes
        held.push(buffer.subarray(0, need))
        await send(Buffer.concat(held, partBytes))
        buffer = buffer.subarray(need)
        held = []
        heldBytes = 0
      }
      if (buffer.length > 0) {
        held.push(buffer)
        heldBytes += buffer.length
      }
    }
    // Az utolsó darab lehet kisebb az 5 MiB-nál — rá nem vonatkozik a szabály.
    // Ha viszont a fájl EGÉSZE fért egy darabba, akkor is ki kell mennie.
    if (heldBytes > 0 || partNumber === 0) await send(Buffer.concat(held, heldBytes))

    await Promise.all([...inFlight])
    check()
    await completeMultipartUpload(config, key, uploadId, parts)
    return { bytes, parts: parts.length }
  } catch (error) {
    // Amit már feltöltöttünk, az pénzbe kerül, amíg ott áll. A takarítás
    // hibája nem nyomhatja el az EREDETI hibát — az mondja meg, mi történt.
    await Promise.all([...inFlight])
    await abortMultipartUpload(config, key, uploadId).catch(abortError => {
      console.warn(`a félbehagyott feltöltés eldobása nem sikerült (${key}): ` +
        `${(abortError as Error).message}`)
    })
    throw error
  }
}

// ---------------------------------------------------------------------------
// A VÖDÖR CORS-SZABÁLYA
// ---------------------------------------------------------------------------
//
// MIÉRT KELL EGYÁLTALÁN. Egy `<img>` alapból bármit betölt, origótól
// függetlenül — a CORS akkor lép be, amikor a JAVASCRIPT is látni akarja a
// képpontokat. A környezeti fény pont ezt teszi: a posztert vászonra rajzolja
// és megméri a színét, ezért `crossOrigin = 'anonymous'`-szal tölti be.
//
// Ilyenkor a szabály szigorú: ha a válaszban NINCS
// `access-control-allow-origin`, a kép be sem töltődik — nem „szennyezett
// vászon" lesz belőle, hanem betöltési hiba.
//
// És ez MÉRT ÁLLAPOT volt, nem feltételezés. Miután a képek átkerültek a
// tükörre, ezt kaptuk:
//
//   curl -H 'Origin: https://…' https://media.…/media/cover/…jpg -D-
//     → HTTP/2 200, content-type: image/jpeg
//     → access-control-allow-origin: (nincs)
//
// A fény tehát azóta csendben elmaradt: a modul elkapja a hibát, figyelmeztet
// a naplóba, és feketén hagyja a hátteret. Ez a szabály adja vissza.
//
// A MÓDSZEREK SZÁNDÉKOSAN CSAK OLVASÓK. Egy `PUT` engedélyezése itt azt
// jelentené, hogy egy böngészőből futó szkript írhatna a vödörbe — a
// feltöltés a kiszolgálón történik, aláírt kéréssel, és semmi keresnivalója
// egy CORS-szabályban.

export interface CorsRule {
  origins: string[]
  methods?: string[]
  headers?: string[]
  exposeHeaders?: string[]
  maxAgeSeconds?: number
}

function corsXml (rules: CorsRule[]): string {
  const rule = (r: CorsRule): string => [
    '<CORSRule>',
    ...r.origins.map(o => `<AllowedOrigin>${escapeXml(o)}</AllowedOrigin>`),
    ...(r.methods ?? ['GET', 'HEAD']).map(m => `<AllowedMethod>${escapeXml(m)}</AllowedMethod>`),
    ...(r.headers ?? ['*']).map(h => `<AllowedHeader>${escapeXml(h)}</AllowedHeader>`),
    ...(r.exposeHeaders ?? []).map(h => `<ExposeHeader>${escapeXml(h)}</ExposeHeader>`),
    `<MaxAgeSeconds>${Math.max(0, Math.floor(r.maxAgeSeconds ?? 86_400))}</MaxAgeSeconds>`,
    '</CORSRule>'
  ].join('')
  return `<CORSConfiguration>${rules.map(rule).join('')}</CORSConfiguration>`
}

/** A vödör jelenlegi CORS-szabálya, nyers XML-ként. `null`, ha nincs beállítva. */
export async function getBucketCors (config: S3Config): Promise<string | null> {
  const { url, headers } = sign(config, 'GET', '', undefined, {}, { cors: '' })
  const res = await fetch(url, { headers })
  if (res.status === 404) return null
  const text = await res.text()
  // A szolgáltatók a „nincs szabály" esetet 404-gyel VAGY egy beszédes
  // hibakóddal jelzik; a kettő ugyanaz az állapot.
  if (!res.ok) {
    if (/NoSuchCORSConfiguration/.test(text)) return null
    throw new Error(`a CORS-szabály lekérdezése elhasalt (${res.status}): ${text.slice(0, 200)}`)
  }
  return text
}

/** A vödör CORS-szabályának beállítása. Felülírja a korábbit. */
export async function putBucketCors (config: S3Config, rules: CorsRule[]): Promise<void> {
  if (rules.length === 0) throw new Error('legalább egy szabály kell')
  if (rules.some(r => r.origins.length === 0)) throw new Error('minden szabályhoz kell legalább egy origó')
  const body = Buffer.from(corsXml(rules), 'utf8')
  const { url, headers } = sign(config, 'PUT', '', body, {
    'content-type': 'application/xml',
    // Az S3 a vödörszintű írásokhoz ezt kéri. Az R2 elfogadja; a szabvány
    // szerinti kérés több szolgáltatón működik, mint a majdnem-szabványos.
    'content-md5': createHash('md5').update(body).digest('base64')
  }, { cors: '' })
  const res = await fetch(url, { method: 'PUT', headers, body })
  if (!res.ok) throw await storageError(res, 'a CORS-szabály beállítása')
}
