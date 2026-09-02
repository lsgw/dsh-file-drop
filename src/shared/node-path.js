import { normalize, resolve, sep } from 'node:path'

// 使用 Node 原生路径规则；仅 Windows 需要大小写折叠。
export function pathKey(value) {
  if (typeof value !== 'string' || value === '') throw new TypeError('path is required')
  const normalized = normalize(resolve(value)).normalize('NFC')
  return sep === '\\' ? normalized.toUpperCase() : normalized
}
