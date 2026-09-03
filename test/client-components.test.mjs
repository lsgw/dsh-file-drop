import assert from 'node:assert/strict'
import test from 'node:test'

import * as api from '../src/client/api.js'
import { insertPaths } from '../src/client/editor.js'
import {
  currentExternalSearchRoots, openExternalSearchRootChannel, subscribeExternalSearchRoots,
} from '../src/client/search-roots.js'
import { composerStatusStore, statusStore } from '../src/client/status.js'
import { createView } from '../src/client/view.js'

const uploadSettings = { mode: 'upload', uploadQuotaMiB: 1024, uploadQuotaEntries: 10000 }
const locateSettings = { ...uploadSettings, mode: 'locate' }
const tick = String.fromCharCode(96)

function reactMock() {
  const effects = []
  const layoutEffects = []
  let externalStore
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useEffect(effect) { effects.push(effect) },
    useLayoutEffect(effect) { layoutEffects.push(effect) },
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
    useSyncExternalStore(subscribe, getSnapshot) {
      externalStore = { subscribe, getSnapshot }
      return getSnapshot()
    },
  }
  return { React, effects, layoutEffects, get externalStore() { return externalStore } }
}

function restoreGlobal(name, existed, value) {
  if (existed) globalThis[name] = value
  else delete globalThis[name]
}

function treeNodes(value) {
  if (!value || typeof value !== 'object') return []
  return [value, ...(value.children || []).flatMap(treeNodes)]
}

test('status hook reads the store snapshot after every notification', () => {
  statusStore.clear()
  const mock = reactMock()
  createView(mock.React).DropZone({})
  assert.ok(mock.externalStore)
  let observed
  const unsubscribe = mock.externalStore.subscribe(() => { observed = mock.externalStore.getSnapshot() })
  statusStore.show('正在测试状态…')
  assert.equal(observed, '正在测试状态…')
  unsubscribe()
  statusStore.clear()
})

test('composer status stores are isolated by input actions', () => {
  const first = composerStatusStore({})
  const second = composerStatusStore({})
  first.show('first')
  second.show('second')
  assert.equal(first.value, 'first')
  assert.equal(second.value, 'second')
  first.clear()
  assert.equal(second.value, 'second')
  second.clear()
})

test('terminal status dismisses after half a second', () => {
  const oldSetTimeout = globalThis.setTimeout
  const oldClearTimeout = globalThis.clearTimeout
  let timer
  globalThis.setTimeout = (callback, delay) => { timer = { callback, delay }; return 1 }
  globalThis.clearTimeout = () => {}
  try {
    statusStore.clear()
    statusStore.show('✓ 完成')
    assert.equal(timer.delay, 500)
    assert.equal(statusStore.value, '✓ 完成')
    timer.callback()
    assert.equal(statusStore.value, null)
  } finally {
    globalThis.setTimeout = oldSetTimeout
    globalThis.clearTimeout = oldClearTimeout
    statusStore.clear()
  }
})

test('paperclip preflight cannot start work after component unmount', async () => {
  const globals = Object.fromEntries(['window', 'fetch', 'document'].map((name) => [name, [
    Object.hasOwn(globalThis, name), globalThis[name],
  ]]))
  let resolveFetch
  let draft
  try {
    globalThis.window = { __ModuleLoader__: globalThis.window && globalThis.window.__ModuleLoader__ }
    globalThis.document = { body: {}, activeElement: null, querySelectorAll: () => [] }
    globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve })
    const mock = reactMock()
    const sessions = { list: {
      getSnapshot: () => ({ current: 'session-a', byId: { 'session-a': { cwd: '/work' } } }),
      subscribe: () => () => {},
    } }
    const tree = createView(mock.React).PaperclipButton({
      sessionId: 'session-a', input: { draft: '' }, sessions,
      inputActions: { setDraft(value) { draft = value } },
    })
    const cleanups = mock.effects.map((effect) => effect()).filter((value) => typeof value === 'function')
    tree.children[1].props.onChange({ target: { files: [{ name: 'x.txt', size: 1 }], value: 'x' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(typeof resolveFetch, 'function')
    for (const cleanup of cleanups.reverse()) cleanup()
    resolveFetch({ ok: true, json: async () => locateSettings })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(draft, undefined)
  } finally {
    for (const [name, [existed, value]] of Object.entries(globals)) restoreGlobal(name, existed, value)
  }
})

test('paperclip remains mounted after StrictMode effect replay', async (t) => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const urls = []
  let draft
  t.after(() => { globalThis.fetch = originalFetch; restoreGlobal('document', Object.hasOwn(globalThis, 'document'), originalDocument) })
  globalThis.document = { body: {}, activeElement: null, querySelectorAll: () => [] }
  api.adoptSettings(uploadSettings)
  globalThis.fetch = async (url) => {
    urls.push(url)
    if (url === '/api/dsh-file-drop/settings') return { ok: true, json: async () => uploadSettings }
    if (url.endsWith('/init')) {
      return { ok: true, json: async () => ({ uploadId: 'strict-upload', chunkBytes: 1, fileCount: 1, totalBytes: 0 }) }
    }
    if (url.endsWith('/finish')) {
      return { ok: true, json: async () => ({ path: '/home/test/.dsh-drops/empty.txt' }) }
    }
    throw new Error('unexpected URL: ' + url)
  }
  const mock = reactMock()
  const sessions = { list: {
    getSnapshot: () => ({ current: 'session-a', byId: { 'session-a': { cwd: '/work' } } }),
    subscribe: () => () => {},
  } }
  const tree = createView(mock.React).PaperclipButton({
    sessionId: 'session-a', input: { draft: '' }, sessions,
    inputActions: { setDraft(value) { draft = value } },
  })
  const firstCleanups = mock.effects.map((effect) => effect()).filter((value) => typeof value === 'function')
  for (const cleanup of firstCleanups.reverse()) cleanup()
  const finalCleanups = mock.effects.map((effect) => effect()).filter((value) => typeof value === 'function')
  tree.children[1].props.onChange({ target: { files: [new File([], 'empty.txt')], value: 'x' } })
  for (let index = 0; index < 8 && !urls.some((url) => url.endsWith('/finish')); index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.ok(urls.some((url) => url.endsWith('/init')))
  assert.ok(urls.some((url) => url.endsWith('/finish')))
  assert.match(draft, /empty\.txt/)
  for (const cleanup of finalCleanups.reverse()) cleanup()
})

test('settings mount adopts the refreshed Host mode', async () => {
  const existed = Object.hasOwn(globalThis, 'fetch')
  const previous = globalThis.fetch
  try {
    api.adoptSettings(uploadSettings)
    globalThis.fetch = async () => ({ ok: true, json: async () => locateSettings })
    const mock = reactMock()
    createView(mock.React).SettingsSection({})
    assert.ok(mock.effects.length > 0)
    mock.effects[0]()
    for (let index = 0; index < 4 && api.currentMode !== 'locate'; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(api.currentMode, 'locate')
  } finally {
    restoreGlobal('fetch', existed, previous)
  }
})

test('locate settings expose external root controls', () => {
  api.adoptSettings(locateSettings)
  const mock = reactMock()
  const tree = createView(mock.React).SettingsSection({})
  const nodes = treeNodes(tree)
  const component = nodes.find((node) => typeof node.type === 'function' && node.type.name === 'SearchRootSettings')
  assert.ok(component)
  const controls = treeNodes(component.type(component.props))
  assert.ok(controls.some((node) => node.props && node.props['aria-label'] === '外部搜索根路径'))
  assert.ok(controls.some((node) => node.type === 'button' && node.children.includes('授权')))
})

test('path insertion stays inside the selected composer owner', () => {
  const documentExisted = Object.hasOwn(globalThis, 'document')
  const documentValue = globalThis.document
  const rafExisted = Object.hasOwn(globalThis, 'requestAnimationFrame')
  const rafValue = globalThis.requestAnimationFrame
  let focused
  let selection
  let draft
  const textareaA = {
    isConnected: true, value: 'left right', selectionStart: 4, selectionEnd: 4,
    getClientRects: () => [{}],
    focus() { focused = 'a' },
    setSelectionRange(start, end) { selection = [start, end] },
  }
  const textareaB = {
    isConnected: true, value: 'wrong composer', selectionStart: 5, selectionEnd: 5,
    getClientRects: () => [{}],
    focus() { focused = 'b' },
    setSelectionRange() {},
  }
  try {
    const body = {}
    const cardA = {
      matches: (selector) => selector === '[data-composer-card]',
      querySelectorAll: () => [textareaA],
    }
    const stackA = {
      parentElement: body,
      matches: () => false,
      querySelector: (selector) => selector === '[data-composer-card]' ? cardA : null,
    }
    const dockSlot = { parentElement: stackA }
    const ownerNode = { parentElement: dockSlot }
    globalThis.document = {
      body, activeElement: textareaB,
      querySelectorAll: () => [textareaA, textareaB],
    }
    globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
    const owner = { current: ownerNode }
    insertPaths({ setDraft(value) { draft = value } }, 'left right', ['C:\\owned.txt'], undefined, owner)
    assert.equal(draft, 'left ' + tick + 'C:\\owned.txt' + tick + ' right')
    assert.equal(focused, 'a')
    assert.deepEqual(selection, [19, 19])
  } finally {
    restoreGlobal('document', documentExisted, documentValue)
    restoreGlobal('requestAnimationFrame', rafExisted, rafValue)
  }
})

test('mode channel closes only after its final effect owner releases it', () => {
  const existed = Object.hasOwn(globalThis, 'window')
  const previous = globalThis.window
  const channels = []
  class FakeBroadcastChannel {
    constructor(name) { this.name = name; this.listeners = []; this.closed = 0; channels.push(this) }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener) }
    postMessage() {}
    close() { this.closed += 1 }
  }
  try {
    globalThis.window = { BroadcastChannel: FakeBroadcastChannel }
    api.adoptSettings(uploadSettings)
    let observed
    const unsubscribeSettings = api.subscribeSettings((settings) => { observed = settings })
    const releaseA = api.openModeChannel()
    const releaseB = api.openModeChannel()
    assert.equal(channels.length, 1)
    releaseA()
    releaseA()
    assert.equal(channels[0].closed, 0)
    channels[0].listeners[0]({ data: locateSettings })
    assert.equal(api.currentMode, 'locate')
    assert.deepEqual(observed, locateSettings)
    unsubscribeSettings()
    releaseB()
    assert.equal(channels[0].closed, 1)
  } finally {
    restoreGlobal('window', existed, previous)
  }
})

test('external root channel refreshes settings subscribers', () => {
  const existed = Object.hasOwn(globalThis, 'window')
  const previous = globalThis.window
  const channels = []
  class FakeBroadcastChannel {
    constructor(name) { this.name = name; this.listeners = []; this.closed = 0; channels.push(this) }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener) }
    postMessage() {}
    close() { this.closed += 1 }
  }
  try {
    globalThis.window = { BroadcastChannel: FakeBroadcastChannel }
    const release = openExternalSearchRootChannel()
    let observed
    const unsubscribe = subscribeExternalSearchRoots(() => { observed = currentExternalSearchRoots() })
    const data = { epoch: 3, roots: [{ id: '11111111-1111-4111-8111-111111111111', path: '/external', available: true }] }
    assert.equal(channels.length, 1)
    channels[0].listeners[0]({ data })
    assert.deepEqual(observed, data)
    channels[0].listeners[0]({ data: { epoch: 2, roots: [] } })
    assert.deepEqual(currentExternalSearchRoots(), data)
    unsubscribe()
    release()
    assert.equal(channels[0].closed, 1)
  } finally {
    restoreGlobal('window', existed, previous)
  }
})
