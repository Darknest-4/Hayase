// A döntés — a pontozástól KÜLÖNVÁLASZTVA.
//
// A `risk.ts` megmondja, mennyire gyanús egy kérés. Ez a fájl megmondja, mit
// kezdjünk vele. A kettő külön van, mert külön is változik: a súlyokat az
// hangolja, aki a forgalmat nézi, a küszöböket az, aki a kockázatot vállalja —
// és egy száraz üzemmód, ami a pontozás közepén ül egy `if`-ben, előbb-utóbb
// mást fog számolni élesben, mint szárazon.
//
// A DÖNTÉS SORRENDJE (ami előbb van, az erősebb):
//   1. tiltás — ha él tiltás, nincs mérlegelés;
//   2. száraz üzem — ilyenkor mindent kiértékelünk, de semmit nem hajtunk végre;
//   3. pontszám a küszöbökhöz.

import type { Action, EdgeConfig } from './config.ts'
import type { Assessment } from './risk.ts'
import type { Ban } from './bans.ts'
import type { Hit } from './waf.ts'

export interface Decision {
  action: Action
  /** Amit tényleg végrehajtunk. Száraz üzemben ez mindig `allow`. */
  effective: Action
  score: number
  /** Egy mondat, ami megmagyarázza. Ez megy a naplóba. */
  reason: string
  /** A tiltás, ha az döntött. */
  ban?: Ban | undefined
  /** Mennyi idő múlva próbálkozhat újra, ha visszautasítottuk. */
  retryAfter?: number | undefined
}

/**
 * Mit kezdjünk ezzel a kéréssel.
 *
 * A `dryRun` nem itt dönti el, hogy mi a helyes válasz — azt ugyanúgy
 * kiszámoljuk. Csak azt mondja meg, hogy végrehajtjuk-e. Így a száraz üzem
 * naplója pontosan azt mutatja, mi történt VOLNA.
 */
export function decide (
  assessment: Assessment,
  config: EdgeConfig,
  ban: Ban | null = null,
  waf: Hit[] = []
): Decision {
  if (ban) {
    const until = ban.expiresAt ? ` (${ban.expiresAt.toISOString()}-ig)` : ' (végleges)'
    return {
      action: 'block',
      // A tiltás száraz üzemben IS hat. Aki kézzel tiltott ki valakit, annak
      // a döntése nem próba — a száraz üzem az automatikáról szól.
      effective: 'block',
      score: assessment.score,
      reason: `tiltás: ${ban.reason}${until}`,
      ban,
      retryAfter: ban.expiresAt
        ? Math.max(1, Math.ceil((ban.expiresAt.getTime() - Date.now()) / 1000))
        : undefined
    }
  }

  const { score } = assessment
  const t = config.thresholds

  let action: Action = 'allow'
  if (score >= t.block) action = 'block'
  else if (score >= t.throttle) action = 'throttle'
  else if (score >= t.challenge) action = 'challenge'
  else if (score >= t.monitor) action = 'monitor'

  /*
   * A SÚLYOSSÁG önmagában is dönthet.
   *
   * Az összeadott pontszám a kétes jelekre való: egy adatközponti cím, egy
   * gyors ütem, egy hiányzó fejléc — külön-külön egyik sem jelent semmit,
   * együtt igen. Van viszont néhány minta, ami egyedül is egyértelmű: egy
   * `UNION SELECT` egy műfajszűrőben, egy `/etc/passwd` kérés, egy
   * parancsbehelyettesítés. Ezekre nincs ártatlan magyarázat.
   *
   * Enélkül egy kritikus találat 60 pontot adott, a tiltás küszöbe 90 volt,
   * és a kérés átment — a súlyosság mint fogalom nem jelentett semmit. Ezt a
   * teszt fogta meg.
   *
   * Kikapcsolható (`criticalBlocks: false`), mert egy szigorúbb szabálykészlet
   * mellett egy üzemeltető dönthet úgy, hogy mindent a pontszámra bíz.
   */
  if (config.criticalBlocks && waf.some(hit => hit.severity === 'critical')) {
    action = 'block'
  }

  // A `monitor` amúgy sem utasít vissza: naplózásra való. Így száraz üzemben
  // a különbség csak a `challenge` fölött látszik.
  const effective = config.dryRun ? 'allow' : action

  return {
    action,
    effective,
    score,
    reason: explain(action, assessment, config.dryRun, waf)
  }
}

function explain (action: Action, assessment: Assessment, dryRun: boolean, waf: Hit[] = []): string {
  if (action === 'allow') return 'a pontszám a megfigyelési küszöb alatt'

  const critical = waf.find(hit => hit.severity === 'critical')
  if (critical) {
    return `visszautasítás: ${critical.title} (${critical.rule})` +
      `${dryRun ? ' [száraz üzem: nem hajtjuk végre]' : ''}`
  }

  // A három legnagyobb jel, mert egy „87 pont" nem válasz arra, hogy miért.
  const top = [...assessment.signals]
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map(signal => `${signal.why} (+${signal.points})`)
    .join('; ')

  const verdict = {
    monitor: 'megfigyelés alatt',
    challenge: 'ellenőrzés kérése',
    throttle: 'lassítás',
    block: 'visszautasítás'
  }[action] ?? action

  return `${verdict} ${assessment.score} ponton — ${top}${dryRun ? ' [száraz üzem: nem hajtjuk végre]' : ''}`
}

/**
 * Elbukhat-e ez a kérés az él hibájából?
 *
 * Fail-open alapból: egy biztonsági réteg hibája ne legyen kiesés. Egy
 * elhasalt IP-lekérdezés miatt senki ne veszítse el a katalógust.
 *
 * Fail-closed a hitelesítésen és az adminon: ott az a rosszabb kimenetel,
 * ha egy bizonytalan ellenőrzés átengedi a kérést. A listát a beállítás adja,
 * tehát egy üzemeltető szűkítheti vagy bővítheti — de az alapértelmezés az,
 * ami a legtöbb telepítésen helyes.
 */
export function onFailure (url: string, config: EdgeConfig): Decision {
  const closed = config.failClosed.some(prefix => url.startsWith(prefix))
  return {
    action: closed ? 'block' : 'allow',
    effective: closed ? 'block' : 'allow',
    score: 0,
    reason: closed
      ? 'az él ellenőrzése nem futott le, és ez az útvonal hiba esetén visszautasít'
      : 'az él ellenőrzése nem futott le; a kérés átengedve',
    retryAfter: closed ? 5 : undefined
  }
}
