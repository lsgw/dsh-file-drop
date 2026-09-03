// dsh-file-drop / locate engine — read a local directory's structure & samples.
import { join } from 'node:path'
import { lstat, opendir } from 'node:fs/promises'
import {
  DIRECTORY_MAX_DEPTH, DIRECTORY_MAX_ENTRIES,
  directoryContentDigest,
  normalizedDirectoryPath,
} from './directory.js'
import { sampleFingerprint } from './fingerprint.js'
import { runIsolatedTask } from './isolate.js'

const DIRECTORY_READ_TIMEOUT_MS = 5000

function beforeDeadline(promise, budget, onLate) {
  const remaining = budget.deadline - Date.now()
  if (remaining <= 0) {
    promise.then(value => { if (onLate) void onLate(value) }, () => {})
    return Promise.reject(new Error('directory fingerprint timed out'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('directory fingerprint timed out'))
    }, remaining)
    promise.then((value) => {
      if (settled) { if (onLate) void onLate(value); return }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

export async function readNodeDirectoryStructure(root, options = {}) {
  const budget = options.budget || { deadline: Date.now() + DIRECTORY_READ_TIMEOUT_MS }
  const entries = []
  let truncated = false
  const visit = async (directory, prefix, depth) => {
    if (depth >= DIRECTORY_MAX_DEPTH) { truncated = true; return }
    let handle
    try {
      handle = await beforeDeadline(opendir(directory), budget, lateHandle => lateHandle.close().catch(() => {}))
    } catch { truncated = true; return }
    let readTimedOut = false
    try {
      while (true) {
        let child
        try { child = await beforeDeadline(handle.read(), budget, () => handle.close().catch(() => {})) }
        catch { readTimedOut = Date.now() >= budget.deadline; truncated = true; break }
        if (!child) break
        if (entries.length >= DIRECTORY_MAX_ENTRIES) { truncated = true; break }
        const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`
        const absolutePath = join(directory, child.name)
        if (child.isSymbolicLink()) continue
        if (child.isDirectory()) {
          entries.push({ path: relativePath, kind: 'directory' })
          await visit(absolutePath, relativePath, depth + 1)
        } else if (child.isFile()) {
          try {
            const info = await beforeDeadline(lstat(absolutePath), budget)
            if (info.isSymbolicLink() || !info.isFile()) { truncated = true; continue }
            entries.push({ path: relativePath, kind: 'file', size: info.size })
          } catch { truncated = true }
        }
      }
    } finally {
      if (!readTimedOut) await handle.close().catch(() => {})
    }
  }
  await visit(root, '', 0)
  return { entries, truncated }
}

export async function nodeDirectoryStructureDigest(path, options = {}) {
  const budget = options.budget || { deadline: Date.now() + DIRECTORY_READ_TIMEOUT_MS }
  const remaining = budget.deadline - Date.now()
  return runIsolatedTask('directory-structure', { path, deadline: budget.deadline }, {
    timeoutMs: remaining,
    maxOutputBytes: 1024 * 1024,
  })
}

export async function nodeDirectoryContentDigestLocal(root, paths, options = {}) {
  const budget = options.budget || { deadline: Date.now() + DIRECTORY_READ_TIMEOUT_MS }
  const samples = []
  for (const path of paths) {
    const safePath = normalizedDirectoryPath(path)
    const absolutePath = join(root, ...safePath.split('/'))
    const info = await beforeDeadline(lstat(absolutePath), budget)
    if (info.isSymbolicLink() || !info.isFile()) continue
    const digest = await beforeDeadline(sampleFingerprint(absolutePath, info.size, info), budget)
    samples.push({ path, size: info.size, digest })
  }
  return directoryContentDigest(samples)
}

export async function nodeDirectoryContentDigest(root, paths, options = {}) {
  const budget = options.budget || { deadline: Date.now() + DIRECTORY_READ_TIMEOUT_MS }
  return runIsolatedTask('directory-content', { path: root, paths, deadline: budget.deadline }, {
    timeoutMs: budget.deadline - Date.now(),
    maxOutputBytes: 1024 * 1024,
  })
}
