import { HttpError, errorCode, errorMessage, errorStatus } from './safety.js'
export { sameOriginRequest } from './local-request.js'

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
  const message = error instanceof HttpError ? errorMessage(error) : 'internal error'
  sendJson(res, errorStatus(error, fallbackStatus), { error: message, ...(code ? { code } : {}) })
}

export function sendLocateError(res, error, fallbackStatus = 500) {
  const message = error instanceof HttpError ? errorMessage(error) : 'internal error'
  sendJson(res, errorStatus(error, fallbackStatus), { status: 'error', message })
}


export function drainRequest(req) {
  if (req && typeof req.resume === 'function') req.resume()
}

export function requireJson(req) {
  const contentType = req.headers && req.headers['content-type']
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    drainRequest(req)
    throw new HttpError(415, 'content-type must be application/json')
  }
}

export function requireBinary(req) {
  const contentType = req.headers && req.headers['content-type']
  if (!contentType || !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)) {
    drainRequest(req)
    throw new HttpError(415, 'content-type must be application/octet-stream')
  }
}

export function requireMethod(req, res, methods) {
  if (methods.includes(req.method)) return true
  drainRequest(req)
  res.writeHead(405, { allow: methods.join(', '), 'content-length': 0 })
  res.end()
  return false
}
