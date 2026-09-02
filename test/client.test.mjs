import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { test } from 'node:test'

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value },
  },
}
await import('../client.js?client-test')
const plugin = definition.factory((name) => {
  if (name === 'react') return {}
  throw new Error('unexpected module: ' + name)
})
const client = plugin.__test



test('multi-composer drop ownership never uses registration order as an ambiguous fallback', () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  assert.equal(client.chooseDropOwner([first, second]), undefined)
  assert.equal(client.chooseDropOwner([first, second], [first]), first)
  assert.equal(client.chooseDropOwner([first, second], [], [second]), second)
  assert.equal(client.chooseDropOwner([first, second], [first, second]), undefined)
  assert.equal(client.chooseDropOwner([first]), first)
})



test('upload and locate mode actions are mutually exclusive', () => {
  const shellPaths = ['C:\\source\\file.txt']
  const extractedPaths = ['/source/file.txt']
  assert.deepEqual(client.chooseDropAction('upload', {
    shellPaths, extractedPaths, fileCount: 1,
  }), { type: 'upload-files' })
  assert.deepEqual(client.chooseDropAction('upload', {
    shellPaths, extractedPaths, directoryCount: 1, fileCount: 1,
  }), { type: 'upload-directories' })
  assert.deepEqual(client.chooseDropAction('upload', {
    shellPaths, extractedPaths,
  }), { type: 'none' })
  assert.deepEqual(client.chooseDropAction('locate', {
    shellPaths, extractedPaths, directoryCount: 1, fileCount: 1,
  }), { type: 'insert-paths', paths: shellPaths })
  assert.deepEqual(client.chooseDropAction('locate', {
    extractedPaths, directoryCount: 1,
  }), { type: 'insert-paths', paths: extractedPaths })
  assert.deepEqual(client.chooseDropAction('locate', { directoryCount: 1 }), { type: 'locate-directories' })
  assert.deepEqual(client.chooseDropAction('locate', { fileCount: 1 }), { type: 'locate-files' })
})

test('upload always copies file content in bounded chunks without reading an original path', async (t) => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const originalDesktop = window.dshDesktop
  let shellPathReads = 0
  let draft = ''
  const requests = []
  const chunks = []
  window.dshDesktop = {
    getPathForFile() {
      shellPathReads += 1
      return 'C:\\source\\original.txt'
    },
  }
  globalThis.document = { querySelectorAll: () => [] }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    if (url.endsWith('/init')) {
      const body = JSON.parse(options.body)
      assert.deepEqual(body, { sessionId: 'session / 中文', kind: 'file', name: 'original.txt', size: 7 })
      return { ok: true, json: async () => ({ uploadId: 'upload-1', chunkBytes: 4, fileCount: 1, totalBytes: 7 }) }
    }
    if (url.endsWith('/chunk')) {
      assert.equal(options.headers['x-dsh-session-scope'], 'session')
      assert.equal(decodeURIComponent(options.headers['x-dsh-session-id']), 'session / 中文')
      const bytes = Buffer.from(await options.body.arrayBuffer())
      chunks.push(bytes)
      const offset = Number(options.headers['x-dsh-upload-offset'])
      return { ok: true, json: async () => ({ written: offset + bytes.length, size: 7 }) }
    }
    if (url.endsWith('/finish')) {
      return { ok: true, json: async () => ({ path: 'C:\\Users\\test\\.dsh\\.dsh-drops\\copied.txt' }) }
    }
    throw new Error('unexpected URL: ' + url)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.document = originalDocument
    window.dshDesktop = originalDesktop
    client.statusStore.clear()
  })

  await client.processFilesUpload([new File(['copy me'], 'original.txt', { type: 'text/plain' })], {
    sessionId: 'session / 中文',
    inputActions: { setDraft(value) { draft = value } },
    getDraft: () => '',
    isActive: () => true,
  })

  assert.equal(shellPathReads, 0)
  assert.deepEqual(requests.map((request) => request.url), [
    '/api/dsh-file-drop/upload/init',
    '/api/dsh-file-drop/upload/chunk',
    '/api/dsh-file-drop/upload/chunk',
    '/api/dsh-file-drop/upload/finish',
  ])
  assert.deepEqual(chunks.map((chunk) => chunk.length), [4, 3])
  assert.equal(Buffer.concat(chunks).toString(), 'copy me')
  assert.match(draft, /[.]dsh-drops\\copied[.]txt/)
  assert.doesNotMatch(draft, /source\\original[.]txt/)
})

test('file URI and retry context stay platform-neutral', () => {
  assert.equal(client.fileUriToPath('file:///C:/Users/Test/report.txt'), 'C:\\Users\\Test\\report.txt')
  assert.equal(client.fileUriToPath('file:///home/test/report.txt'), '/home/test/report.txt')
  assert.equal(client.fileUriToPath('file://localhost/home/test/report.txt'), '/home/test/report.txt')
  assert.equal(client.fileUriToPath('file://server/share/report.txt'), '//server/share/report.txt')
  assert.deepEqual(client.retryWorkspaceContext({
    workspacePaths: ['C:\\Work', 'D:\\Other'],
    sessionId: 'session-1',
  }, 'C:\\Work'), {
    workspacePaths: ['C:\\Work', 'D:\\Other'],
    excludedWorkspacePaths: ['C:\\Work'],
    sessionId: 'session-1',
  })
})

test('complete settings refresh is shared and failures fall closed to locate', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  const expected = { mode: 'locate', uploadQuotaMiB: 9000, uploadQuotaEntries: 8000 }
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setImmediate(resolve))
    return { ok: true, json: async () => expected }
  }
  assert.deepEqual(await Promise.all([
    client.refreshSettings(),
    client.refreshSettings(),
  ]), [expected, expected])
  assert.equal(calls, 1)

  const defaults = { mode: 'locate', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...expected, obsolete: true }) })
  assert.deepEqual(await client.refreshSettings(), defaults)
  globalThis.fetch = async () => { throw new Error('offline') }
  assert.deepEqual(await client.refreshSettings(), defaults)
})

test('queued setting writes send atomic patches and read back the Host result', async (t) => {
  const originalFetch = globalThis.fetch
  const writes = []
  let server = { mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 }
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, '/api/dsh-file-drop/settings')
    if (options.method === 'POST') {
      const patch = JSON.parse(options.body)
      writes.push(patch)
      server = { ...server, ...patch }
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { ok: true, json: async () => ({ ...server }) }
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const results = await Promise.all([
    client.writeSettings({ uploadQuotaMiB: 4321, uploadQuotaEntries: 321 }),
    client.writeSettings({ mode: 'locate' }),
  ])
  assert.deepEqual(writes, [
    { uploadQuotaMiB: 4321, uploadQuotaEntries: 321 },
    { mode: 'locate' },
  ])
  assert.deepEqual(results[1], { mode: 'locate', uploadQuotaMiB: 4321, uploadQuotaEntries: 321 })
})

test('action preflight refreshes stale upload mode and fails closed when settings are unavailable', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let server = { mode: 'upload', uploadQuotaMiB: 4321, uploadQuotaEntries: 321 }
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') server = { ...server, ...JSON.parse(options.body) }
    return { ok: true, json: async () => ({ ...server }) }
  }
  await client.writeSettings({ mode: 'upload' })
  server.mode = 'locate'
  assert.equal(await client.refreshModeForAction(), 'locate')
  globalThis.fetch = async () => { throw new Error('offline') }
  await assert.rejects(client.refreshModeForAction(), /offline/)

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'save failed' }) })
  await assert.rejects(client.writeSettings({ mode: 'locate' }), /save failed/)
  let reads = 0
  globalThis.fetch = async () => { reads += 1; throw new Error('must not read after failed save') }
  await assert.rejects(client.refreshModeForAction(), /save failed/)
  assert.equal(reads, 0)

  server = { mode: 'locate', uploadQuotaMiB: 4321, uploadQuotaEntries: 321 }
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') server = { ...server, ...JSON.parse(options.body) }
    return { ok: true, json: async () => ({ ...server }) }
  }
  await client.writeSettings({ mode: 'locate' })
})

test('switching to upload remains fail-closed until the Host confirms it', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch; client.beginModeChange('locate') })
  assert.equal(client.beginModeChange('locate'), 'locate')
  assert.equal(client.beginModeChange('upload'), 'locate')
  let server = { mode: 'locate', uploadQuotaMiB: 4321, uploadQuotaEntries: 321 }
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'POST') server = { ...server, ...JSON.parse(options.body) }
    return { ok: true, json: async () => ({ ...server }) }
  }
  assert.deepEqual(await client.writeSettings({ mode: 'upload' }), {
    mode: 'upload', uploadQuotaMiB: 4321, uploadQuotaEntries: 321,
  })
})

test('usage and clear requests always target the shared user upload root', async (t) => {
  const originalFetch = globalThis.fetch
  const requests = []
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) })
    return { ok: true, json: async () => url.endsWith('/size')
      ? { path: 'C:\\Users\\test\\.dsh\\.dsh-drops', size: 7, entries: 1 }
      : { path: 'C:\\Users\\test\\.dsh\\.dsh-drops', removed: true } }
  }
  assert.equal((await client.readUserUploadUsage()).data.size, 7)
  assert.equal((await client.clearUserUploadRoot()).data.removed, true)
  assert.deepEqual(requests, [
    { url: '/api/dsh-file-drop/size', method: 'POST', body: {} },
    { url: '/api/dsh-file-drop/clear', method: 'POST', body: { global: true } },
  ])
})

test('client chunk uploader preserves arbitrary bytes without a whole-file read', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const source = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62, 0x00])
  const slices = []
  const received = []
  const file = {
    name: 'raw.bin',
    size: source.length,
    arrayBuffer() { throw new Error('whole-file read is forbidden') },
    slice(start, end, type) {
      slices.push({ start, end, type })
      return new Blob([source.slice(start, end)], { type })
    },
  }
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/init')) {
      return { ok: true, json: async () => ({ uploadId: 'raw-upload', chunkBytes: 3, fileCount: 1, totalBytes: source.length }) }
    }
    if (url.endsWith('/chunk')) {
      const bytes = Buffer.from(await options.body.arrayBuffer())
      received.push(bytes)
      const offset = Number(options.headers['x-dsh-upload-offset'])
      return { ok: true, json: async () => ({ written: offset + bytes.length, size: source.length }) }
    }
    if (url.endsWith('/finish')) return { ok: true, json: async () => ({ path: '/home/test/.dsh/.dsh-drops/raw.bin' }) }
    throw new Error('unexpected URL: ' + url)
  }

  const result = await client.uploadChunked({ kind: 'file', name: file.name, size: file.size }, [file])
  assert.equal(result.path, '/home/test/.dsh/.dsh-drops/raw.bin')
  assert.deepEqual(slices, [
    { start: 0, end: 3, type: 'application/octet-stream' },
    { start: 3, end: 6, type: 'application/octet-stream' },
    { start: 6, end: 7, type: 'application/octet-stream' },
  ])
  assert.deepEqual(Buffer.concat(received), Buffer.from(source))
})

test('client cancels staging after a chunk fails', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let cancelled
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/init')) {
      return { ok: true, json: async () => ({ uploadId: 'failed-upload', chunkBytes: 4, fileCount: 1, totalBytes: 4 }) }
    }
    if (url.endsWith('/chunk')) return { ok: false, status: 503, json: async () => ({ error: 'disk full' }) }
    if (url.endsWith('/cancel')) {
      cancelled = JSON.parse(options.body)
      return { ok: true, json: async () => ({ cancelled: true }) }
    }
    throw new Error('unexpected URL: ' + url)
  }
  await assert.rejects(
    client.uploadChunked({ kind: 'file', name: 'x.bin', size: 4 }, [new File(['data'], 'x.bin')]),
    /disk full/
  )
  assert.deepEqual(cancelled, { uploadId: 'failed-upload' })
})

test('client stops the batch and asks for cleanup when Host reports quota reached', async (t) => {
  const originalFetch = globalThis.fetch
  let initCalls = 0
  globalThis.fetch = async (url) => {
    if (!url.endsWith('/init')) throw new Error('unexpected URL: ' + url)
    initCalls += 1
    return {
      ok: false,
      status: 413,
      json: async () => ({ code: 'quota_exceeded', error: 'server detail' }),
    }
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    client.statusStore.clear()
  })
  await client.processFilesUpload([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')], {
    inputActions: { setDraft() {} },
    getDraft: () => '',
    isActive: () => true,
  })
  assert.equal(initCalls, 1)
  assert.equal(client.statusStore.value, '✗ 已达上传配额，需清理 .dsh-drops')
})

function fileEntry(name) {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve) { resolve(new File(['x'], name)) },
  }
}

function directoryEntry(children, name = 'root') {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let sent = false
      return {
        readEntries(resolve) {
          const batch = sent ? [] : children
          sent = true
          queueMicrotask(() => resolve(batch))
        },
      }
    },
  }
}



test('upload and locate modes both own images and every other file', () => {
  const itemImage = { types: ['Files'], items: [{ kind: 'file', type: 'image/png' }] }
  const fileImage = { types: ['Files'], items: [], files: [{ type: 'image/jpeg' }] }
  assert.equal(client.shouldHandleDataTransfer(itemImage, 'upload'), true)
  assert.equal(client.shouldHandleDataTransfer(fileImage, 'upload'), true)
  assert.equal(client.shouldHandleDataTransfer(itemImage, 'locate'), true)
  assert.equal(client.shouldHandleDataTransfer(fileImage, 'locate'), true)
  assert.equal(client.shouldHandleDataTransfer({ types: ['Files'], items: [{ kind: 'file', type: '' }] }), true)
  assert.equal(client.shouldHandleDataTransfer({
    types: ['Files'],
    items: [{ kind: 'file', type: 'image/png' }, { kind: 'file', type: 'text/plain' }],
  }), true)
  assert.equal(client.shouldHandleDataTransfer({ types: ['text/plain'], items: [] }), false)
})

test('client directory reader exposes the 501st file instead of silently truncating at 500', async () => {
  const root = directoryEntry(Array.from({ length: 501 }, (_, index) => fileEntry('f-' + index)))
  const entries = await client.readEntryAll(root, 501, { count: 0 })
  assert.equal(entries.length, 501)
})



test('client directory reader keeps nested empty directories', async () => {
  const root = directoryEntry([directoryEntry([], 'empty')])
  const entries = await client.readEntryAll(root, 501, { count: 0, entries: 0 }, undefined, false, 10001)
  assert.deepEqual(entries, [{ path: 'empty', kind: 'directory' }])
})

test('client directory reader preserves backslashes inside POSIX names', async () => {
  const root = directoryEntry([fileEntry('a\\b.txt')])
  const entries = await client.readEntryAll(root, 501, { count: 0, entries: 0 })
  assert.equal(entries[0].path, 'a\\b.txt')
  assert.equal(entries[0].kind, 'file')
  assert.equal(entries[0].file.name, 'a\\b.txt')
})

test('client directory upload sends a content-free manifest and streams file bytes', async (t) => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  globalThis.document = { querySelectorAll: () => [] }
  let manifest
  let draft = ''
  const chunks = []
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/init')) {
      manifest = JSON.parse(options.body)
      return { ok: true, json: async () => ({ uploadId: 'dir-upload', chunkBytes: 2, fileCount: 1, totalBytes: 1 }) }
    }
    if (url.endsWith('/chunk')) {
      const bytes = Buffer.from(await options.body.arrayBuffer())
      chunks.push(bytes)
      return { ok: true, json: async () => ({ written: bytes.length, size: 1 }) }
    }
    if (url.endsWith('/finish')) {
      return { ok: true, json: async () => ({ path: '/home/test/.dsh/.dsh-drops/root', cleanupPending: false }) }
    }
    throw new Error('unexpected URL: ' + url)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.document = originalDocument
    client.statusStore.clear()
  })

  await client.processDirectoryUpload(directoryEntry([
    fileEntry('a.txt'),
    directoryEntry([], 'empty'),
  ]), {
    inputActions: { setDraft(value) { draft = value } },
    getDraft: () => '',
    isActive: () => true,
  })

  assert.deepEqual(manifest, {
    kind: 'directory',
    name: 'root',
    entries: [
      { kind: 'file', path: 'a.txt', size: 1 },
      { kind: 'directory', path: 'empty' },
    ],
  })
  assert.equal(JSON.stringify(manifest).includes('content'), false)
  assert.equal(Buffer.concat(chunks).toString(), 'x')
  assert.match(draft, /[.]dsh-drops\/root/)
})



test('client directory reader aborts after a FileSystemEntry callback hangs', async () => {
  for (const entry of [
    { isFile: true, isDirectory: false, file() {} },
    { isFile: false, isDirectory: true, createReader: () => ({ readEntries() {} }) },
  ]) {
    const controller = new AbortController()
    const pending = client.readEntryAll(entry, 501, { count: 0 }, controller.signal)
    controller.abort()
    await assert.rejects(pending, (error) => error && error.name === 'AbortError')
  }
})

test('client directory reader rejects an already aborted operation', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    client.readEntryAll(directoryEntry([]), 501, { count: 0 }, controller.signal),
    (error) => error && error.name === 'AbortError'
  )
})
