// A többrészes feltöltés — hamis S3-kiszolgáló ellen, ami ELLENŐRZI az aláírást.
//
// Miért így: a többrészes út minden hívása a LEKÉRDEZÉSBEN hordozza az
// azonosítóját (`?uploads`, `?partNumber=2&uploadId=…`), és a SigV4 aláírás a
// lekérdezést is aláírja. Egy elrontott kanonikus lekérdezés a való életben
// mindössze annyit üzen, hogy `SignatureDoesNotMatch` — a fájl feléig minden
// jónak látszik, aztán nem megy. Egy csendes álkiszolgáló, ami mindent
// elfogad, pont ezt a hibát nem fogná meg.
//
// A kiszolgáló ezért maga is kiszámolja az aláírást, a KÉRÉSBŐL, nem abból,
// amit a kód épített — és 403-at ad, ha nem egyezik.
//
// A `yume-media` vödröt itt semmi nem érinti: a végpont a helyi teszt-HTTP.

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, describe, test } from 'node:test'
import { Readable } from 'node:stream'

import {
  MIN_PART_BYTES, abortMultipartUpload, deleteObject, getBucketCors, headObject,
  putBucketCors, uploadStream,
  type S3Config
} from '../src/infrastructure/storage/s3.ts'

// ---------------------------------------------------------------------------
// A hamis kiszolgáló
// ---------------------------------------------------------------------------

const ACCESS_KEY = 'teszt-kulcs'
const SECRET = 'teszt-titok-elegge-hosszu-0123456789'

const sha256 = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex')
const hmac = (k: string | Buffer, v: string): Buffer => createHmac('sha256', k).update(v).digest()

/**
 * A kanonikus kódolás — szándékosan ÚJRA leírva, nem importálva.
 *
 * Ha a tesztelt kód segédfüggvényét hívnánk, az aláírás-ellenőrzés önmagát
 * igazolná: bármilyen hibás kódolás mindkét oldalon ugyanúgy lenne hibás.
 */
const enc = (v: string): string =>
  encodeURIComponent(v).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

interface Upload { key: string, parts: Map<number, Buffer>, aborted: boolean }

interface Recorder {
  uploads: Map<string, Upload>
  completed: Map<string, Buffer>
  /** Hány darab volt egyszerre úton, csúcsértéken. */
  peakConcurrent: number
  /** Ennyi darabkérést kell 500-zal elutasítani (tranziens hiba szimulálása). */
  failParts: Map<number, number>
  /** Ez a darab MINDIG elhasal. */
  fatalPart: number | null
  abortCalls: number
  /** A vödör CORS-szabálya, ahogy a kiszolgáló tárolja. */
  cors: string | null
}

function body (req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Az aláírás ellenőrzése a KÉRÉSBŐL. `null`, ha rendben; különben az ok. */
function badSignature (req: IncomingMessage, payload: Buffer): string | null {
  const auth = req.headers.authorization
  if (typeof auth !== 'string') return 'nincs authorization fejléc'

  const parsed = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(auth)
  if (!parsed) return `értelmezhetetlen authorization: ${auth.slice(0, 80)}`
  const [, credential, dateStamp, region, signedHeaders, signature] = parsed as unknown as string[]
  if (credential !== ACCESS_KEY) return 'ismeretlen hozzáférési kulcs'

  const declaredHash = req.headers['x-amz-content-sha256']
  if (declaredHash !== sha256(payload)) return 'a törzs hasított értéke nem egyezik'

  const url = new URL(`http://x${req.url ?? '/'}`)
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const names = signedHeaders!.split(';')
  const canonicalHeaders = names
    .map(n => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join('')

  const canonicalRequest = [
    req.method, url.pathname, query, canonicalHeaders, signedHeaders, declaredHash
  ].join('\n')

  const amzDate = String(req.headers['x-amz-date'])
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp!), region!), 's3'), 'aws4_request')
  const expected = createHmac('sha256', signingKey).update(toSign).digest('hex')

  return expected === signature ? null : 'az aláírás nem egyezik'
}

async function startServer (recorder: Recorder): Promise<{ server: Server, config: S3Config }> {
  let inFlight = 0
  const server = createServer((req, res) => {
    void (async () => {
      const payload = await body(req)
      const problem = badSignature(req, payload)
      if (problem) {
        res.writeHead(403, { 'content-type': 'application/xml' })
        res.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${problem}</Message></Error>`)
        return
      }

      const url = new URL(`http://x${req.url ?? '/'}`)

      /*
       * A VÖDÖRSZINTŰ ÚT: `/vodor`, záró perjel NÉLKÜL. Ez a kiszolgáló
       * megköveteli a különbséget — `/vodor/` esetén nem ide jutnánk —, mert
       * pont ezen múlik, hogy a vödörművelet aláírása jó-e.
       */
      if (url.pathname === '/teszt-vodor' && url.searchParams.has('cors')) {
        if (req.method === 'PUT') {
          recorder.cors = payload.toString('utf8')
          res.writeHead(200).end()
          return
        }
        if (req.method === 'GET') {
          if (recorder.cors === null) {
            res.writeHead(404, { 'content-type': 'application/xml' })
            res.end('<Error><Code>NoSuchCORSConfiguration</Code></Error>')
            return
          }
          res.writeHead(200, { 'content-type': 'application/xml' }).end(recorder.cors)
          return
        }
      }

      const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''))
      const uploadId = url.searchParams.get('uploadId')

      // --- megnyitás ---
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        /*
         * AZ AZONOSÍTÓ SZÁNDÉKOSAN CSÚNYA.
         *
         * Az R2 feltöltésazonosítója átlátszatlan sztring, és a kanonikus
         * kódolásnak akkor is állnia kell, ha épp olyan karakter kerül bele,
         * amit az `encodeURIComponent` békén hagy (`!'()*`), az AWS szabálya
         * viszont kódolva vár. Egy szelíd `feltoltes-1` azonosítóval a
         * kódolás hibája LÁTHATATLAN maradna — kipróbálva: az ellenőrzés
         * mind a kilenc tesztet átengedte. Ezzel az azonosítóval elhasal.
         */
        const id = `feltoltes-${recorder.uploads.size + 1}~a!b'c(d)e*f`
        recorder.uploads.set(id, { key, parts: new Map(), aborted: false })
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(`<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key>` +
          `<UploadId>${id}</UploadId></InitiateMultipartUploadResult>`)
        return
      }

      // --- eldobás ---
      if (req.method === 'DELETE' && uploadId) {
        recorder.abortCalls++
        const upload = recorder.uploads.get(uploadId)
        if (upload) upload.aborted = true
        res.writeHead(204).end()
        return
      }

      // --- darab ---
      if (req.method === 'PUT' && uploadId) {
        const number = Number(url.searchParams.get('partNumber'))
        const remaining = recorder.failParts.get(number) ?? 0
        if (recorder.fatalPart === number || remaining > 0) {
          if (remaining > 0) recorder.failParts.set(number, remaining - 1)
          res.writeHead(500, { 'content-type': 'application/xml' })
          res.end('<Error><Code>InternalError</Code><Message>szándékos</Message></Error>')
          return
        }
        inFlight++
        recorder.peakConcurrent = Math.max(recorder.peakConcurrent, inFlight)
        // Késleltetés, hogy a párhuzamosság egyáltalán MÉRHETŐ legyen: azonnali
        // válasznál soha nem lenne kettő egyszerre úton.
        await new Promise(resolve => setTimeout(resolve, 20))
        inFlight--
        recorder.uploads.get(uploadId)!.parts.set(number, payload)
        res.writeHead(200, { etag: `"${sha256(payload).slice(0, 32)}"` }).end()
        return
      }

      // --- lezárás ---
      if (req.method === 'POST' && uploadId) {
        const upload = recorder.uploads.get(uploadId)!
        const numbers = [...payload.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)]
          .map(m => Number(m[1]))
        const ordered = [...numbers].sort((a, b) => a - b)
        if (JSON.stringify(numbers) !== JSON.stringify(ordered)) {
          res.writeHead(400, { 'content-type': 'application/xml' })
          res.end('<Error><Code>InvalidPartOrder</Code><Message>nem sorrendben</Message></Error>')
          return
        }
        recorder.completed.set(upload.key,
          Buffer.concat(ordered.map(n => upload.parts.get(n)!)))
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end('<CompleteMultipartUploadResult><ETag>"kesz"</ETag></CompleteMultipartUploadResult>')
        return
      }

      // --- egyszerű objektumműveletek (törlés, létezés) ---
      if (req.method === 'DELETE' && !uploadId) {
        const had = recorder.completed.delete(key)
        res.writeHead(had ? 204 : 404).end()
        return
      }
      if (req.method === 'HEAD') {
        const object = recorder.completed.get(key)
        if (!object) { res.writeHead(404).end(); return }
        res.writeHead(200, { 'content-length': String(object.length) }).end()
        return
      }

      res.writeHead(404).end()
    })().catch(error => {
      res.writeHead(500).end(String(error))
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    server,
    config: {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: 'teszt-vodor',
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET,
      region: 'auto'
    }
  }
}

function fresh (): Recorder {
  return {
    uploads: new Map(), completed: new Map(),
    peakConcurrent: 0, failParts: new Map(), fatalPart: null, abortCalls: 0, cors: null
  }
}

/** Determinisztikus tartalom: minden bájt a pozíciójából jön. */
function payloadOf (size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buffer[i] = (i * 31 + (i >> 8)) & 0xff
  return buffer
}

/** Egyenetlen darabokban adja vissza — ahogy egy valódi fájlolvasó is tenné. */
async function * unevenChunks (data: Buffer): AsyncGenerator<Buffer> {
  const sizes = [1, 7777, 65_536, 1_000_003, 3, 262_144]
  let at = 0
  let i = 0
  while (at < data.length) {
    const size = sizes[i++ % sizes.length]!
    yield data.subarray(at, Math.min(at + size, data.length))
    at += size
  }
}

// ---------------------------------------------------------------------------

let recorder = fresh()
let server: Server
let config: S3Config

before(async () => {
  const started = await startServer(recorder)
  server = started.server
  config = started.config
})

after(() => { server.close() })

describe('a többrészes feltöltés', () => {
  test('a feltöltött bájtok pontosan azok, amiket adtunk', async () => {
    const data = payloadOf(MIN_PART_BYTES * 3 + 1234)
    const result = await uploadStream(
      config, 'video/proba.mp4', unevenChunks(data), 'video/mp4',
      { partBytes: MIN_PART_BYTES, concurrency: 2 })

    assert.equal(result.bytes, data.length)
    assert.equal(result.parts, 4)
    assert.deepEqual(recorder.completed.get('video/proba.mp4'), data)
  })

  /*
   * Az R2 MEGKÖVETELI, hogy az utolsó darabon kívül minden darab egyforma
   * legyen — az AWS nem. Enélkül a kód működne az AWS ellen, és pont az ellen
   * hasalna el, amire használjuk.
   */
  test('az utolsó darabon kívül minden darab egyforma', async () => {
    const upload = [...recorder.uploads.values()].find(u => u.key === 'video/proba.mp4')!
    const numbers = [...upload.parts.keys()].sort((a, b) => a - b)
    const sizes = numbers.map(n => upload.parts.get(n)!.length)
    assert.deepEqual(sizes.slice(0, -1), [MIN_PART_BYTES, MIN_PART_BYTES, MIN_PART_BYTES])
    assert.equal(sizes.at(-1), 1234)
  })

  test('a párhuzamosság korlátja tartja magát', async () => {
    recorder.peakConcurrent = 0
    await uploadStream(
      config, 'video/parhuzam.mp4', unevenChunks(payloadOf(MIN_PART_BYTES * 6)),
      'video/mp4', { partBytes: MIN_PART_BYTES, concurrency: 3 })
    assert.ok(recorder.peakConcurrent > 1,
      `a darabok sorban mentek (csúcs: ${recorder.peakConcurrent})`)
    assert.ok(recorder.peakConcurrent <= 3,
      `egyszerre ${recorder.peakConcurrent} darab volt úton, a korlát 3`)
  })

  /*
   * Egy kulcs, amiben olyan karakterek vannak, amiket az `encodeURIComponent`
   * BÉKÉN HAGY, az AWS viszont kódolva vár. Ha a kódolás rossz, a hamis
   * kiszolgáló 403-at ad — ugyanazt, amit az R2 adna.
   */
  test('a szokatlan karakterek a kulcsban is helyesen íródnak alá', async () => {
    const key = "video/Frieren (2023)/01 - a nap, amit'kaptunk!.mp4"
    const data = payloadOf(4096)
    await uploadStream(config, key, unevenChunks(data), 'video/mp4',
      { partBytes: MIN_PART_BYTES, concurrency: 1 })
    assert.deepEqual(recorder.completed.get(key), data)
  })

  test('egy átmeneti hiba után újrapróbálja a darabot', async () => {
    recorder.failParts.set(2, 2)
    const data = payloadOf(MIN_PART_BYTES * 2 + 10)
    await uploadStream(config, 'video/ujra.mp4', unevenChunks(data), 'video/mp4',
      { partBytes: MIN_PART_BYTES, concurrency: 1, attempts: 3 })
    assert.deepEqual(recorder.completed.get('video/ujra.mp4'), data)
    assert.equal(recorder.failParts.get(2), 0, 'mindkét hibát felhasználta')
  })

  /*
   * Ez a legfontosabb hibaút: ami félig fent van, az PÉNZBE KERÜL, amíg ott
   * áll. Egy megszakadt feltöltés után az eldobásnak le kell futnia.
   */
  test('végleges hiba esetén eldobja a félkész feltöltést', async () => {
    recorder.fatalPart = 2
    recorder.abortCalls = 0
    await assert.rejects(
      uploadStream(config, 'video/felkesz.mp4',
        unevenChunks(payloadOf(MIN_PART_BYTES * 3)), 'video/mp4',
        { partBytes: MIN_PART_BYTES, concurrency: 2, attempts: 1 }),
      /InternalError|darab feltöltése/)
    assert.equal(recorder.abortCalls, 1)
    assert.ok([...recorder.uploads.values()].some(u => u.key === 'video/felkesz.mp4' && u.aborted))
    assert.equal(recorder.completed.has('video/felkesz.mp4'), false,
      'félkész feltöltésből nem lett objektum')
    recorder.fatalPart = null
  })

  test('üres forrásból is objektum lesz', async () => {
    const result = await uploadStream(
      config, 'video/ures.mp4', Readable.from([]), 'video/mp4',
      { partBytes: MIN_PART_BYTES })
    assert.equal(result.bytes, 0)
    assert.equal(result.parts, 1)
    assert.equal(recorder.completed.get('video/ures.mp4')?.length, 0)
  })

  test('a darabméret nem mehet az 5 MiB-os alsó korlát alá', async () => {
    await uploadStream(config, 'video/kicsi.mp4',
      unevenChunks(payloadOf(MIN_PART_BYTES + 1)), 'video/mp4', { partBytes: 1024 })
    const upload = [...recorder.uploads.values()].find(u => u.key === 'video/kicsi.mp4')!
    assert.equal(upload.parts.size, 2, 'az 1 KiB-os kérésből nem lett 5121 darab')
  })

  test('a nem létező feltöltés eldobása nem hiba', async () => {
    await abortMultipartUpload(config, 'video/nincs.mp4', 'ismeretlen')
  })
})

describe('a vödör CORS-szabálya', () => {
  /*
   * Ez a suite azért van, mert a szabály HIÁNYA egy MÉRT, éles hiba volt: a
   * képek a tükörre kerültek, a környezeti fény pedig `crossOrigin`-nal tölti
   * be a posztert — ilyenkor a `access-control-allow-origin` nélküli válaszból
   * nem „szennyezett vászon" lesz, hanem betöltési hiba, és a fény csendben
   * elmarad.
   */
  test('beállítás előtt nincs szabály', async () => {
    assert.equal(await getBucketCors(config), null)
  })

  /*
   * A VÖDÖRSZINTŰ ALÁÍRÁS a `/vodor` útvonalra megy, záró perjel nélkül. Ha
   * elrontanánk (`/vodor/`), a kiszolgáló 403-at adna — ugyanazt, amit az R2.
   */
  test('a szabály kiírható és visszaolvasható', async () => {
    await putBucketCors(config, [{ origins: ['https://pelda.hu'], maxAgeSeconds: 3600 }])
    const current = await getBucketCors(config)
    assert.match(current!, /<AllowedOrigin>https:\/\/pelda\.hu<\/AllowedOrigin>/)
    assert.match(current!, /<MaxAgeSeconds>3600<\/MaxAgeSeconds>/)
  })

  test('alapból csak olvasó metódusok kerülnek bele', async () => {
    await putBucketCors(config, [{ origins: ['https://pelda.hu'] }])
    const current = await getBucketCors(config)!
    assert.match(current!, /<AllowedMethod>GET<\/AllowedMethod>/)
    assert.match(current!, /<AllowedMethod>HEAD<\/AllowedMethod>/)
    assert.doesNotMatch(current!, /<AllowedMethod>(PUT|POST|DELETE)<\/AllowedMethod>/,
      'egy böngészőből futó szkript nem írhat a vödörbe')
  })

  test('több origó is megadható', async () => {
    await putBucketCors(config, [{ origins: ['https://a.hu', 'https://b.hu'] }])
    const current = await getBucketCors(config)
    assert.match(current!, /<AllowedOrigin>https:\/\/a\.hu<\/AllowedOrigin>/)
    assert.match(current!, /<AllowedOrigin>https:\/\/b\.hu<\/AllowedOrigin>/)
  })

  /* Az XML-be kerülő értékek nem törhetik el a dokumentumot. */
  test('a különleges karakterek az XML-ben kódolva mennek', async () => {
    await putBucketCors(config, [{ origins: ['https://x.hu'], headers: ['a&b<c'] }])
    const current = await getBucketCors(config)
    assert.match(current!, /<AllowedHeader>a&amp;b&lt;c<\/AllowedHeader>/)
  })

  test('origó nélküli szabályt visszautasít', async () => {
    await assert.rejects(putBucketCors(config, [{ origins: [] }]), /legalább egy origó/)
  })

  test('üres szabálylistát visszautasít', async () => {
    await assert.rejects(putBucketCors(config, []), /legalább egy szabály/)
  })
})

describe('az objektum törlése', () => {
  test('a feltöltött objektum eltüntethető', async () => {
    const data = payloadOf(1024)
    await uploadStream(config, 'video/torlendo.mp4', unevenChunks(data), 'video/mp4')
    assert.ok(await headObject(config, 'video/torlendo.mp4'))

    await deleteObject(config, 'video/torlendo.mp4')
    assert.equal(await headObject(config, 'video/torlendo.mp4'), null)
  })

  /* A kívánt állapot az, hogy ne legyen ott — ha már nincs, készen vagyunk. */
  test('a nem létező objektum törlése nem hiba', async () => {
    await deleteObject(config, 'video/sosem-volt.mp4')
  })
})

describe('a kulcs alakja', () => {
  /*
   * A `URL` normalizálja az útvonalat, az aláírás viszont nem. A kettő
   * különbségéből a szolgáltatónál csak egy `SignatureDoesNotMatch` lesz —
   * amiből nem derül ki, hogy a KULCCSAL van baj. Itt derüljön ki.
   */
  for (const rossz of ['video/../titok.mp4', 'video/./x.mp4']) {
    test(`a(z) „${rossz}" kulcs beszédes hibát ad`, async () => {
      await assert.rejects(
        uploadStream(config, rossz, unevenChunks(payloadOf(1024)), 'video/mp4'),
        /a kulcs nem használható így/)
    })
  }

  /*
   * A DUPLA PERJEL VISZONT ÉRVÉNYES. Az S3 megengedi az üres szakaszt a
   * kulcsban, és a `URL` sem vonja össze — kipróbálva: a feltöltés simán
   * lefut. Csúnya, de nem hiba, és nem a tárhelyréteg dolga megtiltani.
   */
  test('a dupla perjel megengedett', async () => {
    const data = payloadOf(1024)
    await uploadStream(config, 'video//ures.mp4', unevenChunks(data), 'video/mp4')
    assert.deepEqual(recorder.completed.get('video//ures.mp4'), data)
  })

  test('a szabályos kulcs érintetlenül megy ki', async () => {
    const data = payloadOf(2048)
    await uploadStream(config, 'video/rendes/nev-01.mp4', unevenChunks(data), 'video/mp4')
    assert.deepEqual(recorder.completed.get('video/rendes/nev-01.mp4'), data)
  })
})
