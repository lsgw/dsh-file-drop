import { MAX_ROOT_DIRECTORIES } from '../shared/contract.js'
import { throwIfAborted } from './api.js'

// ---- 目录遍历（标准 File System Handle） ----

function abortableCallback(signal, start) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, new DOMException('操作已取消', 'AbortError'))
    if (signal && signal.aborted) { onAbort(); return }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try { start((value) => finish(resolve, value), (error) => finish(reject, error)) }
    catch (error) { finish(reject, error) }
  })
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('操作已取消', 'AbortError'))
    }
    if (signal && signal.aborted) { reject(new DOMException('操作已取消', 'AbortError')); return }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readEntryAll(entry, limit = Number.POSITIVE_INFINITY, state = { count: 0 }, signal,
  includeDirectory = false, entryLimit = Number.POSITIVE_INFINITY) {
  if (!Number.isSafeInteger(state.entries)) state.entries = 0
  throwIfAborted(signal)
  if (state.count >= limit || state.entries >= entryLimit) return []
  if (entry.isFile) {
    const file = await abortableCallback(signal, (resolve, reject) => entry.file(resolve, reject))
    throwIfAborted(signal)
    if (state.count >= limit || state.entries >= entryLimit) return []
    state.count += 1
    state.entries += 1
    return [{ path: '', kind: 'file', file }]
  }
  if (!entry.isDirectory) return []
  const reader = entry.createReader()
  const out = []
  if (includeDirectory) {
    state.entries += 1
    out.push({ path: '', kind: 'directory' })
  }
  while (state.count < limit && state.entries < entryLimit) {
    const children = await abortableCallback(signal, (resolve, reject) => reader.readEntries(resolve, reject))
    throwIfAborted(signal)
    if (!children || children.length === 0) break
    for (const child of children) {
      throwIfAborted(signal)
      if (state.count >= limit || state.entries >= entryLimit) break
      const results = await readEntryAll(child, limit, state, signal, true, entryLimit)
      for (const result of results) {
        out.push({ ...result, path: child.name + (result.path ? '/' + result.path : '') })
      }
    }
  }
  return out
}

function shouldHandleDataTransfer(dataTransfer) {
  return Boolean(dataTransfer && Array.from(dataTransfer.types || []).includes('Files'))
}

function fileSystemHandleEntry(handle) {
  if (!handle || typeof handle !== 'object' || typeof handle.name !== 'string') return undefined
  if (handle.kind === 'file' && typeof handle.getFile === 'function') {
    return {
      name: handle.name,
      isFile: true,
      isDirectory: false,
      file(resolve, reject) { Promise.resolve(handle.getFile()).then(resolve, reject) },
    }
  }
  if (handle.kind !== 'directory' || typeof handle.values !== 'function') return undefined
  let iterator
  return {
    name: handle.name,
    isFile: false,
    isDirectory: true,
    createReader() {
      iterator ||= handle.values()
      return {
        readEntries(resolve, reject) {
          Promise.resolve().then(async () => {
            const entries = []
            while (entries.length < 100) {
              const next = await iterator.next()
              if (next.done) break
              const entry = fileSystemHandleEntry(next.value)
              if (entry) entries.push(entry)
            }
            resolve(entries)
          }).catch(reject)
        },
      }
    },
  }
}

async function getDirectoryEntries(items) {
  const dirs = []
  if (!items) return dirs
  for (const item of items) {
    try {
      let entry
      if (typeof item.getAsFileSystemHandle === 'function') {
        try { entry = fileSystemHandleEntry(await item.getAsFileSystemHandle()) } catch { /* 当前浏览器不支持 */ }
      }

      if (entry && entry.isDirectory) {
        dirs.push(entry)
        if (dirs.length > MAX_ROOT_DIRECTORIES) break
      }
    } catch { /* 忽略 */ }
  }
  return dirs
}


export {
  abortableCallback, abortableDelay, getDirectoryEntries, readEntryAll, shouldHandleDataTransfer,
}