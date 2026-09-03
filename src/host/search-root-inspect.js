import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'

import { MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH } from '../shared/contract.js'
import { HttpError } from './manifest.js'

const MAX_ACTIVE_INSPECTIONS = 4
const MAX_QUEUED_INSPECTIONS = 64
const ROOT_INSPECTION_TIMEOUT_MS = 3000
let activeInspections = 0
const inspectionQueue = []

function inputPath(value) {
  if (typeof value !== 'string') throw new HttpError(400, '外部搜索根路径必须是字符串')
  if (value.trim() === '' || value.length > MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH
    || value.includes('\0') || !isAbsolute(value)) {
    throw new HttpError(400, '外部搜索根必须是有效的绝对目录路径')
  }
  return resolve(value)
}

export function directoryIdentity(info) {
  if (typeof info.dev === 'bigint' && info.dev !== 0n
    && typeof info.ino === 'bigint' && info.ino !== 0n) {
    return 'inode:' + String(info.dev) + ':' + String(info.ino)
  }
  return undefined
}

async function inspectDirectoryLocal(requested) {
  try {
    const initial = await lstat(requested)
    if (!initial.isDirectory() || initial.isSymbolicLink()) {
      throw new HttpError(400, '外部搜索根必须是实际目录')
    }
    const canonical = normalize(await realpath(requested))
    const canonicalInfo = await lstat(canonical)
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) {
      throw new HttpError(400, '外部搜索根必须是实际目录')
    }
    const handle = await opendir(canonical)
    await handle.close()
    const identity = directoryIdentity(await stat(canonical, { bigint: true }))
    if (!identity) throw new HttpError(409, '无法验证外部搜索根的物理身份')
    return { path: canonical, identity }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, '外部搜索根不存在或不可访问')
  }
}

function drainInspections() {
  while (activeInspections < MAX_ACTIVE_INSPECTIONS && inspectionQueue.length > 0) {
    const job = inspectionQueue.shift()
    if (job.settled) continue
    job.started = true
    activeInspections += 1
    Promise.resolve().then(job.start).then((value) => {
      activeInspections -= 1
      if (!job.settled) {
        job.settled = true
        clearTimeout(job.timer)
        job.resolve(value)
      }
      drainInspections()
    }, (error) => {
      activeInspections -= 1
      if (!job.settled) {
        job.settled = true
        clearTimeout(job.timer)
        job.reject(error)
      }
      drainInspections()
    })
  }
}

function scheduleInspection(start, timeoutMs = ROOT_INSPECTION_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new HttpError(503, '外部搜索根验证超时'))
  }
  if (activeInspections >= MAX_ACTIVE_INSPECTIONS
    && inspectionQueue.length >= MAX_QUEUED_INSPECTIONS) {
    return Promise.reject(new HttpError(429, '外部搜索根验证任务过多'))
  }
  return new Promise((resolve, reject) => {
    const job = { start, resolve, reject, settled: false, started: false, timer: undefined }
    job.timer = setTimeout(() => {
      if (job.settled) return
      job.settled = true
      if (!job.started) {
        const index = inspectionQueue.indexOf(job)
        if (index >= 0) inspectionQueue.splice(index, 1)
      }
      reject(new HttpError(503, '外部搜索根验证超时'))
    }, Math.min(timeoutMs, 30_000))
    inspectionQueue.push(job)
    drainInspections()
  })
}

export function inspectDirectory(value, timeoutMs) {
  let requested
  try { requested = inputPath(value) } catch (error) { return Promise.reject(error) }
  return scheduleInspection(() => inspectDirectoryLocal(requested), timeoutMs)
}

export function withInspectionTimeout(operation, timeoutMs) {
  return scheduleInspection(() => operation, timeoutMs)
}

export function inspectionCounts() {
  return { active: activeInspections, queued: inspectionQueue.length }
}
