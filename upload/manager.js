import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  HttpError,
  assertDropRootCapacity,
  cleanupOrphanUploadStages,
  commitUploadStage,
  createUploadStage,
  decodeUploadManifest,
  dropCleanupStatus,
  removeUploadStage,
  resolveBaseDir,
  writeUploadChunk,
} from '../host-safety.js'
import {
  DEFAULT_UPLOAD_QUOTA_BYTES,
  DEFAULT_UPLOAD_QUOTA_ENTRIES,
  LOCATE_MODE_ERROR_CODE,
  LOCATE_MODE_ERROR_MESSAGE,
} from '../settings.js'

export const UPLOAD_PROTOCOL_VERSION = 3
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_MANIFEST_BYTES = 48 * 1024 * 1024
export const MAX_UPLOAD_CONTROL_BYTES = 1024 * 1024
const MAX_ACTIVE_UPLOADS = 16
const UPLOAD_TTL_MS = 10 * 60 * 1000
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function validateUploadId(uploadId) {
  if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) throw new HttpError(400, 'invalid upload id')
  return uploadId
}

function sessionBinding(payload) {
  const supplied = Object.hasOwn(payload, 'sessionId')
  return { supplied, sessionId: supplied ? payload.sessionId : undefined }
}

function chunkSessionBinding(headers) {
  const scope = headers['x-dsh-session-scope']
  const encoded = headers['x-dsh-session-id']
  if (scope === 'global') {
    if (encoded !== undefined) throw new HttpError(400, 'global upload chunk must not include a session id')
    return { supplied: false, sessionId: undefined }
  }
  if (scope !== 'session' || Array.isArray(encoded) || typeof encoded !== 'string') {
    throw new HttpError(400, 'invalid upload chunk session binding')
  }
  let sessionId
  try { sessionId = decodeURIComponent(encoded) } catch { throw new HttpError(400, 'invalid upload chunk session id') }
  if (sessionId === '' || sessionId.length > 256 || sessionId.includes('\0')) {
    throw new HttpError(400, 'invalid upload chunk session id')
  }
  return { supplied: true, sessionId }
}

function parseHeaderInteger(value, label) {
  if (Array.isArray(value) || typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'invalid ' + label + ' header')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'invalid ' + label + ' header')
  return parsed
}

export function createUploadManager(ctx, options) {
  const { withPathLock, canonicalPathKey, uploadBaseDir } = options
  if (typeof uploadBaseDir !== 'string' || !isAbsolute(uploadBaseDir) || uploadBaseDir.includes('\0')) {
    throw new TypeError('uploadBaseDir must be an absolute path')
  }
  const now = options.now || Date.now
  const removeStage = options.removeStage || removeUploadStage
  const commitStage = options.commitStage || commitUploadStage
  const getSettings = options.getSettings || (() => ({
    mode: 'upload',
    maxBytes: DEFAULT_UPLOAD_QUOTA_BYTES,
    maxEntries: DEFAULT_UPLOAD_QUOTA_ENTRIES,
  }))
  const states = new Map()
  let initTail = Promise.resolve()

  const uploadSettings = () => {
    const settings = getSettings()
    if (settings.mode !== 'upload') {
      throw new HttpError(409, LOCATE_MODE_ERROR_MESSAGE, LOCATE_MODE_ERROR_CODE)
    }
    return settings
  }

  const withInitLock = (operation) => {
    const current = initTail.catch(() => {}).then(operation)
    initTail = current
    return current
  }

  const withUploadLock = async (state, operation) => {
    const current = state.tail.catch(() => {}).then(operation)
    state.tail = current
    return current
  }

  const warnCleanup = (state, error) => {
    try { ctx.logger?.warn('dsh-file-drop staging cleanup failed for %s: %o', state.baseDir, error) } catch {}
  }

  const cleanupState = async (state) => {
    state.accepting = false
    try {
      await withPathLock(state.baseDir, () => withUploadLock(state, () => removeStage(state.stage)))
      if (states.get(state.uploadId) === state) states.delete(state.uploadId)
      return true
    } catch (error) {
      state.cleanupRetry = true
      warnCleanup(state, error)
      return false
    }
  }

  const sweepExpired = async () => {
    const deadline = now() - UPLOAD_TTL_MS
    const expired = [...states.values()].filter((state) => state.lastSeen < deadline)
    for (const state of expired) await cleanupState(state)
  }

  const validateLiveBinding = (binding) => {
    resolveBaseDir(ctx, binding.sessionId, binding.supplied)
  }

  const requireState = (uploadId) => {
    validateUploadId(uploadId)
    const state = states.get(uploadId)
    if (!state) throw new HttpError(404, 'upload session not found')
    return state
  }

  const assertStateBinding = (state, binding, label = 'upload session binding changed') => {
    if (binding.supplied !== state.sessionSupplied || binding.sessionId !== state.sessionId) {
      throw new HttpError(409, label)
    }
  }

  const rejectExpiredState = async (state) => {
    if (state.lastSeen >= now() - UPLOAD_TTL_MS) return
    await cleanupState(state)
    throw new HttpError(410, 'upload session expired')
  }

  const resolveBoundState = async (payload) => {
    const binding = sessionBinding(payload)
    const state = requireState(payload.uploadId)
    assertStateBinding(state, binding)
    validateLiveBinding(binding)
    await rejectExpiredState(state)
    return { state, binding }
  }

  async function init(payload) {
    return withInitLock(async () => {
      const binding = sessionBinding(payload)
      validateLiveBinding(binding)
      await sweepExpired()
      const baseDir = uploadBaseDir
      const baseKey = await canonicalPathKey(baseDir)
      const settings = uploadSettings()
      const manifest = decodeUploadManifest(payload, { maxBytes: settings.maxBytes })
      return withPathLock(baseDir, async () => {
        validateLiveBinding(binding)
        const activeForBase = [...states.values()].filter((state) => state.baseKey === baseKey)
        const stagingExists = await cleanupOrphanUploadStages(
          baseDir,
          new Set(activeForBase.map((state) => state.stage.stageName))
        )
        if (states.size >= MAX_ACTIVE_UPLOADS) throw new HttpError(429, 'too many active uploads')
        const liveSettings = uploadSettings()
        await assertDropRootCapacity(
          baseDir,
          manifest.totalBytes,
          manifest.entryCount + (stagingExists ? 0 : 1),
          { maxBytes: liveSettings.maxBytes, maxEntries: liveSettings.maxEntries }
        )
        uploadSettings()
        validateLiveBinding(binding)
        const uploadId = randomUUID()
        let stage
        let state
        try {
          stage = await createUploadStage(baseDir, manifest, uploadId)
          state = {
            uploadId,
            baseDir,
            baseKey,
            sessionSupplied: binding.supplied,
            sessionId: binding.sessionId,
            stage,
            lastSeen: now(),
            accepting: true,
            cleanupRetry: false,
            chunkBusy: false,
            tail: Promise.resolve(),
          }
          states.set(uploadId, state)
          uploadSettings()
          validateLiveBinding(binding)
          return {
            uploadId,
            chunkBytes: UPLOAD_CHUNK_BYTES,
            fileCount: stage.files.length,
            totalBytes: stage.totalBytes,
          }
        } catch (error) {
          if (stage) {
            if (state) state.accepting = false
            try {
              await removeStage(stage)
              if (state && states.get(uploadId) === state) states.delete(uploadId)
            } catch (cleanupError) {
              if (state) state.cleanupRetry = true
              throw new AggregateError([error, cleanupError], 'upload staging cleanup failed')
            }
          }
          throw error
        }
      })
    })
  }

  async function chunk(req) {
    const headers = req.headers || {}
    const uploadId = headers['x-dsh-upload-id']
    if (Array.isArray(uploadId) || typeof uploadId !== 'string') {
      if (typeof req.resume === 'function') req.resume()
      throw new HttpError(400, 'missing upload id header')
    }
    const fileIndex = parseHeaderInteger(headers['x-dsh-file-index'], 'upload file index')
    const offset = parseHeaderInteger(headers['x-dsh-upload-offset'], 'upload offset')
    const binding = chunkSessionBinding(headers)
    let state
    try {
      state = requireState(uploadId)
      assertStateBinding(state, binding, 'upload chunk session binding changed')
      validateLiveBinding(binding)
      await rejectExpiredState(state)
      uploadSettings()
    } catch (error) {
      if (typeof req.resume === 'function') req.resume()
      throw error
    }
    if (!state.accepting || state.chunkBusy) {
      if (typeof req.resume === 'function') req.resume()
      throw new HttpError(409, 'another upload operation is already in progress')
    }
    state.chunkBusy = true
    state.lastSeen = now()
    try {
      return await withUploadLock(state, async () => {
        if (states.get(uploadId) !== state || !state.accepting) {
          if (typeof req.resume === 'function') req.resume()
          throw new HttpError(404, 'upload session not found')
        }
        validateLiveBinding(binding)
        const result = await writeUploadChunk(req, state.stage, fileIndex, offset, UPLOAD_CHUNK_BYTES)
        state.lastSeen = now()
        return result
      })
    } finally {
      state.chunkBusy = false
    }
  }

  async function finish(payload) {
    const { state, binding } = await resolveBoundState(payload)
    if (!state.accepting) throw new HttpError(409, 'another upload operation is already in progress')
    state.accepting = false
    state.lastSeen = now()
    try {
      return await withPathLock(state.baseDir, () => withUploadLock(state, async () => {
        if (states.get(state.uploadId) !== state) throw new HttpError(404, 'upload session not found')
        if (state.cleanupRetry) throw new HttpError(409, 'upload staging cleanup is pending')
        validateLiveBinding(binding)
        uploadSettings()
        const path = await commitStage(state.baseDir, state.stage, {
          beforeCommit: () => {
            validateLiveBinding(binding)
            uploadSettings()
          },
        })
        states.delete(state.uploadId)
        return { path, ...dropCleanupStatus(state.baseDir) }
      }))
    } catch (error) {
      if (states.get(state.uploadId) === state && !state.cleanupRetry) state.accepting = true
      throw error
    }
  }

  async function cancel(payload) {
    validateUploadId(payload.uploadId)
    const binding = sessionBinding(payload)
    const state = states.get(payload.uploadId)
    if (!state) {
      validateLiveBinding(binding)
      return { cancelled: false }
    }
    assertStateBinding(state, binding)
    validateLiveBinding(binding)
    state.accepting = false
    let cleanupStarted = false
    try {
      return await withPathLock(state.baseDir, () => withUploadLock(state, async () => {
        if (states.get(state.uploadId) !== state) return { cancelled: false }
        validateLiveBinding(binding)
        cleanupStarted = true
        await removeStage(state.stage)
        states.delete(state.uploadId)
        return { cancelled: true }
      }))
    } catch (error) {
      if (cleanupStarted) state.cleanupRetry = true
      else state.accepting = true
      throw error
    }
  }

  async function forgetBase() {
    const baseKey = await canonicalPathKey(uploadBaseDir)
    const forgotten = [...states.values()].filter((state) => state.baseKey === baseKey)
    for (const state of forgotten) {
      state.accepting = false
      states.delete(state.uploadId)
    }
    for (const state of forgotten) await withUploadLock(state, async () => {})
  }

  async function cancelAll() {
    await initTail.catch(() => {})
    const active = [...states.values()]
    const errors = []
    for (const state of active) state.accepting = false
    for (const state of active) {
      try {
        await withPathLock(state.baseDir, () => withUploadLock(state, async () => {
          if (states.get(state.uploadId) !== state) return
          await removeStage(state.stage)
          states.delete(state.uploadId)
        }))
      } catch (error) {
        state.cleanupRetry = true
        warnCleanup(state, error)
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'upload staging cleanup failed')
  }

  async function cleanupBase() {
    return withInitLock(async () => {
      const baseDir = uploadBaseDir
      const baseKey = await canonicalPathKey(baseDir)
      const retained = [...states.values()].filter((state) => state.baseKey === baseKey && state.cleanupRetry)
      for (const state of retained) {
        try {
          await withPathLock(state.baseDir, () => withUploadLock(state, async () => {
            if (states.get(state.uploadId) !== state) return
            await removeStage(state.stage)
            states.delete(state.uploadId)
          }))
        } catch (error) { warnCleanup(state, error) }
      }
      const protectedStates = [...states.values()].filter((state) => state.baseKey === baseKey)
      return withPathLock(baseDir, () => cleanupOrphanUploadStages(
        baseDir,
        new Set(protectedStates.map((state) => state.stage.stageName))
      ))
    })
  }

  return Object.freeze({
    init,
    chunk,
    finish,
    cancel,
    cancelAll,
    cleanupBase,
    forgetBase,
    activeCount: () => states.size,
  })
}
