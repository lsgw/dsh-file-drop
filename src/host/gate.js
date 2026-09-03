export function createReadWriteGate() {
  let activeReaders = 0
  let writeTail = Promise.resolve()
  const readerWaiters = []

  const read = async (operation) => {
    await writeTail
    activeReaders += 1
    try {
      return await operation()
    } finally {
      activeReaders -= 1
      if (activeReaders === 0) {
        for (const resolve of readerWaiters.splice(0)) resolve()
      }
    }
  }

  const write = (operation) => {
    let release
    const previous = writeTail
    writeTail = new Promise((resolve) => { release = resolve })
    return (async () => {
      await previous
      if (activeReaders > 0) await new Promise((resolve) => readerWaiters.push(resolve))
      try { return await operation() } finally { release() }
    })()
  }

  return Object.freeze({ read, write })
}
