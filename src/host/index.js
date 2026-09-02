// dsh-file-drop / Host routes.
import { join, resolve } from 'node:path'
import { HttpError, clearDropRoot, dshHome, dropCleanupStatus, measureDropRoot, readJsonBody } from './safety.js'
import { requireBinary, requireJson, requireMethod, sameOriginRequest, sendError, sendJson, sendLocateError } from './http.js'
import { API_PATH } from '../shared/contract.js'
import { createSecureLocator } from '../locate/secure-locator.js'
import { FILE_DROP_ROUTE } from '../locate/protocol.js'
import { physicalPathKey } from '../shared/node-path.js'
import { createSettingsStore, quotaFromSettings } from './settings.js'
import {
  MAX_UPLOAD_CONTROL_BYTES,
  MAX_UPLOAD_MANIFEST_BYTES,
  createUploadManager,
} from './upload-manager.js'

export const name = 'dsh-file-drop'
export const inject = ['webServer', 'sessions']

async function canonicalPathKey(value) {
  return physicalPathKey(value)
}

export function createPathLock() {
  const locks = new Map()
  return async (key, operation) => {
    const canonicalKey = await canonicalPathKey(key)
    const previous = locks.get(canonicalKey) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    locks.set(canonicalKey, current)
    try { return await current } finally {
      if (locks.get(canonicalKey) === current) locks.delete(canonicalKey)
    }
  }
}

async function applyWithSettingsPath(ctx, settingsPath, options = {}) {
  const secureLocate = createSecureLocator(ctx)
  const withPathLock = createPathLock()
  const uploadBaseDir = resolve(options.uploadBaseDir || dshHome())
  const settingsStore = createSettingsStore(settingsPath)
  let settingsTail = Promise.resolve()
  const enqueueSettings = (operation) => {
    const current = settingsTail.catch(() => {}).then(operation)
    settingsTail = current
    return current
  }
  const uploadManager = createUploadManager(ctx, {
    ...(options.uploadManager || {}),
    withPathLock,
    canonicalPathKey,
    uploadBaseDir,
    getSettings: () => {
      const settings = settingsStore.read()
      return { mode: settings.mode, ...quotaFromSettings(settings) }
    },
  })

  const registerUploadControlRoute = (suffix, maxBytes, action, label) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: API_PATH + '/upload/' + suffix,
      handler: async (req, res) => {
        try {
          if (!sameOriginRequest(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
          if (!requireMethod(req, res, ['POST'])) return
          requireJson(req)
          const payload = await readJsonBody(req, maxBytes)
          sendJson(res, 200, await action(payload))
        } catch (error) {
          sendError(res, error)
        }
      },
    }), 'dsh-file-drop: ' + label + ' route')
  }

  registerUploadControlRoute('init', MAX_UPLOAD_MANIFEST_BYTES, uploadManager.init, 'upload init')
  registerUploadControlRoute('finish', MAX_UPLOAD_CONTROL_BYTES, uploadManager.finish, 'upload finish')
  registerUploadControlRoute('cancel', MAX_UPLOAD_CONTROL_BYTES, uploadManager.cancel, 'upload cancel')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/upload/chunk',
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { if (typeof req.resume === 'function') req.resume(); sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireBinary(req)
        sendJson(res, 200, await uploadManager.chunk(req))
      } catch (error) {
        if (typeof req.resume === 'function') req.resume()
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: upload chunk route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FILE_DROP_ROUTE,
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { sendJson(res, 403, { status: 'error', message: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const request = await readJsonBody(req, 4 * 1024 * 1024)
        sendJson(res, 200, await secureLocate(request))
      } catch (error) {
        sendLocateError(res, error)
      }
    },
  }), 'dsh-file-drop: locate route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/settings',
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['GET', 'POST'])) return
        if (req.method === 'GET') {
          await settingsTail.catch(() => {})
          sendJson(res, 200, settingsStore.read())
          return
        }
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        const settings = await enqueueSettings(async () => {
          const next = settingsStore.update(payload)
          if (next.mode === 'locate') {
            try { await uploadManager.cancelAll() } catch (error) {
              ctx.logger.warn('dsh-file-drop staging cleanup will retry during size checks: %o', error)
            }
          }
          return next
        })
        sendJson(res, 200, settings)
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/clear',
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        const keys = Object.keys(payload)
        if (keys.length !== 1 || keys[0] !== 'global' || payload.global !== true) {
          throw new HttpError(400, 'global clear scope is required')
        }
        const path = await withPathLock(uploadBaseDir, async () => {
          await uploadManager.forgetBase()
          return clearDropRoot(uploadBaseDir, {
            onCleanupError: (error) => ctx.logger.warn('dsh-file-drop cleanup failed for %s: %o', uploadBaseDir, error),
          })
        })
        sendJson(res, 200, { path, removed: true, ...dropCleanupStatus(uploadBaseDir) })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: clear route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH + '/size',
    handler: async (req, res) => {
      try {
        if (!sameOriginRequest(req)) { sendJson(res, 403, { error: '跨源请求被拒绝' }); return }
        if (!requireMethod(req, res, ['POST'])) return
        requireJson(req)
        const payload = await readJsonBody(req, 1024 * 1024)
        if (Object.keys(payload).length !== 0) throw new HttpError(400, 'size body must be empty')
        await uploadManager.cleanupBase()
        const result = await withPathLock(uploadBaseDir, () => measureDropRoot(uploadBaseDir))
        sendJson(res, 200, { ...result, ...dropCleanupStatus(uploadBaseDir) })
      } catch (error) {
        sendError(res, error)
      }
    },
  }), 'dsh-file-drop: size route')
}

export function apply(ctx) {
  return applyWithSettingsPath(ctx, join(dshHome(), 'dsh-file-drop.json'))
}

export function applyForTest(ctx, settingsPath, options) {
  return applyWithSettingsPath(ctx, settingsPath, options)
}
