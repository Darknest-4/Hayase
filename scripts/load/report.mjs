// A mérés jelentése.
//
// Kézzel írt jelentésben az a rossz, hogy a számok és a következtetés között
// eltelik egy emlékezés. Ez a szkript a k6 összegzéséből és az
// erőforrás-mintákból ír, tehát a jelentésben nem állhat olyan szám, amit nem
// mértünk.
//
// Amit szándékosan NEM csinál: nem becsül kapacitást a mért fokozatokon túl.
// Ha a legmagasabb megfelelt fokozat 250 VU, akkor a jelentés 250-et mond, nem
// „valószínűleg 400-at bír". A második mondat kitalálás, és pont az a fajta,
// amit később tényként idéznek.
//
//   node scripts/load/report.mjs --dir docs/analytics/load-reports/<id>

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const DIR = arg('dir')
if (!DIR) { console.error('--dir kötelező'); process.exit(2) }
const FAILED_AT = arg('failed-at', null)

const run = JSON.parse(readFileSync(join(DIR, 'run.json'), 'utf8'))

const num = (v, digits = 0) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits)
const ms = v => v == null || !Number.isFinite(v) ? '—' : (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v.toFixed(0) + ' ms')
const p = (m, k) => m?.values?.[`p(${k})`] ?? m?.values?.[`p${k}`]

/** Egy fokozat adatai: a k6 összegzése + az erőforrás-minták. */
function stage (vus) {
  const summary = JSON.parse(readFileSync(join(DIR, `stage-${vus}.summary.json`), 'utf8'))
  const samples = readFileSync(join(DIR, `stage-${vus}.samples.ndjson`), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { vus: Number(vus), m: summary.metrics ?? {}, summary, samples }
}

const stages = readdirSync(DIR)
  .map(f => f.match(/^stage-(\d+)\.summary\.json$/)?.[1])
  .filter(Boolean)
  .map(Number).sort((a, b) => a - b)
  .map(stage)

if (!stages.length) { console.error('nincs egyetlen lefutott fokozat sem'); process.exit(1) }

/** Elbukott-e valamelyik küszöb ezen a fokozaton, és melyik. */
function breaches (s) {
  const out = []
  for (const [name, metric] of Object.entries(s.m)) {
    for (const [expr, t] of Object.entries(metric.thresholds ?? {})) {
      if (t.ok === false) out.push(`${name} ${expr}`)
    }
  }
  return out
}

/** A minták csúcsai — ez mondja meg, MI fogyott el, nem csak hogy lassú lett. */
function peaks (s) {
  const max = (fn) => {
    const values = s.samples.map(fn).filter(v => Number.isFinite(v))
    return values.length ? Math.max(...values) : null
  }
  return {
    cpu: max(x => x.host?.cpuUsagePct),
    loadPerCore: max(x => (x.host?.load1 ?? NaN) / (x.host?.cores ?? 1)),
    mem: max(x => x.host?.memory?.usedPct),
    swap: max(x => x.host?.memory?.swapUsedPct),
    netRx: max(x => x.host?.network?.rxBps),
    netTx: max(x => x.host?.network?.txBps),
    conns: max(x => Number(x.db?.connections)),
    active: max(x => Number(x.db?.active)),
    maxConns: max(x => Number(x.db?.max_connections)),
    lockWaits: max(x => Number(x.db?.waiting_on_lock)),
    longestQuery: max(x => Number(x.db?.longest_query_sec)),
    tps: max(x => x.rates?.tps),
    cacheHit: Math.min(...s.samples.map(x => x.rates?.cacheHitPct).filter(Number.isFinite).concat([Infinity])),
    queue: max(x => Number(x.db?.queue_pending)),
    appCpu: max(x => x.docker?.['yume-load-app-1']?.cpuPct),
    appMem: max(x => x.docker?.['yume-load-app-1']?.memPct),
    workerCpu: max(x => x.docker?.['yume-load-worker-1']?.cpuPct),
    pgCpu: max(x => x.docker?.['yume-load-postgres-1']?.cpuPct)
  }
}

/** Sávszélesség olvasható egységben. 20 kB/s „0.0 MB/s"-ként semmit nem mond. */
const bps = v => {
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' MB/s'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + ' kB/s'
  return v.toFixed(0) + ' B/s'
}

// ---- a mért kapacitás -------------------------------------------------------
// A legmagasabb fokozat, ami küszöbsértés NÉLKÜL ment végig. Nem a legmagasabb,
// ami "elég jónak látszik".
const passed = stages.filter(s => breaches(s).length === 0)
const capacity = passed.length ? passed[passed.length - 1] : null
const firstFail = stages.find(s => breaches(s).length > 0)

const lines = []
const w = (...xs) => lines.push(...xs)

w(`# Terhelésmérés — ${run.id}`, '')
w('| | |', '|---|---|')
w(`| mérés azonosítója | \`${run.id}\` |`)
w(`| dátum | ${run.startedAt} |`)
w(`| forgatókönyv | \`tests/load/${run.scenario}.js\` |`)
w(`| build | \`${run.build}\` |`)
w(`| környezet | mérőverem (\`docker-compose.load.yml\`), ${run.base} |`)
w(`| gép | ${run.host}, ${run.cores} mag, ${run.memTotalMb} MB memória |`)
w(`| fokozatonként | ${run.ramp} felfutás + ${run.duration} terhelés |`)
w('')

w('## A mért kapacitás', '')
if (capacity) {
  const reqs = capacity.m.http_reqs?.values
  w(`**${capacity.vus} egyidejű felhasználó** — ez a legmagasabb fokozat, ami küszöbsértés nélkül végigment.`, '')
  w(`Ez a fokozat **${num(reqs?.rate, 1)} kérés/mp** átlagos terhelést jelentett, `,
    `p95 **${ms(p(capacity.m.http_req_duration, 95))}** késleltetéssel.`, '')
} else {
  w('**Nincs megfelelt fokozat.** Már a legkisebb terhelés is átlépte valamelyik küszöböt — a részletek lent.', '')
}
if (firstFail) {
  w(`Az első fokozat, ami elbukott: **${firstFail.vus} VU**. Amit a küszöb megfogott:`, '')
  for (const b of breaches(firstFail)) w(`* \`${b}\``)
  w('')
  const pk = peaks(firstFail)
  w('Ugyanekkor a gépen:', '')
  w(`* processzor: ${num(pk.cpu, 1)} % (terhelés/mag ${num(pk.loadPerCore, 2)})`)
  w(`* memória: ${num(pk.mem, 1)} %, swap ${num(pk.swap, 1)} %`)
  w(`* Postgres: ${num(pk.conns)} / ${num(pk.maxConns)} kapcsolat, ebből ${num(pk.active)} aktív`)
  w(`* leghosszabb futó lekérdezés: ${num(pk.longestQuery, 1)} s, zárolásra váró: ${num(pk.lockWaits)}`)
  w(`* feladatsor: ${num(pk.queue)} várakozó`)
  w('')
} else {
  w(`Minden lefutott fokozat megfelelt. A felső határ tehát **nem ismert** — a mérés ${stages[stages.length - 1].vus} VU-nál ért véget, nem a kiszolgáló bírásánál.`, '')
}
if (FAILED_AT) w(`> A futás a ${FAILED_AT} VU-s fokozatnál állt le. A magasabb fokozatok nem futottak.`, '')
w('')

// ---- fokozatonként ----------------------------------------------------------
w('## Fokozatok', '')
w('| VU | kérés/mp | iteráció | p50 | p90 | p95 | p99 | max | hiba | 429 | 5xx | időtúllépés |')
w('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const s of stages) {
  const d = s.m.http_req_duration
  const f = s.m.yume_failed?.values
  w(`| ${s.vus} | ${num(s.m.http_reqs?.values?.rate, 1)} | ${num(s.m.iterations?.values?.count)} | ` +
    `${ms(d?.values?.med)} | ${ms(p(d, 90))} | ${ms(p(d, 95))} | ${ms(p(d, 99))} | ${ms(d?.values?.max)} | ` +
    `${f ? (f.rate * 100).toFixed(2) + ' %' : '—'} | ${num(s.m.yume_rate_limited?.values?.count)} | ` +
    `${num(s.m.yume_5xx?.values?.count)} | ${num(s.m.yume_timeouts?.values?.count)} |`)
}
w('')

w('### Egyidejű felhasználó ≠ kérés/mp', '')
const last = stages[stages.length - 1]
const ratio = last.m.http_reqs?.values?.rate / last.vus
w('A két szám nem cserélhető fel, és a legtöbb „hány felhasználót bír" kérdés azért kap rossz választ, mert felcserélik őket.', '')
w(`Ebben a mérésben ${last.vus} egyidejű felhasználó ${num(last.m.http_reqs?.values?.rate, 1)} kérés/mp-et jelentett, ` +
  `vagyis fejenként **${num(ratio, 2)} kérés/mp** — mert egy felhasználó a kérések között OLVAS. ` +
  'Ez a viselkedés tulajdonsága, nem a kiszolgálóé: türelmetlenebb közönséggel ugyanaz a felhasználószám több kérést jelent.', '')
w('| fogalom | mit mér | ebben a mérésben |', '|---|---|---|')
w(`| egyidejű felhasználó (VU) | hányan vannak egyszerre az oldalon | ${capacity ? capacity.vus : '—'} |`)
w(`| kérés/mp | mennyit dolgozik a kiszolgáló | ${capacity ? num(capacity.m.http_reqs?.values?.rate, 1) : '—'} |`)
w(`| sávszélesség | mennyi adat megy a vezetéken | lásd lent |`)
w('| egyidejű WebSocket | hány élő kapcsolat van nyitva | külön mérés (`websocket.js`) |')
w('| videónéző | hány adatfolyam megy egyszerre | **nem ezen a gépen** — a források külsők |')
w('')

// ---- lépések ---------------------------------------------------------------
w('## Lépésenkénti késleltetés (a legmagasabb lefutott fokozaton)', '')
w('| lépés | med | p95 | p99 | max | hívás |', '|---|---:|---:|---:|---:|---:|')
for (const key of Object.keys(last.m).filter(k => k.startsWith('step_') || k.startsWith('play_') || k.startsWith('ws_')).sort()) {
  const m = last.m[key]
  if (!m.values || m.values.med === undefined) continue
  w(`| \`${key}\` | ${ms(m.values.med)} | ${ms(p(m, 95))} | ${ms(p(m, 99))} | ${ms(m.values.max)} | ${num(m.values.count)} |`)
}
w('')

// ---- erőforrások -----------------------------------------------------------
w('## Erőforrások fokozatonként', '')
w('| VU | CPU % | terh./mag | RAM % | swap % | háló be | háló ki | PG kapcs. | PG aktív | tps | gyorsítótár-találat | sor |')
w('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const s of stages) {
  const k = peaks(s)
  w(`| ${s.vus} | ${num(k.cpu, 1)} | ${num(k.loadPerCore, 2)} | ${num(k.mem, 1)} | ${num(k.swap, 1)} | ` +
    `${bps(k.netRx)} | ${bps(k.netTx)} | ${num(k.conns)}/${num(k.maxConns)} | ${num(k.active)} | ${num(k.tps)} | ` +
    `${Number.isFinite(k.cacheHit) ? num(k.cacheHit, 2) + ' %' : '—'} | ${num(k.queue)} |`)
}
w('')
w('Konténerenként (csúcs):', '')
w('| VU | app CPU % | app RAM % | worker CPU % | postgres CPU % |', '|---:|---:|---:|---:|---:|')
for (const s of stages) {
  const k = peaks(s)
  w(`| ${s.vus} | ${num(k.appCpu, 1)} | ${num(k.appMem, 1)} | ${num(k.workerCpu, 1)} | ${num(k.pgCpu, 1)} |`)
}
w('')

// ---- hol a szűk keresztmetszet ---------------------------------------------
w('## Mi fogyott el először', '')
const ref = firstFail ?? last
const k = peaks(ref)
const verdicts = []
if (k.cpu >= 85) verdicts.push(`**processzor** — ${num(k.cpu, 1)} %-on állt a gép a ${ref.vus} VU-s fokozaton.`)
if (k.mem >= 85) verdicts.push(`**memória** — ${num(k.mem, 1)} % használt.`)
if (k.swap >= 5) verdicts.push(`**swap** — ${num(k.swap, 1)} %; ha ez nem nulla, a késleltetés már a lemezről jön.`)
if (k.conns && k.maxConns && k.conns / k.maxConns >= 0.8) {
  verdicts.push(`**Postgres kapcsolatok** — ${num(k.conns)} a ${num(k.maxConns)}-ból.`)
}
if (k.lockWaits >= 1) verdicts.push(`**zárolás** — ${num(k.lockWaits)} lekérdezés várt zárolásra.`)
if (k.queue >= 100) verdicts.push(`**feladatsor** — ${num(k.queue)} várakozó feladat; a worker nem tartotta a tempót.`)
if (ref.m.yume_rate_limited?.values?.count > 0) {
  verdicts.push('**a sebességkorlát** — ez nem eredmény, hanem hiba a mérésben: ellenőrizd a mérőkulcsot.')
}
if (!verdicts.length) {
  verdicts.push('Egyik mért erőforrás sem ért a küszöbéig. Ahol a késleltetés mégis nőtt, ott az ok nem a gép telítettsége, ' +
    'hanem a kiszolgálás soros pontjai — a lépésenkénti táblázat mutatja, melyik hívás vitte az időt.')
}
for (const v of verdicts) w(`* ${v}`)
w('')

w('## Sávszélesség', '')
const bw = peaks(last)
w(`A legmagasabb lefutott fokozaton a kimenő forgalom csúcsa **${bps(bw.netTx)}**, a bejövőé ${bps(bw.netRx)}.`, '')
w('Ez az **alkalmazás** forgalma: JSON-válaszok és a statikus kliens. A videó ebben nincs benne és nem is lesz: ' +
  'a források külső szolgáltatóknál vannak, az adatfolyam nem ezen a gépen megy át. ' +
  'Ha egyszer saját forrás kerül a rendszerbe, a videó sávszélessége külön mérés, külön költséggel.', '')

w('## Mit NEM mond ez a mérés', '')
w('* Nem mond semmit a mért fokozatokon túli kapacitásról. A legmagasabb megfelelt fokozat a válasz; ' +
  'ami fölötte van, azt meg kell mérni, nem megbecsülni.')
w('* A mérőverem ugyanazon a gépen fut, mint az éles példány. A futás ideje alatt osztoznak a processzoron, ' +
  'tehát ezek a számok inkább alsó becslések, mint felsők.')
w('* A videó lejátszásának terhelését nem méri — lásd a sávszélesség szakaszt.')
w('* Egyetlen futás nem trend. Két mérés között a build és az adatállomány is változik; ' +
  'a jelentés fejléce épp ezért írja ki mindkettőt.')
w('')

writeFileSync(join(DIR, 'REPORT.md'), lines.join('\n'))
console.log(`fokozatok: ${stages.map(s => s.vus).join(', ')}`)
console.log(capacity ? `mért kapacitás: ${capacity.vus} VU` : 'nincs megfelelt fokozat')
