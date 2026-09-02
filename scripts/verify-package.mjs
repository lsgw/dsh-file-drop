import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] || '.')
const moduleUrl = (relative) => pathToFileURL(join(root, relative)).href
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-file-drop')

for (const relative of [
  'index.js', 'client.js', 'src/shared/contract.js', 'src/host/index.js',
  'src/host/safety.js', 'src/host/storage.js', 'src/host/upload-manager.js',
  'src/locate/isolate-runner.js', 'src/locate/secure-locator.js', 'src/shared/node-path.js',
]) await access(join(root, relative))

const [host, contract, settings, safety, protocol, nodePath] = await Promise.all([
  import(moduleUrl('index.js')),
  import(moduleUrl('src/shared/contract.js')),
  import(moduleUrl('src/host/settings.js')),
  import(moduleUrl('src/host/safety.js')),
  import(moduleUrl('src/locate/protocol.js')),
  import(moduleUrl('src/shared/node-path.js')),
])
assert.equal(host.name, 'dsh-file-drop')
assert.deepEqual(host.inject, ['webServer', 'sessions'])
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host.applyForTest, 'function')
assert.equal(typeof host.createPathLock, 'function')
assert.equal(settings.DEFAULT_FILE_DROP_SETTINGS, contract.DEFAULT_SETTINGS)
assert.equal(settings.MAX_UPLOAD_QUOTA_MIB, contract.MAX_UPLOAD_QUOTA_MIB)
assert.equal(protocol.FILE_DROP_ROUTE, contract.FILE_DROP_ROUTE)
assert.equal(typeof safety.commitUploadStage, 'function')
assert.equal(typeof safety.decodeUploadManifest, 'function')
assert.equal(typeof nodePath.pathKey, 'function')
assert.equal(typeof nodePath.physicalPathKey, 'function')
assert.equal(typeof nodePath.collisionKey, 'function')
assert.equal(typeof nodePath.sameDirectoryEntry, 'function')

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
  'b0c0e01e5c0caf1c59de201a7ea563b608c8087bdb847d7d744ae6a7dd3e7723'
)

console.log(JSON.stringify({
  root,
  host: host.name,
  client: definition.id,
  cssBytes: client.__test.CSS.length,
  uploadProtocol: contract.UPLOAD_PROTOCOL_VERSION,
  locateProtocol: contract.LOCATE_PROTOCOL_VERSION,
}))
