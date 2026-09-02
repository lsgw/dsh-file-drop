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

try {
  const npmArgs = ['pack', '--ignore-scripts', '--pack-destination', temp]
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...npmArgs])
  else run('npm', npmArgs)

  const archives = (await readdir(temp)).filter((name) => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error('expected one npm archive, found ' + archives.length)
  run('tar', ['-xf', join(temp, archives[0]), '-C', temp])
  const packageRoot = join(temp, 'package')
  await access(join(packageRoot, 'package.json'))
  run(process.execPath, [join(root, 'scripts', 'verify-package.mjs'), packageRoot])
  console.log(JSON.stringify({ archive: archives[0], packageRoot, verified: true }))
} finally {
  await rm(temp, { recursive: true, force: true })
}
