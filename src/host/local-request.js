function loopbackHost(value) {
  const host = String(value || '').toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  if (!/^127(?:\.[0-9]{1,3}){3}$/.test(host)) return false
  return host.split('.').slice(1).every((part) => Number(part) <= 255)
}

function loopbackAddress(value) {
  const address = String(value || '').toLowerCase().split('%')[0]
  return loopbackHost(address) || address.startsWith('::ffff:') && loopbackHost(address.slice(7))
}

export function sameOriginRequest(req) {
  const headers = req.headers || {}
  const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress
  if (!loopbackAddress(remoteAddress) || headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (!origin) return true
  const host = headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && loopbackHost(parsed.hostname)
      && parsed.host.toLowerCase() === host.toLowerCase()
      && parsed.origin === origin
  } catch {
    return false
  }
}
