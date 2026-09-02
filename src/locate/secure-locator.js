import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { LOCATE_PROTOCOL_VERSION as PROTOCOL_VERSION } from '../shared/contract.js'
import { locate } from './locator.js'
import { HttpError, resolveBaseDir, sessionCwd } from '../host/safety.js'
import { pathKey } from '../shared/node-path.js'

const CHALLENGE_TTL_MS = 2 * 60 * 1000
const MAX_CHALLENGES = 1024
const MAX_CHALLENGES_PER_SESSION = 32
const REPLAY_TTL_MS = 30 * 1000
const MAX_CHALLENGE_RECORD_BYTES = 512 * 1024
const MAX_SESSION_CHALLENGE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_CHALLENGE_BYTES = 32 * 1024 * 1024
const MAX_CONCURRENT_LOCATES = 8
const MAX_CONCURRENT_LOCATES_PER_SESSION = 2

function nextPhase(result) {
  if (!result || typeof result !== 'object') return undefined
  if (result.status === 'sample-required') return 'sample'
  if (result.status === 'full-required') return 'full'
  if (result.status === 'directory-structure-required') return 'directory-structure'
  if (result.status === 'directory-content-required') return 'directory-content'
  return undefined
}

function requestSessionKey(request) {
  if (!Object.hasOwn(request, 'sessionId')) return 'global'
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === ''
    || request.sessionId.length > 256 || request.sessionId.includes('\0')) {
    throw new HttpError(400, 'invalid sessionId')
  }
  return 'session:' + request.sessionId
}

function fileIdentity(file) {
  if (!file || typeof file !== 'object') return ''
  if (file.kind === 'directory') return JSON.stringify(['directory', file.name])
  return JSON.stringify(['file', file.name, file.size, file.lastModified === undefined ? null : file.lastModified])
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function directoryStructureIdentity(file) {
  if (!file || file.kind !== 'directory' || !Object.hasOwn(file, 'structure')) return undefined
  const structure = file.structure
  if (!structure || !Array.isArray(structure.entries)) return digestJson(null)
  return digestJson([
    structure.truncated === true,
    structure.entries.map((entry) => [
      entry && entry.path,
      entry && entry.kind,
      entry && entry.kind === 'file' ? entry.size : undefined,
    ]),
  ])
}

function storedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function workspaceKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  const path = resolve(value)
  return pathKey(path)
}

function trustedWorkspaceRoots(ctx, currentWorkspacePath, excludedPaths) {
  const excluded = new Set((Array.isArray(excludedPaths) ? excludedPaths : []).slice(0, 64).map(workspaceKey).filter(Boolean))
  const roots = []
  const seen = new Set()
  const add = (value) => {
    const key = workspaceKey(value)
    if (!key || seen.has(key) || excluded.has(key) || roots.length >= 64) return
    seen.add(key)
    roots.push(value)
  }
  add(currentWorkspacePath)
  try {
    const sessions = ctx.sessions && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
    for (const session of sessions) add(sessionCwd(session))
  } catch {}
  return roots
}

export function createSecureLocator(ctx, options = {}) {
  const ttlMs = options.ttlMs || CHALLENGE_TTL_MS
  const maxChallenges = options.maxChallenges || MAX_CHALLENGES
  const maxChallengesPerSession = options.maxChallengesPerSession || MAX_CHALLENGES_PER_SESSION
  const replayTtlMs = options.replayTtlMs || REPLAY_TTL_MS
  const maxRecordBytes = options.maxRecordBytes || MAX_CHALLENGE_RECORD_BYTES
  const maxSessionBytes = options.maxSessionBytes || MAX_SESSION_CHALLENGE_BYTES
  const maxTotalBytes = options.maxTotalBytes || MAX_TOTAL_CHALLENGE_BYTES
  const maxConcurrentLocates = options.maxConcurrentLocates || MAX_CONCURRENT_LOCATES
  const maxConcurrentLocatesPerSession = options.maxConcurrentLocatesPerSession || MAX_CONCURRENT_LOCATES_PER_SESSION
  const locateFn = options.locateFn || locate
  const resolveBaseDirFn = options.resolveBaseDirFn || resolveBaseDir
  const now = options.now || Date.now
  const tokenFactory = options.tokenFactory || randomUUID
  const challenges = new Map()
  const locateCounts = new Map()
  let totalBytes = 0
  let concurrentLocates = 0

  const runLocate = async (request, operation) => {
    const key = requestSessionKey(request)
    const sessionCount = locateCounts.get(key) || 0
    if (concurrentLocates >= maxConcurrentLocates || sessionCount >= maxConcurrentLocatesPerSession) {
      throw new HttpError(429, 'too many concurrent locate operations')
    }
    concurrentLocates += 1
    locateCounts.set(key, sessionCount + 1)
    try {
      return await operation()
    } finally {
      concurrentLocates -= 1
      const remaining = (locateCounts.get(key) || 1) - 1
      if (remaining > 0) locateCounts.set(key, remaining)
      else locateCounts.delete(key)
    }
  }

  const deleteChallenge = (token) => {
    const record = challenges.get(token)
    if (!record) return false
    challenges.delete(token)
    totalBytes -= record.bytes
    return true
  }

  const prune = (timestamp = now()) => {
    for (const [token, record] of challenges) {
      if (record.expiresAt <= timestamp) deleteChallenge(token)
    }
  }

  const activeCount = (sessionId, excludeToken) => {
    let count = 0
    for (const [token, record] of challenges) {
      if (token !== excludeToken && !record.completed && record.sessionId === sessionId) count += 1
    }
    return count
  }

  const sessionBytes = (sessionId) => {
    let bytes = 0
    for (const record of challenges.values()) {
      if (record.sessionId === sessionId) bytes += record.bytes
    }
    return bytes
  }

  const ensureCapacity = (sessionId, replaceToken, additionalBytes) => {
    prune()
    if (additionalBytes > maxRecordBytes) throw new HttpError(429, 'locate challenge record is too large')
    if (activeCount(sessionId, replaceToken) >= maxChallengesPerSession) {
      throw new HttpError(429, 'too many active locate challenges for this session')
    }
    const fits = () => challenges.size < maxChallenges
      && totalBytes + additionalBytes <= maxTotalBytes
      && sessionBytes(sessionId) + additionalBytes <= maxSessionBytes
    for (const [token, record] of challenges) {
      if (fits()) return false
      if (token !== replaceToken && record.completed && record.sessionId === sessionId) deleteChallenge(token)
    }
    for (const [token, record] of challenges) {
      if (fits()) return false
      if (token !== replaceToken && record.completed) deleteChallenge(token)
    }
    if (fits()) return false
    const replaced = replaceToken && challenges.get(replaceToken)
    const fitsAfterReplacement = replaced
      && challenges.size - 1 < maxChallenges
      && totalBytes - replaced.bytes + additionalBytes <= maxTotalBytes
      && sessionBytes(sessionId) - (replaced.sessionId === sessionId ? replaced.bytes : 0) + additionalBytes <= maxSessionBytes
    if (fitsAfterReplacement) return true
    throw new HttpError(429, 'locate challenge capacity exceeded')
  }

  const issue = (request, result, phase, replaceToken, workspaceScope) => {
    const key = requestSessionKey(request)
    const candidates = Array.isArray(result.candidates) ? [...result.candidates] : []
    const paths = Array.isArray(result.paths) ? [...result.paths] : undefined
    const structureIdentity = request.phase === 'directory-structure'
      ? directoryStructureIdentity(request.file)
      : undefined
    const recordBytes = storedBytes([
      phase,
      key,
      fileIdentity(request.file),
      structureIdentity,
      candidates,
      paths,
    ]) + 256
    const replaceWithoutReplay = ensureCapacity(key, replaceToken, recordBytes)
    let token
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = tokenFactory()
      if (typeof candidate === 'string' && candidate !== '' && candidate.length <= 256
        && !candidate.includes('\0') && !challenges.has(candidate)) {
        token = candidate
        break
      }
    }
    if (!token) throw new HttpError(503, 'unable to allocate locate challenge')
    if (replaceWithoutReplay) deleteChallenge(replaceToken)
    challenges.set(token, {
      phase,
      sessionId: key,
      fileIdentity: fileIdentity(request.file),
      directoryStructureIdentity: structureIdentity,
      candidates,
      paths,
      workspaceScope,
      expiresAt: now() + ttlMs,
      completed: false,
      bytes: recordBytes,
    })
    totalBytes += recordBytes
    return { ...result, challenge: token }
  }

  const continuationKey = (request) => digestJson([
    request.phase,
    requestSessionKey(request),
    fileIdentity(request.file),
    request.digest || null,
    directoryStructureIdentity(request.file) || null,
    Array.isArray(request.directorySamples)
      ? digestJson(request.directorySamples.map((sample) => [sample && sample.path, sample && sample.size, sample && sample.digest]))
      : null,
  ])

  const secureMetadata = async (request) => {
    let currentWorkspacePath
    const hasSession = Object.hasOwn(request, 'sessionId')
    if (hasSession) currentWorkspacePath = resolveBaseDirFn(ctx, request.sessionId, true)
    const key = requestSessionKey(request)
    prune()
    if (activeCount(key) >= maxChallengesPerSession) {
      throw new HttpError(429, 'too many active locate challenges for this session')
    }
    const workspacePaths = trustedWorkspaceRoots(ctx, currentWorkspacePath, request.excludedWorkspacePaths)
    const currentKey = workspaceKey(currentWorkspacePath)
    const trustedRequest = {
      ...request,
      workspacePaths,
      currentWorkspacePath: workspacePaths.some((path) => workspaceKey(path) === currentKey) ? currentWorkspacePath : undefined,
    }
    const result = await runLocate(request, () => locateFn(trustedRequest))
    const phase = nextPhase(result)
    return phase ? issue(request, result, phase, undefined, currentKey) : result
  }

  const retainReplay = (token, record, result) => {
    if (challenges.get(token) !== record) return
    const replayBytes = storedBytes(result) + 128
    const canRetain = record.bytes + replayBytes <= maxRecordBytes
      && totalBytes + replayBytes <= maxTotalBytes
      && sessionBytes(record.sessionId) + replayBytes <= maxSessionBytes
    if (!canRetain) { deleteChallenge(token); return }
    record.bytes += replayBytes
    totalBytes += replayBytes
    record.completed = true
    record.result = result
    record.expiresAt = now() + replayTtlMs
  }

  const secureContinuation = async (request) => {
    if (typeof request.challenge !== 'string' || request.challenge === '') {
      throw new HttpError(400, 'locate challenge is required')
    }
    prune()
    const record = challenges.get(request.challenge)
    if (!record || record.expiresAt <= now()) throw new HttpError(410, 'locate challenge expired')
    if (record.phase !== request.phase) throw new HttpError(409, 'locate phase mismatch')
    const sessionKey = requestSessionKey(request)
    if (record.sessionId !== sessionKey) throw new HttpError(403, 'locate session mismatch')
    if (record.fileIdentity !== fileIdentity(request.file)) throw new HttpError(409, 'dropped-file metadata changed')
    if (sessionKey !== 'global') {
      const currentWorkspacePath = resolveBaseDirFn(ctx, request.sessionId, true)
      if (workspaceKey(currentWorkspacePath) !== record.workspaceScope) {
        throw new HttpError(409, 'locate session workspace changed')
      }
    }
    if (record.directoryStructureIdentity !== undefined
      && record.directoryStructureIdentity !== directoryStructureIdentity(request.file)) {
      throw new HttpError(409, 'directory structure changed')
    }
    if (request.phase === 'directory-content') {
      const samplePaths = Array.isArray(request.directorySamples)
        ? request.directorySamples.map((sample) => sample && sample.path)
        : undefined
      if (!sameStringArray(samplePaths, record.paths)) throw new HttpError(409, 'directory sample set changed')
    }
    const key = continuationKey(request)
    if (record.completed) {
      if (record.requestKey !== key) throw new HttpError(409, 'locate challenge was already completed by another request')
      return record.result
    }
    if (record.inFlight) {
      if (record.requestKey !== key) throw new HttpError(409, 'locate challenge is already in use')
      return record.inFlight
    }

    record.requestKey = key
    const operation = (async () => {
      const trustedRequest = { ...request, candidates: record.candidates }
      const rawResult = await runLocate(request, () => locateFn(trustedRequest))
      if (rawResult && rawResult.status === 'error') {
        record.inFlight = undefined
        record.requestKey = undefined
        return rawResult
      }
      const phase = nextPhase(rawResult)
      const result = phase
        ? issue(request, rawResult, phase, request.challenge, record.workspaceScope)
        : rawResult
      record.inFlight = undefined
      retainReplay(request.challenge, record, result)
      return result
    })()
    record.inFlight = operation
    try {
      return await operation
    } catch (error) {
      record.inFlight = undefined
      record.requestKey = undefined
      throw error
    }
  }

  return async function secureLocate(request) {
    if (!request || request.protocolVersion !== PROTOCOL_VERSION) {
      throw new HttpError(426, 'locate protocol v2 is required; refresh the page')
    }
    if (request.phase === 'metadata') return secureMetadata(request)
    return secureContinuation(request)
  }
}
