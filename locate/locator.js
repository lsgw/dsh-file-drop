// dsh-file-drop / locate engine — multi-phase file/directory locator.
import { homedir } from 'node:os'
import { basename, join, normalize } from 'node:path'
import { lstat, opendir } from 'node:fs/promises'
import {
  DIRECTORY_MAX_ENTRIES,
  DIRECTORY_SAMPLE_FILES,
  directoryContentDigest,
  directoryStructureDigest,
  normalizedDirectoryPath,
  selectDirectorySamplePaths,
} from './directory.js'
import { nodeDirectoryContentDigest, nodeDirectoryStructureDigest } from './directory-node.js'
import { fullFingerprint, sampleFingerprint } from './fingerprint.js'
import { runIsolatedTask } from './isolate.js'
import { broadSearchRoots, indexedSearch, platformPathKey } from '../platform/index.js'
import { SAMPLE_BYTES, SMALL_FILE_BYTES } from './protocol.js'

const MAX_CANDIDATES = 100
const MAX_DISCOVERED_CANDIDATES = 512
const MAX_WORKSPACE_ROOTS = 64
const MAX_NAME_LENGTH = 1024
const MAX_PATH_LENGTH = 32768
const MAX_WALK_ENTRIES = 20000
const WALK_TIMEOUT_MS = 10000
const COMMAND_PHASE_TIMEOUT_MS = 3000
const WALK_DEPTH = 12
const MAX_FULL_CANDIDATES = 8
const MAX_DIRECTORY_DIGEST_CANDIDATES = 16

function candidatePaths(value) {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return undefined
  const paths = []
  for (const path of value) {
    if (typeof path !== 'string' || path === '' || path.length > MAX_PATH_LENGTH || path.includes('\0')) return undefined
    paths.push(path)
  }
  return [...new Set(paths)]
}

function validDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH || value.includes('\0')) return false
  try { normalizedDirectoryPath(value); return true } catch { return false }
}

function validDirectoryStructure(structure) {
  return structure && Array.isArray(structure.entries)
    && typeof structure.truncated === 'boolean'
    && structure.entries.length <= DIRECTORY_MAX_ENTRIES
    && structure.entries.every(entry => entry && validRelativePath(entry.path)
      && (entry.kind === 'file' || entry.kind === 'directory')
      && (entry.kind !== 'file' || (Number.isSafeInteger(entry.size) && entry.size >= 0)))
}

function validDirectorySamples(samples) {
  return Array.isArray(samples) && samples.length <= DIRECTORY_SAMPLE_FILES
    && samples.every(sample => sample && validRelativePath(sample.path)
      && Number.isSafeInteger(sample.size) && sample.size >= 0 && validDigest(sample.digest))
}

export async function runRecursiveCandidateScan(item, roots, budget) {
  const candidates = await recursiveCandidates(item, roots, budget)
  return { paths: candidates.map(candidate => candidate.path), visited: budget.visited }
}

async function isolatedRecursiveCandidates(item, roots, budget) {
  const remaining = budget.deadline - Date.now()
  if (remaining <= 0 || budget.visited >= MAX_WALK_ENTRIES) return []
  const result = await runIsolatedTask('recursive-candidates', {
    item,
    roots,
    visited: budget.visited,
    deadline: budget.deadline,
  }, { timeoutMs: remaining, maxOutputBytes: 4 * 1024 * 1024 })
  budget.visited = result.visited
  return validateCandidates(item, result.paths, budget)
}

async function directCandidate(root, name, kind, budget) {
  const path = join(root, name)
  try {
    const info = budget ? await beforeDeadline(lstat(path), budget) : await lstat(path)
    return (kind === 'file' ? info.isFile() : info.isDirectory()) ? path : undefined
  } catch { return undefined }
}

function deadlineError() {
  const error = new Error('filesystem operation timed out')
  error.status = 503
  return error
}

function beforeDeadline(promise, budget, onLate) {
  const remaining = budget.deadline - Date.now()
  if (remaining <= 0) {
    promise.then(value => { if (onLate) void onLate(value) }, () => {})
    return Promise.reject(deadlineError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(deadlineError())
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

async function walkByName(root, name, kind, budget, depth = WALK_DEPTH) {
  const found = []
  const visit = async (directory, remaining) => {
    if (remaining < 0 || found.length >= MAX_CANDIDATES
      || budget.visited >= MAX_WALK_ENTRIES || Date.now() >= budget.deadline) return
    let handle
    try {
      handle = await beforeDeadline(opendir(directory), budget, lateHandle => lateHandle.close().catch(() => {}))
    } catch { return }
    let readTimedOut = false
    try {
      while (true) {
        let entry
        try {
          entry = await beforeDeadline(handle.read(), budget, () => handle.close().catch(() => {}))
        } catch {
          readTimedOut = Date.now() >= budget.deadline
          break
        }
        if (!entry) break
        budget.visited += 1
        if (budget.visited > MAX_WALK_ENTRIES || Date.now() >= budget.deadline
          || found.length >= MAX_CANDIDATES) break
        const path = join(directory, entry.name)
        if (entry.name === name && (kind === 'file' ? entry.isFile() : entry.isDirectory())) found.push(path)
        if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, remaining - 1)
      }
    } finally {
      if (!readTimedOut) await handle.close().catch(() => {})
    }
  }
  await visit(root, depth)
  return found
}

async function validateCandidates(item, paths, budget) {
  const candidates = []
  for (const path of [...new Set(paths)].slice(0, MAX_DISCOVERED_CANDIDATES)) {
    if (budget && Date.now() >= budget.deadline) throw deadlineError()
    try {
      const info = budget ? await beforeDeadline(lstat(path), budget) : await lstat(path)
      const kindMatches = item.kind === 'file' ? info.isFile() && info.size === item.size : info.isDirectory()
      if (kindMatches && basename(path) === item.name) candidates.push({ path: normalize(path), mtimeMs: info.mtimeMs })
    } catch (error) {
      if (error?.status === 429 || error?.status === 503) throw error
      // Candidate disappeared between lookup and validation.
    }
  }
  return candidates.sort((a, b) => item.kind === 'file'
    ? Math.abs(a.mtimeMs - item.lastModified) - Math.abs(b.mtimeMs - item.lastModified) || a.path.localeCompare(b.path)
    : a.path.localeCompare(b.path)).slice(0, MAX_CANDIDATES)
}

async function directCandidates(item, roots, budget) {
  const paths = await Promise.all(roots.map(root => directCandidate(root, item.name, item.kind, budget)))
  return validateCandidates(item, paths.filter(path => path !== undefined), budget)
}

async function recursiveCandidates(item, roots, budget) {
  const paths = []
  for (const root of roots) {
    if (budget.visited >= MAX_WALK_ENTRIES || Date.now() >= budget.deadline) break
    paths.push(...await walkByName(root, item.name, item.kind, budget))
  }
  return validateCandidates(item, paths, budget)
}

async function metadataCandidates(item, request) {
  const candidateKey = (value) => {
    const path = normalize(value)
    return platformPathKey(path)
  }
  const excluded = new Set((Array.isArray(request.excludedCandidates) ? request.excludedCandidates : [])
    .slice(0, MAX_CANDIDATES)
    .filter(value => typeof value === 'string' && value !== '' && value.length <= MAX_PATH_LENGTH && !value.includes('\0'))
    .map(candidateKey))
  const withoutExcluded = (candidates) => candidates.filter(candidate => !excluded.has(candidateKey(candidate.path)))
  const current = typeof request.currentWorkspacePath === 'string'
    && request.currentWorkspacePath !== ''
    && request.currentWorkspacePath.length <= MAX_PATH_LENGTH
    && !request.currentWorkspacePath.includes('\0')
    ? request.currentWorkspacePath
    : undefined
  const workspaceRoots = [...new Set(Array.isArray(request.workspacePaths) ? request.workspacePaths : [])]
    .filter(root => typeof root === 'string' && root !== '' && root.length <= MAX_PATH_LENGTH)
    .slice(0, MAX_WORKSPACE_ROOTS)
  const otherWorkspaces = workspaceRoots.filter(root => root !== current)
  const commonRoots = [join(homedir(), 'Desktop'), join(homedir(), 'Documents'), join(homedir(), 'Downloads')]
  const rootGroups = [current === undefined ? [] : [current], otherWorkspaces, commonRoots]
  const paths = []
  const directBudget = { deadline: Date.now() + COMMAND_PHASE_TIMEOUT_MS }

  // 不在第一个同名候选处提前返回，否则错误副本会遮蔽其他工作区中的原文件。
  for (const roots of rootGroups) {
    paths.push(...(await directCandidates(item, roots, directBudget)).map(candidate => candidate.path))
  }
  let validationBudget = { deadline: Date.now() + WALK_TIMEOUT_MS }
  let knownCandidates = withoutExcluded(await validateCandidates(item, paths, validationBudget))
  if (knownCandidates.length > 0) return knownCandidates

  paths.push(...await indexedSearch(item.name, item.kind))
  validationBudget = { deadline: Date.now() + WALK_TIMEOUT_MS }
  knownCandidates = withoutExcluded(await validateCandidates(item, paths, validationBudget))
  if (knownCandidates.length > 0) return knownCandidates

  // 内容校验失败后的第二轮会排除旧候选，并在同一全局预算内继续递归搜索。
  const recursivePaths = []
  const budget = { visited: 0, deadline: Date.now() + WALK_TIMEOUT_MS }
  for (const roots of rootGroups) {
    if (recursivePaths.length >= MAX_DISCOVERED_CANDIDATES
      || budget.visited >= MAX_WALK_ENTRIES || Date.now() >= budget.deadline) break
    recursivePaths.push(...(await isolatedRecursiveCandidates(item, roots, budget)).map(candidate => candidate.path))
  }
  paths.push(...recursivePaths)
  knownCandidates = withoutExcluded(await validateCandidates(item, paths, budget))
  if (knownCandidates.length > 0) return knownCandidates
  return withoutExcluded(await isolatedRecursiveCandidates(item, await broadSearchRoots(), budget))
}

async function matchingFileDigest(candidates, digest, phase, file) {
  const budget = { deadline: Date.now() + WALK_TIMEOUT_MS }
  const matched = []
  for (const path of candidates) {
    if (Date.now() >= budget.deadline) throw deadlineError()
    try {
      const info = await beforeDeadline(lstat(path), budget)
      if (!info.isFile() || info.size !== file.size || basename(path) !== file.name) continue
      const fingerprint = phase === 'sample' ? sampleFingerprint(path, file.size) : fullFingerprint(path)
      const actual = await beforeDeadline(fingerprint, budget)
      if (actual === digest) matched.push(normalize(path))
    } catch (error) {
      if (error?.status === 429 || error?.status === 503) throw error
      // Unreadable candidates are not matches.
    }
  }
  return matched
}

async function locateDirectoryStructure(request) {
  const requestedCandidates = candidatePaths(request.candidates)
  if (request.file.kind !== 'directory' || !validDirectoryStructure(request.file.structure) || requestedCandidates === undefined) {
    return { status: 'error', message: 'directory structure phase requires valid candidates and structure' }
  }
  const budget = { deadline: Date.now() + WALK_TIMEOUT_MS }
  const candidates = (await validateCandidates(request.file, requestedCandidates, budget)).map(candidate => candidate.path)
  if (candidates.length === 0) return { status: 'not-found' }
  if (request.file.structure.truncated || candidates.length > MAX_DIRECTORY_DIGEST_CANDIDATES) {
    return { status: 'choose', candidates }
  }
  const expected = directoryStructureDigest(request.file.structure)
  const matched = []
  let samplePaths = selectDirectorySamplePaths(request.file.structure.entries)
  for (const path of candidates) {
    try {
      const actual = await nodeDirectoryStructureDigest(path, { budget })
      if (actual.digest === expected) { matched.push(path); samplePaths = actual.paths }
    } catch (error) {
      if (error?.status === 429 || error?.status === 503) throw error
      // Ignore unreadable directories.
    }
  }
  if (matched.length === 0) return { status: 'not-found' }
  if (matched.length === 1) return { status: 'found', path: matched[0] }
  if (samplePaths.length === 0) return { status: 'choose', candidates: matched }
  return { status: 'directory-content-required', candidates: matched, paths: samplePaths }
}

export async function locate(request) {
  if (!request || !request.file) return { status: 'error', message: 'invalid dropped entry metadata' }
  if ((request.file.kind !== 'file' && request.file.kind !== 'directory')
    || typeof request.file.name !== 'string'
    || request.file.name === ''
    || request.file.name.length > MAX_NAME_LENGTH
    || request.file.name.includes('\0')
    || request.file.name === '.'
    || request.file.name === '..'
    || /[\\/]/.test(request.file.name)
    || (request.file.kind === 'file' && (!Number.isSafeInteger(request.file.size) || request.file.size < 0))
    || (request.file.kind === 'file' && request.file.lastModified !== undefined && !Number.isFinite(request.file.lastModified))) {
    return { status: 'error', message: 'invalid dropped entry metadata' }
  }

  if (request.file.kind === 'directory') {
    if (request.phase === 'metadata') {
      const candidates = await metadataCandidates(request.file, request)
      if (candidates.length === 0) return { status: 'not-found' }
      return { status: 'directory-structure-required', candidates: candidates.map(candidate => candidate.path) }
    }
    if (request.phase === 'directory-structure') return locateDirectoryStructure(request)
    const requestedCandidates = candidatePaths(request.candidates)
    if (request.phase !== 'directory-content' || requestedCandidates === undefined || !validDirectorySamples(request.directorySamples)) {
      return { status: 'error', message: 'invalid directory phase' }
    }
    const budget = { deadline: Date.now() + WALK_TIMEOUT_MS }
    const candidates = (await validateCandidates(request.file, requestedCandidates, budget)).map(candidate => candidate.path)
    if (candidates.length === 0) return { status: 'not-found' }
    if (candidates.length > MAX_DIRECTORY_DIGEST_CANDIDATES) return { status: 'choose', candidates }
    const expected = directoryContentDigest(request.directorySamples)
    const paths = request.directorySamples.map(sample => sample.path)
    const matched = []
    for (const path of candidates) {
      try {
        if (await nodeDirectoryContentDigest(path, paths, { budget }) === expected) matched.push(path)
      } catch (error) {
        if (error?.status === 429 || error?.status === 503) throw error
        // Ignore unreadable directories.
      }
    }
    if (matched.length === 0) return { status: 'not-found' }
    if (matched.length === 1) return { status: 'found', path: matched[0] }
    return { status: 'choose', candidates: matched }
  }

  if (request.phase === 'metadata') {
    const candidates = await metadataCandidates(request.file, request)
    if (candidates.length === 0) return { status: 'not-found' }
    return { status: 'sample-required', candidates: candidates.map(candidate => candidate.path) }
  }
  const candidates = candidatePaths(request.candidates)
  if ((request.phase !== 'sample' && request.phase !== 'full') || !validDigest(request.digest) || candidates === undefined) {
    return { status: 'error', message: 'digest phase requires valid candidates and digest' }
  }
  if (request.phase === 'full' && request.file.size > SMALL_FILE_BYTES) {
    return { status: 'error', message: 'full digest exceeds safe size limit' }
  }
  if (request.phase === 'full' && candidates.length > MAX_FULL_CANDIDATES) {
    const valid = (await validateCandidates(request.file, candidates, { deadline: Date.now() + WALK_TIMEOUT_MS }))
      .map(candidate => candidate.path)
    return valid.length === 0 ? { status: 'not-found' } : { status: 'choose', candidates: valid }
  }
  const matched = await matchingFileDigest(candidates, request.digest, request.phase, request.file)
  if (matched.length === 0) return { status: 'not-found' }
  if (matched.length === 1) return { status: 'found', path: matched[0] }
  if (request.phase === 'sample' && request.file.size <= SAMPLE_BYTES * 3) return { status: 'choose', candidates: matched }
  if (request.phase === 'sample' && request.file.size <= SMALL_FILE_BYTES
    && matched.length <= MAX_FULL_CANDIDATES) return { status: 'full-required', candidates: matched }
  if (request.phase === 'sample' && request.file.size <= SMALL_FILE_BYTES) {
    return { status: 'choose', candidates: matched, fullDigestSkipped: true }
  }
  if (request.phase === 'sample') return { status: 'choose', candidates: matched }
  return { status: 'choose', candidates: matched }
}
