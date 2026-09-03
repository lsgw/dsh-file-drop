import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH, MAX_EXTERNAL_SEARCH_ROOTS } from '../src/shared/contract.js'
import { createSearchRootStore, directoryIdentity, withInspectionTimeout } from '../src/host/search-roots.js'
import { inspectionCounts } from '../src/host/search-root-inspect.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-search-roots-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (error) => error && error.status === status)
}

test('external root validation times out but retains its slot until the operation settles', async () => {
  const before = inspectionCounts().active
  let release
  const operation = new Promise((resolve) => { release = resolve })
  await assert.rejects(withInspectionTimeout(operation, 10), (error) => error.status === 503)
  assert.equal(inspectionCounts().active, before + 1)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inspectionCounts().active, before)
})

test('external root identity rejects filesystems without stable file ids', () => {
  assert.equal(directoryIdentity({ dev: 0n, ino: 1n }), undefined)
  assert.equal(directoryIdentity({ dev: 1n, ino: 0n }), undefined)
  assert.equal(directoryIdentity({ dev: 1n, ino: 2n }), 'inode:1:2')
})

test('search root store authorizes, deduplicates and revokes real directories', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'external')
  const store = createSearchRootStore(join(root, 'state', 'roots.json'))
  await mkdir(directory)

  assert.deepEqual(await store.list(), { epoch: 0, roots: [] })
  const added = await store.authorize(directory)
  assert.equal(added.epoch, 1)
  assert.equal(added.roots.length, 1)
  assert.equal(added.roots[0].available, true)
  assert.equal(added.roots[0].path, await realpath(directory))
  const id = added.roots[0].id

  const duplicate = await store.authorize(directory)
  assert.deepEqual(duplicate, added)
  const trusted = await store.trusted()
  assert.equal(trusted.epoch, 1)
  assert.equal(trusted.roots.length, 1)
  assert.equal(trusted.roots[0].id, id)

  const revoked = await store.revoke(id)
  assert.deepEqual(revoked, { epoch: 2, roots: [] })
  await rejectsStatus(store.revoke(id), 404)
})

test('reauthorizing a moved root replaces its stale physical identity record', async (t) => {
  const root = await fixture(t)
  const before = join(root, 'before')
  const after = join(root, 'after')
  const store = createSearchRootStore(join(root, 'roots.json'))
  await mkdir(before)
  const first = await store.authorize(before)
  await rename(before, after)
  const second = await store.authorize(after)
  assert.equal(second.epoch, 2)
  assert.equal(second.roots.length, 1)
  assert.notEqual(second.roots[0].id, first.roots[0].id)
  assert.equal(second.roots[0].path, await realpath(after))
  assert.equal((await store.trusted()).roots.length, 1)
})

test('POSIX external root authorization preserves trailing spaces', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows does not preserve trailing-space path components')
  const root = await fixture(t)
  const directory = join(root, 'external ')
  const store = createSearchRootStore(join(root, 'roots.json'))
  await mkdir(directory)
  const added = await store.authorize(directory)
  assert.equal(added.roots[0].path, directory)
})

test('search root store rejects relative, missing, file and symlink roots', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'directory')
  const file = join(root, 'file.txt')
  const link = join(root, 'link')
  const store = createSearchRootStore(join(root, 'roots.json'))
  await mkdir(directory)
  await writeFile(file, 'x')
  try {
    await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) t.skip('symlink creation is unavailable')
    else throw error
  }

  await rejectsStatus(store.authorize('relative/path'), 400)
  await rejectsStatus(store.authorize(join(root, 'missing')), 400)
  await rejectsStatus(store.authorize(file), 400)
  await rejectsStatus(store.authorize(link), 400)
  await rejectsStatus(store.authorize(link + sep), 400)
})

test('root revocation waits for in-flight authorization reads', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'external')
  const store = createSearchRootStore(join(root, 'roots.json'))
  await mkdir(directory)
  const added = await store.authorize(directory)
  let release
  let markEntered
  const pending = new Promise((resolve) => { release = resolve })
  const entered = new Promise((resolve) => { markEntered = resolve })
  const reading = store.withRead(async () => { markEntered(); await pending })
  await entered
  let revoked = false
  const revoking = store.revoke(added.roots[0].id).then(() => { revoked = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(revoked, false)
  release()
  await reading
  await revoking
  assert.equal(revoked, true)
})

test('replaced roots become unavailable and require explicit reauthorization', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'external')
  const store = createSearchRootStore(join(root, 'roots.json'))
  await mkdir(directory)
  const first = await store.authorize(directory)
  const id = first.roots[0].id
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory)

  const listed = await store.list()
  assert.equal(listed.roots.length, 1)
  assert.equal(listed.roots[0].id, id)
  assert.equal(listed.roots[0].available, false)
  assert.deepEqual((await store.trusted()).roots, [])

  const second = await store.authorize(directory)
  assert.equal(second.epoch, 2)
  assert.equal(second.roots.length, 1)
  assert.notEqual(second.roots[0].id, id)
  assert.equal(second.roots[0].available, true)
})

test('search root count and path length limits are exact', async (t) => {
  const root = await fixture(t)
  const store = createSearchRootStore(join(root, 'roots.json'))
  for (let index = 0; index < MAX_EXTERNAL_SEARCH_ROOTS; index += 1) {
    const directory = join(root, 'root-' + index)
    await mkdir(directory)
    const result = await store.authorize(directory)
    assert.equal(result.roots.length, index + 1)
  }
  const overflow = join(root, 'overflow')
  await mkdir(overflow)
  await rejectsStatus(store.authorize(overflow), 413)
  const tooLong = resolve(root, 'x'.repeat(MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH))
  await rejectsStatus(store.authorize(tooLong), 400)
})

test('search root disk state rejects duplicate identities and oversized JSON', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'roots.json')
  const store = createSearchRootStore(path)
  const identity = 'inode:1:2'
  await writeFile(path, JSON.stringify({ version: 1, epoch: 2, roots: [
    { id: '11111111-1111-4111-8111-111111111111', generation: '22222222-2222-4222-8222-222222222222', path: resolve(root, 'a'), identity },
    { id: '33333333-3333-4333-8333-333333333333', generation: '44444444-4444-4444-8444-444444444444', path: resolve(root, 'b'), identity },
  ] }))
  await rejectsStatus(store.list(), 500)
  await writeFile(path, ' '.repeat(256 * 1024 + 1))
  await rejectsStatus(store.list(), 500)
})

test('search root state uses bounded validated JSON and survives a fresh store instance', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'external')
  const path = join(root, 'roots.json')
  await mkdir(directory)
  const store = createSearchRootStore(path)
  const added = await store.authorize(directory)
  const fresh = createSearchRootStore(path)
  assert.deepEqual(await fresh.list(), added)
  const info = await stat(path)
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)

  await writeFile(path, JSON.stringify({ version: 1, epoch: 0, roots: [{ bad: true }] }))
  await rejectsStatus(fresh.list(), 500)
})
