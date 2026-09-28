import { buildApp } from './app.ts'
import { config } from './config.ts'
import { pool } from './infrastructure/database/index.ts'
import { guardUnhandledRejections } from './infrastructure/process/crash-guard.ts'

const app = await buildApp()
guardUnhandledRejections('api', (message, error) => { app.log.error({ err: error }, message) })

await app.listen({ port: config.port, host: config.host })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close()
      .then(() => pool.end())
      .catch(error => { app.log.error({ err: error }, 'shutdown did not complete cleanly') })
      .finally(() => process.exit(0))
  })
}
