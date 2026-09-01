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

function bytesOfPayload(payload) {
  return payload.kind === 'text'
    ? Buffer.from(payload.content, 'utf8')
    : Buffer.from(payload.base64, 'base64')
}



test('multi-composer drop ownership never uses registration order as an ambiguous fallback', () => {
  const first = { id: 'first' }
  const second = { id: 'second' }
  assert.equal(client.chooseDropOwner([first, second]), undefined)
  assert.equal(client.chooseDropOwner([first, second], [first]), first)
  assert.equal(client.chooseDropOwner([first, second], [], [second]), second)
  assert.equal(client.chooseDropOwner([first, second], [first, second]), undefined)
  assert.equal(client.chooseDropOwner([first]), first)
})



test('settings capability refresh is shared, abortable and explicitly downgrades v2', async (t) => {
  await new Promise((resolve) => setImmediate(resolve))
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((resolve) => setImmediate(resolve))
    return { ok: true, json: async () => ({ mode: 'upload', uploadProtocolVersion: 2 }) }
  }
  assert.deepEqual(await Promise.all([
    client.refreshUploadCapability(),
    client.refreshUploadCapability(),
  ]), [true, true])
  assert.equal(calls, 1)
  assert.deepEqual(client.capabilitySnapshot(), { uploadProtocolVersion: 2, uploadProtocolKnown: true })

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ mode: 'upload' }) })
  assert.equal(await client.refreshUploadCapability(), true)
  assert.deepEqual(client.capabilitySnapshot(), { uploadProtocolVersion: 1, uploadProtocolKnown: true })

  let release
  globalThis.fetch = () => new Promise((resolve) => { release = resolve })
  const controller = new AbortController()
  const pending = client.refreshUploadCapability(controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, error => error && error.name === 'AbortError')
  release({ ok: true, json: async () => ({ mode: 'upload', uploadProtocolVersion: 2 }) })
  await new Promise((resolve) => setImmediate(resolve))
})

test('client text payload preserves BOM and invalid UTF-8 bytes exactly', async () => {
  const cases = [
    new File([Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])], 'bom.txt', { type: 'text/plain' }),
    new File([Uint8Array.from([0xff, 0x61])], 'invalid.txt', { type: 'text/plain' }),
    new File(['hello'], 'valid.txt', { type: 'text/plain' }),
  ]
  for (const file of cases) {
    const payload = await client.uploadPayload(file)
    assert.deepEqual(bytesOfPayload(payload), Buffer.from(await file.arrayBuffer()))
  }
  assert.equal((await client.uploadPayload(cases[0])).kind, 'text')
  assert.equal((await client.uploadPayload(cases[1])).kind, 'binary')
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



test('client leaves image-only drops to native DSH handling', () => {
  assert.equal(client.shouldHandleDataTransfer({ types: ['Files'], items: [{ kind: 'file', type: 'image/png' }] }), false)
  assert.equal(client.shouldHandleDataTransfer({ types: ['Files'], items: [], files: [{ type: 'image/jpeg' }] }), false)
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
