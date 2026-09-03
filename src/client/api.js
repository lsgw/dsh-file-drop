import {
  API_PATH, DEFAULT_SETTINGS, FAIL_CLOSED_SETTINGS, LOCATE_MODE_ERROR_CODE,
  LOCATE_MODE_ERROR_MESSAGE, MAX_NEGOTIATED_CHUNK_BYTES, MAX_UPLOAD_QUOTA_ENTRIES,
  MAX_UPLOAD_QUOTA_MIB, MODE_READ_ERROR_MESSAGE, QUOTA_ERROR_CODE, QUOTA_ERROR_MESSAGE,
  SETTINGS_PATH, UPLOAD_PATH, UPLOAD_PROTOCOL_VERSION,
} from '../shared/contract.js'
import { clearAllStatuses } from './status.js'
import { chunkRequest } from './chunk-request.js'

let currentSettings = { ...DEFAULT_SETTINGS }
let currentMode = currentSettings.mode
let settingsRefresh
let modeRevision = 0
let settingsWriteQueue = Promise.resolve()
let modeChannel
let modeChannelOwners = 0
const settingsListeners = new Set()
const activeControllers = new Set()

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new DOMException('操作已取消', 'AbortError')
}

function operationController() {
  const controller = new AbortController()
  activeControllers.add(controller)
  return {
    controller,
    release: () => activeControllers.delete(controller),
  }
}

function abortActiveOperations() {
  for (const controller of activeControllers) controller.abort()
  activeControllers.clear()
}

function validSettings(data) {
  return data && !Array.isArray(data) && typeof data === 'object'
    && Object.keys(data).sort().join(',') === 'mode,uploadQuotaEntries,uploadQuotaMiB'
    && (data.mode === 'upload' || data.mode === 'locate')
    && Number.isSafeInteger(data.uploadQuotaMiB) && data.uploadQuotaMiB >= 1
    && data.uploadQuotaMiB <= MAX_UPLOAD_QUOTA_MIB
    && Number.isSafeInteger(data.uploadQuotaEntries) && data.uploadQuotaEntries >= 1
    && data.uploadQuotaEntries <= MAX_UPLOAD_QUOTA_ENTRIES
}

async function readSettings(signal, fallback = true) {
  try {
    const response = await fetch(SETTINGS_PATH, { signal })
    const data = await response.json()
    if (!response.ok || !validSettings(data)) throw new Error('invalid settings response')
    return {
      mode: data.mode,
      uploadQuotaMiB: data.uploadQuotaMiB,
      uploadQuotaEntries: data.uploadQuotaEntries,
    }
  } catch (error) {
    if (!fallback) throw error
    return { ...FAIL_CLOSED_SETTINGS }
  }
}

function refreshSettings() {
  if (!settingsRefresh) {
    settingsRefresh = readSettings().then(adoptSettings).finally(() => { settingsRefresh = undefined })
  }
  return settingsRefresh
}

function adoptSettings(settings) {
  const changed = settings.mode !== currentSettings.mode
    || settings.uploadQuotaMiB !== currentSettings.uploadQuotaMiB
    || settings.uploadQuotaEntries !== currentSettings.uploadQuotaEntries
  currentSettings = settings
  if (settings.mode !== currentMode) {
    abortActiveOperations()
    clearAllStatuses()
    currentMode = settings.mode
    modeRevision += 1
  }
  if (changed) for (const listener of [...settingsListeners]) listener(settings)
  return settings
}

function subscribeSettings(listener) {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

function writeSettings(patch) {
  const persist = async () => {
    const response = await fetch(SETTINGS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !validSettings(data)) {
      throw new Error(data.error || ('保存拖拽设置失败（HTTP ' + response.status + '）'))
    }
    const latest = await readSettings(undefined, false)
    adoptSettings(latest)
    if (modeChannel) modeChannel.postMessage(latest)
    return latest
  }
  settingsWriteQueue = settingsWriteQueue.catch(() => {}).then(persist)
  return settingsWriteQueue
}

async function refreshModeForAction() {
  await settingsWriteQueue
  adoptSettings(await readSettings(undefined, false))
  return currentMode
}

function beginModeChange(nextMode) {
  abortActiveOperations()
  clearAllStatuses()
  modeRevision += 1
  if (nextMode === 'locate') currentMode = 'locate'
  return currentMode
}

async function readUserUploadUsage(signal) {
  const response = await fetch(API_PATH + '/size', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal,
  })
  return { response, data: await response.json().catch(() => ({})) }
}

async function clearUserUploadRoot(signal) {
  const response = await fetch(API_PATH + '/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ global: true }),
    signal,
  })
  return { response, data: await response.json().catch(() => ({})) }
}

// ---- 有界分块上传 ----

function sessionPayload(sessionId) {
  return sessionId === undefined ? {} : { sessionId }
}

function uploadRequestError(data, status, fallback) {
  const code = data && data.code
  const known = code === QUOTA_ERROR_CODE || code === LOCATE_MODE_ERROR_CODE
  const message = code === QUOTA_ERROR_CODE ? QUOTA_ERROR_MESSAGE
    : code === LOCATE_MODE_ERROR_CODE ? LOCATE_MODE_ERROR_MESSAGE
      : (data && data.error) || (fallback + '（HTTP ' + status + '）')
  const error = new Error(message)
  if (known) error.code = code
  return error
}

async function uploadControl(action, payload, signal) {
  const response = await fetch(UPLOAD_PATH + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw uploadRequestError(data, response.status, '上传请求失败')
  return data
}

async function cancelUpload(uploadId, sessionId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    await uploadControl('cancel', { ...sessionPayload(sessionId), uploadId }, controller.signal)
  } catch { /* Host 会在下次上传时回收遗留 staging。 */ }
  finally { clearTimeout(timer) }
}

function chunkSessionHeaders(sessionId) {
  return sessionId === undefined
    ? { 'x-dsh-session-scope': 'global' }
    : { 'x-dsh-session-scope': 'session', 'x-dsh-session-id': encodeURIComponent(String(sessionId)) }
}
async function uploadFileChunks(file, fileIndex, uploadId, chunkBytes, sessionId, signal, onProgress,
  responseTimeoutMs = 45_000) {
  let offset = 0
  while (offset < file.size) {
    throwIfAborted(signal)
    const end = Math.min(offset + chunkBytes, file.size)
    const { response, data } = await chunkRequest(UPLOAD_PATH + '/chunk', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-dsh-upload-id': uploadId,
        'x-dsh-file-index': String(fileIndex),
        'x-dsh-upload-offset': String(offset),
        ...chunkSessionHeaders(sessionId),
      },
      body: file.slice(offset, end, 'application/octet-stream'),
      signal,
    }, responseTimeoutMs)
    if (!response.ok) throw uploadRequestError(data, response.status, '上传分块失败')
    if (data.written !== end || data.size !== file.size) throw new Error('Host 返回了无效的上传进度')
    offset = end
    if (onProgress) onProgress(end)
  }
}

async function uploadChunked(manifest, files, opts = {}) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error('上传内容大小无效')
  let uploadId
  try {
    const initialized = await uploadControl('init', {
      protocolVersion: UPLOAD_PROTOCOL_VERSION,
      ...sessionPayload(opts.sessionId),
      ...manifest,
    }, opts.signal)
    uploadId = initialized.uploadId
    const chunkBytes = initialized.chunkBytes
    if (typeof uploadId !== 'string' || uploadId.length > 64
      || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_NEGOTIATED_CHUNK_BYTES
      || initialized.fileCount !== files.length || initialized.totalBytes !== totalBytes) {
      throw new Error('Host 返回了无效的上传会话')
    }
    let completedBytes = 0
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      await uploadFileChunks(file, index, uploadId, chunkBytes, opts.sessionId, opts.signal, (written) => {
        if (opts.onProgress) opts.onProgress(completedBytes + written, totalBytes)
      }, opts.chunkResponseTimeoutMs)
      completedBytes += file.size
    }
    throwIfAborted(opts.signal)
    const finished = await uploadControl('finish', {
      ...sessionPayload(opts.sessionId),
      uploadId,
    }, opts.signal)
    if (!finished.path) throw new Error('Host 未返回上传路径')
    uploadId = undefined
    return finished
  } catch (error) {
    if (uploadId) await cancelUpload(uploadId, opts.sessionId)
    throw error
  }
}

async function initializeSettings() {
  try {
    const settings = await readSettings(undefined, false)
    currentSettings = settings
    currentMode = settings.mode
  } catch {
    currentMode = 'locate'
  }
}

function openModeChannel() {
  if (!window.BroadcastChannel) return () => {}
  if (!modeChannel) {
    modeChannel = new window.BroadcastChannel('dsh-file-drop-settings')
    modeChannel.addEventListener('message', (event) => {
      if (validSettings(event.data)) adoptSettings({ ...event.data })
    })
  }
  modeChannelOwners += 1
  let released = false
  return () => {
    if (released) return
    released = true
    modeChannelOwners -= 1
    if (modeChannelOwners > 0 || !modeChannel) return
    const channel = modeChannel
    modeChannel = undefined
    channel.close()
  }
}

export {
  abortActiveOperations, adoptSettings, beginModeChange, clearUserUploadRoot, currentMode, currentSettings,
  initializeSettings, modeRevision, openModeChannel, operationController, readSettings,
  readUserUploadUsage, refreshModeForAction, refreshSettings, subscribeSettings, throwIfAborted, uploadChunked,
  uploadFileChunks, validSettings, writeSettings,
}
