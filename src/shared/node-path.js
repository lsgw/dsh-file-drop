import { realpathSync, statSync } from 'node:fs'
import { readdir as readdirAsync, realpath, stat } from 'node:fs/promises'
import { join, normalize, resolve } from 'node:path'

function lexicalPath(value) {
  if (typeof value !== 'string' || value === '') throw new TypeError('path is required')
  return normalize(resolve(value))
}

export function objectKey(canonical, info) {
  if (info && typeof info.dev === 'bigint' && info.dev !== 0n
    && typeof info.ino === 'bigint' && info.ino !== 0n) {
    return 'inode:' + info.dev + ':' + info.ino
  }
  return 'real:' + canonical
}

export function pathKey(value) {
  return lexicalPath(value)
}

export function physicalPathKeySync(value) {
  const lexical = lexicalPath(value)
  try {
    const canonical = normalize(resolve(realpathSync(value)))
    return objectKey(canonical, statSync(canonical, { bigint: true }))
  } catch {
    return 'lexical:' + lexical
  }
}

export async function physicalPathKey(value) {
  const lexical = lexicalPath(value)
  try {
    const canonical = normalize(resolve(await realpath(value)))
    return objectKey(canonical, await stat(canonical, { bigint: true }))
  } catch {
    return 'lexical:' + lexical
  }
}

// 清单采用跨宿主保守碰撞规则；物理路径身份不使用该键。
export function collisionKey(parts) {
  if (!Array.isArray(parts)) throw new TypeError('path components are required')
  return parts.map((part) => String(part).normalize('NFC').toUpperCase()).join('/')
}

function comparableName(value) {
  return String(value).normalize('NFC').toUpperCase()
}

export async function sameDirectoryEntry(parent, actualName, requestedName, deadline) {
  if (actualName === requestedName) return true
  if (comparableName(actualName) !== comparableName(requestedName)) return false
  const actualPath = join(parent, actualName)
  const requestedPath = join(parent, requestedName)
  const comparison = Promise.all([
    physicalPathKey(actualPath), physicalPathKey(requestedPath),
  ]).then(async ([actualKey, requestedKey]) => {
    if (actualKey !== requestedKey) return false
    try {
      const names = await readdirAsync(parent)
      return !names.includes(requestedName)
    } catch {
      return false
    }
  })
  if (!Number.isFinite(deadline)) return comparison
  const remaining = deadline - Date.now()
  if (remaining <= 0) return false
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining)
    comparison.then((result) => { clearTimeout(timer); resolve(result) }, () => { clearTimeout(timer); resolve(false) })
  })
}
