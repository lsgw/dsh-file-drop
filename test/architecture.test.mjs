import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = (...parts) => readFile(join(root, 'src', ...parts), 'utf8')

test('client source keeps the view-runtime-strategy-api dependency direction', async () => {
  const [index, view, searchRootView, runtime, api, upload, locate, contract] = await Promise.all([
    source('client', 'index.js'),
    source('client', 'view.js'),
    source('client', 'search-root-view.js'),
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
  assert.match(searchRootView, /requestRef/)
  assert.doesNotMatch(searchRootView, /setRoots\(result\.roots\)/)
  assert.match(runtime, /from '\.\/upload-strategy\.js'/)
  assert.match(runtime, /from '\.\/locate-strategy\.js'/)
  assert.match(runtime, /from '\.\/search-roots\.js'/)
  assert.doesNotMatch(upload, /locateRequest|fileSampleFingerprint|FILE_DROP_ROUTE/)
  assert.doesNotMatch(locate, /uploadChunked|UPLOAD_PATH|FormData/)
  assert.doesNotMatch(contract, /node:|window|document|React/)
})

test('client source modules stay bounded and generated bundle stays singular', async () => {
  const limits = new Map([
    ['index.js', 90],
    ['runtime.js', 90],
    ['api.js', 310],
    ['chunk-request.js', 45],
    ['drop-data.js', 180],
    ['search-roots.js', 130],
    ['search-root-view.js', 140],
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


test('client core uses standard file and directory capabilities only', async () => {
  const [dropData, view, runtime, controller, searchRoots] = await Promise.all([
    source('client', 'drop-data.js'),
    source('client', 'view.js'),
    source('client', 'runtime.js'),
    source('client', 'drop-controller.js'),
    source('client', 'search-roots.js'),
  ])
  for (const [name, text] of [['drop-data.js', dropData], ['view.js', view], ['runtime.js', runtime], ['drop-controller.js', controller], ['search-roots.js', searchRoots]]) {
    assert.doesNotMatch(text, /dshDesktop|fileUriToPath|extractPaths|drainShellPaths|shellPathOf|webkitGetAsEntry|insert-paths/, name)
  }
  assert.match(dropData, /getAsFileSystemHandle/)
  assert.match(searchRoots, /BroadcastChannel/)
})

test('client build uses a standards-based browser target', async () => {
  const build = await readFile(join(root, 'scripts', 'build-client.mjs'), 'utf8')
  assert.match(build, /platform: 'browser'/)
  assert.match(build, /target: \['es2022'\]/)
  assert.doesNotMatch(build, /chrome\d+/i)
})

test('locate core uses generic Node filesystem scanning without platform adapters', async () => {
  const files = [
    'locate/locator.js', 'locate/directory-node.js', 'locate/isolate.js',
    'locate/isolate-runner.js', 'locate/secure-locator.js',
    'host/index.js', 'host/manifest.js', 'host/storage.js',
  ]
  for (const name of files) {
    const text = await source(...name.split('/'))
    assert.doesNotMatch(text, /platform/, name)
    assert.doesNotMatch(text, /indexedSearch|broadSearchRoots|PowerShell|powershell\.exe|plocate|mdfind|Everything|SystemRoot|WINDIR/, name)
  }
  const pathKey = await source('shared', 'node-path.js')
  const storage = await source('host', 'storage.js')
  assert.match(pathKey, /from 'node:path'/)
  assert.match(pathKey, /realpathSync/)
  assert.match(pathKey, /statSync/)
  assert.match(pathKey, /physicalPathKey/)
  assert.match(pathKey, /collisionKey/)
  assert.match(pathKey, /sameDirectoryEntry/)
  assert.doesNotMatch(pathKey, /process\.platform/)
  assert.doesNotMatch(storage, /realpathSync\.native/)
})

test('Host keeps a thin public entry, HTTP shell, and split safety layers', async () => {
  const [entry, host, http, localRequest, safety, manifest, storage, gate, searchInspect, settings, upload, protocol] = await Promise.all([
    readFile(join(root, 'index.js'), 'utf8'),
    source('host', 'index.js'),
    source('host', 'http.js'),
    source('host', 'local-request.js'),
    source('host', 'safety.js'),
    source('host', 'manifest.js'),
    source('host', 'storage.js'),
    source('host', 'gate.js'),
    source('host', 'search-root-inspect.js'),
    source('host', 'settings.js'),
    source('host', 'upload-manager.js'),
    source('locate', 'protocol.js'),
  ])

  assert.match(entry, /^export \{ .* \} from '\.\/src\/host\/index\.js'\s*$/)
  assert.match(host, /from '\.\/http\.js'/)
  assert.match(http, /from '\.\/local-request\.js'/)
  assert.match(localRequest, /remoteAddress/)
  assert.doesNotMatch(host, /function (?:sendJson|sendError|requireJson|requireBinary|sameOriginRequest)/)
  assert.match(safety, /export \* from '\.\/manifest\.js'/)
  assert.match(safety, /export \* from '\.\/storage\.js'/)
  assert.match(settings, /from '\.\.\/shared\/contract\.js'/)
  assert.match(upload, /from '\.\.\/shared\/contract\.js'/)
  assert.match(protocol, /from '\.\.\/shared\/contract\.js'/)

  for (const [name, text, limit] of [
    ['host/index.js', host, 220], ['host/http.js', http, 70],
    ['host/local-request.js', localRequest, 50],
    ['host/safety.js', safety, 8], ['host/manifest.js', manifest, 260],
    ['host/storage.js', storage, 600], ['host/gate.js', gate, 50],
    ['host/search-root-inspect.js', searchInspect, 150], ['host/upload-manager.js', upload, 410],
  ]) assert.ok(text.split(/\r?\n/).length <= limit, name + ' exceeded ' + limit + ' lines')
})

test('external search roots stay host-validated and platform-neutral', async () => {
  const [store, inspect] = await Promise.all([
    source('host', 'search-roots.js'), source('host', 'search-root-inspect.js'),
  ])
  assert.match(inspect, /realpath/)
  assert.match(inspect, /lstat/)
  assert.match(inspect, /MAX_ACTIVE_INSPECTIONS/)
  assert.match(store, /registerSearchRootRoute/)
  assert.doesNotMatch(store + inspect, /process\.platform|powershell|Everything|mdfind|plocate/)
  assert.ok(store.split(/\r?\n/).length <= 300, 'host/search-roots.js exceeded 300 lines')
})

test('npm package contains only runtime, source, metadata, and documentation', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.files, [
    'index.js', 'client.js', 'src/shared', 'src/host', 'src/locate',
    'cordis.patch.yml', 'dsh.plugin.json', 'README.md', 'LICENSE',
  ])
  assert.equal(pkg.scripts.build, 'node scripts/build-client.mjs')
  assert.equal(pkg.scripts.pretest, 'npm run build')
  assert.equal(pkg.scripts['verify:tarball'], 'node scripts/verify-tarball.mjs')
  assert.equal(pkg.scripts.prepack, 'npm test')
})
