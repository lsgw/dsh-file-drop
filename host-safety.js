import { realpathSync } from 'node:fs'
import { lstat, mkdir, opendir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { runIsolatedTask } from './locate/isolate.js'

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_DIRECTORY_FILES = 500
export const MAX_DIRECTORY_ENTRIES = 10000
export const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
export const MAX_DIRECTORY_DEPTH = 32
export const MAX_DIRECTORY_BODY_BYTES = 100 * 1024 * 1024
export const MAX_DROP_ROOT_BYTES = 1024 * 1024 * 1024
export const MAX_DROP_ROOT_ENTRIES = 10000
const MAX_ENTRY_PATH_LENGTH = 4096
const MAX_SIZE_ENTRIES = 100000
const MAX_SIZE_DEPTH = 64
const MAX_SIZE_BYTES = 1024 * 1024 * 1024 * 1024
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
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toUpperCase() : path
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
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export function errorStatus(error, fallback = 500) {
  const status = error && error.status
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback
}

export function errorMessage(error) {
  return error && error.message ? error.message : String(error)
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
  const cwd = session && (
    session.header && session.header.cwd !== undefined ? session.header.cwd
      : session.meta && session.meta.cwd
  )
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

function strictBase64(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'binary content must be base64')
  if (value === '') return Buffer.alloc(0)
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(400, 'invalid base64 content')
  }
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value) throw new HttpError(400, 'invalid base64 content')
  return data
}

function decodeEntry(kind, content, base64) {
  if (kind === 'text') {
    if (typeof content !== 'string') throw new HttpError(400, 'text content must be a string')
    return Buffer.from(content, 'utf8')
  }
  if (kind === 'binary') return strictBase64(base64)
  throw new HttpError(400, 'invalid file kind')
}

export function decodeUploadPayload(payload) {
  if (!payload || typeof payload.name !== 'string' || payload.name === ''
    || payload.name.length > MAX_ENTRY_PATH_LENGTH || payload.name.includes('\0')) {
    throw new HttpError(400, 'invalid file name')
  }
  if (!Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > MAX_FILE_BYTES) {
    throw new HttpError(413, 'file too large (25MB limit)')
  }
  const data = decodeEntry(payload.kind, payload.content, payload.base64)
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, 'decoded file exceeds 25MB limit')
  if (data.length !== payload.size) throw new HttpError(400, 'declared file size does not match decoded bytes')
  return { name: sanitizeName(payload.name), data }
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
  const path = parts.join('/')
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toUpperCase() : path
}

export function decodeDirectoryPayload(dirName, entries) {
  if (typeof dirName !== 'string' || dirName === '' || dirName.length > MAX_ENTRY_PATH_LENGTH
    || dirName.includes('\0') || !Array.isArray(entries)) {
    throw new HttpError(400, 'invalid directory upload')
  }
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    throw new HttpError(413, 'directory entry-count limit exceeded')
  }
  const files = []
  const nodes = new Map()
  const directories = new Map()
  let fileCount = 0
  let totalBytes = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new HttpError(400, 'invalid directory entry')
    const path = entrySegments(entry.path)
    const entryKind = entry.kind === 'directory' ? 'directory' : 'file'
    for (let index = 0; index < path.safe.length; index += 1) {
      const safeKey = directoryCollisionKey(path.safe.slice(0, index + 1))
      const originKey = directoryCollisionKey(path.original.slice(0, index + 1))
      const kind = index === path.safe.length - 1 ? entryKind : 'directory'
      const existing = nodes.get(safeKey)
      if (existing && (existing.kind !== kind || existing.originKey !== originKey || kind === 'file')) {
        throw new HttpError(409, 'directory entries collide after sanitization')
      }
      if (!existing) nodes.set(safeKey, { kind, originKey })
      if (kind === 'directory') directories.set(safeKey, path.safe.slice(0, index + 1))
    }
    if (entryKind === 'directory') {
      if (Object.hasOwn(entry, 'content') || Object.hasOwn(entry, 'base64') || Object.hasOwn(entry, 'size')) {
        throw new HttpError(400, 'directory marker must not contain file data')
      }
      continue
    }
    fileCount += 1
    if (fileCount > MAX_DIRECTORY_FILES) throw new HttpError(413, 'directory file-count limit exceeded')
    const data = decodeEntry(entry.kind, entry.content, entry.base64)
    if (data.length > MAX_FILE_BYTES) throw new HttpError(413, 'directory entry exceeds 25MB limit')
    if (Object.hasOwn(entry, 'size') && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size !== data.length)) {
      throw new HttpError(400, 'directory entry size does not match decoded bytes')
    }
    totalBytes += data.length
    if (totalBytes > MAX_DIRECTORY_BYTES) throw new HttpError(413, 'directory decoded-size limit exceeded')
    files.push({ segments: path.safe, data })
  }
  return {
    name: sanitizeName(dirName),
    files,
    directories: [...directories.values()],
    totalBytes,
    entryCount: nodes.size + 1,
  }
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
    if (paths.length > MAX_DROP_ROOT_ENTRIES) throw new HttpError(413, 'too many stale upload quarantines')
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
  const comparable = (value) => process.platform === 'win32' || process.platform === 'darwin' ? value.toUpperCase() : value
  if (comparable(rootReal) !== comparable(expected)) throw new HttpError(409, 'drop root escapes its workspace')
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

export async function writeUploadedFile(baseDir, file) {
  const root = await ensureDropRoot(baseDir)
  const target = await availableFileTarget(root, file.name)
  const temp = join(root, '.upload-' + randomUUID() + '.tmp')
  try {
    await assertPlainDirectory(root)
    await writeFile(temp, file.data, { flag: 'wx' })
    await assertPlainDirectory(root)
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
  return target
}

async function writeDirectoryTree(root, directories, files) {
  for (const segments of [...directories].sort((left, right) => left.length - right.length)) {
    let parent = root
    for (const segment of segments) {
      parent = join(parent, segment)
      await ensurePlainDirectory(parent)
    }
  }
  for (const file of files) {
    let parent = root
    for (const segment of file.segments.slice(0, -1)) {
      parent = join(parent, segment)
      await ensurePlainDirectory(parent)
    }
    const target = join(parent, file.segments[file.segments.length - 1])
    await assertPlainDirectory(parent)
    await writeFile(target, file.data, { flag: 'wx' })
  }
}

export async function replaceUploadedDirectory(baseDir, directory) {
  const dropRoot = await ensureDropRoot(baseDir)
  const target = join(dropRoot, directory.name)
  const backup = join(dropRoot, '.' + directory.name + '.bak')
  let existed = await assertSafeTarget(target, true)
  const backupExists = await assertSafeTarget(backup, true)
  if (backupExists) {
    if (existed) {
      await rm(backup, { recursive: true, force: true })
    } else {
      await rename(backup, target)
      existed = true
    }
  }

  const temp = join(dropRoot, '.upload-' + randomUUID() + '.tmp')
  await mkdir(temp)
  try {
    await writeDirectoryTree(temp, directory.directories || [], directory.files)
    await assertPlainDirectory(dropRoot)
    await assertPlainDirectory(temp)
    if (existed) await rename(target, backup)
    try {
      await rename(temp, target)
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
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return target
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
  const maxBytes = options.maxBytes || MAX_DROP_ROOT_BYTES
  const maxEntries = options.maxEntries || MAX_DROP_ROOT_ENTRIES
  const measureFn = options.measureFn || measureDropRoot
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0
    || !Number.isSafeInteger(incomingEntries) || incomingEntries < 0) {
    throw new HttpError(400, 'invalid upload quota request')
  }
  if (incomingBytes > maxBytes || incomingEntries > maxEntries) {
    throw new HttpError(413, 'upload exceeds workspace drop-root quota')
  }
  const cleanup = dropCleanupStatus(baseDir)
  if (cleanup.cleanupPending) throw new HttpError(409, 'previous upload cleanup is still in progress')
  if (cleanup.cleanupError) throw new HttpError(409, 'previous upload cleanup failed; clear the upload directory again')
  const current = await measureFn(baseDir)
  if (current.size + incomingBytes > maxBytes) {
    throw new HttpError(413, 'workspace upload storage exceeds 1GB limit')
  }
  if (current.entries + incomingEntries > maxEntries) {
    throw new HttpError(413, 'workspace upload entry-count limit exceeded')
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
