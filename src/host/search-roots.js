import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'

import { API_PATH, MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH, MAX_EXTERNAL_SEARCH_ROOTS } from '../shared/contract.js'
import { createReadWriteGate } from './gate.js'
import { drainRequest, requireJson, requireMethod, sameOriginRequest, sendError, sendJson } from './http.js'
import { directoryIdentity, inspectDirectory, withInspectionTimeout } from './search-root-inspect.js'
import { HttpError, readJsonBody } from './manifest.js'

const STORE_VERSION = 1
const MAX_STORE_BYTES = 256 * 1024
export const MAX_SEARCH_ROOT_REQUEST_BYTES = 256 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTITY_PATTERN = /^inode:[0-9]+:[0-9]+$/

function emptyState() {
  return { version: STORE_VERSION, epoch: 0, roots: [] }
}

function lexicalPath(value) {
  return normalize(resolve(value))
}

function validUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function validateDiskState(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'epoch,roots,version'
    || value.version !== STORE_VERSION
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || !Array.isArray(value.roots) || value.roots.length > MAX_EXTERNAL_SEARCH_ROOTS) {
    throw new HttpError(500, '外部搜索根配置损坏')
  }
  const ids = new Set()
  const generations = new Set()
  const identities = new Set()
  for (const root of value.roots) {
    if (!root || typeof root !== 'object' || Object.keys(root).sort().join(',') !== 'generation,id,identity,path'
      || !validUuid(root.id) || !validUuid(root.generation)
      || ids.has(root.id) || generations.has(root.generation)
      || typeof root.path !== 'string' || root.path === ''
      || root.path.length > MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH || root.path.includes('\0')
      || !isAbsolute(root.path) || typeof root.identity !== 'string'
      || !IDENTITY_PATTERN.test(root.identity) || identities.has(root.identity)) {
      throw new HttpError(500, '外部搜索根配置损坏')
    }
    ids.add(root.id)
    generations.add(root.generation)
    identities.add(root.identity)
  }
  return { version: STORE_VERSION, epoch: value.epoch, roots: value.roots.map((root) => ({ ...root })) }
}

async function inspectStored(root) {
  try {
    const inspected = await inspectDirectory(root.path)
    if (inspected.path !== root.path || inspected.identity !== root.identity) return undefined
    return { ...root, path: inspected.path, identity: inspected.identity }
  } catch {
    return undefined
  }
}

function publicRoot(root, available) {
  return { id: root.id, path: root.path, available }
}

async function publicState(state) {
  const checked = await Promise.all(state.roots.map((root) => inspectStored(root)))
  return {
    epoch: state.epoch,
    roots: state.roots.map((root, index) => publicRoot(root, checked[index] !== undefined)),
  }
}

async function readStateFile(filePath) {
  const initial = await lstat(filePath)
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_STORE_BYTES) {
    throw new HttpError(500, '外部搜索根配置损坏')
  }
  const handle = await open(filePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_STORE_BYTES) {
      throw new HttpError(500, '外部搜索根配置损坏')
    }
    const buffer = Buffer.allocUnsafe(MAX_STORE_BYTES + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_STORE_BYTES) throw new HttpError(500, '外部搜索根配置损坏')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)) } catch {
      throw new HttpError(500, '外部搜索根配置损坏')
    }
  } finally {
    await handle.close()
  }
}

async function writeState(filePath, state) {
  const directory = dirname(filePath)
  const temporary = filePath + '.tmp-' + randomUUID()
  const serialized = JSON.stringify(state)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
    throw new HttpError(413, '外部搜索根配置过大')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filePath)
    try { await chmod(filePath, 0o600) } catch {}
  } finally {
    if (handle) await handle.close().catch(() => {})
    try { await rm(temporary, { force: true }) } catch {}
  }
}

// 这是同源应用级授权；同一系统账号的本地调用者属于 Host 信任边界。
export function registerSearchRootRoute(ctx, store) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/search-roots',
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { drainRequest(req); sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['GET', 'POST'])) return
        if (req.method === 'GET') {
          sendJson(res, 200, await store.list())
          return
        }
        requireJson(req)
        const payload = await readJsonBody(req, MAX_SEARCH_ROOT_REQUEST_BYTES)
        const keys = Object.keys(payload).sort()
        let result
        if (keys.join(',') === 'action,path' && payload.action === 'authorize') {
          result = await store.authorize(payload.path)
        } else if (keys.join(',') === 'action,id' && payload.action === 'revoke') {
          result = await store.revoke(payload.id)
        } else {
          throw new HttpError(400, 'invalid external search root action')
        }
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: search roots route')
}

export function createSearchRootStore(filePath) {
  if (typeof filePath !== 'string' || filePath === '') throw new TypeError('search root store path is required')
  const read = async () => {
    try {
      return validateDiskState(JSON.parse(await readStateFile(filePath)))
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      if (error instanceof HttpError) throw error
      throw new HttpError(500, '外部搜索根配置损坏')
    }
  }
  const gate = createReadWriteGate()
  const withRead = gate.read
  const list = async () => publicState(await read())
  const trusted = async () => {
    const state = await read()
    const checked = await Promise.all(state.roots.map((root) => inspectStored(root)))
    return { epoch: state.epoch, roots: checked.filter(Boolean) }
  }
  const authorize = (value) => gate.write(async () => {
    const inspected = await inspectDirectory(value)
    const state = await read()
    const existing = state.roots.find((root) => root.identity === inspected.identity && root.path === inspected.path)
    if (existing) return publicState(state)
    const pathKey = lexicalPath(inspected.path)
    const retained = state.roots.filter((root) => {
      if (root.identity === inspected.identity) return false
      try { return lexicalPath(root.path) !== pathKey } catch { return true }
    })
    if (retained.length >= MAX_EXTERNAL_SEARCH_ROOTS) throw new HttpError(413, '外部搜索根数量已达上限')
    const next = {
      version: STORE_VERSION,
      epoch: state.epoch + 1,
      roots: [...retained, {
        id: randomUUID(),
        generation: randomUUID(),
        path: inspected.path,
        identity: inspected.identity,
      }],
    }
    await writeState(filePath, next)
    return publicState(next)
  })
  const revoke = (id) => gate.write(async () => {
    if (!validUuid(id)) throw new HttpError(400, '外部搜索根标识无效')
    const state = await read()
    if (!state.roots.some((root) => root.id === id)) throw new HttpError(404, '外部搜索根不存在')
    const next = {
      version: STORE_VERSION,
      epoch: state.epoch + 1,
      roots: state.roots.filter((root) => root.id !== id),
    }
    await writeState(filePath, next)
    return publicState(next)
  })
  return Object.freeze({ authorize, list, revoke, trusted, withRead })
}

export { directoryIdentity, MAX_STORE_BYTES, STORE_VERSION, withInspectionTimeout }
