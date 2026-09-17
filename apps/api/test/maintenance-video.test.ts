// A karbantartási videó felismerése — a 15. és 20. pont.
//
// A felismerés kényelmi funkció; a BIZTONSÁGI RÉSZ nem az. Ez a modul egy
// könyvtárat olvas, és a kiválasztott név egy URL-be kerül — tehát pontosan
// az a felület, ahol egy `../../` végigmehetne a rendszeren.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { SUPPORTED, discover, isSafeName, resolveVideo } from '../src/modules/maintenance/video-resolver.ts'

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'yume-videos-'))
})

after(async () => { await rm(root, { recursive: true, force: true }) })

const put = (name: string, bytes = 1024): Promise<void> =>
  writeFile(join(root, name), Buffer.alloc(bytes))

describe('útvonal-kitörés', () => {
  it('a szülőkönyvtárra mutató nevek elbuknak', () => {
    // Nem a „..” kiszűrése miatt: a FELOLDOTT útvonalat hasonlítjuk a
    // gyökérhez. Egy mintaillesztés megkerülhető, egy útvonal-összehasonlítás
    // nem.
    for (const name of ['../secret.mp4', '../../etc/passwd', 'a/../../b.mp4', '..', '../']) {
      assert.equal(isSafeName(name, root), false, name)
    }
  })

  it('az abszolút útvonal elbukik', () => {
    assert.equal(isSafeName('/etc/passwd', root), false)
    assert.equal(isSafeName('/tmp/x.mp4', root), false)
  })

  it('a könyvtárelválasztó bármelyik alakban elbukik', () => {
    assert.equal(isSafeName('sub/video.mp4', root), false)
    assert.equal(isSafeName('sub' + String.fromCharCode(92) + 'video.mp4', root), false)
  })

  it('a nullbájtos név elbukik', () => {
    // A nullbájt a régi trükk: a fájlrendszer ott levágja a nevet, tehát egy
    // felületes ellenőrzés `.txt`-t lát, a rendszer meg `.mp4`-et nyit meg.
    assert.equal(isSafeName('video.mp4\u0000.txt', root), false)
  })

  it('a rejtett fájlok kimaradnak', () => {
    assert.equal(isSafeName('.env.mp4', root), false)
  })

  it('a képtelenül hosszú név elbukik', () => {
    assert.equal(isSafeName('a'.repeat(300) + '.mp4', root), false)
  })

  it('a nem videó kiterjesztés elbukik', () => {
    for (const name of ['secret.txt', 'app.js', 'dump.sql', 'video.mp4.txt', 'video']) {
      assert.equal(isSafeName(name, root), false, name)
    }
  })

  it('az ismert kiterjesztések átmennek', () => {
    for (const extension of SUPPORTED) {
      assert.equal(isSafeName('video' + extension, root), true, extension)
    }
    // Nagybetűs kiterjesztés is: a fájlrendszerek nem mind
    // kis-nagybetű-érzékenyek.
    assert.equal(isSafeName('VIDEO.MP4', root), true)
  })
})

describe('felismerés', () => {
  it('üres könyvtár: nincs videó, és nincs hiba', async () => {
    assert.deepEqual(await discover(root), [])
    assert.equal(await resolveVideo(null, root), null)
  })

  it('NEM LÉTEZŐ könyvtár sem hiba', async () => {
    // Egy friss telepítésen nincs `assets/videos`, és a karbantartási oldal
    // videó nélkül is teljes értékű.
    assert.deepEqual(await discover(join(root, 'nincs-ilyen')), [])
    assert.equal(await resolveVideo(null, join(root, 'nincs-ilyen')), null)
  })

  it('egy videót megtalál, és nyilvános címet ad neki', async () => {
    await put('valami.mp4')
    const found = await discover(root)
    assert.equal(found.length, 1)
    assert.equal(found[0]?.name, 'valami.mp4')
    assert.equal(found[0]?.url, '/assets/videos/valami.mp4')
    assert.equal(found[0]?.type, 'video/mp4')
    assert.ok((found[0]?.sizeBytes ?? 0) > 0)
  })

  it('a KARBANTARTÁSRA SZÁNT név nyer, beállítás nélkül', async () => {
    // Aki bemásol egy `maintenance.mp4`-et, annak onnantól az megy.
    await put('aaa-elso-nevsorban.mp4')
    await put('maintenance.mp4')
    const chosen = await resolveVideo(null, root)
    assert.equal(chosen?.name, 'maintenance.mp4')
    assert.equal(chosen?.preferred, true)
  })

  it('több videó közül kiszámítható a sorrend', async () => {
    const names = (await discover(root)).map(asset => asset.name)
    // Előbb a karbantartásra szántak, azon belül névsor — nem a
    // fájlrendszer véletlen sorrendje.
    assert.equal(names[0], 'maintenance.mp4')
    assert.deepEqual([...names].slice(1), [...names].slice(1).sort())
  })

  it('a nem támogatott fájlok nem kerülnek a listába', async () => {
    await put('olvasando.txt')
    await put('kod.js')
    const names = (await discover(root)).map(asset => asset.name)
    assert.ok(!names.includes('olvasando.txt'))
    assert.ok(!names.includes('kod.js'))
  })

  it('a webm és az m3u8 helyes típust kap', async () => {
    await put('maintenance-loop.webm')
    await put('stream.m3u8')
    const byName = new Map((await discover(root)).map(asset => [asset.name, asset.type]))
    assert.equal(byName.get('maintenance-loop.webm'), 'video/webm')
    assert.equal(byName.get('stream.m3u8'), 'application/vnd.apple.mpegurl')
  })

  it('a beállított név is átmegy az ellenőrzésen', async () => {
    // Az admin felület sem megbízható bemenet: ami a válaszba kerül,
    // ugyanazt a kaput járja be.
    assert.equal(await resolveVideo('../../../etc/passwd', root), null)
    assert.equal(await resolveVideo('/etc/shadow', root), null)
  })

  it('a beállított, de nem létező név nem talál ki semmit', async () => {
    // Csendben másik videót adni rosszabb, mint semmit: az admin azt hinné,
    // az ő fájlja megy.
    assert.equal(await resolveVideo('nincs-ilyen.mp4', root), null)
  })

  it('a beállított létező nevet pontosan adja vissza', async () => {
    const chosen = await resolveVideo('maintenance-loop.webm', root)
    assert.equal(chosen?.name, 'maintenance-loop.webm')
  })

  it('a könyvtárakat kihagyja', async () => {
    await mkdir(join(root, 'almappa.mp4'))
    const names = (await discover(root)).map(asset => asset.name)
    assert.ok(!names.includes('almappa.mp4'), 'egy könyvtárat videónak vett')
  })

  it('a szóközös és ékezetes név is működik, kódolt címmel', async () => {
    await put('karbantartás videó.mp4')
    const found = (await discover(root)).find(asset => asset.name === 'karbantartás videó.mp4')
    assert.ok(found, 'nem találta meg az ékezetes nevet')
    assert.ok(!found.url.includes(' '), 'a szóköz kódolatlanul maradt az URL-ben')
    assert.equal(decodeURIComponent(found.url), '/assets/videos/karbantartás videó.mp4')
  })
})
