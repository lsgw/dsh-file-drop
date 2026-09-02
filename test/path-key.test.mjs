import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lstat, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { collisionKey, pathKey, physicalPathKey, sameDirectoryEntry } from '../src/shared/node-path.js'

test('lexical keys preserve Unicode spelling and collision keys normalize it', () => {
  const decomposed = pathKey(join(tmpdir(), 'e\u0301'))
  const composed = pathKey(join(tmpdir(), 'é'))
  assert.notEqual(decomposed, composed)
  assert.equal(collisionKey(['e\u0301']), collisionKey(['é']))
  assert.equal(pathKey(resolve('.')), pathKey(resolve('.')))
})

test('physical path keys resolve aliases of the same entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-path-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'target')
  const alias = join(root, 'alias')
  await mkdir(target)
  try {
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) { t.skip('symlink creation is unavailable'); return }
    throw error
  }
  assert.equal(await physicalPathKey(target), await physicalPathKey(alias))
})

test('physical directory-entry matching follows the actual volume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-name-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const actual = 'CaseProbe.txt'
  const requested = 'caseprobe.txt'
  await writeFile(join(root, actual), 'case')
  let aliases = false
  try { aliases = (await lstat(join(root, requested))).isFile() } catch {}
  assert.equal(await sameDirectoryEntry(root, actual, requested), aliases)
})

test('physical Unicode entries follow the actual volume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-unicode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const composed = 'é.txt'
  const decomposed = 'e\u0301.txt'
  await writeFile(join(root, composed), 'composed')
  await writeFile(join(root, decomposed), 'decomposed')
  const names = await readdir(root)
  const distinct = names.includes(composed) && names.includes(decomposed)
  assert.equal(await physicalPathKey(join(root, composed)) === await physicalPathKey(join(root, decomposed)), !distinct)
})

test('path keys reject missing values', () => {
  assert.throws(() => pathKey(undefined), TypeError)
  assert.throws(() => pathKey(''), TypeError)
})
