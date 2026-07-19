import { buildApp } from './app.ts'
import { config } from './config.ts'
import { pool } from './db.ts'

const app = await buildApp()

await app.listen({ port: config.port, host: config.host })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end()).then(() => process.exit(0))
  })
}
