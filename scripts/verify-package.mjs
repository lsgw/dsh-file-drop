import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(process.argv[2] || '.')
const moduleUrl = (relative) => pathToFileURL(join(root, relative)).href
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(root, 'dsh.plugin.json'), 'utf8'))
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
assert.equal(pkg.name, 'dsh-file-drop')
assert.equal(pkg.main, './index.js')
assert.deepEqual(pkg.exports, {
  '.': './index.js', './client': './client.js', './package.json': './package.json',
})
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web')
assert.deepEqual(pkg.dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
assert.equal(plugin.name, pkg.name)
assert.equal(plugin.version, pkg.version)
assert.deepEqual(plugin.entry, { name: 'dsh-file-drop', inject: ['webServer', 'sessions'] })
assert.deepEqual(plugin.client, { platform: 'web' })
assert.match(patch, /^# dsh-file-drop[:：]/)
assert.match(patch, /id: dsh-file-drop/)
assert.match(patch, /name: dsh-file-drop/)
assert.match(patch, /inject: \[webServer, sessions\]/)

for (const relative of [
  'index.js', 'client.js', 'src/shared/contract.js', 'src/host/index.js',
  'src/host/search-root-inspect.js', 'src/host/gate.js', 'src/host/local-request.js',
  'src/host/safety.js',
  'src/host/search-roots.js', 'src/host/storage.js', 'src/host/upload-manager.js',
  'src/locate/isolate-runner.js', 'src/locate/secure-locator.js', 'src/shared/node-path.js',
]) await access(join(root, relative))

const [host, contract, settings, safety, protocol, nodePath, searchRoots] = await Promise.all([
  import(moduleUrl('index.js')),
  import(moduleUrl('src/shared/contract.js')),
  import(moduleUrl('src/host/settings.js')),
  import(moduleUrl('src/host/safety.js')),
  import(moduleUrl('src/locate/protocol.js')),
  import(moduleUrl('src/shared/node-path.js')),
  import(moduleUrl('src/host/search-roots.js')),
])
assert.equal(host.name, 'dsh-file-drop')
assert.deepEqual(host.inject, ['webServer', 'sessions'])
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host.applyForTest, 'function')
assert.equal(typeof host.createPathLock, 'function')
assert.equal(settings.DEFAULT_FILE_DROP_SETTINGS, contract.DEFAULT_SETTINGS)
assert.equal(settings.MAX_UPLOAD_QUOTA_MIB, contract.MAX_UPLOAD_QUOTA_MIB)
assert.equal(protocol.FILE_DROP_ROUTE, contract.FILE_DROP_ROUTE)
assert.equal(contract.SEARCH_ROOTS_PATH, '/api/dsh-file-drop/search-roots')
assert.equal(contract.MAX_EXTERNAL_SEARCH_ROOTS, 16)
assert.equal(typeof safety.commitUploadStage, 'function')
assert.equal(typeof safety.decodeUploadManifest, 'function')
assert.equal(typeof nodePath.pathKey, 'function')
assert.equal(typeof nodePath.physicalPathKey, 'function')
assert.equal(typeof nodePath.collisionKey, 'function')
assert.equal(typeof nodePath.sameDirectoryEntry, 'function')
assert.equal(typeof searchRoots.createSearchRootStore, 'function')
assert.equal(typeof searchRoots.registerSearchRootRoute, 'function')
assert.equal(typeof searchRoots.directoryIdentity, 'function')

let hasClientSource = true
try { await access(join(root, 'src/client/index.js')) } catch { hasClientSource = false }
if (hasClientSource) {
  const generated = await build({
    absWorkingDir: root,
    bundle: true,
    entryPoints: ['src/client/index.js'],
    format: 'iife',
    legalComments: 'none',
    logLevel: 'silent',
    minify: true,
    outfile: 'client.js',
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
    write: false,
  })
  assert.equal(generated.outputFiles.length, 1)
  assert.equal(Buffer.compare(
    Buffer.from(generated.outputFiles[0].contents), await readFile(join(root, 'client.js'))
  ), 0, 'client.js is stale relative to src/client')
}

let definition
globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
await import(moduleUrl('client.js') + '?verify=' + Date.now())
const client = definition.factory((name) => {
  if (name === 'react') return {}
  throw new Error('unexpected client dependency: ' + name)
})
assert.deepEqual(client.inject, ['slots', 'workspaces', 'sessions'])
assert.equal(
  createHash('sha256').update(client.__test.CSS).digest('hex'),
  'd47f405a2fa175bd748a1a26309379530a2fdf427ff906e614542be5123d5161'
)

console.log(JSON.stringify({
  root,
  host: host.name,
  client: definition.id,
  cssBytes: client.__test.CSS.length,
  uploadProtocol: contract.UPLOAD_PROTOCOL_VERSION,
  locateProtocol: contract.LOCATE_PROTOCOL_VERSION,
}))
