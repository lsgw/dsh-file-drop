import { realpathSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runIsolatedTask } from './locate/isolate.js'
import { platformPathKey } from './platform/index.js'
import {
  DEFAULT_UPLOAD_QUOTA_BYTES,
  DEFAULT_UPLOAD_QUOTA_ENTRIES,
  MAX_UPLOAD_QUOTA_BYTES,
  MAX_UPLOAD_QUOTA_ENTRIES,
  LOCATE_MODE_ERROR_CODE,
  QUOTA_ERROR_CODE,
  QUOTA_ERROR_MESSAGE,
} from './settings.js'

export const MAX_DIRECTORY_FILES = 500
export const MAX_DIRECTORY_ENTRIES = 10000
export const MAX_DIRECTORY_DEPTH = 32
export const UPLOAD_STAGING_DIRECTORY = '.dsh-upload-staging'
const MAX_ENTRY_PATH_LENGTH = 4096
const MAX_SIZE_ENTRIES = MAX_UPLOAD_QUOTA_ENTRIES
const MAX_SIZE_DEPTH = 64
const MAX_SIZE_BYTES = MAX_UPLOAD_QUOTA_BYTES
const cleanupStates = new Map()
const MAX_CLEANUP_STATES = 256

function setCleanupState(key, state) {
  cleanupStates.delete(key)
  cleanupStates.set(key, state)
  for (const [candidateKey, candidate] of cleanupStates) {
    if (cleanupStates.size <= MAX_CLEANUP_STATES) break
    if (candidateKey !== key && !candidate.pending) cleanupStates.delete(candidateKey)
  }
}

function cleanupStateKey(baseDir) {
  let path
  try { path = realpathSync.native(baseDir) } catch { path = resolve(baseDir) }
  path = resolve(path)
  return platformPathKey(path)
}

export function dropCleanupStatus(baseDir) {
  const state = cleanupStates.get(cleanupStateKey(baseDir))
  return state
    ? { cleanupPending: state.pending, ...(state.error ? { cleanupError: state.error } : {}) }
    : { cleanupPending: false }
}

function beforeTimeout(promise, milliseconds, onLate) {
  if (milliseconds <= 0) {
    promise.then(value => { if (onLate) void onLate(value) }, () => {})
    return Promise.reject(new HttpError(503, 'upload storage scan timed out'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new HttpError(503, 'upload storage scan timed out'))
    }, milliseconds)
    promise.then((value) => {
      if (settled) { if (onLate) void onLate(value); return }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

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

async function existingInfo(path) {
  try { return await lstat(path) } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertPlainDirectory(path, allowMissing = false) {
  const info = await existingInfo(path)
  if (!info) {
    if (allowMissing) return false
    throw new HttpError(404, 'directory not found')
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(409, 'unsafe directory path')
  return true
}

async function ensurePlainDirectory(path) {
  const info = await existingInfo(path)
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(409, 'unsafe directory path')
    return
  }
  try { await mkdir(path) } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
  }
  await assertPlainDirectory(path)
}

async function removeQuarantine(path) {
  const info = await existingInfo(path)
  if (!info) return
  if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(409, 'unsafe quarantine path')
  await rm(path, { recursive: true, force: true })
}

async function quarantinePaths(baseDir) {
  const paths = []
  let handle
  try { handle = await opendir(baseDir) }
  catch (error) { if (error && error.code === 'ENOENT') return paths; throw error }
  for await (const entry of handle) {
    if (!entry.name.startsWith('.dsh-drops.deleting-')) continue
    paths.push(join(baseDir, entry.name))
    if (paths.length > MAX_UPLOAD_QUOTA_ENTRIES) throw new HttpError(413, 'too many stale upload quarantines')
  }
  return paths
}

function trackQuarantineCleanup(baseDir, quarantine) {
  const stateKey = cleanupStateKey(baseDir)
  const state = { pending: true, error: undefined, promise: undefined }
  setCleanupState(stateKey, state)
  const cleanup = Promise.resolve().then(() => removeQuarantine(quarantine)).then(() => {
    if (cleanupStates.get(stateKey) === state) cleanupStates.delete(stateKey)
  }, (error) => {
    if (cleanupStates.get(stateKey) === state) {
      state.pending = false
      state.error = errorMessage(error)
    }
    throw error
  })
  state.promise = cleanup
  void cleanup.catch(() => {})
}

async function cleanupQuarantines(baseDir) {
  try {
    const errors = []
    for (const path of await quarantinePaths(baseDir)) {
      try { await removeQuarantine(path) } catch (error) { errors.push(error) }
    }
    return errors
  } catch (error) {
    return [error]
  }
}

export async function ensureDropRoot(baseDir) {
  await mkdir(baseDir, { recursive: true })
  const root = join(baseDir, '.dsh-drops')
  await ensurePlainDirectory(root)
  const baseReal = await realpath(baseDir)
  const rootReal = await realpath(root)
  const expected = join(baseReal, '.dsh-drops')
  if (platformPathKey(rootReal) !== platformPathKey(expected)) throw new HttpError(409, 'drop root escapes its workspace')
  return root
}

async function assertSafeTarget(path, expectedDirectory) {
  const info = await existingInfo(path)
  if (!info) return false
  if (info.isSymbolicLink()) throw new HttpError(409, 'unsafe symlink target')
  if (expectedDirectory ? !info.isDirectory() : !info.isFile()) {
    throw new HttpError(409, 'target type conflict')
  }
  return true
}

function numberedName(name, index) {
  if (index === 0) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const suffix = ' (' + index + ')'
  const safeExtension = truncateComponent(extension, 80, 80)
  const stemUnits = Math.max(1, 180 - safeExtension.length - suffix.length)
  const stemBytes = Math.max(1, 240 - Buffer.byteLength(safeExtension + suffix, 'utf8'))
  return truncateComponent(stem, stemUnits, stemBytes) + suffix + safeExtension
}

async function availableFileTarget(root, name) {
  for (let index = 0; index <= 9999; index += 1) {
    const target = join(root, numberedName(name, index))
    const info = await existingInfo(target)
    if (!info) return target
    if (info.isSymbolicLink()) throw new HttpError(409, 'unsafe symlink target')
  }
  throw new HttpError(409, 'too many files with the same name')
}

function uploadStageName(uploadId, kind) {
  if (typeof uploadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uploadId)) {
    throw new HttpError(400, 'invalid upload id')
  }
  return uploadId + (kind === 'file' ? '.file' : '.dir')
}

export async function ensureUploadStagingRoot(baseDir) {
  const dropRoot = await ensureDropRoot(baseDir)
  const stagingRoot = join(dropRoot, UPLOAD_STAGING_DIRECTORY)
  await ensurePlainDirectory(stagingRoot)
  const dropReal = await realpath(dropRoot)
  const stagingReal = await realpath(stagingRoot)
  if (platformPathKey(stagingReal) !== platformPathKey(join(dropReal, UPLOAD_STAGING_DIRECTORY))) {
    throw new HttpError(409, 'upload staging root escapes its workspace')
  }
  return { dropRoot, stagingRoot }
}

async function removeInternalUploadPath(path) {
  const info = await existingInfo(path)
  if (!info) return
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new HttpError(409, 'unsafe upload staging path')
  }
  await rm(path, { recursive: info.isDirectory(), force: true })
}

export async function cleanupOrphanUploadStages(baseDir, activeNames = new Set()) {
  const dropRoot = await ensureDropRoot(baseDir)
  const candidate = join(dropRoot, UPLOAD_STAGING_DIRECTORY)
  const info = await existingInfo(candidate)
  if (!info) return false
  if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(409, 'unsafe upload staging root')
  const { stagingRoot } = await ensureUploadStagingRoot(baseDir)
  const handle = await opendir(stagingRoot)
  for await (const entry of handle) {
    if (activeNames.has(entry.name)) continue
    await removeInternalUploadPath(join(stagingRoot, entry.name))
  }
  await removeEmptyStagingRoot(stagingRoot)
  return Boolean(await existingInfo(stagingRoot))
}

async function createPreallocatedFile(path, size) {
  const handle = await open(path, 'wx')
  try { await handle.truncate(size) } finally { await handle.close() }
}

async function createManifestStageTree(root, manifest) {
  for (const segments of [...manifest.directories].sort((left, right) => left.length - right.length)) {
    let parent = root
    for (const segment of segments) {
      parent = join(parent, segment)
      await ensurePlainDirectory(parent)
    }
  }
  const files = []
  for (const file of manifest.files) {
    let parent = root
    for (const segment of file.segments.slice(0, -1)) {
      parent = join(parent, segment)
      await ensurePlainDirectory(parent)
    }
    const path = join(parent, file.segments[file.segments.length - 1])
    await assertPlainDirectory(parent)
    await createPreallocatedFile(path, file.size)
    files.push({ path, size: file.size, written: 0 })
  }
  return files
}

export async function createUploadStage(baseDir, manifest, uploadId) {
  const { dropRoot, stagingRoot } = await ensureUploadStagingRoot(baseDir)
  const stageName = uploadStageName(uploadId, manifest.kind)
  const path = join(stagingRoot, stageName)
  try {
    let files
    if (manifest.kind === 'file') {
      await createPreallocatedFile(path, manifest.totalBytes)
      files = [{ path, size: manifest.totalBytes, written: 0 }]
    } else {
      await mkdir(path)
      files = await createManifestStageTree(path, manifest)
    }
    return {
      kind: manifest.kind,
      name: manifest.name,
      totalBytes: manifest.totalBytes,
      entryCount: manifest.entryCount,
      dropRoot,
      stagingRoot,
      stageName,
      path,
      files,
    }
  } catch (error) {
    await removeInternalUploadPath(path).catch(() => {})
    throw error
  }
}

function pathInside(root, candidate) {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value))
}

async function assertUploadStage(stage) {
  const stageInfo = await lstat(stage.path)
  if (stageInfo.isSymbolicLink() || (stage.kind === 'file' ? !stageInfo.isFile() : !stageInfo.isDirectory())) {
    throw new HttpError(409, 'unsafe upload stage')
  }
}

async function assertUploadStageFile(stage, file) {
  await assertUploadStage(stage)
  const info = await lstat(file.path)
  if (info.isSymbolicLink() || !info.isFile() || info.size !== file.size) {
    throw new HttpError(409, 'unsafe upload stage file')
  }
  const boundary = await realpath(stage.kind === 'file' ? stage.stagingRoot : stage.path)
  const actual = await realpath(file.path)
  if (!pathInside(boundary, actual)) throw new HttpError(409, 'upload stage file escapes staging root')
}

async function writeAll(handle, data, position) {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
    if (!result || result.bytesWritten <= 0) throw new HttpError(503, 'upload chunk write made no progress')
    written += result.bytesWritten
  }
}

export async function writeUploadChunk(req, stage, fileIndex, offset, maxChunkBytes) {
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= stage.files.length) {
    if (typeof req.resume === 'function') req.resume()
    throw new HttpError(400, 'invalid upload file index')
  }
  const file = stage.files[fileIndex]
  if (!Number.isSafeInteger(offset) || offset !== file.written) {
    if (typeof req.resume === 'function') req.resume()
    throw new HttpError(409, 'upload chunk offset is not contiguous')
  }
  const expected = Math.min(maxChunkBytes, file.size - offset)
  if (!Number.isSafeInteger(expected) || expected <= 0) {
    if (typeof req.resume === 'function') req.resume()
    throw new HttpError(409, 'upload file is already complete')
  }
  const declaredValue = req.headers && req.headers['content-length']
  if (declaredValue !== undefined) {
    const declared = Number(declaredValue)
    if (!Number.isSafeInteger(declared) || declared !== expected) {
      if (typeof req.resume === 'function') req.resume()
      throw new HttpError(400, 'upload chunk content-length mismatch')
    }
  }
  await assertUploadStageFile(stage, file)
  const handle = await open(file.path, 'r+')
  let received = 0
  try {
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (received + data.length > expected) {
        if (typeof req.resume === 'function') req.resume()
        throw new HttpError(413, 'upload chunk exceeds negotiated size')
      }
      await writeAll(handle, data, offset + received)
      received += data.length
    }
  } finally {
    await handle.close()
  }
  if (received !== expected) throw new HttpError(400, 'upload chunk size mismatch')
  await assertUploadStageFile(stage, file)
  file.written += received
  return { received, written: file.written, size: file.size }
}

export async function verifyUploadStage(stage) {
  await assertUploadStage(stage)
  for (const file of stage.files) {
    if (file.written !== file.size) throw new HttpError(409, 'upload is incomplete')
    await assertUploadStageFile(stage, file)
  }
}

async function commitStagedDirectory(baseDir, stage, beforeCommit) {
  const target = join(stage.dropRoot, stage.name)
  const backup = join(stage.dropRoot, '.' + stage.name + '.bak')
  let existed = await assertSafeTarget(target, true)
  const backupExists = await assertSafeTarget(backup, true)
  if (beforeCommit) beforeCommit()
  if (backupExists) {
    if (existed) await rm(backup, { recursive: true, force: true })
    else { await rename(backup, target); existed = true }
  }
  await assertPlainDirectory(stage.dropRoot)
  await assertPlainDirectory(stage.path)
  if (existed) await rename(target, backup)
  try {
    if (beforeCommit) beforeCommit()
    await rename(stage.path, target)
  } catch (error) {
    if (existed) {
      try { await rename(backup, target) } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'directory replacement and rollback failed')
      }
    }
    throw error
  }
  if (existed) {
    const quarantine = join(baseDir, '.dsh-drops.deleting-' + randomUUID())
    try {
      await rename(backup, quarantine)
      trackQuarantineCleanup(baseDir, quarantine)
    } catch (error) {
      setCleanupState(cleanupStateKey(baseDir), { pending: false, error: errorMessage(error) })
    }
  }
  return target
}

async function removeEmptyStagingRoot(stagingRoot) {
  try { await rmdir(stagingRoot) } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
  }
}

export async function commitUploadStage(baseDir, stage, options = {}) {
  await verifyUploadStage(stage)
  let target
  if (stage.kind === 'directory') target = await commitStagedDirectory(baseDir, stage, options.beforeCommit)
  else {
    target = await availableFileTarget(stage.dropRoot, stage.name)
    await assertPlainDirectory(stage.dropRoot)
    await assertPlainDirectory(stage.stagingRoot)
    if (options.beforeCommit) options.beforeCommit()
    await rename(stage.path, target)
  }
  await removeEmptyStagingRoot(stage.stagingRoot)
  return target
}

export async function removeUploadStage(stage) {
  await removeInternalUploadPath(stage.path)
  await removeEmptyStagingRoot(stage.stagingRoot)
}

export async function measureDropRoot(baseDir, options = {}) {
  if (typeof options.now === 'function' || options.local === true) return measureDropRootLocal(baseDir, options)
  const timeoutMs = options.maxDurationMs || 5000
  try {
    return await runIsolatedTask('measure-drop-root', { baseDir }, { timeoutMs, maxOutputBytes: 1024 * 1024 })
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(error?.status || 500, error?.message || 'upload storage scan failed')
  }
}

export async function assertDropRootCapacity(baseDir, incomingBytes, incomingEntries, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_QUOTA_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_UPLOAD_QUOTA_ENTRIES
  const measureFn = options.measureFn || measureDropRoot
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0
    || !Number.isSafeInteger(incomingEntries) || incomingEntries < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_QUOTA_BYTES
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_UPLOAD_QUOTA_ENTRIES) {
    throw new HttpError(400, 'invalid upload quota request')
  }
  if (incomingBytes > maxBytes || incomingEntries > maxEntries) throw quotaExceeded()
  const cleanup = dropCleanupStatus(baseDir)
  if (cleanup.cleanupPending) throw new HttpError(409, 'previous upload cleanup is still in progress')
  if (cleanup.cleanupError) throw new HttpError(409, 'previous upload cleanup failed; clear the upload directory again')
  const current = await measureFn(baseDir)
  if (current.size + incomingBytes > maxBytes || current.entries + incomingEntries > maxEntries) {
    throw quotaExceeded()
  }
  return current
}

export async function clearDropRoot(baseDir, options = {}) {
  const stateKey = cleanupStateKey(baseDir)
  const priorState = cleanupStates.get(stateKey)
  if (priorState && priorState.promise) await priorState.promise.catch(() => {})
  const staleErrors = await cleanupQuarantines(baseDir)
  for (const error of staleErrors) options.onCleanupError && options.onCleanupError(error)
  const root = join(baseDir, '.dsh-drops')
  const exists = await assertPlainDirectory(root, true)
  if (!exists) {
    if (staleErrors.length > 0) setCleanupState(stateKey, { pending: false, error: errorMessage(staleErrors[0]) })
    else cleanupStates.delete(stateKey)
    return root
  }
  const quarantine = join(baseDir, '.dsh-drops.deleting-' + randomUUID())
  await rename(root, quarantine)
  try {
    await mkdir(root)
  } catch (error) {
    try { await rename(quarantine, root) } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'clear and rollback failed')
    }
    throw error
  }
  const staleError = staleErrors.length > 0 ? errorMessage(staleErrors[0]) : undefined
  const state = { pending: true, error: staleError, promise: undefined }
  setCleanupState(stateKey, state)
  const removeFn = options.removeQuarantineFn || removeQuarantine
  const cleanup = Promise.resolve().then(() => removeFn(quarantine)).then(() => {
    if (cleanupStates.get(stateKey) !== state) return
    if (staleError) { state.pending = false; state.error = staleError }
    else cleanupStates.delete(stateKey)
  }, (error) => {
    state.pending = false
    state.error = errorMessage(error)
    if (options.onCleanupError) options.onCleanupError(error)
    throw error
  })
  state.promise = cleanup
  if (options.waitForCleanup) await cleanup
  else void cleanup.catch(() => {})
  return root
}

export async function measureDropRootLocal(baseDir, options = {}) {
  const now = options.now || Date.now
  const maxDurationMs = options.maxDurationMs || 5000
  const deadline = now() + maxDurationMs
  const realDeadline = Date.now() + maxDurationMs
  const root = join(baseDir, '.dsh-drops')
  const stack = []
  let entries = 0
  const remaining = () => realDeadline - Date.now()
  if (await beforeTimeout(assertPlainDirectory(root, true), remaining())) stack.push({ path: root, depth: 0 })
  for (const quarantine of await beforeTimeout(quarantinePaths(baseDir), remaining())) {
    let info
    try { info = await beforeTimeout(lstat(quarantine), remaining()) }
    catch (error) { if (error && error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(409, 'unsafe quarantine path')
    entries += 1
    stack.push({ path: quarantine, depth: 0 })
  }
  if (stack.length === 0) return { path: root, size: 0, entries: 0 }
  let size = 0
  while (stack.length > 0) {
    if (now() > deadline) throw new HttpError(503, 'upload directory size scan timed out')
    const current = stack.pop()
    if (current.depth > MAX_SIZE_DEPTH) throw new HttpError(413, 'upload directory depth limit exceeded')
    const currentInfo = await beforeTimeout(existingInfo(current.path), remaining())
    if (!currentInfo) continue
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) throw new HttpError(409, 'unsafe upload storage path')
    let handle
    try { handle = await beforeTimeout(opendir(current.path), remaining(), lateHandle => lateHandle.close().catch(() => {})) }
    catch (error) { if (error && error.code === 'ENOENT') continue; throw error }
    let readTimedOut = false
    try {
      while (true) {
        let child
        try { child = await beforeTimeout(handle.read(), remaining(), () => handle.close().catch(() => {})) }
        catch (error) { readTimedOut = error instanceof HttpError && error.status === 503; throw error }
        if (!child) break
        entries += 1
        if ((entries & 255) === 0 && now() > deadline) throw new HttpError(503, 'upload directory size scan timed out')
        if (entries > MAX_SIZE_ENTRIES) throw new HttpError(413, 'upload directory entry limit exceeded')
        const path = join(current.path, child.name)
        if (child.isSymbolicLink()) throw new HttpError(409, 'upload directory contains a symlink')
        if (child.isDirectory()) {
          stack.push({ path, depth: current.depth + 1 })
        } else if (child.isFile()) {
          const info = await beforeTimeout(lstat(path), remaining())
          if (info.isSymbolicLink()) throw new HttpError(409, 'upload directory contains a symlink')
          size += info.size
          if (size > MAX_SIZE_BYTES) throw new HttpError(413, 'upload directory size limit exceeded')
        }
      }
    } finally {
      if (!readTimedOut) await handle.close().catch(() => {})
    }
  }
  return { path: root, size, entries }
}
