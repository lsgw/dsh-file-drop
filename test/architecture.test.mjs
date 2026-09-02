import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (...parts) => readFile(join(root, 'src', ...parts), 'utf8')

test('client source keeps the view-runtime-strategy-api dependency direction', async () => {
  const [index, view, runtime, api, upload, locate, contract] = await Promise.all([
    source('client', 'index.js'),
    source('client', 'view.js'),
    source('client', 'runtime.js'),
    source('client', 'api.js'),
    source('client', 'upload-strategy.js'),
    source('client', 'locate-strategy.js'),
    source('shared', 'contract.js'),
  ])

  assert.match(index, /from '\.\/runtime\.js'/)
  assert.match(index, /from '\.\/view\.js'/)
  assert.doesNotMatch(index, /processFilesUpload|fileSampleFingerprint|uploadChunked/)
  assert.match(view, /from '\.\/runtime\.js'/)
  assert.doesNotMatch(view, /from '\.\/(?:api|upload-strategy|locate-strategy)\.js'/)
  assert.match(runtime, /from '\.\/upload-strategy\.js'/)
  assert.match(runtime, /from '\.\/locate-strategy\.js'/)
  assert.doesNotMatch(upload, /locateRequest|fileSampleFingerprint|FILE_DROP_ROUTE/)
  assert.doesNotMatch(locate, /uploadChunked|UPLOAD_PATH|FormData/)
  assert.doesNotMatch(contract, /node:|window|document|React/)
})

test('client source modules stay bounded and generated bundle stays singular', async () => {
  const limits = new Map([
    ['index.js', 90],
    ['runtime.js', 90],
    ['api.js', 310],
    ['upload-strategy.js', 130],
    ['locate-strategy.js', 500],
    ['view.js', 850],
  ])
  for (const [name, limit] of limits) {
    const text = await source('client', name)
    assert.ok(text.split(/\r?\n/).length <= limit, name + ' exceeded ' + limit + ' lines')
  }
  const bundle = await readFile(join(root, 'client.js'), 'utf8')
  assert.match(bundle, /__ModuleLoader__/)
  assert.doesNotMatch(bundle, /^import\s/m)
})


test('Host keeps a thin public entry, HTTP shell, and split safety layers', async () => {
  const [entry, host, http, safety, manifest, storage, settings, upload, protocol] = await Promise.all([
    readFile(join(root, 'index.js'), 'utf8'),
    source('host', 'index.js'),
    source('host', 'http.js'),
    source('host', 'safety.js'),
    source('host', 'manifest.js'),
    source('host', 'storage.js'),
    source('host', 'settings.js'),
    source('host', 'upload-manager.js'),
    source('locate', 'protocol.js'),
  ])

  assert.match(entry, /^export \{ .* \} from '\.\/src\/host\/index\.js'\s*$/)
  assert.match(host, /from '\.\/http\.js'/)
  assert.doesNotMatch(host, /function (?:sendJson|sendError|requireJson|requireBinary|sameOriginRequest)/)
  assert.match(safety, /export \* from '\.\/manifest\.js'/)
  assert.match(safety, /export \* from '\.\/storage\.js'/)
  assert.match(settings, /from '\.\.\/shared\/contract\.js'/)
  assert.match(upload, /from '\.\.\/shared\/contract\.js'/)
  assert.match(protocol, /from '\.\.\/shared\/contract\.js'/)

  for (const [name, text, limit] of [
    ['host/index.js', host, 220], ['host/http.js', http, 70],
    ['host/safety.js', safety, 8], ['host/manifest.js', manifest, 260],
    ['host/storage.js', storage, 600], ['host/upload-manager.js', upload, 410],
  ]) assert.ok(text.split(/\r?\n/).length <= limit, name + ' exceeded ' + limit + ' lines')
})

test('npm package contains only runtime, source, metadata, and documentation', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.files, [
    'index.js', 'client.js', 'src/shared', 'src/host', 'src/locate', 'src/platform',
    'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE',
  ])
  assert.equal(pkg.scripts.build, 'node scripts/build-client.mjs')
  assert.equal(pkg.scripts.pretest, 'npm run build')
  assert.equal(pkg.scripts['verify:tarball'], 'node scripts/verify-tarball.mjs')
  assert.equal(pkg.scripts.prepack, 'npm test')
})
