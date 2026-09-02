import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  HttpError,
  assertDropRootCapacity,
  cleanupOrphanUploadStages,
  clearDropRoot,
  commitUploadStage,
  createUploadStage,
  decodeUploadManifest,
  dropCleanupStatus,
  errorStatus,
  measureDropRoot,
  readJsonBody,
  removeUploadStage,
  resolveBaseDir,
  sanitizeName,
  verifyUploadStage,
  writeUploadChunk,
} from '../src/host/safety.js'
import { runIsolatedTask } from '../src/locate/isolate.js'
import { DEFAULT_UPLOAD_QUOTA_BYTES, QUOTA_ERROR_CODE } from '../src/host/settings.js'

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-host-' + label + '-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function requestFrom(chunks, headers = {}) {
  const request = Readable.from(chunks)
  request.headers = headers
  return request
}

async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (error) => error instanceof HttpError && error.status === status)
}



test('HTTP status mapping preserves validated isolated-task errors only', async () => {
  let isolatedError
  try { await runIsolatedTask('unknown-task', {}) } catch (error) { isolatedError = error }
  assert.equal(isolatedError.status, 400)
  assert.equal(errorStatus(isolatedError), 400)
  assert.equal(errorStatus({ status: 503 }), 503)
  assert.equal(errorStatus({ status: 200 }), 500)
  assert.equal(errorStatus({ status: 999 }), 500)
})

test('JSON body uses network bytes and strict UTF-8', async () => {
  const bytes = Buffer.from(JSON.stringify({ value: '中文' }))
  const split = bytes.indexOf(Buffer.from('中')) + 1
  const request = requestFrom([bytes.subarray(0, split), bytes.subarray(split)], { 'content-length': String(bytes.length) })
  assert.deepEqual(await readJsonBody(request, bytes.length), { value: '中文' })

  await rejectsStatus(readJsonBody(requestFrom([], { 'content-length': '11' }), 10), 413)
  await rejectsStatus(readJsonBody(requestFrom([Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]), 100), 400)
  await rejectsStatus(readJsonBody(requestFrom([Buffer.from('[]')]), 100), 400)
  await rejectsStatus(readJsonBody(requestFrom([Buffer.from('{')]), 100), 400)
})

test('single-file manifest accepts large files up to the configured user-root quota', () => {
  const large = decodeUploadManifest({ kind: 'file', name: 'large.bin', size: 128 * 1024 * 1024 })
  assert.equal(large.totalBytes, 128 * 1024 * 1024)
  assert.equal(large.files[0].size, large.totalBytes)
  assert.equal(large.name, 'large.bin')
  assert.throws(() => decodeUploadManifest({ kind: 'file', name: 'x'.repeat(4097), size: 0 }), /file name/)
  assert.throws(() => decodeUploadManifest({ kind: 'file', name: 'x', size: -1 }), HttpError)
  assert.throws(() => decodeUploadManifest({ kind: 'file', name: 'x', size: 1.5 }), HttpError)
  assert.throws(
    () => decodeUploadManifest({ kind: 'file', name: 'x', size: DEFAULT_UPLOAD_QUOTA_BYTES + 1 }),
    (error) => error instanceof HttpError && error.code === QUOTA_ERROR_CODE
  )
  assert.throws(() => decodeUploadManifest({ kind: 'file', name: 'x', size: 1, base64: 'AA==' }), /must not contain/)
  assert.throws(() => decodeUploadManifest({ kind: 'binary', name: 'x', size: 1 }), /upload kind/)
})

test('directory manifest enforces structure limits independently from configured byte quota', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({ kind: 'file', path: 'f' + index + '.txt', size: 0 }))
  assert.equal(decodeUploadManifest({ kind: 'directory', name: 'root', entries: [] }).files.length, 0)
  assert.deepEqual(decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'directory', path: 'empty' }],
  }).directories, [['empty']])
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'directory', path: 'empty', size: 0 }],
  }), /marker/)
  assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'x'.repeat(4097), entries: [] }), /directory name/)
  assert.equal(decodeUploadManifest({ kind: 'directory', name: 'root', entries }).files.length, 500)
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [...entries, { kind: 'file', path: 'extra', size: 0 }],
  }), /file-count/)
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'file', path: '../escape', size: 0 }],
  }), /entry path/)
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'file', path: 'C:/absolute', size: 0 }],
  }), /relative/)
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'text', path: 'x', size: 0 }],
  }), /directory entry/)
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'file', path: 'x', size: 1, content: 'x' }],
  }), /must not contain/)
  assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
    { kind: 'file', path: 'a?.txt', size: 0 },
    { kind: 'file', path: 'a*.txt', size: 0 },
  ] }), /collide/)
  assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
    { kind: 'file', path: '\u00e9.txt', size: 0 },
    { kind: 'file', path: 'e\u0301.txt', size: 0 },
  ] }), /collide/)
  assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
    { kind: 'file', path: 'parent', size: 0 },
    { kind: 'file', path: 'parent/child.txt', size: 0 },
  ] }), /collide/)
  assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
    { kind: 'file', path: 'a?/first.txt', size: 0 },
    { kind: 'file', path: 'a*/second.txt', size: 0 },
  ] }), /collide/)
  const nested = decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
    { kind: 'file', path: 'a/b/first.txt', size: 40 * 1024 * 1024 },
    { kind: 'file', path: 'a/b/second.txt', size: 40 * 1024 * 1024 },
  ] })
  assert.equal(nested.entryCount, 5)
  assert.equal(nested.totalBytes, 80 * 1024 * 1024)
  if (process.platform === 'win32') {
    assert.throws(() => decodeUploadManifest({ kind: 'directory', name: 'root', entries: [
      { kind: 'file', path: 'Case.txt', size: 0 },
      { kind: 'file', path: 'case.txt', size: 0 },
    ] }), /collide/)
  }
  const tooDeep = Array.from({ length: 33 }, (_, index) => 'd' + index).join('/')
  assert.throws(() => decodeUploadManifest({
    kind: 'directory', name: 'root', entries: [{ kind: 'file', path: tooDeep, size: 0 }],
  }), /entry path/)
})



test('drop-root quota counts current and incoming storage before writes', async () => {
  const measureFn = async () => ({ size: 90, entries: 9 })
  await assertDropRootCapacity('quota-test', 10, 1, { maxBytes: 100, maxEntries: 10, measureFn })
  await rejectsStatus(assertDropRootCapacity('quota-test', 11, 1, { maxBytes: 100, maxEntries: 10, measureFn }), 413)
  await rejectsStatus(assertDropRootCapacity('quota-test', 10, 2, { maxBytes: 100, maxEntries: 10, measureFn }), 413)
})



test('stale clear quarantines remain visible to size and cumulative quota', async (t) => {
  const root = await fixture(t, 'stale-quarantine-quota')
  const base = join(root, 'workspace')
  const quarantine = join(base, '.dsh-drops.deleting-stale')
  await mkdir(quarantine, { recursive: true })
  await writeFile(join(quarantine, 'old.bin'), Buffer.alloc(64))
  const measured = await measureDropRoot(base)
  assert.equal(measured.size, 64)
  assert.equal(measured.entries, 2)
  await rejectsStatus(assertDropRootCapacity(base, 1, 1, { maxBytes: 64, maxEntries: 10 }), 413)
  await clearDropRoot(base, { waitForCleanup: true })
  assert.equal((await measureDropRoot(base)).size, 0)
})

test('name sanitization handles Windows-invalid and reserved names', () => {
  assert.equal(sanitizeName('a<b>.txt'), 'a_b_.txt')
  assert.equal(sanitizeName('CON'), '_CON')
  assert.equal(sanitizeName('../'), 'file.bin')
  assert.equal(sanitizeName('a'.repeat(178) + '😀').endsWith('😀'), true)
  assert.equal(sanitizeName('😀'.repeat(110) + '.txt').endsWith('.txt'), true)
})

test('chunk writes require contiguous exact blocks and preserve retryability', async (t) => {
  const root = await fixture(t, 'chunks')
  const base = join(root, 'workspace')
  await mkdir(base)
  const stage = await createUploadStage(base, decodeUploadManifest({ kind: 'file', name: 'six.bin', size: 6 }), randomUUID())
  await rejectsStatus(writeUploadChunk(requestFrom([Buffer.from('abc')]), stage, 0, 0, 4), 400)
  assert.equal(stage.files[0].written, 0)
  await writeUploadChunk(requestFrom([Buffer.from('ab'), Buffer.from('cd')], { 'content-length': '4' }), stage, 0, 0, 4)
  await rejectsStatus(writeUploadChunk(requestFrom([Buffer.from('abcd')], { 'content-length': '4' }), stage, 0, 0, 4), 409)
  await rejectsStatus(verifyUploadStage(stage), 409)
  await writeUploadChunk(requestFrom([Buffer.from('ef')], { 'content-length': '2' }), stage, 0, 4, 4)
  await verifyUploadStage(stage)
  const path = await commitUploadStage(base, stage)
  assert.equal(await readFile(path, 'utf8'), 'abcdef')
})

test('staged file and directory commits are atomic and orphan stages are reclaimed', async (t) => {
  const root = await fixture(t, 'write')
  const base = join(root, 'workspace')
  await mkdir(base)
  const uploadFile = async (name, data) => {
    const stage = await createUploadStage(base, decodeUploadManifest({ kind: 'file', name, size: data.length }), randomUUID())
    if (data.length) await writeUploadChunk(requestFrom([data], { 'content-length': String(data.length) }), stage, 0, 0, 16)
    return commitUploadStage(base, stage)
  }
  const filePath = await uploadFile('note.txt', Buffer.from('one'))
  const secondPath = await uploadFile('note.txt', Buffer.from('two'))
  assert.notEqual(secondPath, filePath)
  assert.equal(await readFile(filePath, 'utf8'), 'one')
  assert.equal(await readFile(secondPath, 'utf8'), 'two')
  const longPath = await uploadFile('😀'.repeat(110) + '.txt', Buffer.from('x'))
  assert.equal(await readFile(longPath, 'utf8'), 'x')
  assert.equal(longPath.endsWith('.txt'), true)
  await rm(longPath)

  const directoryManifest = decodeUploadManifest({ kind: 'directory', name: 'folder', entries: [
    { kind: 'file', path: 'nested/a.txt', size: 1 },
    { kind: 'directory', path: 'nested/empty' },
    { kind: 'file', path: 'b.bin', size: 2 },
  ] })
  const directoryStage = await createUploadStage(base, directoryManifest, randomUUID())
  await writeUploadChunk(requestFrom([Buffer.from('A')], { 'content-length': '1' }), directoryStage, 0, 0, 16)
  await writeUploadChunk(requestFrom([Buffer.from([0, 1])], { 'content-length': '2' }), directoryStage, 1, 0, 16)
  const directoryPath = await commitUploadStage(base, directoryStage)
  assert.equal(await readFile(join(directoryPath, 'nested', 'a.txt'), 'utf8'), 'A')
  assert.deepEqual([...await readFile(join(directoryPath, 'b.bin'))], [0, 1])
  assert.equal((await stat(join(directoryPath, 'nested', 'empty'))).isDirectory(), true)

  const unsafeStage = await createUploadStage(base, decodeUploadManifest({
    kind: 'directory', name: 'folder', entries: [{ kind: 'file', path: 'new.txt', size: 5 }],
  }), randomUUID())
  await writeUploadChunk(requestFrom([Buffer.from('newer')], { 'content-length': '5' }), unsafeStage, 0, 0, 16)
  await writeFile(unsafeStage.files[0].path, 'bad')
  await rejectsStatus(commitUploadStage(base, unsafeStage), 409)
  assert.equal(await readFile(join(directoryPath, 'nested', 'a.txt'), 'utf8'), 'A')
  await removeUploadStage(unsafeStage)

  const replacementStage = await createUploadStage(base, decodeUploadManifest({
    kind: 'directory', name: 'folder', entries: [{ kind: 'file', path: 'new.txt', size: 3 }],
  }), randomUUID())
  await writeUploadChunk(requestFrom([Buffer.from('new')], { 'content-length': '3' }), replacementStage, 0, 0, 16)
  await commitUploadStage(base, replacementStage)
  assert.equal(await readFile(join(directoryPath, 'new.txt'), 'utf8'), 'new')
  await assert.rejects(readFile(join(directoryPath, 'nested', 'a.txt')))

  const orphan = await createUploadStage(base, decodeUploadManifest({ kind: 'file', name: 'orphan.bin', size: 2 }), randomUUID())
  await cleanupOrphanUploadStages(base, new Set())
  await assert.rejects(stat(orphan.path))

  for (let attempt = 0; attempt < 20 && dropCleanupStatus(base).cleanupPending; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const measured = await measureDropRoot(base)
  assert.equal(measured.size, 9)
  assert.equal(measured.entries, 4)

  await clearDropRoot(base, { waitForCleanup: true })
  assert.deepEqual(await measureDropRoot(base), { path: join(base, '.dsh-drops'), size: 0, entries: 0 })
})





test('mode rejection immediately before commit leaves no file and restores replaced directories', async (t) => {
  const root = await fixture(t, 'commit-mode-rejection')
  const base = join(root, 'workspace')
  const fileStage = await createUploadStage(
    base,
    decodeUploadManifest({ kind: 'file', name: 'blocked.txt', size: 0 }),
    randomUUID()
  )
  await assert.rejects(commitUploadStage(base, fileStage, {
    beforeCommit() { throw new HttpError(409, '当前为定位模式，未上传', 'locate_mode') },
  }), (error) => error.code === 'locate_mode')
  await assert.rejects(stat(join(base, '.dsh-drops', 'blocked.txt')), (error) => error.code === 'ENOENT')
  await removeUploadStage(fileStage)

  const directoryStage = await createUploadStage(
    base,
    decodeUploadManifest({ kind: 'directory', name: 'replace-me', entries: [] }),
    randomUUID()
  )
  const target = join(base, '.dsh-drops', 'replace-me')
  await mkdir(target)
  await writeFile(join(target, 'old.txt'), 'old')
  let checks = 0
  await assert.rejects(commitUploadStage(base, directoryStage, {
    beforeCommit() {
      checks += 1
      if (checks === 2) throw new HttpError(409, '当前为定位模式，未上传', 'locate_mode')
    },
  }), (error) => error.code === 'locate_mode')
  assert.equal(checks, 2)
  assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'old')
  await stat(directoryStage.path)
  await removeUploadStage(directoryStage)
})

test('clear reports asynchronous quarantine cleanup failures', async (t) => {
  const root = await fixture(t, 'cleanup-failure')
  const base = join(root, 'workspace')
  await mkdir(join(base, '.dsh-drops'), { recursive: true })
  await writeFile(join(base, '.dsh-drops', 'locked.txt'), 'data')
  const errors = []
  await clearDropRoot(base, {
    removeQuarantineFn: async () => { throw new Error('simulated locked file') },
    onCleanupError: (error) => errors.push(error),
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(dropCleanupStatus(base), {
    cleanupPending: false,
    cleanupError: 'simulated locked file',
  })
  assert.equal(errors.length, 1)
  assert.deepEqual(await measureDropRoot(base), { path: join(base, '.dsh-drops'), size: 4, entries: 2 })
  await rejectsStatus(assertDropRootCapacity(base, 1, 1), 409)
})

test('cleanup status canonicalizes physical directory aliases', async (t) => {
  const root = await fixture(t, 'cleanup-alias')
  const base = join(root, 'workspace')
  const alias = join(root, 'workspace-alias')
  await mkdir(join(base, '.dsh-drops'), { recursive: true })
  await writeFile(join(base, '.dsh-drops', 'locked.txt'), 'data')
  try {
    await symlink(base, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('symlink creation is unavailable')
      return
    }
    throw error
  }
  await clearDropRoot(base, {
    removeQuarantineFn: async () => { throw new Error('simulated alias cleanup failure') },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(dropCleanupStatus(alias), {
    cleanupPending: false,
    cleanupError: 'simulated alias cleanup failure',
  })
})

test('size timeout is enforced inside one large flat directory', async (t) => {
  const root = await fixture(t, 'flat-size-timeout')
  const base = join(root, 'workspace')
  const drops = join(base, '.dsh-drops')
  await mkdir(drops, { recursive: true })
  await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(drops, 'f-' + index), '')))
  let calls = 0
  await rejectsStatus(measureDropRoot(base, {
    maxDurationMs: 1,
    now: () => calls++ < 2 ? 0 : 2,
  }), 503)
})

test('drop-root symlinks or junctions are rejected', async (t) => {
  const root = await fixture(t, 'link')
  const base = join(root, 'workspace')
  const target = join(root, 'target')
  await mkdir(base)
  await mkdir(target)
  const link = join(base, '.dsh-drops')
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) { t.skip('symlink creation is unavailable'); return }
    throw error
  }
  await rejectsStatus(measureDropRoot(base), 409)
  await rejectsStatus(clearDropRoot(base), 409)
  await rejectsStatus(createUploadStage(base, decodeUploadManifest({ kind: 'file', name: 'x', size: 1 }), randomUUID()), 409)
  assert.deepEqual(await readdirSafe(target), [])
})

async function readdirSafe(path) {
  try { return await (await import('node:fs/promises')).readdir(path) } catch { return [] }
}



test('clear never follows stale quarantine links', async (t) => {
  const root = await fixture(t, 'quarantine-link')
  const base = join(root, 'workspace')
  const target = join(root, 'target')
  await mkdir(base)
  await mkdir(join(base, '.dsh-drops'))
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'keep')
  const stale = join(base, '.dsh-drops.deleting-stale')
  try {
    await symlink(target, stale, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) { t.skip('symlink creation is unavailable'); return }
    throw error
  }
  await clearDropRoot(base, { waitForCleanup: true })
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'keep')
})

test('session resolution distinguishes missing and invalid ids', async (t) => {
  const root = await fixture(t, 'session')
  const ctx = { sessions: { get: (id) => id === 'valid' ? { header: { cwd: root } } : undefined } }
  assert.equal(resolveBaseDir(ctx, 'valid'), root)
  assert.throws(() => resolveBaseDir({ sessions: { get: () => ({ meta: { cwd: root } }) } }, 'old'),
    (error) => error.status === 404)
  assert.throws(() => resolveBaseDir(ctx, 'missing'), (error) => error.status === 404)
  for (const value of [null, '', '   ', 7]) {
    assert.throws(() => resolveBaseDir(ctx, value, true), (error) => error.status === 400)
  }
})
