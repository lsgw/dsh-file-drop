// dsh-file-drop / Host routes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HttpError,
  MAX_DIRECTORY_BODY_BYTES,
  MAX_FILE_BYTES,
  assertDropRootCapacity,
  clearDropRoot,
  decodeDirectoryPayload,
  decodeUploadPayload,
  dshHome,
  dropCleanupStatus,
  errorMessage,
  errorStatus,
  measureDropRoot,
  readJsonBody,
  replaceUploadedDirectory,
  resolveBaseDir,
  writeUploadedFile,
} from './host-safety.js'
import { createSecureLocator } from './locate/secure-locator.js'
import { FILE_DROP_ROUTE } from './locate/protocol.js'

export const name = 'dsh-file-drop'
export const inject = ['webServer', 'sessions']

const API_PATH = '/api/dsh-file-drop'
const MAX_FILE_BODY_BYTES = MAX_FILE_BYTES * 2 + 1024 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res, error, fallbackStatus = 500) {
  sendJson(res, errorStatus(error, fallbackStatus), { error: errorMessage(error) })
}

function sendLocateError(res, error, fallbackStatus = 500) {
  sendJson(res, errorStatus(error, fallbackStatus), { status: 'error', message: errorMessage(error) })
}

function fence(req) {
  const headers = req.headers || {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (!origin) return true
  const host = headers.host
  if (!host) return false
  return origin === 'http://' + host || origin === 'https://' + host
}

function requireJson(req) {
  const contentType = req.headers && req.headers['content-type']
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'content-type must be application/json')
  }
}

function requireMethod(req, res, methods) {
  if (methods.includes(req.method)) return true
  res.writeHead(405, { allow: methods.join(', '), 'content-length': 0 })
  res.end()
  return false
}

function readMode() {
  try {
    const value = JSON.parse(readFileSync(join(dshHome(), 'dsh-file-drop.json'), 'utf8'))
    return value && value.mode === 'locate' ? 'locate' : 'upload'
  } catch { return 'upload' }
}

function writeMode(mode) {
  const dir = dshHome()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dsh-file-drop.json'), JSON.stringify({ mode }), 'utf8')
}

async function canonicalPathKey(value) {
  let path
  try { path = await realpath(value) } catch { path = resolve(value) }
  path = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toUpperCase() : path
}

export function createPathLock() {
  const locks = new Map()
  return async (key, operation) => {
    const canonicalKey = await canonicalPathKey(key)
    const previous = locks.get(canonicalKey) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    locks.set(canonicalKey, current)
    try { return await current } finally {
      if (locks.get(canonicalKey) === current) locks.delete(canonicalKey)
    }
  }
}

export async function apply(ctx) {
  const secureLocate = createSecureLocator(ctx)
  const withPathLock = createPathLock()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, MAX_FILE_BODY_BYTES)
        const baseDir = resolveBaseDir(ctx, payload.sessionId, Object.hasOwn(payload, 'sessionId'))
        const file = decodeUploadPayload(payload)
        const path = await withPathLock(baseDir, async () => {
          await assertDropRootCapacity(baseDir, file.data.length, 1)
          return writeUploadedFile(baseDir, file)
        })
        sendJson(res, 200, { path })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: save route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FILE_DROP_ROUTE,
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { status: 'error', message: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const request = await readJsonBody(req, 4 * 1024 * 1024)
        sendJson(res, 200, await secureLocate(request))
      } catch (error) {
        sendLocateError(res, error)
      }
    },
  }), 'dsh-file-drop: locate route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/dir',
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, MAX_DIRECTORY_BODY_BYTES)
        const baseDir = resolveBaseDir(ctx, payload.sessionId, Object.hasOwn(payload, 'sessionId'))
        const directory = decodeDirectoryPayload(payload.dirName, payload.entries)
        const path = await withPathLock(baseDir, async () => {
          await assertDropRootCapacity(baseDir, directory.totalBytes, directory.entryCount)
          return replaceUploadedDirectory(baseDir, directory)
        })
        sendJson(res, 200, { path, ...dropCleanupStatus(baseDir) })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: dir route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/settings',
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['GET', 'POST'])) return
        if (req.method === 'GET') {
          sendJson(res, 200, { mode: readMode(), uploadProtocolVersion: 2 })
          return
        }
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        if (payload.mode !== 'upload' && payload.mode !== 'locate') throw new HttpError(400, 'invalid file-drop mode')
        const mode = payload.mode
        writeMode(mode)
        sendJson(res, 200, { mode, uploadProtocolVersion: 2 })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/clear',
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        const hasSession = Object.hasOwn(payload, 'sessionId')
        if (!hasSession && payload.global !== true) throw new HttpError(400, 'sessionId or explicit global scope is required')
        const baseDir = resolveBaseDir(ctx, payload.sessionId, hasSession)
        const path = await withPathLock(baseDir, () => clearDropRoot(baseDir, {
          onCleanupError: (error) => ctx.logger.warn('dsh-file-drop cleanup failed for %s: %o', baseDir, error),
        }))
        sendJson(res, 200, { path, removed: true, ...dropCleanupStatus(baseDir) })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: clear route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/size',
    handler: async (req, res) => {
      try {
        if (!fence(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        const baseDir = resolveBaseDir(ctx, payload.sessionId, Object.hasOwn(payload, 'sessionId'))
        const result = await withPathLock(baseDir, () => measureDropRoot(baseDir))
        sendJson(res, 200, { ...result, ...dropCleanupStatus(baseDir) })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: size route')
}
