// dsh-file-drop · Client half（DSH web __ModuleLoader__ 格式）
// 两种模式职责互斥：upload 只复制文件/目录，locate 只获取或搜索原始路径。
// 回形针按钮选择文件；上传和定位模式都接管所有文件和目录，避免旁路各自的 Host 契约。
window.__ModuleLoader__.load({
  id: 'dsh-file-drop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const MAX_TOP_LEVEL_FILES = 500
    const MAX_DIRECTORY_ENTRIES = 10000
    const MAX_ROOT_DIRECTORIES = 32
    const DEFAULT_SETTINGS = Object.freeze({ mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 })
    const FAIL_CLOSED_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, mode: 'locate' })
    const MAX_UPLOAD_QUOTA_MIB = 1024 * 1024
    const MAX_UPLOAD_QUOTA_ENTRIES = 100000
    const MIB_BYTES = 1024 * 1024
    const QUOTA_ERROR_CODE = 'quota_exceeded'
    const QUOTA_ERROR_MESSAGE = '已达上传配额，需清理 .dsh-drops'
    const LOCATE_MODE_ERROR_CODE = 'locate_mode'
    const LOCATE_MODE_ERROR_MESSAGE = '当前为定位模式，未上传'
    const MODE_READ_ERROR_MESSAGE = '无法确认当前拖拽模式，未上传'
    const MAX_NEGOTIATED_CHUNK_BYTES = 4 * 1024 * 1024
    const API_PATH = '/api/dsh-file-drop'
    const UPLOAD_PATH = API_PATH + '/upload'
    const SETTINGS_PATH = API_PATH + '/settings'
    let currentSettings = { ...DEFAULT_SETTINGS }
    let currentMode = currentSettings.mode
    let settingsRefresh
    let settingsLoaded = false
    let modeRevision = 0
    let settingsWriteQueue = Promise.resolve()
    let modeChannel
    const activeControllers = new Set()
    const claimedDropEvents = new WeakSet()
    const dropOwners = new Set()

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
        settingsRefresh = readSettings().then((settings) => {
          currentSettings = settings
          settingsLoaded = true
          return settings
        }).finally(() => { settingsRefresh = undefined })
      }
      return settingsRefresh
    }

    function adoptSettings(settings) {
      currentSettings = settings
      settingsLoaded = true
      if (settings.mode !== currentMode) {
        abortActiveOperations()
        statusStore.clear()
        currentMode = settings.mode
        modeRevision += 1
      }
      return settings
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
      statusStore.clear()
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

    async function uploadFileChunks(file, fileIndex, uploadId, chunkBytes, sessionId, signal, onProgress) {
      let offset = 0
      while (offset < file.size) {
        throwIfAborted(signal)
        const end = Math.min(offset + chunkBytes, file.size)
        const response = await fetch(UPLOAD_PATH + '/chunk', {
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
        })
        const data = await response.json().catch(() => ({}))
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
          })
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

    // ---- 桌面壳 ----

    // 拖拽场景：preload 在捕获阶段已用 webUtils.getPathForFile 解析好路径
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

    // ---- 共享状态（按钮上传与拖拽共用一个状态条） ----

    const STATUS_DISMISS_MS = 3500
    const statusStore = {
      value: null,
      listeners: new Set(),
      timer: null,
      generation: 0,
      revision: 0,
      notify() {
        for (const listener of [...this.listeners]) listener()
      },
      set(text, { autoDismiss = true } = {}) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        const revision = ++this.revision
        this.value = text
        this.notify()
        if (!autoDismiss) return true
        this.timer = setTimeout(() => {
          if (revision !== this.revision) return
          this.timer = null
          this.value = null
          this.notify()
        }, STATUS_DISMISS_MS)
        return true
      },
      show(text) {
        this.generation += 1
        return this.set(text)
      },
      begin(text) {
        const token = ++this.generation
        this.set(text, { autoDismiss: false })
        return token
      },
      update(token, text) {
        if (token !== this.generation) return false
        return this.set(text, { autoDismiss: false })
      },
      finish(token, text) {
        if (token !== this.generation) return false
        return this.set(text)
      },
      cancel(token) {
        if (token === this.generation) this.clear()
      },
      clear() {
        this.generation += 1
        this.revision += 1
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.value = null
        this.notify()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    function useStatus() {
      return React.useSyncExternalStore(
        (listener) => statusStore.subscribe(listener),
        () => statusStore.value,
        () => statusStore.value
      )
    }

    if (typeof window.BroadcastChannel === 'function') {
      modeChannel = new window.BroadcastChannel('dsh-file-drop-settings')
      modeChannel.addEventListener('message', (event) => {
        if (!validSettings(event.data)) return
        adoptSettings({ ...event.data })
      })
    }

    // ---- 光标处插入（零跟踪：坐标直接读 textarea 的 DOM 原生 selection） ----

    // composer 的 textarea 是真实原生 <textarea>，父容器稳定锚点 [data-input-scroll]；
    // selectionStart/selectionEnd 失焦后由浏览器保留最近一次值，无需插件自己跟踪。
    function composerTextarea(draft) {
      const all = [...document.querySelectorAll('[data-input-scroll] textarea')]
      const visible = all.filter((el) => el.isConnected && el.getClientRects().length > 0)
      if (visible.includes(document.activeElement)) return document.activeElement
      const matching = visible.filter((el) => el.value === draft)
      return matching.at(-1) || visible.at(-1) || all.at(-1) || null
    }

    function summarizeItems(items, separator = '；', limit = 8) {
      const visible = items.slice(0, limit).join(separator)
      return items.length > limit ? visible + separator + '另有 ' + (items.length - limit) + ' 项' : visible
    }

    function markdownPath(path) {
      const text = String(path)
      const maxRun = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length))
      const fence = '`'.repeat(maxRun + 1)
      const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
      return fence + padding + text + padding + fence
    }

    function insertPaths(inputActions, draft, paths, isActive = () => true) {
      if (!inputActions || !isActive()) return
      const fallbackDraft = typeof draft === 'string' ? draft : ''
      const insert = paths.map(markdownPath).join(' ')
      // 聚焦时读到当前光标；未聚焦时读到 DOM 原生保留的上次光标位置。
      // 唯一盲区：从未聚焦过的 textarea 恒为 0，空草稿下与插入末尾等价。
      const el = composerTextarea(fallbackDraft)
      const currentDraft = el ? el.value : fallbackDraft
      const start = Math.min(el ? (el.selectionStart ?? currentDraft.length) : currentDraft.length, currentDraft.length)
      const end = Math.min(el ? (el.selectionEnd ?? start) : start, currentDraft.length)
      const before = currentDraft.slice(0, start)
      const after = currentDraft.slice(end)
      const sepB = (before === '' || /[\s]$/.test(before)) ? '' : ' '
      const sepA = (after === '' || /^[\s]/.test(after)) ? '' : ' '
      const next = before + sepB + insert + sepA + after
      if (!isActive()) return
      inputActions.setDraft(next)
      // React 受控 textarea：等 value commit 落盘后把光标复位到插入内容之后
      if (el) {
        requestAnimationFrame(() => {
          if (!isActive() || !el.isConnected) return
          const pos = start + sepB.length + insert.length
          el.focus({ preventScroll: true })
          el.setSelectionRange(pos, pos)
        })
      }
    }

    // 上传模式始终分块复制文件内容，不读取原始路径。
    async function processFilesUpload(files, opts) {
      if (!files.length) return
      if (files.length > MAX_TOP_LEVEL_FILES) {
        statusStore.show('✗ 一次最多处理 ' + MAX_TOP_LEVEL_FILES + ' 个文件')
        return
      }
      const { sessionId, inputActions, getDraft, signal } = opts
      const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
      const statusToken = statusStore.begin('正在上传 ' + files.length + ' 个文件…')
      const ok = []
      const errs = []
      let quotaReached = false
      let locateModeBlocked = false
      for (const file of files) {
        if (!isActive()) { statusStore.cancel(statusToken); return }
        try {
          const result = await uploadChunked({ kind: 'file', name: file.name, size: file.size }, [file], {
            sessionId,
            signal,
            onProgress: (written, total) => {
              if (isActive()) statusStore.update(statusToken, '正在上传 ' + file.name + '（' + formatSize(written) + ' / ' + formatSize(total) + '）…')
            },
          })
          if (!isActive()) { statusStore.cancel(statusToken); return }
          ok.push(result.path)
        } catch (error) {
          if (!isActive()) { statusStore.cancel(statusToken); return }
          if (error && error.code === QUOTA_ERROR_CODE) { quotaReached = true; break }
          if (error && error.code === LOCATE_MODE_ERROR_CODE) { locateModeBlocked = true; break }
          errs.push(file.name + '：' + String((error && error.message) || error))
        }
      }
      if (!isActive()) { statusStore.cancel(statusToken); return }
      if (ok.length > 0) insertPaths(inputActions, getDraft(), ok, isActive)
      const text = [
        ok.length > 0 ? '✓ ' + ok.length + ' 个文件已上传' : '',
        quotaReached ? '✗ ' + QUOTA_ERROR_MESSAGE : '',
        locateModeBlocked ? '✗ ' + LOCATE_MODE_ERROR_MESSAGE : '',
        errs.length > 0 ? '✗ ' + summarizeItems(errs) : '',
      ].filter(Boolean).join('　')
      statusStore.finish(statusToken, text || '没有文件被处理')
    }

    // 目录只上传结构清单，文件内容逐块发送，空子目录会被保留。
    async function processDirectoryUpload(entry, opts) {
      const { sessionId, inputActions, getDraft, signal } = opts
      const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true
      const MAX_DIR_FILES = 500
      const statusToken = statusStore.begin('正在读取目录 ' + entry.name + ' …')
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
        if (!isActive()) { statusStore.cancel(statusToken); return }
        statusStore.finish(statusToken, '✗ 读取目录失败：' + String((error && error.message) || error))
        return
      }
      if (!isActive()) { statusStore.cancel(statusToken); return }
      const fileRecords = all.filter((record) => record.kind === 'file')
      if (fileRecords.length > MAX_DIR_FILES) {
        statusStore.finish(statusToken, '✗ 目录超过 ' + MAX_DIR_FILES + ' 个文件限制，未上传任何内容')
        return
      }
      if (all.length > MAX_DIRECTORY_ENTRIES) {
        statusStore.finish(statusToken, '✗ 目录超过 ' + MAX_DIRECTORY_ENTRIES + ' 个条目限制，未上传任何内容')
        return
      }
      const entries = all.map((record) => record.kind === 'directory'
        ? { kind: 'directory', path: record.path }
        : { kind: 'file', path: record.path || record.file.name, size: record.file.size })
      const files = fileRecords.map((record) => record.file)
      statusStore.update(statusToken, '正在上传目录 ' + entry.name + '（' + files.length + ' 个文件）…')
      try {
        const result = await uploadChunked({ kind: 'directory', name: entry.name, entries }, files, {
          sessionId,
          signal,
          onProgress: (written, total) => {
            if (isActive()) statusStore.update(statusToken, '正在上传目录 ' + entry.name + '（' + formatSize(written) + ' / ' + formatSize(total) + '）…')
          },
        })
        if (!isActive()) { statusStore.cancel(statusToken); return }
        insertPaths(inputActions, getDraft(), [result.path], isActive)
        const cleanupNote = result.cleanupError
          ? '；原目录清理失败：' + result.cleanupError
          : result.cleanupPending ? '；原目录正在后台清理' : ''
        statusStore.finish(statusToken, '✓ 目录已上传' + cleanupNote)
      } catch (error) {
        if (!isActive()) { statusStore.cancel(statusToken); return }
        statusStore.finish(statusToken, error && error.code === QUOTA_ERROR_CODE
          ? '✗ ' + QUOTA_ERROR_MESSAGE
          : error && error.code === LOCATE_MODE_ERROR_CODE
            ? '✗ ' + LOCATE_MODE_ERROR_MESSAGE
            : '✗ 目录上传失败：' + String((error && error.message) || error))
      }
    }

    // ---- locate 方案（搜索定位，零拷贝） ----

    const LOCATE_ROUTE = '/file-drop/locate'
    const LOCATE_PROTOCOL_VERSION = 2
    const LOCATE_SAMPLE_BYTES = 64 * 1024
    const LOCATE_FULL_MAX_BYTES = 8 * 1024 * 1024
    const LOCATE_MAX_DEPTH = 32
    const LOCATE_MAX_ENTRIES = 10000

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
        children.sort((a, b) => a.name.normalize('NFC').localeCompare(b.name.normalize('NFC')))
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
        current = (await readEntryChildren(current, signal)).find((entry) => entry.name.normalize('NFC') === part.normalize('NFC'))
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

    function normalizeSessionId(value) {
      return typeof value === 'string' && value.trim() !== '' ? value : undefined
    }

    function dropOwnerElement(record) {
      let element = record.ownerRef.current && record.ownerRef.current.parentElement
      while (element) {
        const style = getComputedStyle(element)
        if (style.visibility === 'hidden' || style.display === 'none') return undefined
        if (element.getClientRects().length > 0) return element
        element = element.parentElement
      }
      return undefined
    }

    function chooseDropOwner(eligible, containing = [], pointed = [], focused = []) {
      for (const candidates of [containing, pointed, focused]) {
        if (candidates.length === 1) return candidates[0]
      }
      return eligible.length === 1 ? eligible[0] : undefined
    }

    function selectDropOwner(event, sessions) {
      let currentSessionId
      try {
        const snapshot = sessions && sessions.list && sessions.list.getSnapshot()
        currentSessionId = normalizeSessionId(snapshot && snapshot.current)
      } catch { return undefined }
      const target = event.target instanceof Element ? event.target : undefined
      const eligible = [...dropOwners].filter((record) => {
        if (record.optsRef.current.sessionId !== currentSessionId) return false
        return dropOwnerElement(record) !== undefined
      })
      const containing = target ? eligible.filter((record) => {
        const element = dropOwnerElement(record)
        return element && element.contains(target)
      }) : []
      const pointed = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        ? eligible.filter((record) => {
          const rect = dropOwnerElement(record).getBoundingClientRect()
          return event.clientX >= rect.left && event.clientX <= rect.right
            && event.clientY >= rect.top && event.clientY <= rect.bottom
        })
        : []
      const active = document.activeElement instanceof Element ? document.activeElement : undefined
      const focused = active ? eligible.filter((record) => dropOwnerElement(record).contains(active)) : []
      return chooseDropOwner(eligible, containing, pointed, focused)
    }

    function currentSessionMatches(sessions, sessionId) {
      try {
        const snapshot = sessions && sessions.list && sessions.list.getSnapshot()
        return normalizeSessionId(snapshot && snapshot.current) === sessionId
      } catch { return false }
    }

    function currentSessionWorkspacePath(sessions) {
      try {
        const snapshot = sessions && sessions.list && sessions.list.getSnapshot()
        const id = snapshot && snapshot.current
        return id === undefined ? undefined : (snapshot.byId[id] && snapshot.byId[id].cwd)
      } catch { return undefined }
    }

    function workspaceContext(workspaces, currentWorkspacePath, sessionId) {
      sessionId = normalizeSessionId(sessionId)
      const items = (workspaces && workspaces.list && workspaces.list.getSnapshot && workspaces.list.getSnapshot().items) || []
      return {
        workspacePaths: items.map((item) => item.path),
        ...(currentWorkspacePath === undefined ? {} : { currentWorkspacePath }),
        ...(sessionId === undefined ? {} : { sessionId }),
      }
    }

    function retryWorkspaceContext(wctx, currentWorkspacePath) {
      return {
        workspacePaths: wctx.workspacePaths,
        excludedWorkspacePaths: currentWorkspacePath === undefined ? [] : [currentWorkspacePath],
        ...(wctx.sessionId === undefined ? {} : { sessionId: wctx.sessionId }),
      }
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
      if (found.length > 0) insertPaths(inputActions, getDraft(), found, isActive)
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
          insertPaths(inputActions, getDraft(), [result.path], isActive)
          statusStore.finish(statusToken, '✓ 已定位目录原始路径：' + entry.name)
        } else if (result.status === 'choose') {
          const picked = choosePathInteractive(entry.name, result.candidates)
          if (picked) {
            insertPaths(inputActions, getDraft(), [picked], isActive)
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

    function chooseDropAction(mode, options = {}) {
      const shellPaths = options.shellPaths || []
      const extractedPaths = options.extractedPaths || []
      if (mode === 'locate') {
        const paths = shellPaths.length > 0 ? shellPaths : extractedPaths
        if (paths.length > 0) return { type: 'insert-paths', paths }
        if (options.directoryCount > 0) return { type: 'locate-directories' }
        if (options.fileCount > 0) return { type: 'locate-files' }
      } else {
        if (options.directoryCount > 0) return { type: 'upload-directories' }
        if (options.fileCount > 0) return { type: 'upload-files' }
      }
      return { type: 'none' }
    }

    // ---- 组件 ----

    // 输入框工具行：回形针按钮（点开文件选择器）
    function PaperclipButton(props) {
      const pickRef = React.useRef(null)
      const operationRef = React.useRef(0)
      const operationHandleRef = React.useRef(null)
      const optsRef = React.useRef({})
      optsRef.current = {
        sessionId: normalizeSessionId(props.sessionId),
        inputActions: props.inputActions,
        draft: (props.input && props.input.draft) || '',
        workspaces: props.workspaces,
        currentWorkspacePath: currentSessionWorkspacePath(props.sessions),
      }
      const cancelCurrent = () => {
        operationRef.current += 1
        const handle = operationHandleRef.current
        operationHandleRef.current = null
        if (handle) { handle.controller.abort(); handle.release() }
      }
      React.useEffect(() => { cancelCurrent() }, [props.sessionId, props.inputActions])
      React.useEffect(() => {
        const store = props.sessions && props.sessions.list
        if (!store || typeof store.subscribe !== 'function') return undefined
        return store.subscribe(() => {
          if (!currentSessionMatches(props.sessions, optsRef.current.sessionId)) cancelCurrent()
        })
      }, [props.sessions])
      React.useEffect(() => () => { cancelCurrent() }, [])
      const onClick = () => { if (pickRef.current) pickRef.current.click() }
      const onChange = (e) => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        if (files.length === 0) return
        cancelCurrent()
        const started = { ...optsRef.current }
        const modeStatus = statusStore.begin('正在确认拖拽模式…')
        void (async () => {
          let mode
          try { mode = await refreshModeForAction() } catch {
            statusStore.finish(modeStatus, '✗ ' + MODE_READ_ERROR_MESSAGE)
            return
          }
          statusStore.cancel(modeStatus)
          if (optsRef.current.sessionId !== started.sessionId
            || optsRef.current.inputActions !== started.inputActions
            || !currentSessionMatches(props.sessions, started.sessionId)) return
          const handle = operationController()
          operationHandleRef.current = handle
          const operationId = ++operationRef.current
          const snapshot = {
            ...started,
            mode,
            modeRevision,
            signal: handle.controller.signal,
            getDraft: () => optsRef.current.draft,
          }
          snapshot.isActive = () => operationRef.current === operationId
            && !snapshot.signal.aborted
            && optsRef.current.sessionId === snapshot.sessionId
            && optsRef.current.inputActions === snapshot.inputActions
            && currentSessionMatches(props.sessions, snapshot.sessionId)
            && currentMode === snapshot.mode
            && modeRevision === snapshot.modeRevision
          try {
            if (snapshot.mode === 'locate') {
              if (files.length > MAX_TOP_LEVEL_FILES) {
                statusStore.show('✗ 一次最多处理 ' + MAX_TOP_LEVEL_FILES + ' 个文件')
                return
              }
              const directPaths = []
              const unresolved = []
              for (const file of files) {
                const path = shellPathOf(file)
                if (path) directPaths.push(path)
                else unresolved.push(file)
              }
              if (!snapshot.isActive()) return
              if (directPaths.length > 0) insertPaths(snapshot.inputActions, snapshot.getDraft(), directPaths, snapshot.isActive)
              if (unresolved.length > 0) await processFilesLocate(unresolved, snapshot)
              else statusStore.show('✓ 已获取 ' + directPaths.length + ' 个文件的原始路径')
            } else await processFilesUpload(files, snapshot)
          } finally {
            handle.release()
            if (operationHandleRef.current === handle) operationHandleRef.current = null
          }
        })()
      }
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsh-paperclip-wrap' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-paperclip',
            'aria-label': '选择文件',
            onClick: onClick,
          },
            React.createElement('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true },
              React.createElement('path', {
                d: 'M5.5498 9.75V5H6.9502V9.75C6.9502 10.3299 7.4201 10.7998 8 10.7998C8.5799 10.7998 9.0498 10.3299 9.0498 9.75V4.5C9.0498 2.9536 7.7964 1.7002 6.25 1.7002C4.7036 1.7002 3.4502 2.9536 3.4502 4.5V9.75C3.4502 12.2629 5.4871 14.2998 8 14.2998C10.5129 14.2998 12.5498 12.2629 12.5498 9.75V4H13.9502V9.75C13.9502 13.0361 11.2861 15.7002 8 15.7002C4.71391 15.7002 2.0498 13.0361 2.0498 9.75V4.5C2.04981 2.1804 3.9304 0.299806 6.25 0.299805C8.5696 0.299805 10.4502 2.1804 10.4502 4.5V9.75C10.4502 11.1031 9.3531 12.2002 8 12.2002C6.6469 12.2002 5.5498 11.1031 5.5498 9.75Z',
                fill: 'currentColor',
              })
            )
          ),
          React.createElement('div', { className: 'dsh-paperclip-tip' },
            '点击选择文件 · 也可把文件拖到窗口任意位置'
          )
        ),
        React.createElement('input', {
          ref: pickRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: onChange,
        })
      )
    }

    // 输入框上方 dock：拖拽监听 + 浮层 + 状态条
    function DropZone(props) {
      const [drag, setDrag] = React.useState(false)
      const ownerRef = React.useRef(null)
      const statusText = useStatus()
      const [statusBottom, setStatusBottom] = React.useState(110)
      const [statusLeft, setStatusLeft] = React.useState('50%')
      const depthRef = React.useRef(0)
      const busyRef = React.useRef(false)
      const operationRef = React.useRef(0)
      const operationHandleRef = React.useRef(null)
      const optsRef = React.useRef({})
      optsRef.current = {
        sessionId: normalizeSessionId(props.sessionId),
        inputActions: props.inputActions,
        draft: (props.input && props.input.draft) || '',
        workspaces: props.workspaces,
        currentWorkspacePath: currentSessionWorkspacePath(props.sessions),
      }
      const ownerRecordRef = React.useRef()
      if (!ownerRecordRef.current) {
        ownerRecordRef.current = { ownerRef, optsRef }
      }
      React.useEffect(() => {
        const record = ownerRecordRef.current
        dropOwners.add(record)
        return () => { dropOwners.delete(record) }
      }, [])

      const cancelCurrent = () => {
        operationRef.current += 1
        busyRef.current = false
        const handle = operationHandleRef.current
        operationHandleRef.current = null
        if (handle) { handle.controller.abort(); handle.release() }
      }

      React.useEffect(() => {
        cancelCurrent()
        statusStore.clear()
      }, [props.sessionId])

      React.useEffect(() => {
        const store = props.sessions && props.sessions.list
        if (!store || typeof store.subscribe !== 'function') return undefined
        return store.subscribe(() => {
          if (!currentSessionMatches(props.sessions, optsRef.current.sessionId)) cancelCurrent()
        })
      }, [props.sessions])

      React.useEffect(() => () => { cancelCurrent() }, [])

      // 让状态提示跟随 composer 输入框：动态定位到输入框上方
      React.useLayoutEffect(() => {
        const position = () => {
          const card = document.querySelector('[data-composer-card]')
          if (card instanceof HTMLElement) {
            const rect = card.getBoundingClientRect()
            setStatusBottom(Math.max(8, window.innerHeight - rect.top + 8))
            setStatusLeft(rect.left + rect.width / 2)
          }
        }
        let observer
        const card = document.querySelector('[data-composer-card]')
        if (card instanceof HTMLElement && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(position)
          observer.observe(card)
        }
        position()
        window.addEventListener('resize', position)
        window.addEventListener('scroll', position, true)
        return () => {
          if (observer) observer.disconnect()
          window.removeEventListener('resize', position)
          window.removeEventListener('scroll', position, true)
        }
      }, [])

      React.useEffect(() => {
        // 全部挂在 window 捕获阶段：事件流的第一个节点，先于 DSH 自带的
        // document 级原生附件处理（InputBar intakeImages / DropOverlay）。
        const hasFiles = (e) => shouldHandleDataTransfer(e.dataTransfer, currentMode)
        const claim = (e) => {
          if (selectDropOwner(e, props.sessions) !== ownerRecordRef.current) return false
          if (claimedDropEvents.has(e)) return false
          claimedDropEvents.add(e)
          return true
        }
        const onDragEnter = (e) => {
          if (!hasFiles(e) || !claim(e)) return
          e.preventDefault()
          e.stopPropagation()
          depthRef.current += 1
          setDrag(true)
        }
        const onDragOver = (e) => {
          if (!hasFiles(e) || !claim(e)) return
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer) e.dataTransfer.dropEffect = currentMode === 'locate' ? 'link' : 'copy'
        }
        const onDragLeave = (e) => {
          if (!hasFiles(e)) {
            if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files') && depthRef.current > 0) {
              depthRef.current -= 1
              if (depthRef.current <= 0) { depthRef.current = 0; setDrag(false) }
            }
            return
          }
          if (!claim(e)) return
          e.stopPropagation()
          depthRef.current -= 1
          if (depthRef.current <= 0) { depthRef.current = 0; setDrag(false) }
        }
        const onDrop = (e) => {
          const carriesFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
          const fileDrop = hasFiles(e)
          const pathOnly = fileDrop || carriesFiles ? undefined : extractPaths(e)
          if (!fileDrop && (!pathOnly || pathOnly.length === 0)) {
            if (carriesFiles) { depthRef.current = 0; setDrag(false) }
            return
          }
          if (!claim(e)) return
          e.preventDefault()
          e.stopPropagation()
          depthRef.current = 0
          setDrag(false)
          void handleDrop(e, pathOnly)
        }
        window.addEventListener('dragenter', onDragEnter, true)
        window.addEventListener('dragover', onDragOver, true)
        window.addEventListener('dragleave', onDragLeave, true)
        window.addEventListener('drop', onDrop, true)
        return () => {
          window.removeEventListener('dragenter', onDragEnter, true)
          window.removeEventListener('dragover', onDragOver, true)
          window.removeEventListener('dragleave', onDragLeave, true)
          window.removeEventListener('drop', onDrop, true)
        }
      }, [])

      function beginOperation() {
        const started = optsRef.current
        const id = ++operationRef.current
        const mode = currentMode
        const revision = modeRevision
        const handle = operationController()
        operationHandleRef.current = handle
        return {
          ...started,
          id,
          mode,
          modeRevision: revision,
          signal: handle.controller.signal,
          release: () => {
            handle.release()
            if (operationHandleRef.current === handle) operationHandleRef.current = null
          },
          getDraft: () => optsRef.current.draft || '',
          isActive: () => operationRef.current === id
            && !handle.controller.signal.aborted
            && optsRef.current.sessionId === started.sessionId
            && optsRef.current.inputActions === started.inputActions
            && currentSessionMatches(props.sessions, started.sessionId)
            && currentMode === mode
            && modeRevision === revision,
        }
      }

      async function runDropOperation(run) {
        const operation = beginOperation()
        busyRef.current = true
        try {
          await run(operation)
        } finally {
          operation.release()
          if (operationRef.current === operation.id) busyRef.current = false
        }
      }

      async function handleDrop(e, extractedPaths) {
        if (busyRef.current) return
        const dataTransfer = e.dataTransfer
        const files = Array.from((dataTransfer && dataTransfer.files) || [])
        const directories = getDirectoryEntries(dataTransfer && dataTransfer.items)
        const shellPaths = drainShellPaths()
        const suppliedPaths = extractedPaths || extractPaths(e)
        const started = { ...optsRef.current }
        const modeStatus = statusStore.begin('正在确认拖拽模式…')
        busyRef.current = true
        let mode
        try { mode = await refreshModeForAction() } catch {
          busyRef.current = false
          statusStore.finish(modeStatus, '✗ ' + MODE_READ_ERROR_MESSAGE)
          return
        }
        statusStore.cancel(modeStatus)
        if (optsRef.current.sessionId !== started.sessionId
          || optsRef.current.inputActions !== started.inputActions
          || !currentSessionMatches(props.sessions, started.sessionId)) {
          busyRef.current = false
          return
        }
        busyRef.current = false
        const action = chooseDropAction(mode, {
          shellPaths,
          extractedPaths: suppliedPaths,
          directoryCount: directories.length,
          fileCount: files.length,
        })

        if (action.type === 'insert-paths') {
          if (action.paths.length > MAX_TOP_LEVEL_FILES) {
            statusStore.show('✗ 一次最多处理 ' + MAX_TOP_LEVEL_FILES + ' 个路径')
            return
          }
          insertPaths(optsRef.current.inputActions, optsRef.current.draft, action.paths)
          statusStore.show('✓ 已定位 ' + action.paths.length + ' 个原始路径')
          return
        }

        if (action.type.endsWith('-directories')) {
          if (directories.length > MAX_ROOT_DIRECTORIES) {
            statusStore.show('✗ 一次最多处理 ' + MAX_ROOT_DIRECTORIES + ' 个目录')
            return
          }
          const locate = action.type === 'locate-directories'
          await runDropOperation(async (operation) => {
            for (const directory of directories) {
              if (!operation.isActive()) break
              await (locate
                ? processDirectoryLocate(directory, operation)
                : processDirectoryUpload(directory, operation))
            }
          })
          return
        }

        if (action.type.endsWith('-files')) {
          await runDropOperation((operation) => action.type === 'locate-files'
            ? processFilesLocate(files, operation)
            : processFilesUpload(files, operation))
          return
        }

        const pathOnly = shellPaths.length > 0 || suppliedPaths.length > 0
        statusStore.show(mode === 'upload' && pathOnly
          ? '✗ 上传模式需要可读取的文件或目录内容'
          : '✗ 未获取到可处理的文件或目录')
      }

      return React.createElement(React.Fragment, null,
        React.createElement('span', { ref: ownerRef, className: 'dsh-drop-owner', 'aria-hidden': true }),
        statusText ? React.createElement('div', { className: 'dsh-drop-status', style: { bottom: statusBottom, left: statusLeft } },
          statusText.includes('正在') ? React.createElement('span', { className: 'dsh-drop-status-spinner' }) : null,
          React.createElement('span', { className: 'dsh-drop-status-text' }, statusText)
        ) : null,
        drag ? React.createElement('div', { className: 'dsh-drop-overlay' },
          React.createElement('div', { className: 'dsh-drop-overlay-inner' },
            currentMode === 'locate' ? '松开鼠标，定位文件或目录' : '松开鼠标，上传文件或目录')
        ) : null
      )
    }

    // 设置页 section：选择拖拽处理方案
    // 字节数 → 友好格式（B/KB/MB/GB）
    function formatSize(bytes) {
      if (bytes == null || bytes < 0) return '未知'
      if (bytes === 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let i = 0
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
      return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + ' ' + units[i]
    }

    function SettingsSection(props) {
      const [mode, setMode] = React.useState(currentMode)
      const [modeMsg, setModeMsg] = React.useState('')
      const [quotaMiB, setQuotaMiB] = React.useState(String(currentSettings.uploadQuotaMiB))
      const [quotaEntries, setQuotaEntries] = React.useState(String(currentSettings.uploadQuotaEntries))
      const [savedQuota, setSavedQuota] = React.useState({
        mib: currentSettings.uploadQuotaMiB,
        entries: currentSettings.uploadQuotaEntries,
      })
      const [savingQuota, setSavingQuota] = React.useState(false)
      const [quotaMsg, setQuotaMsg] = React.useState('')
      const [clearing, setClearing] = React.useState(false)
      const [clearMsg, setClearMsg] = React.useState('')
      const [usage, setUsage] = React.useState(null)
      React.useEffect(() => {
        let active = true
        const revision = modeRevision
        refreshSettings().then((settings) => {
          if (!active || revision !== modeRevision) return
          adoptSettings(settings)
          setMode(settings.mode)
          setQuotaMiB(String(settings.uploadQuotaMiB))
          setQuotaEntries(String(settings.uploadQuotaEntries))
          setSavedQuota({ mib: settings.uploadQuotaMiB, entries: settings.uploadQuotaEntries })
        })
        return () => { active = false }
      }, [])
      const pick = (nextMode) => {
        beginModeChange(nextMode)
        setMode(nextMode)
        setModeMsg('')
        void writeSettings({ mode: nextMode }).then((settings) => {
          setMode(settings.mode)
        }).catch((error) => {
          setMode(currentMode)
          setModeMsg('✗ ' + String((error && error.message) || error))
        })
      }
      const mountedRef = React.useRef(true)
      const sizeRequestRef = React.useRef(0)
      const cleanupRef = React.useRef({ generation: 0, controller: undefined })
      const cancelCleanup = () => {
        cleanupRef.current.generation += 1
        if (cleanupRef.current.controller) cleanupRef.current.controller.abort()
        cleanupRef.current.controller = undefined
      }
      React.useEffect(() => () => { mountedRef.current = false; cancelCleanup() }, [])
      // 拉取用户目录 ~/.dsh/.dsh-drops 的实际磁盘占用。
      const loadSize = async (generation, signal) => {
        const requestId = ++sizeRequestRef.current
        const canCommit = () => mountedRef.current
          && requestId === sizeRequestRef.current
          && (generation === undefined || cleanupRef.current.generation === generation)
        try {
          const { response, data } = await readUserUploadUsage(signal)
          if (canCommit()) {
            setUsage(response.ok && typeof data.size === 'number' && typeof data.entries === 'number'
              ? { size: data.size, entries: data.entries } : null)
          }
          return response.ok ? data : undefined
        } catch {
          if (canCommit() && (!signal || !signal.aborted)) setUsage(null)
          return undefined
        }
      }
      const waitForCleanup = async (generation, signal) => {
        const canCommit = () => mountedRef.current && cleanupRef.current.generation === generation
        for (let attempt = 0; attempt < 20 && canCommit(); attempt += 1) {
          await abortableDelay(500, signal)
          if (!canCommit()) return
          const state = await loadSize(generation, signal)
          if (!canCommit()) return
          if (!state) continue
          if (state.cleanupError) {
            setClearMsg('⚠ 已从用户上传目录移除，但磁盘清理失败：' + state.cleanupError)
            return
          }
          if (!state.cleanupPending && state.size === 0 && state.entries === 0) {
            setClearMsg('✓ 已清空用户上传目录，容量与条目累计已重置为 0')
            return
          }
        }
        if (canCommit()) setClearMsg('磁盘清理仍在进行，容量与条目累计尚未归零')
      }
      React.useEffect(() => { void loadSize() }, [])
      // 清空用户目录 ~/.dsh/.dsh-drops，与当前会话工作区无关。
      const clearDrops = async () => {
        if (cleanupRef.current.controller) return
        cancelCleanup()
        const generation = cleanupRef.current.generation
        const controller = new AbortController()
        cleanupRef.current.controller = controller
        const canCommit = () => mountedRef.current
          && cleanupRef.current.generation === generation
          && cleanupRef.current.controller === controller
        setClearing(true)
        setClearMsg('')
        try {
          const { response, data } = await clearUserUploadRoot(controller.signal)
          if (!canCommit()) return
          if (response.ok) {
            setClearMsg(data.cleanupError
              ? '⚠ 已从用户上传目录移除，但磁盘清理失败：' + data.cleanupError
              : data.cleanupPending
                ? '已从用户上传目录移除，正在重置容量与条目累计'
                : '✓ 用户上传目录容量与条目累计已重置为 0')
            if (data.cleanupPending) await waitForCleanup(generation, controller.signal)
            else await loadSize(generation, controller.signal)
          } else {
            setClearMsg('✗ 清空失败：' + (data.error || 'HTTP ' + response.status))
          }
        } catch (err) {
          if (canCommit() && (!err || err.name !== 'AbortError')) {
            setClearMsg('✗ 清空失败：' + String((err && err.message) || err))
          }
        } finally {
          if (canCommit()) {
            cleanupRef.current.controller = undefined
            setClearing(false)
          }
        }
      }
      const parsedQuotaMiB = Number(quotaMiB)
      const parsedQuotaEntries = Number(quotaEntries)
      const quotaValid = Number.isSafeInteger(parsedQuotaMiB) && parsedQuotaMiB >= 1
        && parsedQuotaMiB <= MAX_UPLOAD_QUOTA_MIB
        && Number.isSafeInteger(parsedQuotaEntries) && parsedQuotaEntries >= 1
        && parsedQuotaEntries <= MAX_UPLOAD_QUOTA_ENTRIES
      const quotaReached = usage
        && (usage.size >= savedQuota.mib * MIB_BYTES || usage.entries >= savedQuota.entries)
      const saveQuota = async () => {
        if (!quotaValid || savingQuota) {
          setQuotaMsg('✗ 容量须为 1–1048576 MiB，条目须为 1–100000 的整数')
          return
        }
        setSavingQuota(true)
        setQuotaMsg('')
        try {
          const saved = await writeSettings({
            uploadQuotaMiB: parsedQuotaMiB,
            uploadQuotaEntries: parsedQuotaEntries,
          })
          if (!mountedRef.current) return
          setQuotaMiB(String(saved.uploadQuotaMiB))
          setQuotaEntries(String(saved.uploadQuotaEntries))
          setSavedQuota({ mib: saved.uploadQuotaMiB, entries: saved.uploadQuotaEntries })
          setQuotaMsg('✓ 配额已保存')
        } catch (error) {
          if (mountedRef.current) setQuotaMsg('✗ ' + String((error && error.message) || error))
        } finally {
          if (mountedRef.current) setSavingQuota(false)
        }
      }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '拖拽文件处理方式'),
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('input', { type: 'radio', name: 'dsh-file-drop-mode', checked: mode === 'upload', onChange: () => pick('upload') }),
          React.createElement('span', null, '上传模式（复制文件和目录）')
        ),
        mode === 'upload' ? React.createElement('div', { className: 'dsh-upload-settings' },
          React.createElement('div', { className: 'dsh-quota-row' },
            React.createElement('label', { className: 'dsh-quota-field' },
              React.createElement('span', null, '容量上限'),
              React.createElement('span', { className: 'dsh-quota-input-wrap' },
                React.createElement('input', {
                  type: 'number', min: 1, max: MAX_UPLOAD_QUOTA_MIB, step: 1,
                  value: quotaMiB, 'aria-label': '上传容量上限（MiB）',
                  onChange: (event) => { setQuotaMiB(event.target.value); setQuotaMsg('') },
                }),
                React.createElement('span', null, 'MiB')
              )
            ),
            React.createElement('label', { className: 'dsh-quota-field' },
              React.createElement('span', null, '条目上限'),
              React.createElement('span', { className: 'dsh-quota-input-wrap' },
                React.createElement('input', {
                  type: 'number', min: 1, max: MAX_UPLOAD_QUOTA_ENTRIES, step: 1,
                  value: quotaEntries, 'aria-label': '上传条目上限',
                  onChange: (event) => { setQuotaEntries(event.target.value); setQuotaMsg('') },
                }),
                React.createElement('span', null, '条目')
              )
            ),
            React.createElement('button', {
              type: 'button', className: 'dsh-clear-btn', disabled: savingQuota,
              onClick: () => void saveQuota(),
            }, savingQuota ? '保存中...' : '保存配额')
          ),
          quotaMsg ? React.createElement('div', { className: 'dsh-quota-msg' }, quotaMsg) : null,
          React.createElement('div', { className: 'dsh-usage-row' },
            React.createElement('span', { className: 'dsh-clear-size' }, usage
              ? '用户目录累计：' + formatSize(usage.size) + ' / ' + formatSize(savedQuota.mib * MIB_BYTES)
                + '；' + usage.entries + ' / ' + savedQuota.entries + ' 条目'
              : '用户目录累计：未知'),
            React.createElement('button', {
              type: 'button', className: 'dsh-clear-btn', disabled: clearing,
              onClick: () => void clearDrops(),
            }, clearing
              ? React.createElement(React.Fragment, null,
                  React.createElement('span', { className: 'dsh-clear-spinner', 'aria-hidden': true }),
                  '重置中...'
                )
              : '清空并重置累计'),
            clearMsg ? React.createElement('span', { className: 'dsh-clear-msg' }, clearMsg) : null
          ),
          quotaReached ? React.createElement('div', { className: 'dsh-quota-warning' }, QUOTA_ERROR_MESSAGE) : null
        ) : null,
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('input', { type: 'radio', name: 'dsh-file-drop-mode', checked: mode === 'locate', onChange: () => pick('locate') }),
          React.createElement('span', null, '定位模式（只定位，不复制）')
        ),
        modeMsg ? React.createElement('div', { className: 'dsh-mode-msg' }, modeMsg) : null
      )
    }

    const CSS = `
      .dsh-drop-owner { display: none; }
      .dsh-upload-settings { display: flex; flex-direction: column; gap: 8px; padding-left: 24px; min-width: 0; }
      .dsh-quota-row { display: grid; grid-template-columns: minmax(150px, 220px) minmax(150px, 220px) auto; align-items: end; gap: 8px; }
      .dsh-quota-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.68)); }
      .dsh-quota-input-wrap { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; height: 30px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(255,255,255,0.15)); border-radius: 6px; background: var(--dsw-alias-bg-input, rgba(128,128,128,0.08)); }
      .dsh-quota-input-wrap:focus-within { border-color: var(--dsw-alias-interactive-primary, #4f8cff); }
      .dsh-quota-input-wrap input { width: 100%; min-width: 0; height: 100%; padding: 0 8px; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, inherit); font: inherit; }
      .dsh-quota-input-wrap span { padding: 0 8px; white-space: nowrap; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.58)); }
      .dsh-usage-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
      .dsh-mode-msg, .dsh-quota-msg, .dsh-clear-msg, .dsh-quota-warning { overflow-wrap: anywhere; }
      .dsh-mode-msg { padding-left: 24px; font-size: 12px; color: var(--dsw-alias-label-error, #d92d20); }
      .dsh-quota-msg, .dsh-clear-msg { font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.6)); }
      .dsh-quota-warning { font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-error, #d92d20); }
      @media (max-width: 640px) { .dsh-quota-row { grid-template-columns: minmax(0, 1fr); align-items: stretch; } }
      .dsh-clear-btn {
        display: inline-flex; align-items: center; gap: 6px;
        height: 28px; padding: 0 12px;
        border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(255,255,255,0.15));
        border-radius: 8px;
        background: var(--dsw-specific-selector, rgba(128,128,128,0.14));
        color: var(--dsw-alias-label-primary, inherit);
        font-size: 12px; line-height: 1.4;
        cursor: pointer; user-select: none;
      }
      .dsh-clear-btn:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,0.24));
      }
      .dsh-clear-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .dsh-clear-spinner {
        flex: none; width: 12px; height: 12px;
        border: 2px solid rgba(128,128,128,0.35);
        border-top-color: currentColor;
        border-radius: 50%;
        animation: dshClearSpin 0.8s linear infinite;
      }
      @keyframes dshClearSpin { to { transform: rotate(360deg); } }
      .dsh-clear-size {
        font-size: 12px; line-height: 1.4;
        color: var(--dsw-alias-label-secondary, rgba(255,255,255,0.6));
        min-width: 64px;
      }
      .dsh-paperclip-wrap {
        position: relative;
        display: inline-flex;
      }
      .dsh-paperclip-wrap .dsh-paperclip-tip {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        z-index: 50;
        white-space: nowrap;
        font-size: 12px;
        line-height: 1.4;
        color: #dce1e8;
        background: rgba(20, 22, 28, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 6px 10px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        opacity: 0;
        pointer-events: none;
      }
      /* 每次 hover 都重新播放：淡入 → 停留 → 自动淡出 */
      .dsh-paperclip-wrap:hover .dsh-paperclip-tip {
        animation: dshTipCycle 1.5s ease forwards;
      }
      @keyframes dshTipCycle {
        0% { opacity: 0; }
        10% { opacity: 1; }
        85% { opacity: 1; }
        100% { opacity: 0; }
      }
      .dsh-paperclip {
        display: grid; place-items: center; flex: none;
        width: 28px; height: 28px;
        border: none; border-radius: 999px;
        background: var(--dsw-specific-selector, rgba(128, 128, 128, 0.14));
        color: var(--dsw-alias-label-primary, inherit);
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .dsh-paperclip:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(128, 128, 128, 0.24));
      }
      .dsh-drop-status {
        position: fixed; bottom: 110px; transform: translateX(-50%);
        z-index: 9998; pointer-events: none;
        display: inline-flex; align-items: center; gap: 8px;
        max-width: 70vw;
        font-size: 12px; line-height: 1.5; color: #dce1e8;
        background: rgba(20, 22, 28, 0.85); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 999px; padding: 6px 14px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        animation: dshDropStatusIn 0.18s ease-out;
      }
      .dsh-drop-status-text {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dsh-drop-status-spinner {
        flex: none;
        width: 12px; height: 12px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: dshDropStatusSpin 0.8s linear infinite;
      }
      @keyframes dshDropStatusSpin {
        to { transform: rotate(360deg); }
      }
      @keyframes dshDropStatusIn {
        from { opacity: 0; transform: translateX(-50%) translateY(6px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      .dsh-drop-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(24, 118, 255, 0.08);
        border: 2px dashed rgba(24, 118, 255, 0.7);
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
      }
      .dsh-drop-overlay-inner {
        background: #1876ff; color: #fff; border-radius: 10px;
        padding: 14px 28px; font-size: 15px; font-weight: 600;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
      }
    `

    const inject = ['slots', 'workspaces', 'sessions']

    async function apply(ctx) {
      // 注册任何文件入口前先确认模式；失败时按定位模式接管并禁止上传。
      try {
        const settings = await readSettings(undefined, false)
        currentSettings = settings
        currentMode = settings.mode
        settingsLoaded = true
      } catch {
        currentMode = 'locate'
        settingsLoaded = false
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-file-drop'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-file-drop: styles')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'file-drop-pick',
          order: 0,
          inject: () => ({ workspaces: ctx.workspaces, sessions: ctx.sessions }),
        },
        (props) => React.createElement(PaperclipButton, props)
      ))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'file-drop',
          order: 30,
          inject: () => ({ workspaces: ctx.workspaces, sessions: ctx.sessions }),
        },
        (props) => React.createElement(DropZone, props)
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-file-drop',
          order: 110,
          label: () => '拖拽文件',
          inject: () => ({ sessions: ctx.sessions }),
        },
        (props) => React.createElement(SettingsSection, props)
      ))
    }

    exports.__test = {
      uploadChunked,
      uploadFileChunks,
      processFilesUpload,
      processDirectoryUpload,
      readEntryAll,
      statusStore,
      chooseDropOwner,
      chooseDropAction,
      refreshSettings,
      refreshModeForAction,
      beginModeChange,
      readUserUploadUsage,
      clearUserUploadRoot,
      writeSettings,
      fileUriToPath,
      retryWorkspaceContext,
      shouldHandleDataTransfer,
    }
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
