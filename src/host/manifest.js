import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { platformPathKey } from '../platform/index.js'
import {
  DEFAULT_UPLOAD_QUOTA_BYTES, LOCATE_MODE_ERROR_CODE, MAX_UPLOAD_QUOTA_BYTES,
  QUOTA_ERROR_CODE, QUOTA_ERROR_MESSAGE,
} from './settings.js'

export const MAX_DIRECTORY_FILES = 500
export const MAX_DIRECTORY_ENTRIES = 10000
export const MAX_DIRECTORY_DEPTH = 32
const MAX_ENTRY_PATH_LENGTH = 4096

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (code) this.code = code
  }
}

function quotaExceeded() {
  return new HttpError(413, QUOTA_ERROR_MESSAGE, QUOTA_ERROR_CODE)
}

export function errorStatus(error, fallback = 500) {
  const status = error && error.status
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback
}

export function errorMessage(error) {
  return error && error.message ? error.message : String(error)
}

export function errorCode(error) {
  return error && (error.code === QUOTA_ERROR_CODE || error.code === LOCATE_MODE_ERROR_CODE)
    ? error.code : undefined
}

export async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers && req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (typeof req.resume === 'function') req.resume()
    throw new HttpError(413, 'payload too large')
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      if (typeof req.resume === 'function') req.resume()
      throw new HttpError(413, 'payload too large')
    }
    chunks.push(bytes)
  }
  if (total === 0) return {}
  let raw
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)) } catch {
    throw new HttpError(400, 'invalid UTF-8 body')
  }
  try {
    const value = JSON.parse(raw)
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new HttpError(400, 'JSON body must be an object')
    }
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'invalid JSON body')
  }
}

export function dshHome() {
  return resolve((process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh'))
}

export function sessionCwd(session) {
  const cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' && cwd.length <= 32768
    && !cwd.includes('\0') && isAbsolute(cwd) ? cwd : undefined
}

export function resolveBaseDir(ctx, sessionId, supplied = sessionId !== undefined) {
  if (!supplied) return dshHome()
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new HttpError(400, 'invalid sessionId')
  const key = sessionId
  if (key.length > 256 || key.includes('\0')) throw new HttpError(400, 'invalid sessionId')
  let session
  try { session = ctx.sessions && ctx.sessions.get(key) } catch { session = undefined }
  const cwd = sessionCwd(session)
  if (cwd === undefined) throw new HttpError(404, 'session not found')
  return cwd
}

function truncateComponent(value, maxUnits = 180, maxBytes = 240) {
  let result = ''
  let units = 0
  let bytes = 0
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, 'utf8')
    if (units + point.length > maxUnits || bytes + pointBytes > maxBytes) break
    result += point
    units += point.length
    bytes += pointBytes
  }
  return result
}

function truncateNamePreservingExtension(value) {
  if (truncateComponent(value) === value) return value
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return truncateComponent(value)
  const extension = truncateComponent(value.slice(dot), 80, 80)
  const stemUnits = Math.max(1, 180 - extension.length)
  const stemBytes = Math.max(1, 240 - Buffer.byteLength(extension, 'utf8'))
  return truncateComponent(value.slice(0, dot), stemUnits, stemBytes) + extension
}

export function sanitizeName(value) {
  let safe = basename(String(value || '').normalize('NFC'))
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
  if (!safe) safe = 'file.bin'
  safe = truncateNamePreservingExtension(safe).replace(/[. ]+$/, '')
  const stem = safe.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) safe = '_' + safe
  return safe || 'file.bin'
}

function uploadSize(value, label, maxBytes) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'invalid ' + label + ' size')
  if (value > maxBytes) throw quotaExceeded()
  return value
}

function uploadName(value, label) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ENTRY_PATH_LENGTH || value.includes('\0')) {
    throw new HttpError(400, 'invalid ' + label + ' name')
  }
  return sanitizeName(value)
}

function entrySegments(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ENTRY_PATH_LENGTH || value.includes('\0')) {
    throw new HttpError(400, 'invalid directory entry path')
  }
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new HttpError(400, 'directory entry path must be relative')
  }
  const parts = normalized.split('/')
  if (parts.length > MAX_DIRECTORY_DEPTH || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new HttpError(400, 'invalid directory entry path')
  }
  return { original: parts.map((part) => part.normalize('NFC')), safe: parts.map(sanitizeName) }
}

function directoryCollisionKey(parts) {
  return platformPathKey(parts.join('/'))
}

function decodeDirectoryManifest(name, entries, maxBytes) {
  if (!Array.isArray(entries)) throw new HttpError(400, 'directory entries must be an array')
  if (entries.length > MAX_DIRECTORY_ENTRIES) throw new HttpError(413, 'directory entry-count limit exceeded')
  const files = []
  const nodes = new Map()
  const directories = new Map()
  let totalBytes = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || (entry.kind !== 'file' && entry.kind !== 'directory')) {
      throw new HttpError(400, 'invalid directory entry')
    }
    if (Object.hasOwn(entry, 'content') || Object.hasOwn(entry, 'base64')) {
      throw new HttpError(400, 'directory manifest must not contain file content')
    }
    const path = entrySegments(entry.path)
    for (let index = 0; index < path.safe.length; index += 1) {
      const safeKey = directoryCollisionKey(path.safe.slice(0, index + 1))
      const originKey = directoryCollisionKey(path.original.slice(0, index + 1))
      const kind = index === path.safe.length - 1 ? entry.kind : 'directory'
      const existing = nodes.get(safeKey)
      if (existing && (existing.kind !== kind || existing.originKey !== originKey || kind === 'file')) {
        throw new HttpError(409, 'directory entries collide after sanitization')
      }
      if (!existing) nodes.set(safeKey, { kind, originKey })
      if (kind === 'directory') directories.set(safeKey, path.safe.slice(0, index + 1))
    }
    if (entry.kind === 'directory') {
      if (Object.hasOwn(entry, 'size')) throw new HttpError(400, 'directory marker must not contain a size')
      continue
    }
    if (files.length >= MAX_DIRECTORY_FILES) throw new HttpError(413, 'directory file-count limit exceeded')
    const size = uploadSize(entry.size, 'directory entry', maxBytes)
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw quotaExceeded()
    files.push({ segments: path.safe, size })
  }
  return {
    kind: 'directory',
    name: uploadName(name, 'directory'),
    files,
    directories: [...directories.values()],
    totalBytes,
    entryCount: nodes.size + 1,
  }
}

export function decodeUploadManifest(payload, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_QUOTA_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_QUOTA_BYTES) {
    throw new HttpError(500, 'invalid configured upload quota')
  }
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'invalid upload manifest')
  if (payload.kind === 'file') {
    if (Object.hasOwn(payload, 'content') || Object.hasOwn(payload, 'base64')) {
      throw new HttpError(400, 'file manifest must not contain file content')
    }
    return {
      kind: 'file',
      name: uploadName(payload.name, 'file'),
      files: [{ segments: [], size: uploadSize(payload.size, 'file', maxBytes) }],
      directories: [],
      totalBytes: payload.size,
      entryCount: 1,
    }
  }
  if (payload.kind === 'directory') return decodeDirectoryManifest(payload.name, payload.entries, maxBytes)
  throw new HttpError(400, 'invalid upload kind')
}


export { quotaExceeded, truncateComponent }
