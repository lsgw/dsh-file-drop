import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

let definition
globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
await import('../client.js?ui-contract-test')
const plugin = definition.factory((name) => {
  if (name === 'react') return {}
  throw new Error('unexpected module: ' + name)
})

test('current UI CSS and component surface stay frozen', () => {
  assert.equal(plugin.__test.CSS.length, 7412)
  assert.equal(
    createHash('sha256').update(plugin.__test.CSS).digest('hex'),
    'd47f405a2fa175bd748a1a26309379530a2fdf427ff906e614542be5123d5161'
  )
  assert.deepEqual(Object.keys(plugin.__test.components), [
    'DropZone', 'PaperclipButton', 'SettingsSection',
  ])
  assert.match(plugin.__test.CSS, /\.dsh-drop-overlay-inner/)
  assert.match(plugin.__test.CSS, /border: 2px dashed rgba\(24, 118, 255, 0\.7\)/)
  assert.match(plugin.__test.CSS, /border-radius: 999px/)
})

test('current style and slot registration contract stays unchanged', async (t) => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const styles = []
  const registrations = []
  const injections = []
  const cleanups = []

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 }
    },
  })
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'style')
      return { dataset: {}, textContent: '', remove() { this.removed = true } }
    },
    head: { appendChild(style) { styles.push(style) } },
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.document = originalDocument
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup()
  })

  const ctx = {
    workspaces: { marker: 'workspaces' },
    sessions: { marker: 'sessions' },
    effect(effect) { cleanups.push(effect()) },
    slots: {
      inject(name, install) { injections.push(name); install() },
      register(meta, render) { registrations.push({ meta, render }); return () => {} },
    },
  }
  await plugin.apply(ctx)

  assert.deepEqual(injections, [
    'conversation.input.left', 'conversation.input.dock', 'settings.section',
  ])
  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, 'dsh-file-drop')
  assert.equal(styles[0].textContent, plugin.__test.CSS)
  assert.deepEqual(registrations.map(({ meta }) => ({
    name: meta.name, id: meta.id, order: meta.order, label: meta.label?.(),
  })), [
    { name: 'conversation.input.left', id: 'file-drop-pick', order: 0, label: undefined },
    { name: 'conversation.input.dock', id: 'file-drop', order: 30, label: undefined },
    { name: 'settings.section', id: 'dsh-file-drop', order: 110, label: '拖拽文件' },
  ])
  assert.deepEqual(registrations[0].meta.inject(), { workspaces: ctx.workspaces, sessions: ctx.sessions })
  assert.deepEqual(registrations[1].meta.inject(), { workspaces: ctx.workspaces, sessions: ctx.sessions })
  assert.deepEqual(registrations[2].meta.inject(), { sessions: ctx.sessions })
})
