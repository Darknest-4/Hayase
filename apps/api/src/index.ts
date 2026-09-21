import { buildApp } from './app.ts'
import { config } from './config.ts'
import { pool } from './infrastructure/database/index.ts'
import { warmUpAnikoto } from './modules/providers/adapters/anikoto.ts'

const app = await buildApp()

await app.listen({ port: config.port, host: config.host })

/*
 * A SZOLGÁLTATÓK ELŐMELEGÍTÉSE — a `listen` UTÁN, a háttérben.
 *
 * Az Anikoto katalógusának nincs kereső végpontja, ezért az adapter indexet
 * épít belőle (180 lap). Ha ez az első néző kérésére történne, ő üres
 * eredményt kapna, mert a feloldásnak nincs annyi ideje — a következő
 * kérés pedig már működne. Ez a sor teszi, hogy ne legyen ilyen „első
 * néző".
 *
 * A `listen` UTÁN, mert az egészségellenőrzés nem várhat egy idegen
 * kiszolgálóra; és `void`-dal, mert az indulás nem bukhat el rajta.
 */
warmUpAnikoto()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end()).then(() => process.exit(0))
  })
}
