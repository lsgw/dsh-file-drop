import {
  MAX_ROOT_DIRECTORIES, MAX_TOP_LEVEL_FILES, MAX_UPLOAD_QUOTA_ENTRIES,
  MAX_UPLOAD_QUOTA_MIB, MIB_BYTES, MODE_READ_ERROR_MESSAGE, QUOTA_ERROR_MESSAGE,
  abortableDelay, adoptSettings, beginModeChange, claimedDropEvents, clearUserUploadRoot, currentMode,
  currentSessionMatches, currentSessionWorkspacePath, currentSettings,
  dropOwners, formatSize, getDirectoryEntries, modeRevision, normalizeSessionId,
  operationController, processDirectoryLocate, processDirectoryUpload, processFilesLocate,
  processFilesUpload, readUserUploadUsage, refreshModeForAction, refreshSettings,
  selectDropOwner, shouldHandleDataTransfer, statusStore, writeSettings,
  chooseDropAction,
} from './runtime.js'

export function createView(React) {
  function useStatus() {
    return React.useSyncExternalStore(
      (listener) => statusStore.subscribe(listener),
      () => statusStore.value,
      () => statusStore.value
    )
  }

  // ---- 组件 ----

  // 输入框工具行：回形针按钮（点开文件选择器）
  function PaperclipButton(props) {
    const pickRef = React.useRef(null)
    const ownerRef = React.useRef(null)
    const operationRef = React.useRef(0)
    const operationHandleRef = React.useRef(null)
    const optsRef = React.useRef({})
    optsRef.current = {
      sessionId: normalizeSessionId(props.sessionId),
      inputActions: props.inputActions,
      draft: (props.input && props.input.draft) || '',
      workspaces: props.workspaces,
      currentWorkspacePath: currentSessionWorkspacePath(props.sessions),
      ownerElement: ownerRef,
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
            await processFilesLocate(files, snapshot)
          } else await processFilesUpload(files, snapshot)
        } finally {
          handle.release()
          if (operationHandleRef.current === handle) operationHandleRef.current = null
        }
      })()
    }
    return React.createElement(React.Fragment, null,
      React.createElement('div', { ref: ownerRef, className: 'dsh-paperclip-wrap' },
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
      ownerElement: ownerRef,
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
      const hasFiles = (e) => shouldHandleDataTransfer(e.dataTransfer)
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
        if (!hasFiles(e) || !claim(e)) return
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

    async function handleDrop(e) {
      if (busyRef.current) return
      busyRef.current = true
      const dataTransfer = e.dataTransfer
      const files = Array.from((dataTransfer && dataTransfer.files) || [])
      const started = { ...optsRef.current }
      const modeStatus = statusStore.begin('正在确认拖拽模式…')
      let directories
      try {
        directories = await getDirectoryEntries(dataTransfer && dataTransfer.items)
      } catch {
        busyRef.current = false
        statusStore.finish(modeStatus, '✗ 未获取到可处理的文件或目录')
        return
      }
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
        directoryCount: directories.length,
        fileCount: files.length,
      })

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

      statusStore.show('✗ 未获取到可处理的文件或目录')
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

  return { CSS, DropZone, PaperclipButton, SettingsSection }
}
