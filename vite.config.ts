import { resolve } from 'node:path'

import { sveltekit } from '@sveltejs/kit/vite'
import license from 'rollup-plugin-license'
import { defineConfig, type Plugin } from 'vite'
import devtoolsJson from 'vite-plugin-devtools-json'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const viteServerConfig = () => ({
  name: 'add-headers',
  configureServer: (server) => {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      next()
    })
  }
}) as Plugin

export default defineConfig({
  plugins: [
    sveltekit(),
    viteServerConfig(),
    license({
      thirdParty: {
        allow: '(MIT OR Apache-2.0 OR ISC OR BSD-3-Clause OR BSD-2-Clause OR MPL-2.0 OR LGPL-2.1 OR LGPL-2.1+)',
        // written early in generateBundle, sveltekit adapter recreates build/ after, so copy in closeBundle
        output: resolve(import.meta.dirname, 'node_modules/.cache/license-deps.txt'),
        includeSelf: true
      }
    }),
    viteStaticCopy({
      targets: [
        { // VITE IS DOG AND DOESNT SUPPORT DYNAMIC JSON IMPORTS
          src: 'node_modules/doc999tor-fast-geoip/data/*.json',
          dest: 'geoip/',
          rename: { stripBase: true }
        }
      ]
    }),
    devtoolsJson()
  ],
  resolve: {
    alias: {
      path: 'path-esm',
      'node-fetch': '',
      // no exports :/
      'bittorrent-tracker/lib/client/websocket-tracker.js': resolve(import.meta.dirname, 'node_modules/bittorrent-tracker/lib/client/websocket-tracker.js'),
      debug: resolve(import.meta.dirname, 'src/patches/debug.ts')
    }
  },
  server: { port: 7344 },
  build: {
    target: 'esnext',
    sourcemap: true,
    assetsInlineLimit: 0
  },
  ssr: {
    target: 'webworker'
  },
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    exclude: ['anitomyscript']
  }
})
