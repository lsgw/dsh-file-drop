import {
  authorizeExternalSearchRoot, currentExternalSearchRoots, openExternalSearchRootChannel,
  readExternalSearchRoots, revokeExternalSearchRoot, subscribeExternalSearchRoots,
} from './runtime.js'

export function createSearchRootSettings(React) {
  return function SearchRootSettings() {
    const [roots, setRoots] = React.useState([])
    const [path, setPath] = React.useState('')
    const [message, setMessage] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const mountedRef = React.useRef(true)
    const busyRef = React.useRef(false)
    const requestRef = React.useRef(0)

    React.useEffect(() => {
      let active = true
      mountedRef.current = true
      const releaseChannel = openExternalSearchRootChannel()
      const unsubscribe = subscribeExternalSearchRoots(() => {
        if (active) setRoots(currentExternalSearchRoots().roots)
      })
      const refresh = () => {
        void readExternalSearchRoots().then(() => {
          if (active) { setRoots(currentExternalSearchRoots().roots); setMessage('') }
        }).catch((error) => {
          if (active) setMessage('✗ ' + String((error && error.message) || error))
        })
      }
      setRoots(currentExternalSearchRoots().roots)
      refresh()
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', refresh)
      }
      return () => {
        active = false
        mountedRef.current = false
        requestRef.current += 1
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('focus', refresh)
        }
        unsubscribe()
        releaseChannel()
      }
    }, [])

    const sync = (requestId, result, successMessage) => {
      if (!mountedRef.current || requestId !== requestRef.current) return false
      const latest = currentExternalSearchRoots()
      setRoots(latest.roots)
      if (result.epoch < latest.epoch) return false
      setMessage(successMessage)
      return true
    }
    const authorize = async () => {
      if (busyRef.current) return
      if (path.trim() === '') { setMessage('✗ 请输入外部搜索根路径'); return }
      const requestId = ++requestRef.current
      busyRef.current = true
      setBusy(true)
      setMessage('')
      try {
        const result = await authorizeExternalSearchRoot(path)
        if (sync(requestId, result, '✓ 外部搜索根已授权')) setPath('')
      } catch (error) {
        if (mountedRef.current && requestId === requestRef.current) {
          setMessage('✗ ' + String((error && error.message) || error))
        }
      } finally {
        if (requestId === requestRef.current) {
          busyRef.current = false
          if (mountedRef.current) setBusy(false)
        }
      }
    }
    const revoke = async (id) => {
      if (busyRef.current) return
      const requestId = ++requestRef.current
      busyRef.current = true
      setBusy(true)
      setMessage('')
      try {
        sync(requestId, await revokeExternalSearchRoot(id), '✓ 外部搜索根已撤销')
      } catch (error) {
        if (mountedRef.current && requestId === requestRef.current) {
          setMessage('✗ ' + String((error && error.message) || error))
        }
      } finally {
        if (requestId === requestRef.current) {
          busyRef.current = false
          if (mountedRef.current) setBusy(false)
        }
      }
    }

    return React.createElement('div', { className: 'dsh-external-root-settings' },
      React.createElement('div', { className: 'dsh-external-root-title' }, '授权外部搜索根'),
      React.createElement('div', { className: 'dsh-external-root-row' },
        React.createElement('input', {
          type: 'text', value: path, placeholder: '输入绝对目录路径',
          'aria-label': '外部搜索根路径', disabled: busy,
          onChange: (event) => { setPath(event.target.value); setMessage('') },
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void authorize() } },
        }),
        React.createElement('button', {
          type: 'button', className: 'dsh-clear-btn', disabled: busy,
          onClick: () => void authorize(),
        }, busy ? '授权中...' : '授权')
      ),
      roots.length > 0
        ? React.createElement('div', { className: 'dsh-external-root-list' }, roots.map((root) =>
            React.createElement('div', { key: root.id, className: 'dsh-external-root-item' },
              React.createElement('span', { className: 'dsh-external-root-path', title: root.path }, root.path),
              !root.available ? React.createElement('span', { className: 'dsh-external-root-state' }, '不可用') : null,
              React.createElement('button', {
                type: 'button', className: 'dsh-clear-btn', disabled: busy,
                'aria-label': '撤销外部搜索根 ' + root.path,
                onClick: () => void revoke(root.id),
              }, '撤销')
            )
          ))
        : React.createElement('div', { className: 'dsh-external-root-empty' }, '尚未授权外部搜索根'),
      message ? React.createElement('div', { className: 'dsh-external-root-msg' }, message) : null
    )
  }
}
