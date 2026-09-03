import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sampleFingerprint } from '../src/locate/fingerprint.js'
import { apply, applyForTest, createPathLock } from '../index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-routes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function createRoutes(cwd, options) {
  const routes = new Map()
  const ctx = {
    sessions: {
      get: (id) => id === 'valid' ? { header: { cwd } } : undefined,
      list: () => [{ header: { cwd } }],
    },
    logger: { warn() {} },
    webServer: {
      register(spec) { routes.set(spec.path, spec.handler); return () => {} },
    },
    effect(register) { return register() },
  }
  await applyForTest(ctx, join(cwd, '.dsh-file-drop-test-settings.json'), {
    ...options,
    uploadBaseDir: options && options.uploadBaseDir ? options.uploadBaseDir : cwd,
  })
  return routes
}

test('production apply reads only declared Cordis injections', async () => {
  const target = {
    sessions: { get() {}, list: () => [] },
    logger: { warn() {} },
    webServer: { register() { return () => {} } },
    effect(register) { return register() },
  }
  const ctx = new Proxy(target, {
    get(object, property) {
      if (!Reflect.has(object, property)) throw new Error('cannot get property "' + String(property) + '" without inject')
      return Reflect.get(object, property)
    },
  })
  await apply(ctx)
})

async function callRoute(routes, path, options = {}) {
  const raw = options.raw !== undefined
    ? Buffer.from(options.raw)
    : options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body))
  const req = Readable.from(options.chunks || [raw])
  req.method = options.method || 'POST'
  req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' }
  req.headers = {
    host: '127.0.0.1:3080',
    ...(options.contentType === false ? {} : { 'content-type': options.contentType || 'application/json' }),
    ...(options.origin === undefined ? { origin: 'http://127.0.0.1:3080' } : options.origin ? { origin: options.origin } : {}),
    ...(options.headers || {}),
  }
  let status
  let headers
  let responseBody = Buffer.alloc(0)
  const res = {
    writeHead(value, valueHeaders) { status = value; headers = valueHeaders || {} },
    end(value) { if (value !== undefined) responseBody = Buffer.from(value) },
  }
  const handler = routes.get(path)
  assert.ok(handler, 'route is registered: ' + path)
  await handler(req, res)
  let json
  try { json = responseBody.length ? JSON.parse(responseBody.toString('utf8')) : undefined } catch { json = undefined }
  return { status, headers, json, body: responseBody.toString('utf8') }
}

const UPLOAD_PATH = '/api/dsh-file-drop/upload'
const SEARCH_ROOTS_PATH = '/api/dsh-file-drop/search-roots'
const CHUNK_BYTES = 4 * 1024 * 1024

async function enableLocate(routes) {
  const response = await callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'locate' } })
  assert.equal(response.status, 200)
}

async function initUpload(routes, body) {
  return callRoute(routes, UPLOAD_PATH + '/init', { body: { protocolVersion: 3, ...body } })
}

async function writeChunk(routes, uploadId, fileIndex, offset, data, options = {}) {
  return callRoute(routes, UPLOAD_PATH + '/chunk', {
    raw: data,
    contentType: options.contentType || 'application/octet-stream',
    headers: {
      'x-dsh-upload-id': uploadId,
      'x-dsh-file-index': String(fileIndex),
      'x-dsh-upload-offset': String(offset),
      'x-dsh-session-scope': options.global ? 'global' : 'session',
      ...(options.global ? {} : { 'x-dsh-session-id': encodeURIComponent(options.sessionId || 'valid') }),
      ...(options.contentLength === false ? {} : { 'content-length': String(data.length) }),
    },
  })
}

async function finishUpload(routes, sessionId, uploadId) {
  return callRoute(routes, UPLOAD_PATH + '/finish', { body: { sessionId, uploadId } })
}

async function cancelUpload(routes, sessionId, uploadId) {
  return callRoute(routes, UPLOAD_PATH + '/cancel', { body: { sessionId, uploadId } })
}



test('path lock serializes aliases of the same physical workspace', async (t) => {
  const root = await fixture(t)
  const workspace = join(root, 'workspace')
  const alias = join(root, 'workspace-alias')
  await mkdir(workspace)
  try {
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) { t.skip('symlink creation is unavailable'); return }
    throw error
  }
  const withPathLock = createPathLock()
  let active = 0
  let maxActive = 0
  const operation = (path) => withPathLock(path, async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 30))
    active -= 1
  })
  await Promise.all([operation(workspace), operation(alias)])
  assert.equal(maxActive, 1)
})

test('Host upload routes enforce method, origin and content type boundaries', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const initPath = UPLOAD_PATH + '/init'
  assert.equal((await callRoute(routes, initPath, { raw: '{' })).status, 400)
  assert.equal((await callRoute(routes, initPath, {
    body: { kind: 'file', name: 'old.txt', size: 0 },
  })).status, 426)
  assert.equal((await callRoute(routes, initPath, { body: {}, contentType: 'text/plain' })).status, 415)
  assert.equal((await callRoute(routes, initPath, { body: {}, origin: 'https://evil.example' })).status, 403)
  assert.equal((await callRoute(routes, initPath, {
    body: {}, origin: 'http://evil.example:3080', headers: { host: 'evil.example:3080' },
  })).status, 403)
  assert.equal((await callRoute(routes, initPath, {
    body: {}, origin: null, remoteAddress: '192.0.2.10',
  })).status, 403)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', {
    method: 'GET', origin: null, contentType: false,
  })).status, 200)
  assert.equal((await callRoute(routes, initPath, { body: {}, method: 'GET' })).status, 405)
  assert.equal((await callRoute(routes, UPLOAD_PATH + '/chunk', { raw: Buffer.from('x') })).status, 415)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'PUT', body: {} })).status, 405)
  assert.equal(routes.has('/api/dsh-file-drop'), false)
  assert.equal(routes.has('/api/dsh-file-drop/dir'), false)
})

test('Host locate route is available only in locate mode', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const request = {
    protocolVersion: 2, phase: 'metadata', sessionId: 'valid',
    file: { kind: 'file', name: 'x.txt', size: 1, lastModified: 1 },
  }
  const blocked = await callRoute(routes, '/file-drop/locate', { body: request })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.message, '当前为上传模式，未定位')
  await enableLocate(routes)
  assert.equal((await callRoute(routes, '/file-drop/locate', { body: request })).status, 200)
})

test('external search root route authorizes lists and revokes roots', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const external = join(root, 'external')
  await mkdir(external)
  const initial = await callRoute(routes, SEARCH_ROOTS_PATH, { method: 'GET' })
  assert.deepEqual(initial.json, { epoch: 0, roots: [] })
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, { method: 'PUT', body: {} })).status, 405)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, { body: {}, contentType: 'text/plain' })).status, 415)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, { body: {}, origin: 'https://evil.example' })).status, 403)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, { body: {} })).status, 400)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: join(root, 'missing') },
  })).status, 400)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external, extra: true },
  })).status, 400)
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'revoke', id: 'not-a-uuid' },
  })).status, 400)

  const added = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external },
  })
  assert.equal(added.status, 200)
  assert.equal(added.json.epoch, 1)
  assert.equal(added.json.roots.length, 1)
  assert.equal(added.json.roots[0].path, await realpath(external))
  const id = added.json.roots[0].id
  const duplicate = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external },
  })
  assert.deepEqual(duplicate.json, added.json)
  const revoked = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'revoke', id },
  })
  assert.deepEqual(revoked.json, { epoch: 2, roots: [] })
  assert.equal((await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'revoke', id },
  })).status, 404)
})

test('authorized external root extends the real locate route', async (t) => {
  const workspace = await fixture(t)
  const external = await mkdtemp(join(tmpdir(), 'dsh-file-drop-route-external-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  const filePath = join(external, 'outside-route.txt')
  await writeFile(filePath, 'route-external-content')
  const info = await stat(filePath)
  const routes = await createRoutes(workspace)
  await enableLocate(routes)
  const initial = await callRoute(routes, '/file-drop/locate', {
    body: {
      protocolVersion: 2, phase: 'metadata', sessionId: 'valid',
      file: { kind: 'file', name: 'outside-route.txt', size: info.size, lastModified: info.mtimeMs },
    },
  })
  assert.equal(initial.status, 200)
  assert.equal(initial.json.status, 'not-found')

  const authorized = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external },
  })
  assert.equal(authorized.status, 200)
  const canonicalPath = join(authorized.json.roots[0].path, 'outside-route.txt')
  const file = { kind: 'file', name: 'outside-route.txt', size: info.size, lastModified: info.mtimeMs }
  const metadata = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'metadata', sessionId: 'valid', file },
  })
  assert.equal(metadata.json.status, 'sample-required')
  assert.deepEqual(metadata.json.candidates, [canonicalPath])
  const sample = await callRoute(routes, '/file-drop/locate', {
    body: {
      protocolVersion: 2, phase: 'sample', sessionId: 'valid', file,
      digest: await sampleFingerprint(canonicalPath, info.size), challenge: metadata.json.challenge,
    },
  })
  assert.deepEqual(sample.json, { status: 'found', path: canonicalPath })
})

test('authorized external root extends real directory locating', async (t) => {
  const workspace = await fixture(t)
  const external = await mkdtemp(join(tmpdir(), 'dsh-file-drop-route-directory-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  const firstDirectory = join(external, 'group-a', 'outside-dir')
  const secondDirectory = join(external, 'group-b', 'outside-dir')
  await mkdir(firstDirectory, { recursive: true })
  await mkdir(secondDirectory, { recursive: true })
  const firstChild = join(firstDirectory, 'child.txt')
  const secondChild = join(secondDirectory, 'child.txt')
  await writeFile(firstChild, 'directory-content')
  await writeFile(secondChild, 'different-content')
  const childInfo = await stat(firstChild)
  const routes = await createRoutes(workspace)
  await enableLocate(routes)
  const authorized = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external },
  })
  const canonicalRoot = authorized.json.roots[0].path
  const canonicalDirectory = join(canonicalRoot, 'group-a', 'outside-dir')
  const file = { kind: 'directory', name: 'outside-dir' }
  const structure = {
    truncated: false,
    entries: [{ path: 'child.txt', kind: 'file', size: childInfo.size }],
  }
  const metadata = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'metadata', sessionId: 'valid', file },
  })
  assert.equal(metadata.json.status, 'directory-structure-required')
  const structureResult = await callRoute(routes, '/file-drop/locate', {
    body: {
      protocolVersion: 2, phase: 'directory-structure', sessionId: 'valid',
      file: { ...file, structure }, candidates: metadata.json.candidates, challenge: metadata.json.challenge,
    },
  })
  assert.equal(structureResult.json.status, 'directory-content-required')
  assert.equal(structureResult.json.candidates.length, 2)
  const sample = {
    path: 'child.txt', size: childInfo.size,
    digest: await sampleFingerprint(firstChild, childInfo.size),
  }
  const contentResult = await callRoute(routes, '/file-drop/locate', {
    body: {
      protocolVersion: 2, phase: 'directory-content', sessionId: 'valid',
      file: { ...file, structure }, candidates: structureResult.json.candidates,
      directorySamples: [sample], challenge: structureResult.json.challenge,
    },
  })
  assert.deepEqual(contentResult.json, { status: 'found', path: canonicalDirectory })
})

test('locate response is written before external root revoke completes', async (t) => {
  const workspace = await fixture(t)
  const external = await mkdtemp(join(tmpdir(), 'dsh-file-drop-route-lock-'))
  t.after(() => rm(external, { recursive: true, force: true }))
  let release
  let markStarted
  const pending = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const routes = await createRoutes(workspace, {
    locateFn: async () => { markStarted(); await pending; return { status: 'not-found' } },
  })
  await enableLocate(routes)
  const authorized = await callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'authorize', path: external },
  })
  const locate = callRoute(routes, '/file-drop/locate', {
    body: {
      protocolVersion: 2, phase: 'metadata', sessionId: 'valid',
      file: { kind: 'file', name: 'blocked.txt', size: 1, lastModified: 1 },
    },
  })
  await started
  let revokeDone = false
  const revoke = callRoute(routes, SEARCH_ROOTS_PATH, {
    body: { action: 'revoke', id: authorized.json.roots[0].id },
  }).then((result) => { revokeDone = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(revokeDone, false)
  release()
  assert.equal((await locate).status, 200)
  assert.equal((await revoke).status, 200)
  assert.equal(revokeDone, true)
})

test('switching to upload waits for an in-flight locate response', async (t) => {
  const root = await fixture(t)
  let release
  let markStarted
  const pending = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const routes = await createRoutes(root, {
    locateFn: async () => { markStarted(); await pending; return { status: 'not-found' } },
  })
  await enableLocate(routes)
  const request = {
    protocolVersion: 2, phase: 'metadata', sessionId: 'valid',
    file: { kind: 'file', name: 'x.txt', size: 1, lastModified: 1 },
  }
  const locating = callRoute(routes, '/file-drop/locate', { body: request })
  await started
  let switched = false
  const switching = callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'upload' } })
    .then((result) => { switched = true; return result })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(switched, false)
  release()
  assert.equal((await locating).status, 200)
  assert.equal((await switching).json.mode, 'upload')
  assert.equal((await callRoute(routes, '/file-drop/locate', { body: request })).status, 409)
})

test('settings persists the complete latest mode and quota schema', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const settings = await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET' })
  assert.equal(settings.status, 200)
  assert.deepEqual(settings.json, {
    mode: 'upload',
    uploadQuotaMiB: 10000,
    uploadQuotaEntries: 10000,
  })
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', { body: {} })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 },
  })).status, 400)
  const located = await callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'locate' } })
  assert.equal(located.status, 200)
  const saved = await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { uploadQuotaMiB: 64, uploadQuotaEntries: 77 },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.mode, 'locate')
  assert.equal(saved.json.uploadQuotaMiB, 64)
  assert.equal(saved.json.uploadQuotaEntries, 77)
  assert.deepEqual((await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET' })).json, saved.json)
})

test('concurrent mode and quota patches cannot overwrite each other across tabs', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const [modeResult, quotaResult] = await Promise.all([
    callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'locate' } }),
    callRoute(routes, '/api/dsh-file-drop/settings', { body: { uploadQuotaMiB: 222, uploadQuotaEntries: 333 } }),
  ])
  assert.equal(modeResult.status, 200)
  assert.equal(quotaResult.status, 200)
  assert.deepEqual((await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET' })).json, {
    mode: 'locate', uploadQuotaMiB: 222, uploadQuotaEntries: 333,
  })
})

test('corrupt settings fail closed and cannot enable an upload', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await writeFile(join(root, '.dsh-file-drop-test-settings.json'), '{', 'utf8')
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET' })).status, 500)
  const blocked = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'blocked.txt', size: 1 })
  assert.equal(blocked.status, 500)
  await assert.rejects(stat(join(root, '.dsh-drops')), (error) => error.code === 'ENOENT')
})

test('locate mode rejects file and directory upload before staging is created', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { mode: 'locate' },
  })
  for (const payload of [
    { sessionId: 'valid', kind: 'file', name: 'blocked.txt', size: 1 },
    { sessionId: 'valid', kind: 'directory', name: 'blocked-dir', entries: [] },
  ]) {
    const blocked = await initUpload(routes, payload)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.json.code, 'locate_mode')
    assert.equal(blocked.json.error, '当前为定位模式，未上传')
  }
  await assert.rejects(stat(join(root, '.dsh-drops')), (error) => error.code === 'ENOENT')
})

test('switching to locate mode cancels active staging before settings save completes', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const active = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'active.bin', size: 3 })
  assert.equal(active.status, 200)
  const located = await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { mode: 'locate' },
  })
  assert.equal(located.status, 200)
  assert.equal((await writeChunk(routes, active.json.uploadId, 0, 0, Buffer.from('abc'))).status, 404)
  await assert.rejects(stat(join(root, '.dsh-drops', '.dsh-upload-staging')), (error) => error.code === 'ENOENT')
  const usage = await callRoute(routes, '/api/dsh-file-drop/size', { body: {} })
  assert.equal(usage.json.size, 0)
  assert.equal(usage.json.entries, 0)
})

test('locate mode save succeeds and stays authoritative when staging deletion must retry', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root, { uploadManager: {
    removeStage: async () => { throw Object.assign(new Error('staging locked'), { code: 'EPERM' }) },
  } })
  const initialized = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'locked.bin', size: 0 })
  assert.equal(initialized.status, 200)
  const changed = await callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'locate' } })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.mode, 'locate')
  assert.equal((await finishUpload(routes, 'valid', initialized.json.uploadId)).status, 409)
  const readBack = await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET', contentType: false })
  assert.equal(readBack.status, 200)
  assert.equal(readBack.json.mode, 'locate')
})

test('size reclaims restart-orphaned staging while locate mode remains active', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'locate' } })
  const orphan = join(root, '.dsh-drops', '.dsh-upload-staging', '11111111-1111-4111-8111-111111111111.dir')
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, 'partial.bin'), 'partial')
  const usage = await callRoute(routes, '/api/dsh-file-drop/size', { body: {} })
  assert.equal(usage.status, 200)
  assert.equal(usage.json.size, 0)
  assert.equal(usage.json.entries, 0)
  await assert.rejects(stat(join(root, '.dsh-drops', '.dsh-upload-staging')), (error) => error.code === 'ENOENT')
})

test('configured byte and entry quotas reject init with a cleanup prompt', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { uploadQuotaMiB: 1, uploadQuotaEntries: 2 },
  })
  const oversized = await initUpload(routes, {
    sessionId: 'valid', kind: 'file', name: 'large.bin', size: 1024 * 1024 + 1,
  })
  assert.equal(oversized.status, 413)
  assert.equal(oversized.json.code, 'quota_exceeded')
  assert.equal(oversized.json.error, '已达上传配额，需清理 .dsh-drops')

  await callRoute(routes, '/api/dsh-file-drop/settings', {
    body: { uploadQuotaMiB: 1, uploadQuotaEntries: 1 },
  })
  const tooManyEntries = await initUpload(routes, {
    sessionId: 'valid', kind: 'file', name: 'entry.bin', size: 0,
  })
  assert.equal(tooManyEntries.status, 413)
  assert.equal(tooManyEntries.json.code, 'quota_exceeded')
})

test('invalid explicit sessions are rejected before touching the user upload root', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const payload = { sessionId: 'missing', name: 'x.txt', size: 1, kind: 'file' }
  const upload = await initUpload(routes, payload)
  assert.equal(upload.status, 404)
  assert.match(upload.json.error, /session not found/)
  for (const sessionId of [null, '', '   ', 7]) {
    const invalid = await initUpload(routes, { sessionId, name: 'x.txt', size: 1, kind: 'file' })
    assert.equal(invalid.status, 400)
    assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId } })).status, 400)
  }
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: {} })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId: 'valid', global: true } })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: { global: true, extra: true } })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId: 'missing' } })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/size', { body: { sessionId: 'missing' } })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/size', { body: { sessionId: 'valid' } })).status, 400)
  await assert.rejects(stat(join(root, '.dsh-drops')), (error) => error.code === 'ENOENT')
})

test('single-file upload streams exact chunks and numbers duplicate names', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const first = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'note.txt', size: 6 })
  assert.equal(first.status, 200)
  assert.equal((await writeChunk(routes, first.json.uploadId, 0, 0, Buffer.from('中文'), { sessionId: 'other' })).status, 409)
  assert.equal((await writeChunk(routes, first.json.uploadId, 0, 0, Buffer.from('中文'))).status, 200)
  const text = await finishUpload(routes, 'valid', first.json.uploadId)
  assert.equal(text.status, 200)
  assert.equal(await readFile(text.json.path, 'utf8'), '中文')

  const second = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'note.txt', size: 3 })
  await writeChunk(routes, second.json.uploadId, 0, 0, Buffer.from('new'))
  const duplicate = await finishUpload(routes, 'valid', second.json.uploadId)
  assert.equal(duplicate.status, 200)
  assert.notEqual(duplicate.json.path, text.json.path)
  assert.equal(await readFile(text.json.path, 'utf8'), '中文')
  assert.equal(await readFile(duplicate.json.path, 'utf8'), 'new')

  const largeSize = 25 * 1024 * 1024 + 3
  const binaryInit = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'large.bin', size: largeSize })
  for (let offset = 0; offset < largeSize; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, largeSize - offset)
    const data = Buffer.alloc(length, Math.floor(offset / CHUNK_BYTES) + 1)
    assert.equal((await writeChunk(routes, binaryInit.json.uploadId, 0, offset, data)).status, 200)
  }
  const binary = await finishUpload(routes, 'valid', binaryInit.json.uploadId)
  assert.equal(binary.status, 200)
  const stored = await readFile(binary.json.path)
  assert.equal(stored.length, largeSize)
  assert.equal(stored[0], 1)
  assert.equal(stored[CHUNK_BYTES], 2)
  assert.equal(stored.at(-1), 7)

  const oldPayload = await initUpload(routes, {
    sessionId: 'valid', kind: 'file', name: 'old.bin', size: 1, base64: 'AA==',
  })
  assert.equal(oldPayload.status, 400)
})

test('directory upload streams each file, preserves empty directories and validates manifests', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const valid = await initUpload(routes, {
    sessionId: 'valid',
    kind: 'directory',
    name: 'folder',
    entries: [
      { kind: 'file', path: 'nested/a.txt', size: 1 },
      { kind: 'directory', path: 'nested/empty' },
      { kind: 'file', path: 'b.bin', size: 2 },
    ],
  })
  assert.equal(valid.status, 200)
  await writeChunk(routes, valid.json.uploadId, 0, 0, Buffer.from('A'))
  await writeChunk(routes, valid.json.uploadId, 1, 0, Buffer.from([0, 1]))
  const finished = await finishUpload(routes, 'valid', valid.json.uploadId)
  assert.equal(finished.status, 200)
  assert.equal(await readFile(join(finished.json.path, 'nested', 'a.txt'), 'utf8'), 'A')
  assert.equal((await stat(join(finished.json.path, 'nested', 'empty'))).isDirectory(), true)

  const empty = await initUpload(routes, { sessionId: 'valid', kind: 'directory', name: 'empty-folder', entries: [] })
  assert.equal((await finishUpload(routes, 'valid', empty.json.uploadId)).status, 200)
  const large = await initUpload(routes, {
    sessionId: 'valid', kind: 'directory', name: 'large-folder',
    entries: [{ kind: 'file', path: 'large.bin', size: 80 * 1024 * 1024 }],
  })
  assert.equal(large.status, 200)
  assert.equal((await cancelUpload(routes, 'valid', large.json.uploadId)).json.cancelled, true)

  const entries = Array.from({ length: 501 }, (_, index) => ({ kind: 'file', path: 'f' + index, size: 0 }))
  assert.equal((await initUpload(routes, { sessionId: 'valid', kind: 'directory', name: 'too-many', entries })).status, 413)
  assert.equal((await initUpload(routes, {
    sessionId: 'valid', kind: 'directory', name: 'escape', entries: [{ kind: 'file', path: '../x', size: 1 }],
  })).status, 400)
})



test('locate route requires protocol v2, valid sessions and challenges', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await enableLocate(routes)
  const file = { kind: 'file', name: 'x.txt', size: 1, lastModified: 1 }
  const unsupported = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 1, phase: 'metadata', file },
  })
  assert.equal(unsupported.status, 426)
  const invalidSession = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'metadata', sessionId: 'missing', file },
  })
  assert.equal(invalidSession.status, 404)
  const noChallenge = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'sample', sessionId: 'valid', file, candidates: [], digest: '0'.repeat(64) },
  })
  assert.equal(noChallenge.status, 400)
})

test('upload, size and clear use one user root instead of the session workspace', async (t) => {
  const workspace = await fixture(t)
  const uploadRoot = await fixture(t)
  const routes = await createRoutes(workspace, { uploadBaseDir: uploadRoot })
  const initialized = await initUpload(routes, { sessionId: 'valid', kind: 'file', name: 'note.txt', size: 3 })
  await writeChunk(routes, initialized.json.uploadId, 0, 0, Buffer.from('abc'))
  const finished = await finishUpload(routes, 'valid', initialized.json.uploadId)
  assert.equal(finished.status, 200)
  assert.equal(finished.json.path.startsWith(join(uploadRoot, '.dsh-drops')), true)
  await assert.rejects(stat(join(workspace, '.dsh-drops')), (error) => error.code === 'ENOENT')

  const size = await callRoute(routes, '/api/dsh-file-drop/size', { body: {} })
  assert.equal(size.status, 200)
  assert.equal(size.json.path, join(uploadRoot, '.dsh-drops'))
  assert.equal(size.json.size, 3)
  assert.equal(size.json.entries, 1)
  const clear = await callRoute(routes, '/api/dsh-file-drop/clear', { body: { global: true } })
  assert.equal(clear.status, 200)
  assert.equal(clear.json.removed, true)
  assert.equal(typeof clear.json.cleanupPending, 'boolean')
  let after
  for (let attempt = 0; attempt < 20; attempt += 1) {
    after = await callRoute(routes, '/api/dsh-file-drop/size', { body: {} })
    if (after.status === 200 && !after.json.cleanupPending && after.json.size === 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(after.status, 200, after.body)
  assert.equal(after.json.size, 0)
  assert.equal(after.json.entries, 0)
})
