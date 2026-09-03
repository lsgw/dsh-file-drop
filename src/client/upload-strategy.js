import {
  LOCATE_MODE_ERROR_CODE, LOCATE_MODE_ERROR_MESSAGE, MAX_DIRECTORY_ENTRIES,
  MAX_TOP_LEVEL_FILES, QUOTA_ERROR_CODE, QUOTA_ERROR_MESSAGE,
} from '../shared/contract.js'
import { uploadChunked } from './api.js'
import { readEntryAll } from './drop-data.js'
import { insertPaths, summarizeItems } from './editor.js'
import { formatSize } from './format.js'
import { statusStore } from './status.js'

async function processFilesUpload(files, opts) {
  const statuses = opts.statusStore || statusStore
  if (!files.length) return
  if (files.length > MAX_TOP_LEVEL_FILES) {
    statuses.show('✗ 一次最多处理 ' + MAX_TOP_LEVEL_FILES + ' 个文件')
    return
  }
  const { sessionId, inputActions, getDraft, signal } = opts
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const statusToken = statuses.begin('正在上传 ' + files.length + ' 个文件…')
  const ok = []
  const errs = []
  let quotaReached = false
  let locateModeBlocked = false
  for (const file of files) {
    if (!isActive()) { statuses.cancel(statusToken); return }
    try {
      const result = await uploadChunked({ kind: 'file', name: file.name, size: file.size }, [file], {
        sessionId,
        signal,
        onProgress: (written, total) => {
          if (isActive()) statuses.update(statusToken, '正在上传 ' + file.name + '（' + formatSize(written) + ' / ' + formatSize(total) + '）…')
        },
      })
      if (!isActive()) { statuses.cancel(statusToken); return }
      ok.push(result.path)
    } catch (error) {
      if (!isActive()) { statuses.cancel(statusToken); return }
      if (error && error.code === QUOTA_ERROR_CODE) { quotaReached = true; break }
      if (error && error.code === LOCATE_MODE_ERROR_CODE) { locateModeBlocked = true; break }
      errs.push(file.name + '：' + String((error && error.message) || error))
    }
  }
  if (!isActive()) { statuses.cancel(statusToken); return }
  if (ok.length > 0) insertPaths(inputActions, getDraft(), ok, isActive, opts.ownerElement)
  const text = [
    ok.length > 0 ? '✓ ' + ok.length + ' 个文件已上传' : '',
    quotaReached ? '✗ ' + QUOTA_ERROR_MESSAGE : '',
    locateModeBlocked ? '✗ ' + LOCATE_MODE_ERROR_MESSAGE : '',
    errs.length > 0 ? '✗ ' + summarizeItems(errs) : '',
  ].filter(Boolean).join('　')
  statuses.finish(statusToken, text || '没有文件被处理')
}

// 目录只上传结构清单，文件内容逐块发送，空子目录会被保留。
async function processDirectoryUpload(entry, opts) {
  const statuses = opts.statusStore || statusStore
  const { sessionId, inputActions, getDraft, signal } = opts
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
  const MAX_DIR_FILES = 500
  const statusToken = statuses.begin('正在读取目录 ' + entry.name + ' …')
  let all
  try {
    all = await readEntryAll(
      entry,
      MAX_DIR_FILES + 1,
      { count: 0, entries: 0 },
      signal,
      false,
      MAX_DIRECTORY_ENTRIES + 1
    )
  } catch (error) {
    if (!isActive()) { statuses.cancel(statusToken); return }
    statuses.finish(statusToken, '✗ 读取目录失败：' + String((error && error.message) || error))
    return
  }
  if (!isActive()) { statuses.cancel(statusToken); return }
  const fileRecords = all.filter((record) => record.kind === 'file')
  if (fileRecords.length > MAX_DIR_FILES) {
    statuses.finish(statusToken, '✗ 目录超过 ' + MAX_DIR_FILES + ' 个文件限制，未上传任何内容')
    return
  }
  if (all.length > MAX_DIRECTORY_ENTRIES) {
    statuses.finish(statusToken, '✗ 目录超过 ' + MAX_DIRECTORY_ENTRIES + ' 个条目限制，未上传任何内容')
    return
  }
  const entries = all.map((record) => record.kind === 'directory'
    ? { kind: 'directory', path: record.path }
    : { kind: 'file', path: record.path || record.file.name, size: record.file.size })
  const files = fileRecords.map((record) => record.file)
  statuses.update(statusToken, '正在上传目录 ' + entry.name + '（' + files.length + ' 个文件）…')
  try {
    const result = await uploadChunked({ kind: 'directory', name: entry.name, entries }, files, {
      sessionId,
      signal,
      onProgress: (written, total) => {
        if (isActive()) statuses.update(statusToken, '正在上传目录 ' + entry.name + '（' + formatSize(written) + ' / ' + formatSize(total) + '）…')
      },
    })
    if (!isActive()) { statuses.cancel(statusToken); return }
    insertPaths(inputActions, getDraft(), [result.path], isActive, opts.ownerElement)
    const cleanupNote = result.cleanupError
      ? '；原目录清理失败：' + result.cleanupError
      : result.cleanupPending ? '；原目录正在后台清理' : ''
    statuses.finish(statusToken, '✓ 目录已上传' + cleanupNote)
  } catch (error) {
    if (!isActive()) { statuses.cancel(statusToken); return }
    statuses.finish(statusToken, error && error.code === QUOTA_ERROR_CODE
      ? '✗ ' + QUOTA_ERROR_MESSAGE
      : error && error.code === LOCATE_MODE_ERROR_CODE
        ? '✗ ' + LOCATE_MODE_ERROR_MESSAGE
        : '✗ 目录上传失败：' + String((error && error.message) || error))
  }
}

export { processDirectoryUpload, processFilesUpload }
