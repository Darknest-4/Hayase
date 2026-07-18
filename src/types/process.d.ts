declare module 'process' {
  export const env: Record<string, string | undefined>
  export const cwd: () => string
  export const exit: (code?: number) => never
  export const argv: string[]
}

declare module 'node:process' {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import path = require('process')
  export = path
}
