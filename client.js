// dsh-file-drop · Client half（DSH web __ModuleLoader__ 格式）
// 两个入口共用同一套处理逻辑（壳直取原始路径 → uri-list → 上传兜底）：
// 1. 回形针按钮（conversation.input.left）：点击弹文件选择器
// 2. 拖拽（window 捕获阶段拦截，先于 DSH 自带图片拖拽处理）：
//    - 桌面壳 preload 已解析路径 → 直接取
//    - DataTransfer 自带路径（uri-list）→ 直接取
//    - 普通文件 → POST /api/dsh-file-drop 上传到工作区
window.__ModuleLoader__.load({
  id: 'dsh-file-drop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const TEXT_EXT = new Set([
      'md', 'markdown', 'txt', 'text', 'json', 'csv', 'tsv', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
      'py', 'pyw', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'xml', 'html', 'htm', 'css',
      'scss', 'sass', 'less', 'sh', 'bash', 'zsh', 'fish', 'sql', 'go', 'rs', 'java', 'kt', 'kts',
      'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'rb', 'php', 'lua', 'r', 'swift', 'vue', 'svelte', 'env',
      'properties', 'gitignore', 'dockerfile', 'makefile', 'gradle', 'lock',
    ])
    const TEXT_MIME = new Set([
      'application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
      'application/sql', 'application/x-sh', 'application/x-httpd-php', 'application/ecmascript',
    ])
    const MAX_BYTES = 25 * 1024 * 1024
    const API_PATH = '/api/dsh-file-drop'
    const SETTINGS_PATH = API_PATH + '/settings'
    let currentMode = 'upload'

    async function readMode() {
      try {
        const res = await fetch(SETTINGS_PATH)
        const data = await res.json().catch(() => ({}))
        return data.mode === 'locate' ? 'locate' : 'upload'
      } catch { return 'upload' }
    }

    async function writeMode(mode) {
      try {
        await fetch(SETTINGS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
      } catch { /* ignore */ }
    }

    // ---- 文件识别与读取 ----

    function looksText(file) {
      if (file.type && file.type.startsWith('text/')) return true
      if (file.type && TEXT_MIME.has(file.type)) return true
      const dot = file.name.lastIndexOf('.')
      if (dot < 0) return false
      return TEXT_EXT.has(file.name.slice(dot + 1).toLowerCase())
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
        reader.onload = () => {
          try {
            const bytes = new Uint8Array(reader.result)
            let bin = ''
            const CHUNK = 0x8000
            for (let i = 0; i < bytes.length; i += CHUNK) {
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
            }
            resolve(btoa(bin))
          } catch (e) { reject(e) }
        }
        reader.readAsArrayBuffer(file)
      })
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

    // 拖拽自带路径（Obsidian / 文件管理器拖拽常带 uri-list）
    function extractPaths(e) {
      const paths = []
      try {
        const uris = (e.dataTransfer.getData('text/uri-list') || '').split('\n')
        for (const line of uris) {
          const t = line.trim()
          if (!t || t.startsWith('#')) continue
          if (t.startsWith('file://')) {
            try {
              paths.push(decodeURIComponent(t.slice('file://'.length).replace(/^localhost/, '')))
            } catch { paths.push(t.slice(7)) }
          } else if (t.startsWith('/')) {
            paths.push(t)
          }
        }
      } catch { /* 某些浏览器/事件阶段读不了，忽略 */ }
      if (paths.length === 0) {
        try {
          const plain = (e.dataTransfer.getData('text/plain') || '').trim()
          if (plain && (plain.startsWith('/') || /^[A-Za-z]:[\\/]/.test(plain)) && !plain.includes('\n')) {
            paths.push(plain)
          }
        } catch { /* 忽略 */ }
      }
      return paths
    }

    // ---- 目录遍历（webkitGetAsEntry，upload 与 locate 共用） ----

    function readEntryAll(entry) {
      return new Promise((resolve, reject) => {
        if (entry.isFile) {
          entry.file((file) => resolve([{ path: '', file }]), reject)
          return
        }
        if (!entry.isDirectory) { resolve([]); return }
        const reader = entry.createReader()
        const out = []
        const readBatch = () => {
          reader.readEntries(async (children) => {
            if (!children || children.length === 0) { resolve(out); return }
            try {
              const results = await Promise.all(children.map((child) => readEntryAll(child)))
              children.forEach((child, i) => {
                for (const s of results[i]) out.push({ path: child.name + (s.path ? '/' + s.path : ''), file: s.file })
              })
              readBatch()
            } catch (err) { reject(err) }
          }, reject)
        }
        readBatch()
      })
    }

    function getDirectoryEntries(items) {
      const dirs = []
      if (!items) return dirs
      for (const item of items) {
        try {
          const entry = item.webkitGetAsEntry && item.webkitGetAsEntry()
          if (entry && entry.isDirectory) dirs.push(entry)
        } catch { /* 忽略 */ }
      }
      return dirs
    }

    // ---- 共享状态（按钮上传与拖拽共用一个状态条） ----

    const statusStore = {
      value: null,
      listeners: new Set(),
      timer: null,
      set(text) {
        if (currentMode === 'upload') return
        this.value = text
        for (const l of [...this.listeners]) l()
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.value = null
          for (const l of [...this.listeners]) l()
        }, 3500)
      },
      clear() {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.value = null
        for (const l of [...this.listeners]) l()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    function useStatus() {
      const [value, setValue] = React.useState(statusStore.value)
      React.useEffect(() => statusStore.subscribe(() => setValue(statusStore.value)), [])
      return value
    }

    function appendToDraft(inputActions, draft, paths) {
      if (!inputActions) return
      const lines = paths.map((p) => '`' + p + '`')
      const sep = draft === '' ? '' : ' '
      inputActions.setDraft(draft + sep + lines.join(' '))
    }

    // 共用处理：壳路径优先，其余走上传兜底
    async function processFiles(files, opts) {
      if (!files.length) return
      const { sessionId, inputActions, getDraft } = opts
      const direct = []
      const rest = []
      for (const f of files) {
        const p = shellPathOf(f)
        if (p) direct.push(p)
        else rest.push(f)
      }
      if (direct.length > 0) {
        appendToDraft(inputActions, getDraft(), direct)
        statusStore.set('✓ 已获取 ' + direct.length + ' 个原始路径（桌面壳）')
      }
      if (rest.length === 0) return

      statusStore.set('正在上传 ' + rest.length + ' 个文件…')
      const ok = []
      const errs = []
      for (const f of rest) {
        if (f.size > MAX_BYTES) { errs.push(f.name + '（超过 25MB 限制）'); continue }
        try {
          const payload = looksText(f)
            ? { kind: 'text', content: await f.text() }
            : { kind: 'binary', base64: await fileToBase64(f) }
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              name: f.name,
              size: f.size,
              type: f.type || '',
              ...payload,
            }),
          })
          const data = await response.json().catch(() => ({}))
          if (response.ok && data.path) ok.push(data.path)
          else errs.push(f.name + '：' + (data.error || '保存失败'))
        } catch (err) {
          errs.push(f.name + '：' + String((err && err.message) || err))
        }
      }
      if (ok.length > 0) appendToDraft(inputActions, getDraft(), ok)
      const text = [
        ok.length > 0 ? '✓ ' + ok.length + ' 个文件已上传' : '',
        errs.length > 0 ? '✗ ' + errs.join('；') : '',
      ].filter(Boolean).join('　')
      statusStore.set(text || '没有文件被处理')
    }

    // 目录：递归遍历后整包上传，落盘为同名目录，插入目录根路径（upload 方案）
    async function processDirectoryUpload(entry, opts) {
      const { sessionId, inputActions, getDraft } = opts
      const MAX_DIR_FILES = 500
      statusStore.set('正在读取目录 ' + entry.name + ' …')
      let all
      try {
        all = await readEntryAll(entry)
      } catch (err) {
        statusStore.set('✗ 读取目录失败：' + String((err && err.message) || err))
        return
      }
      if (all.length > MAX_DIR_FILES) {
        all = all.slice(0, MAX_DIR_FILES)
      }
      const entries = []
      const skipped = []
      for (const { path, file } of all) {
        if (file.size > MAX_BYTES) { skipped.push(file.name); continue }
        const payload = looksText(file)
          ? { kind: 'text', content: await file.text() }
          : { kind: 'binary', base64: await fileToBase64(file) }
        entries.push({ path: path || file.name, ...payload })
      }
      if (entries.length === 0) {
        statusStore.set('✗ 目录内没有可上传的文件' + (skipped.length ? '（跳过 ' + skipped.length + ' 个超大文件）' : ''))
        return
      }
      statusStore.set('正在上传目录 ' + entry.name + '（' + entries.length + ' 个文件）…')
      try {
        const response = await fetch(API_PATH + '/dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, dirName: entry.name, entries }),
        })
        const data = await response.json().catch(() => ({}))
        if (response.ok && data.path) {
          appendToDraft(inputActions, getDraft(), [data.path])
          statusStore.set('✓ 目录已上传' + (skipped.length ? '（跳过 ' + skipped.length + ' 个超大文件）' : ''))
        } else {
          statusStore.set('✗ 目录上传失败：' + (data.error || '保存失败'))
        }
      } catch (err) {
        statusStore.set('✗ 目录上传失败：' + String((err && err.message) || err))
      }
    }

    // ---- locate 方案（搜索定位，零拷贝） ----

    const LOCATE_ROUTE = '/file-drop/locate'
    const LOCATE_SAMPLE_BYTES = 64 * 1024
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

    async function fileSampleFingerprint(file) {
      const ranges = locateSampleRanges(file.size)
      const parts = await Promise.all(ranges.map((r) => file.slice(r.start, r.end).arrayBuffer()))
      const total = parts.reduce((sum, part) => sum + part.byteLength, 8)
      const combined = new Uint8Array(total)
      new DataView(combined.buffer).setBigUint64(0, BigInt(file.size))
      let cursor = 8
      for (const part of parts) {
        combined.set(new Uint8Array(part), cursor)
        cursor += part.byteLength
      }
      return hexFromArrayBuffer(await crypto.subtle.digest('SHA-256', combined))
    }

    async function fileFullFingerprint(file) {
      return hexFromArrayBuffer(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
    }

    async function locateRequest(body) {
      const response = await fetch(LOCATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value = await response.json().catch(() => ({}))
      return response.ok ? value : { status: 'error', message: value.message || ('HTTP ' + response.status) }
    }

    function readEntryChildren(entry) {
      const reader = entry.createReader()
      const out = []
      return new Promise((resolve, reject) => {
        const readBatch = () => {
          reader.readEntries((batch) => {
            if (!batch || batch.length === 0) { resolve(out); return }
            out.push(...batch)
            readBatch()
          }, reject)
        }
        readBatch()
      })
    }

    async function readDirectoryStructure(root) {
      const entries = []
      let truncated = false
      const visit = async (directory, prefix, depth) => {
        if (depth >= LOCATE_MAX_DEPTH) { truncated = true; return }
        const children = await readEntryChildren(directory)
        children.sort((a, b) => a.name.normalize('NFC').localeCompare(b.name.normalize('NFC')))
        for (const child of children) {
          if (entries.length >= LOCATE_MAX_ENTRIES) { truncated = true; return }
          const path = prefix === '' ? child.name : prefix + '/' + child.name
          if (child.isDirectory) {
            entries.push({ path, kind: 'directory' })
            await visit(child, path, depth + 1)
          } else if (child.isFile) {
            const file = await new Promise((resolve, reject) => child.file(resolve, reject))
            entries.push({ path, kind: 'file', size: file.size })
          }
        }
      }
      await visit(root, '', 0)
      return { entries, truncated }
    }

    async function findEntryByPath(root, relativePath) {
      let current = root
      for (const part of relativePath.split('/')) {
        if (!current || !current.isDirectory) return undefined
        current = (await readEntryChildren(current)).find((entry) => entry.name.normalize('NFC') === part.normalize('NFC'))
        if (current === undefined) return undefined
      }
      return current
    }

    async function readDirectoryContentSamples(root, paths) {
      const samples = []
      for (const path of paths) {
        const entry = await findEntryByPath(root, path)
        if (entry && entry.isFile === true) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
          samples.push({ path, size: file.size, digest: await fileSampleFingerprint(file) })
        }
      }
      return samples
    }

    function workspaceContext(workspaces, currentWorkspacePath) {
      const items = (workspaces && workspaces.list && workspaces.list.getSnapshot && workspaces.list.getSnapshot().items) || []
      return {
        workspacePaths: items.map((item) => item.path),
        ...(currentWorkspacePath === undefined ? {} : { currentWorkspacePath }),
      }
    }

    async function locateDroppedFile(file, workspaces, currentWorkspacePath) {
      const meta = droppedFileMeta(file)
      const wctx = workspaceContext(workspaces, currentWorkspacePath)
      let result = await locateRequest({ phase: 'metadata', file: meta, ...wctx })
      if (result.status !== 'sample-required') return result
      result = await locateRequest({ phase: 'sample', file: meta, candidates: result.candidates, digest: await fileSampleFingerprint(file) })
      if (result.status !== 'full-required') return result
      return locateRequest({ phase: 'full', file: meta, candidates: result.candidates, digest: await fileFullFingerprint(file) })
    }

    async function locateDroppedDirectory(entry, workspaces, currentWorkspacePath) {
      const initial = { kind: 'directory', name: entry.name }
      const wctx = workspaceContext(workspaces, currentWorkspacePath)
      let result = await locateRequest({ phase: 'metadata', file: initial, ...wctx })
      if (result.status !== 'directory-structure-required') return result
      const meta = { ...initial, structure: await readDirectoryStructure(entry) }
      result = await locateRequest({ phase: 'directory-structure', file: meta, candidates: result.candidates })
      if (result.status !== 'directory-content-required') return result
      return locateRequest({ phase: 'directory-content', file: meta, candidates: result.candidates, directorySamples: await readDirectoryContentSamples(entry, result.paths) })
    }

    function choosePathInteractive(name, candidates) {
      // 多个候选无法区分时，用简单弹窗让用户选择序号（后续可换成更友好的 UI）
      const max = candidates.length > 10 ? 10 : candidates.length
      const lines = candidates.slice(0, max).map((p, i) => '[' + i + '] ' + p).join('\n')
      const raw = window.prompt('「' + name + '」有多个匹配路径，输入序号选择：\n' + lines)
      if (raw === null || raw === undefined) return undefined
      const idx = parseInt(raw, 10)
      return Number.isInteger(idx) && idx >= 0 && idx < max ? candidates[idx] : undefined
    }

    async function processFilesLocate(files, opts) {
      const { inputActions, getDraft, workspaces, currentWorkspacePath } = opts
      statusStore.set('正在定位文件中…')
      const found = []
      const failures = []
      for (const file of files) {
        try {
          const result = await locateDroppedFile(file, workspaces, currentWorkspacePath)
          if (result.status === 'found') found.push(result.path)
          else if (result.status === 'choose') {
            const picked = choosePathInteractive(file.name, result.candidates)
            if (picked) found.push(picked)
            else failures.push(file.name)
          } else failures.push(file.name)
        } catch (err) {
          failures.push(file.name)
        }
      }
      if (found.length > 0) appendToDraft(inputActions, getDraft(), found)
      if (failures.length > 0) statusStore.set('✗ 未能定位：' + failures.join('、'))
      else statusStore.clear()
    }

    async function processDirectoryLocate(entry, opts) {
      const { inputActions, getDraft, workspaces, currentWorkspacePath } = opts
      statusStore.set('正在定位目录中…')
      try {
        const result = await locateDroppedDirectory(entry, workspaces, currentWorkspacePath)
        if (result.status === 'found') {
          appendToDraft(inputActions, getDraft(), [result.path])
          statusStore.clear()
        } else if (result.status === 'choose') {
          const picked = choosePathInteractive(entry.name, result.candidates)
          if (picked) {
            appendToDraft(inputActions, getDraft(), [picked])
            statusStore.clear()
          } else {
            statusStore.set('✗ 未选择目录路径')
          }
        } else {
          statusStore.set('✗ 未能定位目录：' + entry.name)
        }
      } catch (err) {
        statusStore.set('✗ 未能定位目录：' + entry.name)
      }
    }

    // ---- 组件 ----

    // 输入框工具行：回形针按钮（点开文件选择器）
    function PaperclipButton(props) {
      const pickRef = React.useRef(null)
      const optsRef = React.useRef({})
      optsRef.current = {
        sessionId: props.sessionId,
        inputActions: props.inputActions,
        getDraft: () => (props.input && props.input.draft) || '',
      }
      const onClick = () => { if (pickRef.current) pickRef.current.click() }
      const onChange = (e) => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        if (files.length > 0) void processFiles(files, optsRef.current)
      }
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsh-paperclip-wrap' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-paperclip',
            'aria-label': '上传文件',
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
      const statusText = useStatus()
      const [statusBottom, setStatusBottom] = React.useState(110)
      const [statusLeft, setStatusLeft] = React.useState('50%')
      const depthRef = React.useRef(0)
      const busyRef = React.useRef(false)
      const optsRef = React.useRef({})
      optsRef.current = {
        sessionId: props.sessionId,
        inputActions: props.inputActions,
        getDraft: () => (props.input && props.input.draft) || '',
        workspaces: props.workspaces,
        currentWorkspacePath: (() => {
          try {
            const s = props.sessions && props.sessions.list && props.sessions.list.getSnapshot()
            const id = s && s.current
            return id === undefined ? undefined : (s.byId[id] && s.byId[id].cwd)
          } catch { return undefined }
        })(),
      }

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
        // document 级拖拽图片处理（InputBar intakeImages / DropOverlay）。
        const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
        const onDragEnter = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          depthRef.current += 1
          setDrag(true)
        }
        const onDragOver = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        }
        const onDragLeave = (e) => {
          e.stopPropagation()
          depthRef.current -= 1
          if (depthRef.current <= 0) { depthRef.current = 0; setDrag(false) }
        }
        const onDrop = (e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.stopPropagation()
          depthRef.current = 0
          setDrag(false)
          void handleDrop(e)
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

      async function handleDrop(e) {
        if (busyRef.current) return
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])

        // 桌面壳（preload 捕获阶段已解析好磁盘原始路径）
        const shellPaths = drainShellPaths()
        if (shellPaths.length > 0) {
          appendToDraft(optsRef.current.inputActions, optsRef.current.getDraft(), shellPaths)
          statusStore.set('✓ 已获取 ' + shellPaths.length + ' 个原始路径（桌面壳）')
          return
        }

        // 拖拽自带路径 → 直接取地址，零上传
        const paths = extractPaths(e)
        if (paths.length > 0) {
          appendToDraft(optsRef.current.inputActions, optsRef.current.getDraft(), paths)
          statusStore.set('✓ 已获取 ' + paths.length + ' 个文件路径')
          return
        }

        // 目录拖拽 → 按模式走「目录上传」或「目录定位」
        const dirEntries = getDirectoryEntries(e.dataTransfer && e.dataTransfer.items)
        if (dirEntries.length > 0) {
          busyRef.current = true
          try {
            for (const dirEntry of dirEntries) {
              if (currentMode === 'locate') {
                await processDirectoryLocate(dirEntry, optsRef.current)
              } else {
                await processDirectoryUpload(dirEntry, optsRef.current)
              }
            }
          } finally {
            busyRef.current = false
          }
          return
        }

        // 普通文件 → 按模式走「上传兜底」或「搜索定位」
        if (files.length === 0) return
        busyRef.current = true
        try {
          if (currentMode === 'locate') {
            await processFilesLocate(files, optsRef.current)
          } else {
            await processFiles(files, optsRef.current)
          }
        } finally {
          busyRef.current = false
        }
      }

      return React.createElement(React.Fragment, null,
        statusText ? React.createElement('div', { className: 'dsh-drop-status', style: { bottom: statusBottom, left: statusLeft } },
          statusText.indexOf('正在') === 0 ? React.createElement('span', { className: 'dsh-drop-status-spinner' }) : null,
          React.createElement('span', { className: 'dsh-drop-status-text' }, statusText)
        ) : null,
        drag ? React.createElement('div', { className: 'dsh-drop-overlay' },
          React.createElement('div', { className: 'dsh-drop-overlay-inner' }, '松开鼠标，获取文件')
        ) : null
      )
    }

    // 设置页 section：选择拖拽处理方案
    function SettingsSection(props) {
      const [mode, setMode] = React.useState(currentMode)
      React.useEffect(() => { readMode().then((m) => { currentMode = m; setMode(m) }) }, [])
      const pick = (m) => { currentMode = m; setMode(m); void writeMode(m) }
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '拖拽文件处理方式'),
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('input', { type: 'radio', name: 'dsh-file-drop-mode', checked: mode === 'upload', onChange: () => pick('upload') }),
          React.createElement('span', null, '上传到工作区（.dsh-drops，稳定可靠）')
        ),
        React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('input', { type: 'radio', name: 'dsh-file-drop-mode', checked: mode === 'locate', onChange: () => pick('locate') }),
          React.createElement('span', null, '搜索定位原始路径（零拷贝，文件须在可搜索范围内）')
        )
      )
    }

    const CSS = `
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

    function apply(ctx) {
      // 初始化当前模式（异步读取，默认 upload）
      readMode().then((m) => { currentMode = m })

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-file-drop'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-file-drop: styles')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'file-drop-pick', order: 0 },
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
        { name: 'settings.section', id: 'dsh-file-drop', order: 110, label: () => '拖拽文件' },
        (props) => React.createElement(SettingsSection, props)
      ))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
