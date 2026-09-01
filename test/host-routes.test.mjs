import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, createPathLock } from '../index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-routes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function createRoutes(cwd) {
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
  await apply(ctx)
  return routes
}

async function callRoute(routes, path, options = {}) {
  const raw = options.raw !== undefined
    ? Buffer.from(options.raw)
    : options.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(options.body))
  const req = Readable.from(options.chunks || [raw])
  req.method = options.method || 'POST'
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

test('Host routes return precise request errors', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop', { raw: '{' })).status, 400)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop', { body: {}, contentType: 'text/plain' })).status, 415)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop', { body: {}, origin: 'https://evil.example' })).status, 403)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop', { body: {}, method: 'GET' })).status, 405)
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'PUT', body: {} })).status, 405)
})



test('settings advertises upload protocol and rejects invalid modes', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const settings = await callRoute(routes, '/api/dsh-file-drop/settings', { method: 'GET' })
  assert.equal(settings.status, 200)
  assert.equal(settings.json.uploadProtocolVersion, 2)
  const invalid = await callRoute(routes, '/api/dsh-file-drop/settings', { body: { mode: 'typo' } })
  assert.equal(invalid.status, 400)
})

test('invalid explicit sessions never fall back to DSH_HOME', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const payload = { sessionId: 'missing', name: 'x.txt', size: 1, kind: 'text', content: 'x' }
  const upload = await callRoute(routes, '/api/dsh-file-drop', { body: payload })
  assert.equal(upload.status, 404)
  assert.match(upload.json.error, /session not found/)
  for (const sessionId of [null, '', '   ', 7]) {
    const invalid = await callRoute(routes, '/api/dsh-file-drop', {
      body: { sessionId, name: 'x.txt', size: 1, kind: 'text', content: 'x' },
    })
    assert.equal(invalid.status, 400)
    assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId } })).status, 400)
  }
  assert.equal((await callRoute(routes, '/api/dsh-file-drop/clear', { body: {} })).status, 400)
  const clear = await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId: 'missing' } })
  assert.equal(clear.status, 404)
  const size = await callRoute(routes, '/api/dsh-file-drop/size', { body: { sessionId: 'missing' } })
  assert.equal(size.status, 404)
})

test('single-file route validates and writes decoded bytes', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const text = await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'note.txt', size: 6, kind: 'text', content: '中文' },
  })
  assert.equal(text.status, 200)
  assert.equal(await readFile(text.json.path, 'utf8'), '中文')
  const duplicate = await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'note.txt', size: 3, kind: 'text', content: 'new' },
  })
  assert.equal(duplicate.status, 200)
  assert.notEqual(duplicate.json.path, text.json.path)
  assert.equal(await readFile(text.json.path, 'utf8'), '中文')
  assert.equal(await readFile(duplicate.json.path, 'utf8'), 'new')

  const binary = await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'data.bin', size: 3, kind: 'binary', base64: 'AAEC' },
  })
  assert.equal(binary.status, 200)
  assert.deepEqual([...await readFile(binary.json.path)], [0, 1, 2])

  const invalid = await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'bad.bin', size: 3, kind: 'binary', base64: '%%%%' },
  })
  assert.equal(invalid.status, 400)
  const mismatched = await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'short.bin', size: 1, kind: 'binary', base64: 'AAE=' },
  })
  assert.equal(mismatched.status, 400)
})

test('directory route enforces Host count and path schema before writing', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const valid = await callRoute(routes, '/api/dsh-file-drop/dir', {
    body: {
      sessionId: 'valid',
      dirName: 'folder',
      entries: [
        { kind: 'text', path: 'nested/a.txt', content: 'A' },
        { kind: 'directory', path: 'nested/empty' },
        { kind: 'binary', path: 'b.bin', base64: 'AAE=' },
      ],
    },
  })
  assert.equal(valid.status, 200)
  assert.equal(await readFile(join(valid.json.path, 'nested', 'a.txt'), 'utf8'), 'A')
  assert.equal((await stat(join(valid.json.path, 'nested', 'empty'))).isDirectory(), true)
  const empty = await callRoute(routes, '/api/dsh-file-drop/dir', {
    body: { sessionId: 'valid', dirName: 'empty-folder', entries: [] },
  })
  assert.equal(empty.status, 200)

  const entries = Array.from({ length: 501 }, (_, index) => ({ kind: 'text', path: 'f' + index, content: '' }))
  const tooMany = await callRoute(routes, '/api/dsh-file-drop/dir', {
    body: { sessionId: 'valid', dirName: 'too-many', entries },
  })
  assert.equal(tooMany.status, 413)
  const traversal = await callRoute(routes, '/api/dsh-file-drop/dir', {
    body: { sessionId: 'valid', dirName: 'escape', entries: [{ kind: 'text', path: '../x', content: 'x' }] },
  })
  assert.equal(traversal.status, 400)
})



test('locate route requires protocol v2, valid sessions and challenges', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  const file = { kind: 'file', name: 'x.txt', size: 1, lastModified: 1 }
  const legacy = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 1, phase: 'metadata', file },
  })
  assert.equal(legacy.status, 426)
  const invalidSession = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'metadata', sessionId: 'missing', file },
  })
  assert.equal(invalidSession.status, 404)
  const noChallenge = await callRoute(routes, '/file-drop/locate', {
    body: { protocolVersion: 2, phase: 'sample', sessionId: 'valid', file, candidates: [], digest: '0'.repeat(64) },
  })
  assert.equal(noChallenge.status, 400)
})

test('size and clear routes use the same valid session root', async (t) => {
  const root = await fixture(t)
  const routes = await createRoutes(root)
  await callRoute(routes, '/api/dsh-file-drop', {
    body: { sessionId: 'valid', name: 'note.txt', size: 3, kind: 'text', content: 'abc' },
  })
  const size = await callRoute(routes, '/api/dsh-file-drop/size', { body: { sessionId: 'valid' } })
  assert.equal(size.status, 200)
  assert.equal(size.json.size, 3)
  assert.equal(size.json.entries, 1)
  const clear = await callRoute(routes, '/api/dsh-file-drop/clear', { body: { sessionId: 'valid' } })
  assert.equal(clear.status, 200)
  assert.equal(clear.json.removed, true)
  assert.equal(typeof clear.json.cleanupPending, 'boolean')
  let after
  for (let attempt = 0; attempt < 20; attempt += 1) {
    after = await callRoute(routes, '/api/dsh-file-drop/size', { body: { sessionId: 'valid' } })
    if (after.status === 200 && !after.json.cleanupPending && after.json.size === 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(after.status, 200, after.body)
  assert.equal(after.json.size, 0)
})
