// Az összesítő feladat.
//
// Külön sor a feladatsorban, nem a `stats` mellé tömve: a nézési statisztika
// egy profilra fut és másodpercek, ez a teljes napra és percek lehet. Egy
// lassú összesítés nem tarthatja fel azt a frissítést, amit a felhasználó
// vár.

import { pruneAnalytics, rollupAll } from './rollup.ts'

import type { Job } from '../../infrastructure/queue/index.ts'

export async function handleAnalyticsJob (job: Job): Promise<void> {
  // A megőrzés külön kérés: naponta egyszer kell, nem óránként.
  if (job.payload.prune === true) {
    const removed = await pruneAnalytics()
    console.log('analytics retention:', JSON.stringify(removed))
    return
  }

  // Egy megadott nap újraszámolása — a napi véglegesítéshez és kézi
  // javításhoz. Az összesítők idempotensek, tehát ezt bármikor újra lehet
  // futtatni.
  const day = typeof job.payload.day === 'string' ? job.payload.day : undefined
  await rollupAll(day)
}
