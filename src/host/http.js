import { HttpError, errorCode, errorMessage, errorStatus } from './safety.js'

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, error, fallbackStatus = 500) {
  const code = errorCode(error)
  sendJson(res, errorStatus(error, fallbackStatus), { error: errorMessage(error), ...(code ? { code } : {}) })
}

export function sendLocateError(res, error, fallbackStatus = 500) {
  sendJson(res, errorStatus(error, fallbackStatus), { status: 'error', message: errorMessage(error) })
}

export function sameOriginRequest(req) {
  const headers = req.headers || {}
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (!origin) return true
  const host = headers.host
  if (!host) return false
  return origin === 'http://' + host || origin === 'https://' + host
}

export function requireJson(req) {
  const contentType = req.headers && req.headers['content-type']
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'content-type must be application/json')
  }
}

export function requireBinary(req) {
  const contentType = req.headers && req.headers['content-type']
  if (!contentType || !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)) {
    if (typeof req.resume === 'function') req.resume()
    throw new HttpError(415, 'content-type must be application/octet-stream')
  }
}

export function requireMethod(req, res, methods) {
  if (methods.includes(req.method)) return true
  res.writeHead(405, { allow: methods.join(', '), 'content-length': 0 })
  res.end()
  return false
}
