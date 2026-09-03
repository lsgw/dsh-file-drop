import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const temp = await mkdtemp(join(tmpdir(), 'dsh-file-drop-pack-'))

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' exited with ' + result.status)
}

const EXPECTED_FILES = [
  'LICENSE', 'README.md', 'client.js', 'cordis.patch.yml', 'dsh.plugin.json', 'index.js', 'package.json',
  'src/host/search-root-inspect.js', 'src/host/gate.js', 'src/host/http.js', 'src/host/index.js',
  'src/host/local-request.js',
  'src/host/manifest.js', 'src/host/safety.js', 'src/host/search-roots.js', 'src/host/settings.js',
  'src/host/storage.js', 'src/host/upload-manager.js', 'src/locate/directory-node.js',
  'src/locate/directory.js', 'src/locate/fingerprint.js', 'src/locate/isolate-runner.js',
  'src/locate/isolate.js', 'src/locate/locator.js', 'src/locate/protocol.js',
  'src/locate/secure-locator.js', 'src/shared/contract.js', 'src/shared/node-path.js',
].sort()

async function listFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

try {
  const npmArgs = ['pack', '--ignore-scripts', '--pack-destination', temp]
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...npmArgs])
  else run('npm', npmArgs)

  const archives = (await readdir(temp)).filter((name) => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error('expected one npm archive, found ' + archives.length)
  run('tar', ['-xf', join(temp, archives[0]), '-C', temp])
  const packageRoot = join(temp, 'package')
  await access(join(packageRoot, 'package.json'))
  assert.deepEqual((await listFiles(packageRoot)).sort(), EXPECTED_FILES)
  run(process.execPath, [join(root, 'scripts', 'verify-package.mjs'), packageRoot])
  console.log(JSON.stringify({ archive: archives[0], packageRoot, verified: true }))
} finally {
  await rm(temp, { recursive: true, force: true })
}
