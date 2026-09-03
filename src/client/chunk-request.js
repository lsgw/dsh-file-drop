export async function chunkRequest(url, options, timeoutMs = 45_000) {
  const controller = new AbortController()
  const parent = options.signal
  let timedOut = false
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) onAbort()
  else if (parent) parent.addEventListener('abort', onAbort, { once: true })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('上传分块响应超时'))
    }, Math.max(1, Math.min(timeoutMs, 120_000)))
  })
  const request = fetch(url, { ...options, signal: controller.signal }).then(async (response) => ({
    response,
    data: await response.json().catch(() => ({})),
  }))
  try {
    return await Promise.race([request, timeout])
  } catch (error) {
    if (timedOut) throw new Error('上传分块响应超时')
    throw error
  } finally {
    clearTimeout(timer)
    if (parent) parent.removeEventListener('abort', onAbort)
  }
}
