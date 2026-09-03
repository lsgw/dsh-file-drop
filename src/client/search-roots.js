import {
  MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH, MAX_EXTERNAL_SEARCH_ROOTS, SEARCH_ROOTS_PATH,
} from '../shared/contract.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let snapshot = { epoch: 0, roots: [] }
let channel
let channelOwners = 0
const listeners = new Set()

function validExternalSearchRoots(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object'
    || Object.keys(data).sort().join(',') !== 'epoch,roots'
    || !Number.isSafeInteger(data.epoch) || data.epoch < 0
    || !Array.isArray(data.roots) || data.roots.length > MAX_EXTERNAL_SEARCH_ROOTS) return false
  return data.roots.every((root) => root && typeof root === 'object'
    && Object.keys(root).sort().join(',') === 'available,id,path'
    && typeof root.id === 'string' && UUID_PATTERN.test(root.id)
    && typeof root.path === 'string' && root.path !== ''
    && root.path.length <= MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH
    && !root.path.includes('\0') && typeof root.available === 'boolean')
}

function notify(data) {
  if (data.epoch < snapshot.epoch) return
  snapshot = { epoch: data.epoch, roots: data.roots.map((root) => ({ ...root })) }
  for (const listener of [...listeners]) listener()
}

function publish(data) {
  notify(data)
  if (channel) channel.postMessage(data)
}

async function request(method, body, signal, broadcast = false) {
  const options = { method, signal }
  if (method === 'POST') {
    options.headers = { 'content-type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  const response = await fetch(SEARCH_ROOTS_PATH, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !validExternalSearchRoots(data)) {
    throw new Error(data.error || ('外部搜索根请求失败（HTTP ' + response.status + '）'))
  }
  if (broadcast) publish(data)
  else notify(data)
  return data
}

function readExternalSearchRoots(signal) {
  return request('GET', undefined, signal, true)
}

function authorizeExternalSearchRoot(path, signal) {
  return request('POST', { action: 'authorize', path }, signal, true)
}

function revokeExternalSearchRoot(id, signal) {
  return request('POST', { action: 'revoke', id }, signal, true)
}

function subscribeExternalSearchRoots(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function currentExternalSearchRoots() {
  return { epoch: snapshot.epoch, roots: snapshot.roots.map((root) => ({ ...root })) }
}

function openExternalSearchRootChannel() {
  if (typeof window === 'undefined' || !window.BroadcastChannel) return () => {}
  if (!channel) {
    channel = new window.BroadcastChannel('dsh-file-drop-search-roots')
    channel.addEventListener('message', (event) => {
      if (validExternalSearchRoots(event.data)) notify(event.data)
    })
  }
  channelOwners += 1
  let released = false
  return () => {
    if (released) return
    released = true
    channelOwners -= 1
    if (channelOwners > 0 || !channel) return
    const current = channel
    channel = undefined
    current.close()
  }
}

export {
  authorizeExternalSearchRoot, currentExternalSearchRoots, openExternalSearchRootChannel,
  readExternalSearchRoots, revokeExternalSearchRoot, subscribeExternalSearchRoots,
  validExternalSearchRoots,
}
