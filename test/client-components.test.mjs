import assert from 'node:assert/strict'
import test from 'node:test'

import * as api from '../src/client/api.js'
import { insertPaths } from '../src/client/editor.js'
import { statusStore } from '../src/client/status.js'
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

test('paperclip locate inserts an Electron direct path without a global binding', async () => {
  const globals = Object.fromEntries(['window', 'document', 'fetch'].map((name) => [name, [
    Object.hasOwn(globalThis, name), globalThis[name],
  ]]))
  let draft
  try {
    api.adoptSettings(locateSettings)
    globalThis.window = { dshDesktop: { getPathForFile: () => 'C:\\original\\report.txt' } }
    globalThis.document = { activeElement: null, querySelectorAll: () => [] }
    globalThis.fetch = async () => ({ ok: true, json: async () => locateSettings })
    const mock = reactMock()
    const tree = createView(mock.React).PaperclipButton({
      sessionId: 'session-a',
      input: { draft: 'prefix' },
      inputActions: { setDraft(value) { draft = value } },
      sessions: { list: {
        getSnapshot: () => ({ current: 'session-a', byId: { 'session-a': { cwd: 'C:\\work' } } }),
        subscribe: () => () => {},
      } },
    })
    const owner = tree.children[0].props.ref
    owner.current = { closest: () => ({ querySelectorAll: () => [] }) }
    tree.children[1].props.onChange({ target: { files: [{ name: 'report.txt', size: 1 }], value: 'selected' } })
    for (let index = 0; index < 4 && draft === undefined; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(draft, 'prefix ' + tick + 'C:\\original\\report.txt' + tick)
  } finally {
    statusStore.clear()
    for (const [name, [existed, value]] of Object.entries(globals)) restoreGlobal(name, existed, value)
  }
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
    const releaseA = api.openModeChannel()
    const releaseB = api.openModeChannel()
    assert.equal(channels.length, 1)
    releaseA()
    releaseA()
    assert.equal(channels[0].closed, 0)
    channels[0].listeners[0]({ data: locateSettings })
    assert.equal(api.currentMode, 'locate')
    releaseB()
    assert.equal(channels[0].closed, 1)
  } finally {
    restoreGlobal('window', existed, previous)
  }
})
