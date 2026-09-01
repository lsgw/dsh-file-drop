import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HttpError,
  MAX_FILE_BYTES,
  assertDropRootCapacity,
  clearDropRoot,
  decodeDirectoryPayload,
  decodeUploadPayload,
  dropCleanupStatus,
  errorStatus,
  measureDropRoot,
  readJsonBody,
  replaceUploadedDirectory,
  resolveBaseDir,
  sanitizeName,
  writeUploadedFile,
} from '../host-safety.js'
import { runIsolatedTask } from '../locate/isolate.js'

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

test('single-file payload validates metadata, decoded bytes and base64', () => {
  const text = decodeUploadPayload({ name: 'note.txt', size: 6, kind: 'text', content: '中文' })
  assert.equal(text.data.length, 6)
  assert.equal(text.name, 'note.txt')
  const binary = decodeUploadPayload({ name: 'data.bin', size: 3, kind: 'binary', base64: 'AAEC' })
  assert.deepEqual([...binary.data], [0, 1, 2])
  assert.throws(() => decodeUploadPayload({ name: 'x'.repeat(4097), size: 0, kind: 'text', content: '' }), /file name/)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: -1, kind: 'text', content: '' }), HttpError)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: MAX_FILE_BYTES + 1, kind: 'text', content: '' }), HttpError)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: 1, kind: 'binary', base64: '%%%=' }), /invalid base64/)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: 1, kind: 'text', content: '中文' }), /does not match/)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: 1, kind: 'binary', base64: 'AAE=' }), /does not match/)
  assert.throws(() => decodeUploadPayload({ name: 'x', size: 1.5, kind: 'text', content: 'x' }), HttpError)
})

test('directory payload enforces count, depth, paths, kinds and collisions', () => {
  const entries = Array.from({ length: 500 }, (_, index) => ({ kind: 'text', path: 'f' + index + '.txt', content: '' }))
  assert.equal(decodeDirectoryPayload('root', []).files.length, 0)
  assert.deepEqual(decodeDirectoryPayload('root', [{ kind: 'directory', path: 'empty' }]).directories, [['empty']])
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'directory', path: 'empty', content: '' }]), /marker/)
  assert.throws(() => decodeDirectoryPayload('x'.repeat(4097), []), /directory upload/)
  assert.equal(decodeDirectoryPayload('root', entries).files.length, 500)
  assert.throws(() => decodeDirectoryPayload('root', [...entries, { kind: 'text', path: 'extra', content: '' }]), /file-count/)
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'text', path: '../escape', content: '' }]), /entry path/)
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'text', path: 'C:/absolute', content: '' }]), /relative/)
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'other', path: 'x', content: '' }]), /file kind/)
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'binary', path: 'x', size: 1, base64: 'AAE=' }]), /does not match/)
  assert.throws(() => decodeDirectoryPayload('root', [
    { kind: 'text', path: 'a?.txt', content: '' },
    { kind: 'text', path: 'a*.txt', content: '' },
  ]), /collide/)
  assert.throws(() => decodeDirectoryPayload('root', [
    { kind: 'text', path: '\u00e9.txt', content: '' },
    { kind: 'text', path: 'e\u0301.txt', content: '' },
  ]), /collide/)
  assert.throws(() => decodeDirectoryPayload('root', [
    { kind: 'text', path: 'parent', content: '' },
    { kind: 'text', path: 'parent/child.txt', content: '' },
  ]), /collide/)
  assert.throws(() => decodeDirectoryPayload('root', [
    { kind: 'text', path: 'a?/first.txt', content: '' },
    { kind: 'text', path: 'a*/second.txt', content: '' },
  ]), /collide/)
  const nested = decodeDirectoryPayload('root', [
    { kind: 'text', path: 'a/b/first.txt', content: '' },
    { kind: 'text', path: 'a/b/second.txt', content: '' },
  ])
  assert.equal(nested.entryCount, 5)
  if (process.platform === 'win32') {
    assert.throws(() => decodeDirectoryPayload('root', [
      { kind: 'text', path: 'Case.txt', content: '' },
      { kind: 'text', path: 'case.txt', content: '' },
    ]), /collide/)
  }
  const tooDeep = Array.from({ length: 33 }, (_, index) => 'd' + index).join('/')
  assert.throws(() => decodeDirectoryPayload('root', [{ kind: 'text', path: tooDeep, content: '' }]), /entry path/)
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

test('file and directory writes replace atomically and size is bounded', async (t) => {
  const root = await fixture(t, 'write')
  const base = join(root, 'workspace')
  await mkdir(base)
  const first = decodeUploadPayload({ name: 'note.txt', size: 3, kind: 'text', content: 'one' })
  const filePath = await writeUploadedFile(base, first)
  assert.equal(await readFile(filePath, 'utf8'), 'one')
  const second = decodeUploadPayload({ name: 'note.txt', size: 3, kind: 'text', content: 'two' })
  const secondPath = await writeUploadedFile(base, second)
  assert.notEqual(secondPath, filePath)
  assert.equal(await readFile(filePath, 'utf8'), 'one')
  assert.equal(await readFile(secondPath, 'utf8'), 'two')
  const longName = '😀'.repeat(110) + '.txt'
  const longPath = await writeUploadedFile(base, decodeUploadPayload({ name: longName, size: 1, kind: 'text', content: 'x' }))
  assert.equal(await readFile(longPath, 'utf8'), 'x')
  assert.equal(longPath.endsWith('.txt'), true)
  await rm(longPath)

  const directory = decodeDirectoryPayload('folder', [
    { kind: 'text', path: 'nested/a.txt', content: 'A' },
    { kind: 'directory', path: 'nested/empty' },
    { kind: 'binary', path: 'b.bin', base64: 'AAE=' },
  ])
  const directoryPath = await replaceUploadedDirectory(base, directory)
  assert.equal(await readFile(join(directoryPath, 'nested', 'a.txt'), 'utf8'), 'A')
  assert.deepEqual([...await readFile(join(directoryPath, 'b.bin'))], [0, 1])
  assert.equal((await stat(join(directoryPath, 'nested', 'empty'))).isDirectory(), true)

  const backupPath = join(base, '.dsh-drops', '.folder.bak')
  await rename(directoryPath, backupPath)
  await assert.rejects(replaceUploadedDirectory(base, {
    name: 'folder',
    files: [
      { segments: ['same.txt'], data: Buffer.from('first') },
      { segments: ['same.txt'], data: Buffer.from('second') },
    ],
  }))
  assert.equal(await readFile(join(directoryPath, 'nested', 'a.txt'), 'utf8'), 'A')

  let clockCalls = 0
  await rejectsStatus(measureDropRoot(base, { maxDurationMs: 1, now: () => clockCalls++ === 0 ? 0 : 2 }), 503)
  const measured = await measureDropRoot(base)
  assert.equal(measured.size, 9)
  assert.equal(measured.entries, 7)

  await clearDropRoot(base, { waitForCleanup: true })
  assert.deepEqual(await measureDropRoot(base), { path: join(base, '.dsh-drops'), size: 0, entries: 0 })
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
  await rejectsStatus(writeUploadedFile(base, decodeUploadPayload({ name: 'x', size: 1, kind: 'text', content: 'x' })), 409)
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
  const ctx = { sessions: { get: (id) => id === 'valid' ? { header: { cwd: root } }
    : id === 'legacy' ? { meta: { cwd: root } } : undefined } }
  assert.equal(resolveBaseDir(ctx, 'valid'), root)
  assert.equal(resolveBaseDir(ctx, 'legacy'), root)
  assert.throws(() => resolveBaseDir(ctx, 'missing'), (error) => error.status === 404)
  for (const value of [null, '', '   ', 7]) {
    assert.throws(() => resolveBaseDir(ctx, value, true), (error) => error.status === 400)
  }
})
