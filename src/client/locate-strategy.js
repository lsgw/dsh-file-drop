import {
  FILE_DROP_ROUTE as LOCATE_ROUTE, LOCATE_FULL_MAX_BYTES, LOCATE_MAX_DEPTH,
  LOCATE_MAX_ENTRIES, LOCATE_PROTOCOL_VERSION, LOCATE_SAMPLE_BYTES, MAX_TOP_LEVEL_FILES,
} from '../shared/contract.js'
import { throwIfAborted } from './api.js'
import { abortableCallback } from './drop-data.js'
import { insertPaths, summarizeItems } from './editor.js'
import { retryWorkspaceContext, workspaceContext } from './session.js'
import { statusStore } from './status.js'

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function droppedFileMeta(file) {
  return { kind: 'file', name: file.name, size: file.size, lastModified: file.lastModified }
}

function hexFromArrayBuffer(buffer) {
  return [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function locateSampleRanges(size) {
  if (size <= LOCATE_SAMPLE_BYTES * 3) return [{ start: 0, end: size }]
  const starts = [0, Math.max(0, Math.floor(size / 2) - Math.floor(LOCATE_SAMPLE_BYTES / 2)), size - LOCATE_SAMPLE_BYTES]
  return starts.map((start) => ({ start, end: Math.min(start + LOCATE_SAMPLE_BYTES, size) }))
}

async function fileSampleFingerprint(file, signal) {
  throwIfAborted(signal)
  const ranges = locateSampleRanges(file.size)
  const parts = await Promise.all(ranges.map((r) => file.slice(r.start, r.end).arrayBuffer()))
  throwIfAborted(signal)
  const total = parts.reduce((sum, part) => sum + part.byteLength, 8)
  const combined = new Uint8Array(total)
  new DataView(combined.buffer).setBigUint64(0, BigInt(file.size))
  let cursor = 8
  for (const part of parts) {
    combined.set(new Uint8Array(part), cursor)
    cursor += part.byteLength
  }
  const digest = await crypto.subtle.digest('SHA-256', combined)
  throwIfAborted(signal)
  return hexFromArrayBuffer(digest)
}

async function fileFullFingerprint(file, signal) {
  throwIfAborted(signal)
  const bytes = await file.arrayBuffer()
  throwIfAborted(signal)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  throwIfAborted(signal)
  return hexFromArrayBuffer(digest)
}

async function locateRequest(body, signal) {
  const response = await fetch(LOCATE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, protocolVersion: LOCATE_PROTOCOL_VERSION }),
    signal,
  })
  const value = await response.json().catch(() => ({}))
  return response.ok ? value : { status: 'error', message: value.message || ('HTTP ' + response.status) }
}

async function readEntryChildren(entry, signal) {
  throwIfAborted(signal)
  const reader = entry.createReader()
  const out = []
  while (true) {
    const batch = await abortableCallback(signal, (resolve, reject) => reader.readEntries(resolve, reject))
    throwIfAborted(signal)
    if (!batch || batch.length === 0) return out
    out.push(...batch)
  }
}

async function readDirectoryStructure(root, signal) {
  const entries = []
  let truncated = false
  const visit = async (directory, prefix, depth) => {
    throwIfAborted(signal)
    if (depth >= LOCATE_MAX_DEPTH) { truncated = true; return }
    const children = await readEntryChildren(directory, signal)
    children.sort((a, b) => compareText(a.name, b.name))
    for (const child of children) {
      throwIfAborted(signal)
      if (entries.length >= LOCATE_MAX_ENTRIES) { truncated = true; return }
      const path = prefix === '' ? child.name : prefix + '/' + child.name
      if (child.isDirectory) {
        entries.push({ path, kind: 'directory' })
        await visit(child, path, depth + 1)
      } else if (child.isFile) {
        const file = await abortableCallback(signal, (resolve, reject) => child.file(resolve, reject))
        entries.push({ path, kind: 'file', size: file.size })
      }
    }
  }
  await visit(root, '', 0)
  return { entries, truncated }
}

async function findEntryByPath(root, relativePath, signal) {
  let current = root
  for (const part of relativePath.split('/')) {
    throwIfAborted(signal)
    if (!current || !current.isDirectory) return undefined
    const children = await readEntryChildren(current, signal)
    current = children.find((entry) => entry.name === part)
    if (current === undefined) {
      const normalizedPart = part.normalize('NFC')
      const equivalent = children.filter((entry) => entry.name.normalize('NFC') === normalizedPart)
      current = equivalent.length === 1 ? equivalent[0] : undefined
    }
    if (current === undefined) return undefined
  }
  return current
}

async function readDirectoryContentSamples(root, paths, signal) {
  const samples = []
  for (const path of paths) {
    throwIfAborted(signal)
    const entry = await findEntryByPath(root, path, signal)
    if (entry && entry.isFile === true) {
      const file = await abortableCallback(signal, (resolve, reject) => entry.file(resolve, reject))
      samples.push({ path, size: file.size, digest: await fileSampleFingerprint(file, signal) })
    }
  }
  return samples
}

async function verifyFileCandidates(file, meta, result, sessionId, signal) {
  if (result.status !== 'sample-required') return result
  result = await locateRequest({
    phase: 'sample',
    file: meta,
    candidates: result.candidates,
    digest: await fileSampleFingerprint(file, signal),
    challenge: result.challenge,
    ...(sessionId === undefined ? {} : { sessionId }),
  }, signal)
  const needsSafeFull = result.status === 'choose'
    && result.fullDigestSkipped !== true
    && file.size > LOCATE_SAMPLE_BYTES * 3
    && file.size <= LOCATE_FULL_MAX_BYTES
  if (result.status !== 'full-required' && !needsSafeFull) return result
  if (file.size > LOCATE_FULL_MAX_BYTES) {
    return { status: 'choose', candidates: result.candidates }
  }
  return locateRequest({
    phase: 'full',
    file: meta,
    candidates: result.candidates,
    digest: await fileFullFingerprint(file, signal),
    challenge: result.challenge,
    ...(sessionId === undefined ? {} : { sessionId }),
  }, signal)
}

async function locateDroppedFile(file, workspaces, currentWorkspacePath, sessionId, signal) {
  const meta = droppedFileMeta(file)
  const wctx = workspaceContext(workspaces, currentWorkspacePath, sessionId)
  const metadata = await locateRequest({ phase: 'metadata', file: meta, ...wctx }, signal)
  let result = await verifyFileCandidates(file, meta, metadata, sessionId, signal)
  if (result.status !== 'not-found') return result

  // 排除内容不匹配的候选和当前根，再在可信搜索范围内查找嵌套原件。
  const retryContext = currentWorkspacePath === undefined ? wctx : retryWorkspaceContext(wctx, currentWorkspacePath)
  result = await locateRequest({
    phase: 'metadata', file: meta, ...retryContext,
    excludedCandidates: Array.isArray(metadata.candidates) ? metadata.candidates : [],
  }, signal)
  return verifyFileCandidates(file, meta, result, sessionId, signal)
}

async function verifyDirectoryCandidates(entry, initial, result, sessionId, signal) {
  if (result.status !== 'directory-structure-required') return result
  const meta = { ...initial, structure: await readDirectoryStructure(entry, signal) }
  result = await locateRequest({
    phase: 'directory-structure',
    file: meta,
    candidates: result.candidates,
    challenge: result.challenge,
    ...(sessionId === undefined ? {} : { sessionId }),
  }, signal)
  if (result.status !== 'directory-content-required') return result
  return locateRequest({
    phase: 'directory-content',
    file: meta,
    candidates: result.candidates,
    directorySamples: await readDirectoryContentSamples(entry, result.paths, signal),
    challenge: result.challenge,
    ...(sessionId === undefined ? {} : { sessionId }),
  }, signal)
}

async function locateDroppedDirectory(entry, workspaces, currentWorkspacePath, sessionId, signal) {
  const initial = { kind: 'directory', name: entry.name }
  const wctx = workspaceContext(workspaces, currentWorkspacePath, sessionId)
  const metadata = await locateRequest({ phase: 'metadata', file: initial, ...wctx }, signal)
  let result = await verifyDirectoryCandidates(entry, initial, metadata, sessionId, signal)
  if (result.status !== 'not-found') return result
  const retryContext = currentWorkspacePath === undefined ? wctx : retryWorkspaceContext(wctx, currentWorkspacePath)
  result = await locateRequest({
    phase: 'metadata', file: initial, ...retryContext,
    excludedCandidates: Array.isArray(metadata.candidates) ? metadata.candidates : [],
  }, signal)
  return verifyDirectoryCandidates(entry, initial, result, sessionId, signal)
}

function choosePathInteractive(name, candidates) {
  // 多个候选无法区分时，用简单弹窗让用户选择序号（后续可换成更友好的 UI）
  const shown = []
  let textLength = 0
  for (const path of candidates.slice(0, 20)) {
    const line = '[' + shown.length + '] ' + path
    if (shown.length > 0 && textLength + line.length + 1 > 16000) break
    shown.push(line.slice(0, 16000))
    textLength += line.length + 1
  }
  const max = shown.length
  const lines = shown.join('\n')
  const raw = window.prompt('「' + name + '」有多个匹配路径，输入序号选择：\n' + lines)
  if (raw === null || raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  const idx = Number(raw.trim())
  return idx >= 0 && idx < max ? candidates[idx] : undefined
}

async function processFilesLocate(files, opts) {
  if (files.length > MAX_TOP_LEVEL_FILES) {
    statusStore.show('✗ 一次最多处理 ' + MAX_TOP_LEVEL_FILES + ' 个文件')
    return
  }
  const { sessionId, inputActions, getDraft, workspaces, currentWorkspacePath, signal } = opts
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const statusToken = statusStore.begin('正在定位文件中…')
  const found = []
  const failures = []
  for (const file of files) {
    try {
      const result = await locateDroppedFile(file, workspaces, currentWorkspacePath, sessionId, signal)
      if (!isActive()) { statusStore.cancel(statusToken); return }
      if (result.status === 'found') found.push(result.path)
      else if (result.status === 'choose') {
        const picked = choosePathInteractive(file.name, result.candidates)
        if (picked) found.push(picked)
        else failures.push(file.name)
      } else failures.push(file.name)
    } catch (err) {
      if (!isActive()) { statusStore.cancel(statusToken); return }
      failures.push(file.name)
    }
  }
  if (!isActive()) { statusStore.cancel(statusToken); return }
  if (found.length > 0) insertPaths(inputActions, getDraft(), found, isActive, opts.ownerElement)
  const summary = [
    found.length > 0 ? '✓ 已定位 ' + found.length + ' 个原始路径' : '',
    failures.length > 0 ? '✗ 未能定位：' + summarizeItems(failures, '、') : '',
  ].filter(Boolean).join('　')
  statusStore.finish(statusToken, summary || '✗ 没有文件被定位')
}

async function processDirectoryLocate(entry, opts) {
  const { sessionId, inputActions, getDraft, workspaces, currentWorkspacePath, signal } = opts
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const statusToken = statusStore.begin('正在定位目录中…')
  try {
    const result = await locateDroppedDirectory(entry, workspaces, currentWorkspacePath, sessionId, signal)
    if (!isActive()) { statusStore.cancel(statusToken); return }
    if (result.status === 'found') {
      insertPaths(inputActions, getDraft(), [result.path], isActive, opts.ownerElement)
      statusStore.finish(statusToken, '✓ 已定位目录原始路径：' + entry.name)
    } else if (result.status === 'choose') {
      const picked = choosePathInteractive(entry.name, result.candidates)
      if (picked) {
        insertPaths(inputActions, getDraft(), [picked], isActive, opts.ownerElement)
        statusStore.finish(statusToken, '✓ 已定位目录原始路径：' + entry.name)
      } else {
        statusStore.finish(statusToken, '✗ 未选择目录路径')
      }
    } else {
      statusStore.finish(statusToken, '✗ 未能定位目录：' + entry.name)
    }
  } catch (err) {
    if (!isActive()) { statusStore.cancel(statusToken); return }
    statusStore.finish(statusToken, '✗ 未能定位目录：' + entry.name)
  }
}

export {
  fileFullFingerprint, fileSampleFingerprint, locateDroppedDirectory, locateDroppedFile,
  locateSampleRanges, processDirectoryLocate, processFilesLocate, readDirectoryStructure,
}
