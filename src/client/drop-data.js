import { MAX_DIRECTORY_ENTRIES, MAX_ROOT_DIRECTORIES } from '../shared/contract.js'
import { throwIfAborted } from './api.js'

function drainShellPaths() {
  try {
    if (typeof window === 'undefined' || !window.dshDesktop) return []
    if (typeof window.dshDesktop.drainDroppedPaths === 'function') {
      const p = window.dshDesktop.drainDroppedPaths()
      return Array.isArray(p) ? p : []
    }
  } catch { /* 忽略 */ }
  return []
}

// 按钮/兜底场景：直接映射单个 File（preload 暴露的备用 API）
function shellPathOf(file) {
  try {
    if (typeof window === 'undefined' || !window.dshDesktop) return null
    if (typeof window.dshDesktop.getPathForFile === 'function') {
      const p = window.dshDesktop.getPathForFile(file)
      return (typeof p === 'string' && p.length > 0) ? p : null
    }
  } catch { /* 忽略 */ }
  return null
}

function fileUriToPath(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const host = decodeURIComponent(url.hostname)
    let path = decodeURIComponent(url.pathname)
    const driveUri = /^\/[A-Za-z]:\//.test(path)
    if (driveUri) path = path.slice(1).replaceAll('/', '\\')
    if (host && host.toLowerCase() !== 'localhost') path = '//' + host + path
    return path || null
  } catch { return null }
}

// 拖拽自带路径（Obsidian / 文件管理器拖拽常带 uri-list）
function extractPaths(e) {
  const paths = []
  try {
    const uris = (e.dataTransfer.getData('text/uri-list') || '').split('\n')
    for (const line of uris) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (/^file:\/\//i.test(t)) {
        const path = fileUriToPath(t)
        if (path) paths.push(path)
      } else if (t.startsWith('/')) {
        paths.push(t)
      }
    }
  } catch { /* 某些浏览器/事件阶段读不了，忽略 */ }
  if (paths.length === 0) {
    try {
      const plain = (e.dataTransfer.getData('text/plain') || '').trim()
      if (plain && (plain.startsWith('/') || /^\\\\[^\\]/.test(plain) || /^[A-Za-z]:[\\/]/.test(plain)) && !plain.includes('\n')) {
        paths.push(plain)
      }
    } catch { /* 忽略 */ }
  }
  return [...new Set(paths)]
}

// ---- 目录遍历（webkitGetAsEntry，upload 与 locate 共用） ----

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

function getDirectoryEntries(items) {
  const dirs = []
  if (!items) return dirs
  for (const item of items) {
    try {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry()
      if (entry && entry.isDirectory) {
        dirs.push(entry)
        if (dirs.length > MAX_ROOT_DIRECTORIES) break
      }
    } catch { /* 忽略 */ }
  }
  return dirs
}


export {
  abortableCallback, abortableDelay, drainShellPaths, extractPaths, fileUriToPath,
  getDirectoryEntries, readEntryAll, shellPathOf, shouldHandleDataTransfer,
}
