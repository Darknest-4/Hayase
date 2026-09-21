// Worker entrypoint: node --run worker  (or --once to drain and exit).
// Schedules its own recurring jobs (maintenance hourly, trending hourly,
// daily rollup) by enqueueing with dedupe keys.

import { pool } from '../infrastructure/database/index.ts'
import { recordError } from '../errors/reporting.ts'
import { drain, enqueue, runWorker } from '../infrastructure/queue/index.ts'
import { handleWebhookJob } from '../modules/webhooks/delivery.ts'
import { announceDeadJobs } from '../modules/webhooks/subscriptions.ts'
import { handleAnalyticsJob } from '../modules/analytics/worker.ts'
import { handleDiscordJob } from '../modules/discord/worker.ts'
import { handleEdgeJob } from '../modules/edge/worker.ts'
import { handleFounderJob } from '../modules/library/founder.ts'
import { handleImportJob } from '../integrations/anilist/importer.ts'
import { handleMaintenanceJob } from '../infrastructure/maintenance.ts'
import { handleMediaJob } from '../modules/media/mirror.ts'
import { handleMetadataJob } from '../modules/metadata/worker.ts'
import { handleMonitorJob } from '../modules/system/monitor-worker.ts'
import { handleNotifyJob } from '../modules/notifications/worker.ts'
import { handleStatsJob } from '../modules/system/stats-worker.ts'

// Who hears about a job that ran out of retries. The queue reports; this
// decides what that means. See modules/webhooks/subscriptions.ts.
announceDeadJobs()

const handlers = {
  stats: handleStatsJob,
  notify: handleNotifyJob,
  maintenance: handleMaintenanceJob,
  metadata: handleMetadataJob,
  monitor: handleMonitorJob,
  import: handleImportJob,
  webhook: handleWebhookJob,
  // Fills the first account's library with the whole catalogue. Enqueued once,
  // when the bootstrap promotes that account; see modules/library/founder.ts.
  founder: handleFounderJob,
  // Napi összesítők a látogatottsághoz. Külön sor, mert a teljes napra fut és
  // percek lehet — a `stats` egy profilra fut és másodpercek.
  analytics: handleAnalyticsJob,
  // Az él háttérmunkája: IP-adatok frissítése, viselkedéselemzés, összesítés,
  // takarítás. Külön sor, mert a DNS-feloldás lassú, és nem tarthatja fel a
  // többi feladatot.
  edge: handleEdgeJob,
  // A katalógusképek tükrözése saját tárhelyre. Külön sor, mert kötegenként
  // több száz idegen CDN-kérés, és nem tarthatja fel sem a webhookokat, sem a
  // mérőszámokat. Magát ütemezi újra, amíg van hátra — lásd `handleMediaJob`.
  media: handleMediaJob,
  /*
   * A tartós Discord-üzenetek frissítése. Külön sor, mert IDEGEN
   * KISZOLGÁLÓRA megy: egy lassú vagy korlátozó Discord nem tarthatja fel a
   * saját összesítőinket, és egy elakadt üzenet nem foghatja meg a
   * webhookokat.
   */
  discord: handleDiscordJob
} as const

async function scheduleRecurring (): Promise<void> {
  await enqueue('maintenance', { dedupe: 'maintenance' })
  await enqueue('stats', { trending: true, dedupe: 'trending' })
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  await enqueue('stats', { rollupDay: yesterday, dedupe: `rollup:${yesterday}` })
  await enqueue('stats', { dailyDigest: true, dedupe: `digest:${yesterday}` })

  // A látogatottság mai összesítője óránként frissül, hogy a panel ne legyen
  // egy napot késésben; a tegnapi egyszer, véglegesítve. Mindkettő
  // idempotens, tehát egy kétszer lefutott óra nem duplázza a számokat.
  const today = new Date().toISOString().slice(0, 10)
  await enqueue('analytics', { day: today, dedupe: `analytics:${today}` })
  await enqueue('analytics', { day: yesterday, dedupe: `analytics:${yesterday}` })
  await enqueue('analytics', { prune: true, dedupe: `analytics-prune:${today}` })

  // Az él: az összesítő és a viselkedéselemzés óránként, a takarítás naponta.
  // Az IP-frissítés a saját ütemezőjén megy, sűrűbben — lásd lent.
  await enqueue('edge', { day: today, dedupe: `edge:${today}` })
  await enqueue('edge', { behaviour: true, dedupe: 'edge-behaviour' })
  await enqueue('edge', { prune: true, dedupe: `edge-prune:${today}` })

  // A tartós üzenetek előzményének nyesése naponta. A FRISSÍTÉS nem itt van:
  // az sűrűbb ütemet kíván, és saját időzítőn megy — lásd `scheduleDiscord`.
  await enqueue('discord', { prune: true, dedupe: `discord-prune:${today}` })
}

/**
 * A tartós üzenetek frissítése sűrűbb ütemet kíván, mint az óránkénti
 * feladatok — de nem annyit, mint a rendszermetrika. A tényleges fékezés
 * amúgy sem itt van: a rekordonkénti minimális időköz és az
 * ujjlenyomat-egyezés dönti el, hogy tényleg kimegy-e kérés.
 *
 * A dedupe-kulcs miatt egy lassú kör sosem torlódhat fel.
 */
const DISCORD_INTERVAL_MS = Number(process.env.DISCORD_SYNC_INTERVAL_MS ?? 60_000)

async function scheduleDiscord (): Promise<void> {
  await enqueue('discord', { dedupe: 'discord-sync' })
}

/**
 * VPS metrics need a much tighter cadence than the hourly jobs, so they get
 * their own timer. The dedupe key means a slow cycle can never pile up.
 */
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS ?? 60_000)

async function scheduleMonitor (): Promise<void> {
  await enqueue('monitor', { dedupe: 'monitor' })
}

/*
 * Az IP-adatok frissítése.
 *
 * Sűrűbben, mint az óránkénti kör, mert egy új cím addig „ismeretlen", amíg
 * meg nem néztük — és az ismeretlen cím nem kap se pozitív, se negatív pontot.
 * Kis kötegekben megy: minden cím egy fordított névfeloldás.
 */
const INTEL_INTERVAL_MS = Number(process.env.EDGE_INTEL_INTERVAL_MS ?? 5 * 60_000)

async function scheduleIntel (): Promise<void> {
  await enqueue('edge', { intel: true, dedupe: 'edge-intel' })
}

const once = process.argv.includes('--once')

/**
 * Egy ütemezőhívás, ami nem viheti magával a workert.
 *
 * MÉRVE, EGY ADATBÁZIS-ÚJRAINDÍTÁSKOR: a worker kétszer omlott össze, mert az
 * `enqueue` `57P03`-mal (`the database system is starting up`) elhasalt, és a
 * hívás körül nem volt elkapás. A folyamat kilépett, a Docker újraindította, a
 * Postgres még mindig indult, és ez ismétlődött.
 *
 * Az időzített hívásoknál ugyanez a `void scheduleRecurring()` alakban rejtőzött:
 * egy elutasított ígéret `void`-dal is elutasított ígéret marad, és a Node 22
 * kezeletlen elutasításra kilép.
 *
 * Egy ütemezés kimaradása nem vészhelyzet: a következő órában újra próbálja, a
 * `dedupe` kulcsok miatt kétszer beütemezni sem tud semmit. A folyamat halála
 * viszont az — ezért ez a burkoló naplóz, és hagyja futni a workert.
 */
async function attempt (name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (error) {
    console.error(`${name} nem futott le: ${(error as Error).message}`)
    return false
  }
}

/**
 * Indulás: megvárja, hogy az adatbázis fogadjon.
 *
 * A `depends_on: service_healthy` csak az EGYÜTTES indulásra vonatkozik. Ha a
 * Postgrest külön indítják újra — például egy hangolás miatt —, a worker
 * futva marad, elveszíti a kapcsolatait, és az ütemezése egy még induló
 * kiszolgálóba fut. Ilyenkor várni kell, nem meghalni.
 */
async function waitForDatabase (attempts = 30, delayMs = 2_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      if (i === attempts) throw error
      console.log(`az adatbázis még nem fogad (${i}/${attempts}): ${(error as Error).message}`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

if (once) {
  await scheduleRecurring()
  await scheduleMonitor()
  await scheduleIntel()
  await scheduleDiscord()
  const executed = await drain(handlers)
  console.log(`drained ${executed} jobs`)
  await pool.end()
} else {
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => controller.abort())
  }

  // Az adatbázisnak nem kell futnia ahhoz, hogy a worker ELINDULJON — de
  // ahhoz igen, hogy ütemezzen. A várakozás olcsóbb, mint egy összeomlási hurok.
  await waitForDatabase()

  await attempt('az ismétlődő feladatok ütemezése', scheduleRecurring)
  setInterval(() => { void attempt('az ismétlődő feladatok ütemezése', scheduleRecurring) }, 60 * 60 * 1000).unref()

  await attempt('a mérőszámok ütemezése', scheduleMonitor)
  setInterval(() => { void attempt('a mérőszámok ütemezése', scheduleMonitor) }, MONITOR_INTERVAL_MS).unref()

  await attempt('az IP-adatok ütemezése', scheduleIntel)
  setInterval(() => { void attempt('az IP-adatok ütemezése', scheduleIntel) }, INTEL_INTERVAL_MS).unref()

  await attempt('a tartós üzenetek ütemezése', scheduleDiscord)
  setInterval(() => { void attempt('a tartós üzenetek ütemezése', scheduleDiscord) }, DISCORD_INTERVAL_MS).unref()

  console.log('worker running:', Object.keys(handlers).join(', '))
  await runWorker(handlers, {
    signal: controller.signal,
    onError: (job, error) => {
      console.error(`job ${job.queue}#${job.id} failed:`, error.message)
      void recordError('worker', error, { queue: job.queue, jobId: job.id })
    }
  })
  await pool.end()
}
