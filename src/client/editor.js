function composerTextarea(draft, ownerElement) {
  const owner = ownerElement && Object.hasOwn(ownerElement, 'current') ? ownerElement.current : ownerElement
  let composer
  for (let scope = owner; scope && scope !== document.body; scope = scope.parentElement) {
    composer = scope.matches?.('[data-composer-card]')
      ? scope
      : scope.querySelector?.('[data-composer-card]')
    if (composer) break
  }
  const all = [...(composer || document).querySelectorAll('[data-input-scroll] textarea')]
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

function insertPaths(inputActions, draft, paths, isActive = () => true, ownerElement) {
  if (!inputActions || !isActive()) return
  const fallbackDraft = typeof draft === 'string' ? draft : ''
  const insert = paths.map(markdownPath).join(' ')
  // 聚焦时读到当前光标；未聚焦时读到 DOM 原生保留的上次光标位置。
  // 唯一盲区：从未聚焦过的 textarea 恒为 0，空草稿下与插入末尾等价。
  const el = composerTextarea(fallbackDraft, ownerElement)
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

export { composerTextarea, insertPaths, markdownPath, summarizeItems }
