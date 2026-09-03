const STATUS_DISMISS_MS = 500
const subscribedStores = new Set()

function createStatusStore() {
  return {
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
    subscribe(listener) {
      this.listeners.add(listener)
      subscribedStores.add(this)
      return () => {
        this.listeners.delete(listener)
        if (this.listeners.size === 0) subscribedStores.delete(this)
      }
    },
  }
}

const statusStore = createStatusStore()
const composerStores = new WeakMap()

function clearAllStatuses() {
  statusStore.clear()
  for (const store of [...subscribedStores]) {
    if (store !== statusStore) store.clear()
  }
}

function composerStatusStore(owner) {
  if ((!owner || typeof owner !== 'object') && typeof owner !== 'function') return statusStore
  let store = composerStores.get(owner)
  if (!store) {
    store = createStatusStore()
    composerStores.set(owner, store)
  }
  return store
}

export { clearAllStatuses, composerStatusStore, createStatusStore, statusStore }
