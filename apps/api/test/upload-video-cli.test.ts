// A videófeltöltő szkript — a VALÓDI szkript, alfolyamatként indítva.
//
// Miért így, és nem a függvényeit importálva: a szkript hibáinak a fele nem a
// logikában van, hanem a parancssorban. Az első változatom argumentumelemzője
// a `--dry-run film.mp4` sorrendnél a fájlnevet a kapcsoló értékének hitte, és
// „add meg a feltöltendő fájlt" hibával állt le — egy importált függvény
// tesztelése ezt sosem fogta volna meg, mert a hiba pont a belépési pontban
// volt.
//
// A `--dry-run` mindent kiszámol, de NEM nyúl se a hálózathoz, se az
// adatbázishoz: ez a suite így a vödröt nem érinti.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/upload-video.ts', import.meta.url))

interface Result { code: number, stdout: string, stderr: string }

async function cli (...args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(
      process.execPath, ['--experimental-strip-types', SCRIPT, ...args],
      {
        env: {
          ...process.env,
          // A szkript ebből építi a nyilvános címet. Üresre állítva
          // ellenőrizhető az az ág is, ahol NEM tud címet mondani.
          MEDIA_BASE_URL: process.env.YUME_TEST_MEDIA_BASE ?? '',
          NODE_OPTIONS: ''
        }
      })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number, stdout?: string, stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

let dir: string
let video: string
let digest: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yume-video-'))
  video = join(dir, 'Frieren 01.mp4')
  const body = Buffer.alloc(3 * 1024 * 1024, 7)
  await writeFile(video, body)
  digest = createHash('sha256').update(body).digest('hex')
})

after(async () => { await rm(dir, { recursive: true, force: true }) })

describe('a videófeltöltő parancssora', () => {
  test('a kulcs a tartalomból származik', async () => {
    const result = await cli(video, '--dry-run', '--base', 'https://media.pelda.hu')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`kulcs: video/${digest.slice(0, 2)}/${digest}\\.mp4`))
  })

  test('ugyanaz a tartalom ugyanazt a kulcsot adja', async () => {
    const masolat = join(dir, 'mas-nev.mp4')
    await writeFile(masolat, Buffer.alloc(3 * 1024 * 1024, 7))
    const a = await cli(video, '--dry-run')
    const b = await cli(masolat, '--dry-run')
    const kulcs = (r: Result): string => /kulcs: (\S+)/.exec(r.stdout)![1]!
    assert.equal(kulcs(a), kulcs(b))
  })

  /* Ez az a sorrend, amin az első elemzőm elhasalt. */
  test('a kapcsoló a fájlnév előtt is állhat', async () => {
    const result = await cli('--dry-run', video, '--base', 'https://media.pelda.hu')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /kulcs: video\//)
  })

  test('a nyilvános cím az alapból és a kulcsból áll össze', async () => {
    const result = await cli(video, '--dry-run', '--base', 'https://media.pelda.hu')
    assert.match(result.stdout, new RegExp(`cím: https://media\\.pelda\\.hu/video/../${digest}\\.mp4`))
  })

  /*
   * Ha nincs beállított nyilvános alap, a szkript NEM talál ki egyet. Egy
   * kitalált cím a forrástáblába kerülne, és ott egy nem létező domainre
   * mutató lejátszási forrás lenne belőle.
   */
  test('beállított alap nélkül nem talál ki címet', async () => {
    const result = await cli(video, '--dry-run')
    assert.doesNotMatch(result.stdout, /cím: /)
    assert.match(result.stderr, /nincs abszolút címre állítva/)
  })

  test('bejegyzéshez nyilvános cím kell', async () => {
    const result = await cli(video, '--dry-run', '--episode', '00000000-0000-0000-0000-000000000001')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /nyilvános URL nélkül nem tudom bejegyezni/)
  })

  test('száraz futásban a bejegyzés is csak kiírás', async () => {
    const result = await cli(video, '--dry-run', '--base', 'https://media.pelda.hu',
      '--episode', '00000000-0000-0000-0000-000000000001')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /\[száraz\] bejegyzés ide: epizód 00000000-/)
  })

  test('kiszámolja, hány darabban menne', async () => {
    const result = await cli(video, '--dry-run', '--part-mb', '16')
    assert.match(result.stdout, /3\.0 MB menne fel 16\.0 MB-os darabokban, 1 darab/)
  })

  /*
   * A száraz futás TERVE és az éles futás VISELKEDÉSE nem térhet el. A túl
   * kicsi darabméretet a feltöltő 5 MiB-ra emeli; ha a terv a nyers kért
   * értékkel számolna, mást ígérne, mint ami történne.
   */
  test('a túl kicsi darabméretet a terv is felemeli', async () => {
    const result = await cli(video, '--dry-run', '--part-mb', '1')
    assert.match(result.stderr, /a darabméret legalább 5 MiB lehet/)
    assert.match(result.stdout, /5\.0 MB-os darabokban, 1 darab/)
  })

  test('ismeretlen kapcsolót visszautasít', async () => {
    const result = await cli(video, '--dry-run', '--epizod', 'x')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ismeretlen kapcsoló: --epizod/)
  })

  test('érték nélküli kapcsolót visszautasít', async () => {
    const result = await cli(video, '--dry-run', '--episode')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /értéket vár/)
  })

  test('két fájlt nem visz egyszerre', async () => {
    const result = await cli(video, video, '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /egyszerre egy fájl megy/)
  })

  test('fájl nélkül megmondja, mi hiányzik', async () => {
    const result = await cli('--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /add meg a feltöltendő fájlt/)
  })

  test('nem létező fájlt nem próbál feltölteni', async () => {
    const result = await cli(join(dir, 'nincs.mp4'), '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /nincs ilyen fájl/)
  })

  test('üres fájlt visszautasít', async () => {
    const ures = join(dir, 'ures.mp4')
    await writeFile(ures, '')
    const result = await cli(ures, '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /a fájl üres/)
  })

  test('ismeretlen kiterjesztést visszautasít', async () => {
    const rossz = join(dir, 'valami.rar')
    await writeFile(rossz, Buffer.alloc(1024))
    const result = await cli(rossz, '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ismeretlen kiterjesztés/)
  })

  /*
   * A Matroska feltölthető, de egyetlen böngésző sem játssza le natívan. Ezt
   * feltöltés előtt jobb megtudni, mint egy néző hibajelentéséből.
   */
  test('a .mkv fájlnál figyelmeztet, de nem áll le', async () => {
    const mkv = join(dir, 'proba.mkv')
    await writeFile(mkv, Buffer.alloc(1024 * 1024, 3))
    const result = await cli(mkv, '--dry-run')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /nem játsszák le natívan/)
  })

  /*
   * Az elgépelt felbontás korábban csak a feltöltés UTÁN derült ki. Ez a teszt
   * arra megy, hogy előbb — a fájl végigolvasása előtt.
   */
  test('ismeretlen felbontást visszautasít, mielőtt bármit tenne', async () => {
    const result = await cli(video, '--resolution', '1440', '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ismeretlen felbontás: 1440/)
    assert.doesNotMatch(result.stdout, /ujjlenyomat/, 'még a fájlt sem olvasta végig')
  })

  test('ismeretlen változatot visszautasít', async () => {
    const result = await cli(video, '--variant', 'felirat', '--dry-run')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ismeretlen változat: felirat/)
  })
})
