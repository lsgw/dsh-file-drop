const claimedDropEvents = new WeakSet()
const dropOwners = new Set()

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

export {
  claimedDropEvents, chooseDropOwner, currentSessionMatches, currentSessionWorkspacePath,
  dropOwners, normalizeSessionId, retryWorkspaceContext, selectDropOwner, workspaceContext,
}
