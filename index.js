// dsh-file-drop · Host half
// POST /api/dsh-file-drop：保存拖拽上传的普通文件（无桌面壳时的兜底路径）。
// - text：直接写 UTF-8 内容
// - binary：接收 base64，解码后写真实字节（node fs 原生能力，无需 subprocess）
// 落盘位置：会话工作区 .dsh-drops/，无会话时回退 $DSH_HOME/.dsh-drops
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { locate } from './locate/locator.js'
import { FILE_DROP_ROUTE } from './locate/protocol.js'

export const name = 'dsh-file-drop'
export const inject = ['webServer', 'sessions']

const MAX_BYTES = 25 * 1024 * 1024
const API_PATH = '/api/dsh-file-drop'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

// 同源校验：带 Origin 的请求必须与 Host 一致（防跨站探测）；无 Origin 的本地调用放行。
function fence(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (origin && host) {
    const allowed = new Set(['http://' + host, 'https://' + host])
    return allowed.has(origin)
  }
  return true
}

function sanitizeName(value) {
  let safe = basename(String(value || ''))
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  if (!safe) safe = 'file.bin'
  if (safe.length > 180) {
    safe = safe.slice(0, 180)
  }
  return safe
}

async function readJsonBody(req, maxBytes) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > maxBytes) {
      req.resume()
      throw new Error('payload too large')
    }
  }
  if (raw === '') return {}
  return JSON.parse(raw)
}

function settingsDir() {
  return (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh')
}

function readMode() {
  try {
    const j = JSON.parse(readFileSync(join(settingsDir(), 'dsh-file-drop.json'), 'utf8'))
    return j && j.mode === 'locate' ? 'locate' : 'upload'
  } catch { return 'upload' }
}

function writeMode(mode) {
  const dir = settingsDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dsh-file-drop.json'), JSON.stringify({ mode }), 'utf8')
}

export async function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: async (req, res) => {
      try {
        if (!fence(req)) {
          sendJson(res, 403, { error: '跨源请求被拒绝' })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-length': 0 })
          res.end()
          return
        }
        const payload = await readJsonBody(req, MAX_BYTES * 2 + 1024 * 1024)
        const { sessionId, name, size, kind } = payload
        if (!name || (kind !== 'text' && kind !== 'binary')) {
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        if (!Number.isFinite(Number(size)) || Number(size) > MAX_BYTES) {
          sendJson(res, 413, { error: 'file too large (25MB limit)' })
          return
        }

        // 落盘目录：优先当前会话工作区，回退 $DSH_HOME
        let dir
        const sessions = ctx.sessions
        if (sessions && sessionId) {
          const s = sessions.get(String(sessionId))
          if (s && s.meta && s.meta.cwd) dir = s.meta.cwd
        }
        if (!dir) {
          dir = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh')
        }
        const dropDir = join(dir, '.dsh-drops')
        mkdirSync(dropDir, { recursive: true })

        const safe = sanitizeName(name)
        const target = join(dropDir, safe)
        if (kind === 'text') {
          writeFileSync(target, String(payload.content == null ? '' : payload.content), 'utf8')
        } else {
          const buf = Buffer.from(String(payload.base64 || ''), 'base64')
          writeFileSync(target, buf)
        }
        sendJson(res, 200, { path: target })
      } catch (err) {
        sendJson(res, 500, { error: String(err && err.message || err) })
      }
    },
  }), 'dsh-file-drop: save route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FILE_DROP_ROUTE,
    handler: async (req, res) => {
      if (!fence(req)) {
        sendJson(res, 403, { status: 'error', message: '跨源请求被拒绝' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { status: 'error', message: 'method not allowed' })
        return
      }
      try {
        const request = await readJsonBody(req, 4 * 1024 * 1024)
        sendJson(res, 200, await locate(request))
      } catch (error) {
        sendJson(res, 400, { status: 'error', message: error && error.message ? error.message : String(error) })
      }
    },
  }), 'dsh-file-drop: locate route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/dir',
    handler: async (req, res) => {
      try {
        if (!fence(req)) {
          sendJson(res, 403, { error: '跨源请求被拒绝' })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'content-length': 0 })
          res.end()
          return
        }
        const payload = await readJsonBody(req, 100 * 1024 * 1024)
        const { sessionId, dirName, entries } = payload
        if (!dirName || !Array.isArray(entries)) {
          sendJson(res, 400, { error: 'bad request' })
          return
        }

        let dir
        const sessions = ctx.sessions
        if (sessions && sessionId) {
          const s = sessions.get(String(sessionId))
          if (s && s.meta && s.meta.cwd) dir = s.meta.cwd
        }
        if (!dir) {
          dir = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh')
        }
        const rootDir = join(join(dir, '.dsh-drops'), sanitizeName(dirName))
        // 全量覆盖：先清空旧目录，再写入，避免残留旧文件
        rmSync(rootDir, { recursive: true, force: true })
        mkdirSync(rootDir, { recursive: true })

        for (const entry of entries) {
          const segs = String(entry && entry.path || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter((s) => s && s !== '.' && s !== '..')
            .map(sanitizeName)
          if (segs.length === 0) continue
          const fileName = segs.pop()
          const subDir = segs.length ? join(rootDir, ...segs) : rootDir
          mkdirSync(subDir, { recursive: true })
          const target = join(subDir, fileName)
          if (entry.kind === 'text') {
            writeFileSync(target, String(entry.content == null ? '' : entry.content), 'utf8')
          } else if (entry.kind === 'binary') {
            writeFileSync(target, Buffer.from(String(entry.base64 || ''), 'base64'))
          }
        }
        sendJson(res, 200, { path: rootDir })
      } catch (err) {
        sendJson(res, 500, { error: String(err && err.message || err) })
      }
    },
  }), 'dsh-file-drop: dir route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/settings',
    handler: async (req, res) => {
      try {
        if (!fence(req)) {
          sendJson(res, 403, { error: '跨源请求被拒绝' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { mode: readMode() })
          return
        }
        if (req.method === 'POST') {
          const payload = await readJsonBody(req, 1024 * 1024)
          const mode = payload && payload.mode === 'locate' ? 'locate' : 'upload'
          writeMode(mode)
          sendJson(res, 200, { mode })
          return
        }
        res.writeHead(405, { allow: 'GET, POST', 'content-length': 0 })
        res.end()
      } catch (err) {
        sendJson(res, 500, { error: String(err && err.message || err) })
      }
    },
  }), 'dsh-file-drop: settings route')
}
