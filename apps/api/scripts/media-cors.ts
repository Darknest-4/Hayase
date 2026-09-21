// A médiavödör CORS-szabálya — megmutatni és beállítani.
//
//   node --experimental-strip-types scripts/media-cors.ts --show
//   node --experimental-strip-types scripts/media-cors.ts --set [--origin <url> …] [--dry-run]
//
// MIÉRT VAN RÁ SZÜKSÉG. A képek a tükörről jönnek, tehát IDEGEN ORIGÓRÓL. Egy
// `<img>`-nek ez mindegy; a JAVASCRIPTNEK nem. A lejátszó környezeti fénye a
// posztert vászonra rajzolja, és megméri a színét — ehhez
// `crossOrigin = 'anonymous'`-szal tölti be, és ilyenkor a válasznak
// `access-control-allow-origin`-t KELL hoznia, különben a kép be sem töltődik.
//
// Az R2 vödör alapból nem küld ilyet, és ezt megmértük — a `--show` bármikor
// megismételhető.
//
// A SZABÁLY SZÁNDÉKOSAN SZŰK: csak olvasás (`GET`, `HEAD`), csak a megadott
// origókról. Egy `*` itt nem „kényelmesebb", hanem azt jelenti, hogy bármelyik
// weboldal beolvashatja a vödör tartalmát a látogatói böngészőjén keresztül.

import { getBucketCors, mediaStorage, putBucketCors } from '../src/infrastructure/storage/s3.ts'

const argv = process.argv.slice(2)

function fail (message: string): never {
  console.error(`hiba: ${message}`)
  process.exit(1)
}

const origins: string[] = []
let mode: 'show' | 'set' | null = null
let dryRun = false

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg === '--show') mode = 'show'
  else if (arg === '--set') mode = 'set'
  else if (arg === '--dry-run') dryRun = true
  else if (arg === '--origin') {
    const value = argv[++i]
    if (!value) fail('a --origin kapcsoló értéket vár')
    if (!/^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(value)) {
      // Az origó SÉMA + GAZDA + PORT, útvonal és záró perjel nélkül. Egy
      // `https://pelda.hu/` soha nem fog egyezni a böngésző `Origin`
      // fejlécével, a szabály pedig csendben hatástalan lenne.
      fail(`nem érvényes origó (séma + gazda, útvonal nélkül): ${value}`)
    }
    origins.push(value)
  } else fail(`ismeretlen kapcsoló: ${arg}`)
}

if (!mode) fail('add meg, mit tegyek: --show vagy --set')

const config = mediaStorage()
if (!config) fail('nincs médiatárhely beállítva (R2_ENDPOINT, R2_ACCESS_KEY_ID, …)')

console.log(`vödör: ${config.bucket}`)

if (mode === 'show') {
  const current = await getBucketCors(config)
  if (current === null) console.log('nincs beállított CORS-szabály')
  else console.log(current)
  process.exit(0)
}

// A beállításnál az origók a PUBLIC_URL-ből jönnek, ha nem adtunk meg mást.
// Így nincs a kódban éles cím, és egy másik telepítés a saját környezetéből
// kapja a sajátját.
if (origins.length === 0) {
  const fromEnv = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (!fromEnv) fail('nincs --origin, és a PUBLIC_URL sincs beállítva')
  origins.push(fromEnv)
}

const rule = { origins, methods: ['GET', 'HEAD'], headers: ['*'], maxAgeSeconds: 86_400 }
console.log(`origók: ${origins.join(', ')}`)
console.log('metódusok: GET, HEAD')

if (dryRun) {
  console.log('[száraz] a szabály nem íródott ki')
  process.exit(0)
}

await putBucketCors(config, [rule])
console.log('beállítva')

// ELLENŐRZÉS. Egy „beállítva" üzenet, ami mögött nincs visszaolvasás, pont
// annyit ér, mint egy találgatás.
const after = await getBucketCors(config)
if (!after) fail('a beállítás után sincs szabály a vödrön')
for (const origin of origins) {
  if (!after.includes(origin)) fail(`a visszaolvasott szabályban nincs benne: ${origin}`)
}
console.log('visszaolvasva, a szabály a helyén van')
