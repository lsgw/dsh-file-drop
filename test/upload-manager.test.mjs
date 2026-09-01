import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createPathLock } from '../index.js'
import { measureDropRoot, removeUploadStage } from '../host-safety.js'
import { UPLOAD_CHUNK_BYTES, createUploadManager } from '../upload/manager.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-manager-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function canonicalPathKey(value) {
  try { return await realpath(value) } catch { return resolve(value) }
}

function chunkRequest(uploadId, fileIndex, offset, data) {
  const req = Readable.from([data])
  req.headers = {
    'content-length': String(data.length),
    'x-dsh-upload-id': uploadId,
    'x-dsh-file-index': String(fileIndex),
    'x-dsh-upload-offset': String(offset),
    'x-dsh-session-scope': 'session',
    'x-dsh-session-id': 'valid',
  }
  return req
}

function createManager(cwdRef, now = Date.now, getSettings, options = {}) {
  const ctx = {
    sessions: { get: (id) => id === 'valid' ? { header: { cwd: cwdRef.value } } : undefined },
    logger: { warn() {} },
  }
  return createUploadManager(ctx, {
    withPathLock: options.withPathLock || createPathLock(),
    canonicalPathKey,
    uploadBaseDir: options.uploadBaseDir || cwdRef.value,
    now,
    ...(getSettings ? { getSettings } : {}),
    ...(options.removeStage ? { removeStage: options.removeStage } : {}),
    ...(options.commitStage ? { commitStage: options.commitStage } : {}),
  })
}

test('upload manager binds the session but always commits to the user upload root', async (t) => {
  const firstWorkspace = await fixture(t)
  const secondWorkspace = await fixture(t)
  const uploadRoot = await fixture(t)
  const cwdRef = { value: firstWorkspace }
  const manager = createManager(cwdRef, Date.now, undefined, { uploadBaseDir: uploadRoot })
  const initialized = await manager.init({
    sessionId: 'valid', kind: 'file', name: 'data.bin', size: UPLOAD_CHUNK_BYTES + 4,
  })
  const data = Buffer.alloc(UPLOAD_CHUNK_BYTES, 7)
  const results = await Promise.allSettled([
    manager.chunk(chunkRequest(initialized.uploadId, 0, 0, data)),
    manager.chunk(chunkRequest(initialized.uploadId, 0, 0, data)),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1)
  await manager.chunk(chunkRequest(initialized.uploadId, 0, UPLOAD_CHUNK_BYTES, Buffer.from('tail')))

  cwdRef.value = secondWorkspace
  const finished = await manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId })
  assert.equal(await readFile(finished.path, 'utf8').then((value) => value.slice(-4)), 'tail')
  assert.equal(finished.path.startsWith(join(uploadRoot, '.dsh-drops')), true)
  assert.equal((await measureDropRoot(firstWorkspace)).size, 0)
  assert.equal((await measureDropRoot(secondWorkspace)).size, 0)
})

test('invalid session init cannot sweep expired user-root staging', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let clock = 0
  const manager = createManager(cwdRef, () => clock)
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'pending.bin', size: 0 })
  clock = 11 * 60 * 1000
  cwdRef.value = undefined
  await assert.rejects(
    manager.init({ sessionId: 'valid', kind: 'file', name: 'invalid.bin', size: 0 }),
    (error) => error.status === 404
  )
  assert.equal(manager.activeCount(), 1)
  cwdRef.value = root
  assert.deepEqual(await manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }), { cancelled: true })
})

test('removed sessions cannot write, finish or cancel user-root staging', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  const manager = createManager(cwdRef)
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'live.bin', size: 3 })
  cwdRef.value = undefined
  await assert.rejects(
    manager.chunk(chunkRequest(initialized.uploadId, 0, 0, Buffer.from('bad'))),
    (error) => error.status === 404
  )
  await assert.rejects(
    manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId }),
    (error) => error.status === 404
  )
  await assert.rejects(
    manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }),
    (error) => error.status === 404
  )
  assert.equal(manager.activeCount(), 1)

  cwdRef.value = root
  await manager.chunk(chunkRequest(initialized.uploadId, 0, 0, Buffer.from('ok!')))
  const finished = await manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId })
  assert.equal(await readFile(finished.path, 'utf8'), 'ok!')
})

test('cancel revalidation failure does not mark staging cleanup as failed', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  const pathLock = createPathLock()
  let invalidateOnLock = false
  const manager = createManager(cwdRef, Date.now, undefined, {
    withPathLock: async (path, operation) => {
      if (invalidateOnLock) {
        invalidateOnLock = false
        cwdRef.value = undefined
      }
      return pathLock(path, operation)
    },
  })
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'race.bin', size: 3 })
  invalidateOnLock = true
  await assert.rejects(
    manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }),
    (error) => error.status === 404
  )
  assert.equal(manager.activeCount(), 1)

  cwdRef.value = root
  await manager.chunk(chunkRequest(initialized.uploadId, 0, 0, Buffer.from('ok!')))
  const finished = await manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId })
  assert.equal(await readFile(finished.path, 'utf8'), 'ok!')
})

test('finish revalidates the live session at the final commit hook', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let beforeCommitCalls = 0
  const manager = createManager(cwdRef, Date.now, undefined, {
    commitStage: async (_baseDir, _stage, options) => {
      options.beforeCommit()
      beforeCommitCalls += 1
      cwdRef.value = undefined
      options.beforeCommit()
      throw new Error('unreachable commit')
    },
  })
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'final.bin', size: 0 })
  await assert.rejects(
    manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId }),
    (error) => error.status === 404
  )
  assert.equal(beforeCommitCalls, 1)
  assert.equal(manager.activeCount(), 1)

  cwdRef.value = root
  assert.deepEqual(await manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }), { cancelled: true })
})

test('upload manager rejects chunk and finish after mode changes to locate', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  const mode = { value: 'upload' }
  const manager = createManager(cwdRef, Date.now, () => ({
    mode: mode.value,
    maxBytes: 10000 * 1024 * 1024,
    maxEntries: 10000,
  }))
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'blocked.bin', size: 3 })
  mode.value = 'locate'
  await assert.rejects(
    manager.chunk(chunkRequest(initialized.uploadId, 0, 0, Buffer.from('abc'))),
    (error) => error.status === 409 && error.code === 'locate_mode'
  )
  mode.value = 'upload'
  await manager.chunk(chunkRequest(initialized.uploadId, 0, 0, Buffer.from('abc')))
  mode.value = 'locate'
  await assert.rejects(
    manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId }),
    (error) => error.status === 409 && error.code === 'locate_mode'
  )
  assert.deepEqual(await manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }), { cancelled: true })
  assert.deepEqual(await measureDropRoot(root), { path: join(root, '.dsh-drops'), size: 0, entries: 0 })
})

test('init removes a newly created stage when mode changes during preallocation', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let settingsReads = 0
  const manager = createManager(cwdRef, Date.now, () => {
    settingsReads += 1
    return {
      mode: settingsReads >= 4 ? 'locate' : 'upload',
      maxBytes: 10000 * 1024 * 1024,
      maxEntries: 10000,
    }
  })
  await assert.rejects(
    manager.init({ sessionId: 'valid', kind: 'file', name: 'racing.bin', size: 3 }),
    (error) => error.status === 409 && error.code === 'locate_mode'
  )
  assert.equal(manager.activeCount(), 0)
  assert.deepEqual(await measureDropRoot(root), { path: join(root, '.dsh-drops'), size: 0, entries: 0 })
  await assert.rejects(stat(join(root, '.dsh-drops', '.dsh-upload-staging')), (error) => error.code === 'ENOENT')
})

test('concurrent finish commits exactly once', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  const manager = createManager(cwdRef)
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'empty.bin', size: 0 })
  const results = await Promise.allSettled([
    manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId }),
    manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId }),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok(rejected[0].reason.status === 404 || rejected[0].reason.status === 409)
  assert.equal((await readFile(fulfilled[0].value.path)).length, 0)
  assert.equal(manager.activeCount(), 0)
})

test('size cleanup protects staging while finish is waiting for its path lock', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let blockNext = false
  let enterBlocked
  let releaseBlocked
  const blocked = new Promise((resolve) => { enterBlocked = resolve })
  const release = new Promise((resolve) => { releaseBlocked = resolve })
  const withPathLock = async (_baseDir, operation) => {
    if (blockNext) {
      blockNext = false
      enterBlocked()
      await release
    }
    return operation()
  }
  const manager = createManager(cwdRef, Date.now, undefined, { withPathLock })
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'finishing.bin', size: 0 })
  blockNext = true
  const finishing = manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId })
  await blocked
  try {
    assert.equal(await manager.cleanupBase(), true)
  } finally {
    releaseBlocked()
  }
  const result = await finishing
  assert.equal(await readFile(result.path, 'utf8'), '')
  assert.equal(manager.activeCount(), 0)
})

test('finish cannot commit after a concurrent cancel leaves cleanup pending', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let blockNext = false
  let locked = true
  let enterBlocked
  let releaseBlocked
  const blocked = new Promise((resolve) => { enterBlocked = resolve })
  const release = new Promise((resolve) => { releaseBlocked = resolve })
  const withPathLock = async (_baseDir, operation) => {
    if (blockNext) {
      blockNext = false
      enterBlocked()
      await release
    }
    return operation()
  }
  const manager = createManager(cwdRef, Date.now, undefined, {
    withPathLock,
    removeStage: async (stage) => {
      if (locked) throw Object.assign(new Error('staging locked'), { code: 'EBUSY' })
      return removeUploadStage(stage)
    },
  })
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'cancel-race.bin', size: 0 })
  blockNext = true
  const finishing = manager.finish({ sessionId: 'valid', uploadId: initialized.uploadId })
  await blocked
  await assert.rejects(manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }), /staging locked/)
  releaseBlocked()
  await assert.rejects(finishing, (error) => error && error.status === 409)
  assert.equal(manager.activeCount(), 1)
  locked = false
  await manager.cleanupBase()
  assert.equal(manager.activeCount(), 0)
})

test('cancel waits for an in-flight chunk before removing staging', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  const manager = createManager(cwdRef)
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'slow.bin', size: 4 })
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  let release
  const wait = new Promise((resolve) => { release = resolve })
  const req = Readable.from((async function * () {
    markStarted()
    yield Buffer.from('ab')
    await wait
    yield Buffer.from('cd')
  })())
  req.headers = {
    'content-length': '4',
    'x-dsh-upload-id': initialized.uploadId,
    'x-dsh-file-index': '0',
    'x-dsh-upload-offset': '0',
    'x-dsh-session-scope': 'session',
    'x-dsh-session-id': 'valid',
  }
  const chunk = manager.chunk(req)
  await started
  await new Promise((resolve) => setImmediate(resolve))
  let cancelSettled = false
  const cancel = manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId })
    .finally(() => { cancelSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelSettled, false)
  release()
  assert.equal((await chunk).written, 4)
  assert.deepEqual(await cancel, { cancelled: true })
  assert.equal((await measureDropRoot(root)).size, 0)
})

test('size cleanup retries an inactive staging removal without restart', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let locked = true
  const manager = createManager(cwdRef, Date.now, undefined, {
    removeStage: async (stage) => {
      if (locked) throw Object.assign(new Error('staging locked'), { code: 'EPERM' })
      return removeUploadStage(stage)
    },
  })
  const initialized = await manager.init({ sessionId: 'valid', kind: 'file', name: 'locked.bin', size: 0 })
  await assert.rejects(manager.cancel({ sessionId: 'valid', uploadId: initialized.uploadId }), /staging locked/)
  assert.equal(manager.activeCount(), 1)
  locked = false
  assert.equal(await manager.cleanupBase(), false)
  assert.equal(manager.activeCount(), 0)
  assert.deepEqual(await measureDropRoot(root), { path: join(root, '.dsh-drops'), size: 0, entries: 0 })
})

test('cancelAll cleans other stages while retaining each failed stage for retry', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let locked = true
  const manager = createManager(cwdRef, Date.now, undefined, {
    removeStage: async (stage) => {
      if (locked && stage.name === 'first.bin') throw Object.assign(new Error('first stage locked'), { code: 'EBUSY' })
      return removeUploadStage(stage)
    },
  })
  await manager.init({ sessionId: 'valid', kind: 'file', name: 'first.bin', size: 0 })
  await manager.init({ sessionId: 'valid', kind: 'file', name: 'second.bin', size: 0 })
  await assert.rejects(manager.cancelAll(), /upload staging cleanup failed/)
  assert.equal(manager.activeCount(), 1)
  locked = false
  await manager.cancelAll()
  assert.equal(manager.activeCount(), 0)
  assert.deepEqual(await measureDropRoot(root), { path: join(root, '.dsh-drops'), size: 0, entries: 0 })
})

test('upload manager expires sessions, reclaims staging and enforces the user-root concurrency cap', async (t) => {
  const root = await fixture(t)
  const cwdRef = { value: root }
  let clock = 0
  const manager = createManager(cwdRef, () => clock)
  const active = []
  for (let index = 0; index < 16; index += 1) {
    active.push(await manager.init({ sessionId: 'valid', kind: 'file', name: 'f-' + index, size: 0 }))
  }
  await assert.rejects(
    manager.init({ sessionId: 'valid', kind: 'file', name: 'too-many', size: 0 }),
    (error) => error.status === 429
  )
  assert.equal(manager.activeCount(), 16)

  clock = 11 * 60 * 1000
  const replacement = await manager.init({ sessionId: 'valid', kind: 'file', name: 'after-expiry', size: 3 })
  assert.equal(manager.activeCount(), 1)
  await manager.chunk(chunkRequest(replacement.uploadId, 0, 0, Buffer.from('new')))
  const finished = await manager.finish({ sessionId: 'valid', uploadId: replacement.uploadId })
  assert.equal(await readFile(finished.path, 'utf8'), 'new')
  assert.equal(manager.activeCount(), 0)
})
