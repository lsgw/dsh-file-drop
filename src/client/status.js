const STATUS_DISMISS_MS = 500
const statusStore = {
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
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
}

export { statusStore }
