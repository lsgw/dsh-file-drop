// dsh-file-drop / locate engine — directory structure digest & content sampling.
import { createHash } from 'node:crypto'
import { sep } from 'node:path'

export const DIRECTORY_MAX_ENTRIES = 10000
export const DIRECTORY_MAX_DEPTH = 32
export const DIRECTORY_SAMPLE_FILES = 24

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function normalizedDirectoryPath(path) {
  const normalized = String(path)
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.length > DIRECTORY_MAX_DEPTH
    || parts.some(part => part === '' || part === '.' || part === '..'
      || (sep === '\\' && part.includes('\\')))) {
    throw new TypeError('invalid directory-relative path')
  }
  return normalized
}

export function canonicalDirectoryEntries(entries) {
  return entries.map(entry => ({
    path: normalizedDirectoryPath(entry.path),
    kind: entry.kind,
    ...(entry.kind === 'file' ? { size: entry.size ?? 0 } : {}),
  })).sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind))
}

export function directoryStructureDigest(structure) {
  const hash = createHash('sha256')
  hash.update(structure.truncated ? 'truncated\n' : 'complete\n')
  for (const entry of canonicalDirectoryEntries(structure.entries)) {
    hash.update(`${entry.kind}\0${entry.path}\0${entry.size ?? ''}\n`)
  }
  return hash.digest('hex')
}

export function selectDirectorySamplePaths(entries) {
  return canonicalDirectoryEntries(entries)
    .filter(entry => entry.kind === 'file')
    .map(entry => ({ path: entry.path, rank: createHash('sha256').update(entry.path).digest('hex') }))
    .sort((a, b) => compareText(a.rank, b.rank) || compareText(a.path, b.path))
    .slice(0, DIRECTORY_SAMPLE_FILES)
    .map(entry => entry.path)
}

export function directoryContentDigest(samples) {
  const hash = createHash('sha256')
  for (const sample of [...samples].sort((a, b) => compareText(a.path, b.path))) {
    hash.update(`${normalizedDirectoryPath(sample.path)}\0${sample.size}\0${sample.digest}\n`)
  }
  return hash.digest('hex')
}
