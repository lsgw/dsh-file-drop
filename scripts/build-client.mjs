import { build } from 'esbuild'

await build({
  bundle: true,
  entryPoints: ['src/client/index.js'],
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
  minify: true,
  outfile: 'client.js',
  platform: 'browser',
  sourcemap: false,
  target: ['chrome120'],
})
