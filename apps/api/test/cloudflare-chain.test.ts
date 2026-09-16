// Ki a látogató, ha a Cloudflare is a láncban van?
//
// A `trust-proxy.test.ts` a BEÁLLÍTÁS értelmezését méri: mit fogad el a
// `TRUST_PROXY`, mit utasít vissza. Azt soha nem mérte, ami a végén számít —
// hogy egy kérés végigfutva a láncon MELYIK címet kapja `request.ip`-ként.
//
// Ez most lesz fontos. A lánc ma:
//
//     látogató → Caddy (172.20.0.6) → app
//
// és a Cloudflare bekapcsolása után:
//
//     látogató → Cloudflare → Caddy → app
//
// A különbség nem elméleti. A Cloudflare beírja a látogató címét az
// `X-Forwarded-For`-ba, a Caddy pedig hozzáfűzi a SAJÁT peer-jét, vagyis a
// Cloudflare él-szerverének címét. Ha a `TRUST_PROXY` csak a Docker-hálózatot
// ismeri, az app jobbról balra haladva a Cloudflare IP-jénél megáll — és
// onnantól MINDEN látogató ugyanaz a cím. A sebességkorlát tovább „működik",
// csak épp az egész internetet egy vödörbe teszi, és mindenkit együtt zár ki.
//
// Ez a fajta hiba nem dob kivételt és nem ír naplót. Ezért van ez a fájl.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

/*
 * A `config.ts` egyszer olvassa a környezetet, importáláskor — tehát az
 * értéket az app betöltése ELŐTT kell beállítani. A tesztfájlok külön
 * folyamatban futnak, így ez nem szivárog át máshová.
 */
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
]
process.env.TRUST_PROXY = ['172.16.0.0/12', ...CLOUDFLARE_V4].join(',')
process.env.JWT_SECRET ??= 'cloudflare-chain-secret-0123456789abcdef'
process.env.RATE_LIMIT_MAX ??= '100000'

const HAS_DB = Boolean(process.env.DATABASE_URL)

describe('a valódi látogató a Cloudflare mögött is felismerhető', { skip: HAS_DB ? false : 'no DATABASE_URL' }, () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts').buildApp>>
  let pool: import('pg').Pool

  /** A Caddy címe a compose-hálózaton. Ez a közvetlen peer minden kérésnél. */
  const CADDY = '172.20.0.6'
  /** Egy valódi Cloudflare él-cím a 172.64.0.0/13 tartományból. */
  const CLOUDFLARE_EDGE = '172.70.130.45'
  /** A látogató. Dokumentációs tartomány, hogy valódi címet ne használjunk. */
  const VISITOR = '203.0.113.42'

  before(async () => {
    const [{ buildApp }, db] = await Promise.all([
      import('../src/app.ts'), import('../src/infrastructure/database/index.ts')
    ])
    app = await buildApp()
    pool = db.pool as never
    // Egy útvonal, ami megmondja, kinek hiszi a hívót. A `buildApp` után, a
    // `ready` előtt: ekkor még lehet útvonalat regisztrálni.
    app.get('/__ki-vagyok', async request => ({ ip: request.ip }))
    await app.ready()
  })

  after(async () => {
    try { await app?.close() } finally { await pool?.end() }
  })

  const seenAs = async (remoteAddress: string, forwardedFor?: string): Promise<string> => {
    const res = await app.inject({
      url: '/__ki-vagyok',
      remoteAddress,
      ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {})
    })
    return (res.json() as { ip: string }).ip
  }

  /*
   * A MAI LÁNC. A Cloudflare bekapcsolása ezt nem törheti el — a `duckdns`
   * cím továbbra is közvetlenül a Caddyhez érkezik.
   */
  test('Caddyn át, Cloudflare nélkül: a látogatót látjuk', async () => {
    assert.equal(await seenAs(CADDY, VISITOR), VISITOR)
  })

  /*
   * A HOLNAPI LÁNC, és ez a fájl fő állítása. A Caddy a Cloudflare címét fűzi
   * a lista végére; az appnak át kell lépnie rajta a látogatóig.
   */
  test('Cloudflare + Caddy: a látogatót látjuk, nem a Cloudflare-t', async () => {
    const ip = await seenAs(CADDY, `${VISITOR}, ${CLOUDFLARE_EDGE}`)
    assert.equal(ip, VISITOR,
      `a lánc végén ${ip} jött ki; ha ez a Cloudflare címe, minden látogató egy ` +
      'sebességkorlát-vödörbe kerül')
  })

  test('több Cloudflare-ugrás sem téveszti meg', async () => {
    assert.equal(
      await seenAs(CADDY, `${VISITOR}, 104.16.0.9, ${CLOUDFLARE_EDGE}`),
      VISITOR)
  })

  /*
   * A MÁSIK IRÁNY, és ez a fontosabbik. A bővített bizalmi lista nem teheti
   * hiszékennyé az appot: aki NEM megbízható címről jön, annak a beírt
   * `X-Forwarded-For`-ja nem számít.
   */
  test('közvetlen kapcsolatból a hamisított fejléc nem számít', async () => {
    const attacker = '198.51.100.7'
    const ip = await seenAs(attacker, '1.2.3.4')
    assert.equal(ip, attacker,
      'egy közvetlenül csatlakozó hívó hamisított címet tudott magára venni')
  })

  test('a Cloudflare-tartományba írt hamisítás sem megy át közvetlen kapcsolatból', async () => {
    const attacker = '198.51.100.8'
    assert.equal(await seenAs(attacker, `1.2.3.4, ${CLOUDFLARE_EDGE}`), attacker)
  })

  /*
   * A HATÁRESET, amit ki kell mondani, mert a bizalmi lista nem tudja megoldani.
   *
   * Ha valaki Cloudflare WARP-ról (vagy más, Cloudflare-címről kimenő
   * szolgáltatásról) KÖZVETLENÜL az origin IP-t hívja, a peer-je egy
   * Cloudflare-cím lesz — tehát megbízhatónak látszik, és a beírt fejléce
   * számítani fog. Ezt nem a `TRUST_PROXY` javítja, hanem az, ha az origin
   * csak a Cloudflare felől fogad kapcsolatot (az audit NET-01 tétele).
   *
   * A teszt ezt NEM hibaként rögzíti, hanem tényként: ha egyszer a tűzfal
   * felkerül, ez az állítás megfordul, és akkor itt kell átírni — nem egy
   * meglepetésben, élesben.
   */
  test('ismert határeset: Cloudflare-címről érkező közvetlen hívás fejlécét elhisszük', async () => {
    const ip = await seenAs(CLOUDFLARE_EDGE, '9.9.9.9')
    assert.equal(ip, '9.9.9.9',
      'ha ez megváltozott, az origin már csak a Cloudflare felől fogad — írd át ezt az állítást')
  })
})
