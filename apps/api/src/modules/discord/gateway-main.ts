/**
 * A gateway FOLYAMATA — a hálózat, a motor köré.
 *
 * A protokoll döntései a `gateway.ts`-ben vannak, és ott mérhetők is. Itt
 * csak az van, amit valódi kapcsolat nélkül nem lehet kipróbálni: a
 * WebSocket megnyitása, az időzítők és a leállás.
 *
 * SAJÁT FOLYAMAT, nem a workerben. A gateway ÁLLANDÓ kapcsolatot tart; a
 * worker ciklikus feladatokat futtat, és egy hosszú feladat közben a
 * szívverés elmaradna. Egy elmaradt szívveréstől a Discord bontja a
 * kapcsolatot, és a rendszer újracsatlakozási hurokba kerülne — ami
 * pontosan úgy néz ki, mint egy hálózati hiba, és órákig lehet keresni.
 *
 * AMI ELVESZIK EGY ÚJRAINDÍTÁSNÁL: néhány másodpercnyi üzenetszámláló. A
 * `resume` a kimaradt eseményeket pótolja, ha a munkamenet még folytatható;
 * ha nem, az adott percek hiányoznak. Ez helyes csere — egy statisztika
 * pontatlansága nem baj, egy duplán számolt üzenet viszont hazudik.
 */

import {
  allapotIr, elsoSzivveres, esemenyBol, folytathato, Gyujto, intentsFromEnv,
  konfiguralva, kodMagyarazat, OP, ujAllapot, ujraVaras, vegzetes, botToken
} from './gateway.ts'

import * as commands from './commands.ts'
import * as rest from './rest-client.ts'
import * as welcome from './welcome.ts'

import type { EngineState } from './gateway.ts'

const GATEWAY_URL = process.env.DISCORD_GATEWAY_URL ?? 'wss://gateway.discord.gg/?v=10&encoding=json'
const FLUSH_MS = Number(process.env.DISCORD_GATEWAY_FLUSH_MS ?? 30_000)

const gyujto = new Gyujto()
const allapot: EngineState = ujAllapot()

let socket: WebSocket | null = null
let szivveresTimer: NodeJS.Timeout | undefined
let elsoTimer: NodeJS.Timeout | undefined
let flushTimer: NodeJS.Timeout | undefined
let probalkozas = 0
let leallitva = false

function naplo (uzenet: string, extra: Record<string, unknown> = {}): void {
  // A TOKEN SOHA NEM KERÜL NAPLÓBA. Itt csak állapot és hibakód utazik.
  console.info(JSON.stringify({ komponens: 'discord-gateway', uzenet, ...extra }))
}

function idozitokLe (): void {
  if (szivveresTimer) { clearInterval(szivveresTimer); szivveresTimer = undefined }
  if (elsoTimer) { clearTimeout(elsoTimer); elsoTimer = undefined }
}

function kuld (payload: unknown): void {
  if (socket?.readyState === 1) socket.send(JSON.stringify(payload))
}

function szivver (): void {
  /*
   * ELMARADT NYUGTA = HALOTT KAPCSOLAT.
   *
   * A TCP nem mondja meg, hogy a másik oldal elhallgatott: a kapcsolat
   * „nyitva" marad, és a bot némán semmit nem kap. A Discord dokumentációja
   * ezért írja elő, hogy nyugta nélkül BONTSUNK és folytassunk — enélkül a
   * gateway órákig tudna egy halott csővel ülni.
   */
  if (!allapot.acked) {
    naplo('elmaradt szívverés-nyugta, újracsatlakozás')
    try { socket?.close(4000, 'zombie connection') } catch { /* már zárva */ }
    return
  }
  allapot.acked = false
  kuld({ op: OP.HEARTBEAT, d: allapot.sequence })
}

function azonosit (): void {
  kuld({
    op: OP.IDENTIFY,
    d: {
      token: botToken(),
      intents: intentsFromEnv(),
      properties: { os: process.platform, browser: 'yume', device: 'yume' },
      // NEM KÉRÜNK JELENLÉTET ÉS NEM KÜLDÜNK ÁLLAPOTOT: a bot nem
      // „játszik" semmit, és a jelenléti adatokat nem gyűjtjük.
      presence: { status: 'online', afk: false, since: null, activities: [] }
    }
  })
}

function folytat (): void {
  kuld({
    op: OP.RESUME,
    d: { token: botToken(), session_id: allapot.sessionId, seq: allapot.sequence }
  })
}

async function feldolgoz (t: string, d: unknown): Promise<void> {
  /*
   * AZ INTERAKCIÓ NEM STATISZTIKA. Előbb ezt nézzük meg, mert a parancsra
   * HÁROM MÁSODPERCEN BELÜL válaszolni kell — a számlálók ráérnek.
   */
  if (t === 'INTERACTION_CREATE') { await interakcio(d); return }

  const e = esemenyBol(t, d)
  if (!e) return
  if (e.kind === 'message') {
    gyujto.uzenet({ guildId: e.guildId, channelId: e.channelId!, bot: e.bot === true })
  } else if (e.kind === 'memberCount') {
    gyujto.tagletszam(e.guildId, e.memberCount ?? null)
  } else {
    gyujto.mozgott(e.guildId, e.kind)
    // A BELÉPÉS KÖSZÖNTŐT IS JELENTHET. A `handleJoin` maga dönti el, hogy
    // kell-e — és maga védekezik a duplikált esemény ellen.
    if (e.kind === 'join') await belepes(t, d, e.guildId)
  }
}

/**
 * EGY SLASH PARANCS.
 *
 * A VÁLASZ MINDIG ELMEGY, akkor is, ha a kezelő elhasalt: a Discord három
 * másodpercig vár, utána a felhasználónak azt írja ki, hogy a bot nem
 * válaszolt. Egy őszinte hibaüzenet ennél jobb.
 */
async function interakcio (d: unknown): Promise<void> {
  const i = commands.parseInteraction(d)
  if (!i) return

  // A PING-re PONG. A Discord ezzel ellenőrzi a kapcsolatot.
  if (i.type === commands.INTERACTION.PING) {
    await rest.respondToInteraction(i.id, i.token, { type: commands.RESPONSE.PONG })
    return
  }
  if (i.type !== commands.INTERACTION.COMMAND) return

  const eredmeny = await commands.handle(i)
  const elment = await rest.respondToInteraction(i.id, i.token, eredmeny.response)
  naplo('parancs', { parancs: i.command, kimenet: eredmeny.outcome, valasz: elment })
}

/** Egy új tag. A köszöntő részleteit a `welcome` modul dönti el. */
async function belepes (t: string, d: unknown, guildId: string): Promise<void> {
  const adat = (d ?? {}) as Record<string, unknown>
  const user = (adat.user ?? {}) as Record<string, unknown>
  if (typeof user.id !== 'string') return
  try {
    const kimenet = await welcome.handleJoin({
      guildId,
      userId: user.id,
      username: String(user.username ?? user.id)
    })
    if (kimenet !== 'skipped') naplo('köszöntő', { kimenet })
  } catch (error) {
    naplo('a köszöntő elhasalt', { hiba: String((error as Error)?.message ?? error).slice(0, 200) })
  }
}

function csatlakoz (): void {
  if (leallitva) return
  if (!konfiguralva()) {
    naplo('nincs bekapcsolva vagy nincs token — a gateway nem indul')
    return
  }

  const folytatunk = folytathato(allapot)
  const url = folytatunk ? `${allapot.resumeUrl!}/?v=10&encoding=json` : GATEWAY_URL
  naplo(folytatunk ? 'folytatás' : 'csatlakozás', { url: folytatunk ? 'resume_url' : 'gateway' })

  void allapotIr({ status: folytatunk ? 'resuming' : 'connecting', intents: intentsFromEnv() })

  socket = new WebSocket(url)

  socket.addEventListener('open', () => {
    probalkozas = 0
  })

  socket.addEventListener('message', event => {
    let uzenet: { op: number, d?: unknown, s?: number | null, t?: string | null }
    try {
      uzenet = JSON.parse(String(event.data))
    } catch {
      return
    }

    // A SORSZÁM MINDEN DISPATCH-nél frissül — ebből tudja a folytatás, hol
    // tartottunk. Egy kihagyott sorszámtól a Discord újraküldené az egészet.
    if (typeof uzenet.s === 'number') allapot.sequence = uzenet.s

    switch (uzenet.op) {
      case OP.HELLO: {
        const d = (uzenet.d ?? {}) as { heartbeat_interval?: number }
        allapot.heartbeatMs = Number(d.heartbeat_interval ?? 41_250)
        allapot.acked = true
        idozitokLe()
        // Az ELSŐ szívverés véletlen késleltetéssel — lásd `elsoSzivveres`.
        elsoTimer = setTimeout(() => {
          szivver()
          szivveresTimer = setInterval(szivver, allapot.heartbeatMs)
        }, elsoSzivveres(allapot.heartbeatMs))
        if (folytathato(allapot)) folytat()
        else azonosit()
        break
      }

      case OP.HEARTBEAT:
        // A Discord is KÉRHET szívverést soron kívül. Azonnal válaszolunk.
        kuld({ op: OP.HEARTBEAT, d: allapot.sequence })
        break

      case OP.HEARTBEAT_ACK:
        allapot.acked = true
        break

      case OP.RECONNECT:
        naplo('a Discord újracsatlakozást kért')
        try { socket?.close(4000, 'reconnect requested') } catch { /* már zárva */ }
        break

      case OP.INVALID_SESSION: {
        /*
         * A `d` MEZŐ MONDJA MEG, FOLYTATHATÓ-E. Ha nem, a munkamenetet EL
         * KELL DOBNI — enélkül a következő folytatás ugyanígy elbukna, és a
         * hurok soha nem érne véget.
         */
        const folytathatoE = uzenet.d === true
        naplo('érvénytelen munkamenet', { folytathato: folytathatoE })
        if (!folytathatoE) {
          allapot.sessionId = null
          allapot.resumeUrl = null
          allapot.sequence = null
        }
        try { socket?.close(4000, 'invalid session') } catch { /* már zárva */ }
        break
      }

      case OP.DISPATCH: {
        const t = uzenet.t ?? ''
        if (t === 'READY') {
          const d = (uzenet.d ?? {}) as { session_id?: string, resume_gateway_url?: string }
          allapot.sessionId = d.session_id ?? null
          allapot.resumeUrl = d.resume_gateway_url ?? null
          naplo('kész')
          void allapotIr({
            status: 'ready', ready: true, event: true,
            sessionId: allapot.sessionId, resumeUrl: allapot.resumeUrl,
            sequence: allapot.sequence, lastError: null
          })
        } else if (t === 'RESUMED') {
          naplo('folytatva')
          void allapotIr({ status: 'ready', ready: true, event: true, lastError: null })
        } else {
          void feldolgoz(t, uzenet.d)
          void allapotIr({ event: true, sequence: allapot.sequence })
        }
        break
      }
    }
  })

  socket.addEventListener('close', event => {
    idozitokLe()
    socket = null
    const kod = Number(event.code ?? 0)

    if (vegzetes(kod)) {
      /*
       * BEÁLLÍTÁSI HIBA — ÚJRAPRÓBÁLÁS NÉLKÜL. Egy rossz token vagy egy nem
       * engedélyezett privilegizált intent újracsatlakozással sosem javul
       * meg; a végtelen próbálkozás csak forgalmat gyárt, és elfedi az
       * igazi okot.
       */
      naplo('végzetes lezárás, nem próbálkozunk újra', { kod })
      void allapotIr({ status: 'failed', lastError: kodMagyarazat(kod) })
      return
    }

    probalkozas++
    const varas = ujraVaras(probalkozas) + Math.floor(Math.random() * 1000)
    naplo('kapcsolat bontva, újracsatlakozás', { kod, varas })
    void allapotIr({ status: 'disconnected', reconnect: true, lastError: kodMagyarazat(kod) })
    setTimeout(csatlakoz, varas)
  })

  socket.addEventListener('error', () => {
    // A `close` úgyis jön utána; itt csak annyi dolgunk van, hogy a hiba ne
    // döntse el a folyamatot.
    naplo('kapcsolati hiba')
  })
}

async function kiir (): Promise<void> {
  try {
    const n = await gyujto.kiir()
    if (n > 0) naplo('mérések kiírva', { sorok: n })
  } catch (error) {
    naplo('a mérések kiírása nem sikerült', { hiba: String((error as Error)?.message ?? error).slice(0, 200) })
  }
}

async function leall (): Promise<void> {
  leallitva = true
  idozitokLe()
  if (flushTimer) clearInterval(flushTimer)
  // AMI A PUFFERBEN VAN, AZ MÉG KIMEGY. Egy szabályos leállásnál nincs okunk
  // eldobni percnyi mérést.
  await kiir()
  try { socket?.close(1000, 'shutdown') } catch { /* már zárva */ }
  await allapotIr({ status: 'disconnected' })
  process.exit(0)
}

process.on('SIGTERM', () => { void leall() })
process.on('SIGINT', () => { void leall() })

flushTimer = setInterval(() => { void kiir() }, FLUSH_MS)
csatlakoz()
