import { createHash, randomUUID } from 'node:crypto'
import { LOCATE_PROTOCOL_VERSION as PROTOCOL_VERSION, MAX_EXTERNAL_SEARCH_ROOTS } from '../shared/contract.js'
import { locate } from './locator.js'
import { HttpError, resolveBaseDir, sessionCwd } from '../host/safety.js'
import { physicalPathKey } from '../shared/node-path.js'

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

function excludedPathList(value) {
  const paths = []
  let bytes = 0
  for (const path of (Array.isArray(value) ? value : [])) {
    if (typeof path !== 'string' || path === '' || path.length > 32768 || path.includes('\0')) continue
    const pathBytes = Buffer.byteLength(path, 'utf8')
    if (paths.length >= 64 || bytes + pathBytes > 64 * 1024) break
    paths.push(path)
    bytes += pathBytes
  }
  return paths
}

async function workspaceKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  return physicalPathKey(value)
}

function compareScope(left, right) {
  const a = JSON.stringify(left)
  const b = JSON.stringify(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function validExternalState(value) {
  return value && Number.isSafeInteger(value.epoch) && value.epoch >= 0
    && Array.isArray(value.roots)
}

async function trustedWorkspaceRoots(ctx, currentWorkspacePath, excludedPaths, getExternalSearchRoots, includeSessionRoots) {
  const excluded = new Set()
  for (const value of excludedPathList(excludedPaths)) {
    const key = await workspaceKey(value)
    if (key) excluded.add(key)
  }
  const roots = []
  const seen = new Set()
  const scopeEntries = []
  const add = async (value, descriptor) => {
    if (roots.length >= 64) return
    const key = await workspaceKey(value)
    if (!key || seen.has(key) || excluded.has(key)) return
    seen.add(key)
    roots.push(value)
    scopeEntries.push([...descriptor, key])
  }
  await add(currentWorkspacePath, ['workspace'])

  let externalState = { epoch: 0, roots: [] }
  if (getExternalSearchRoots) {
    try {
      externalState = await getExternalSearchRoots() || externalState
      if (!validExternalState(externalState)) externalState = { epoch: 'unavailable', roots: [] }
    } catch {
      externalState = { epoch: 'unavailable', roots: [] }
    }
    const externalRoots = externalState.roots.slice(0, MAX_EXTERNAL_SEARCH_ROOTS)
    for (const root of externalRoots) {
      if (!root || typeof root.path !== 'string' || typeof root.id !== 'string'
        || typeof root.generation !== 'string' || typeof root.identity !== 'string') continue
      await add(root.path, ['external', root.id, root.generation, root.identity])
    }
  }

  if (includeSessionRoots) {
    try {
      const sessions = ctx.sessions && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
      for (const session of sessions) {
        if (roots.length >= 64) break
        await add(sessionCwd(session), ['workspace'])
      }
    } catch {}
  }
  scopeEntries.sort(compareScope)
  const currentKey = await workspaceKey(currentWorkspacePath)
  return {
    paths: roots,
    currentTrusted: Boolean(currentKey && seen.has(currentKey) && !excluded.has(currentKey)),
    scope: digestJson([externalState.epoch, scopeEntries]),
  }
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
  const getExternalSearchRoots = options.getExternalSearchRoots
  const resolveBaseDirFn = options.resolveBaseDirFn || resolveBaseDir
  const now = options.now || Date.now
  const tokenFactory = options.tokenFactory || randomUUID
  const challenges = new Map()
  const readTrustedRoots = (currentWorkspacePath, excludedPaths, includeSessionRoots) =>
    trustedWorkspaceRoots(ctx, currentWorkspacePath, excludedPaths, getExternalSearchRoots, includeSessionRoots)
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

  const issue = (request, result, phase, replaceToken, workspaceScope, rootScope, excludedWorkspacePaths) => {
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
      rootScope,
      excludedWorkspacePaths,
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
      rootScope,
      excludedWorkspacePaths: excludedPathList(excludedWorkspacePaths),
      expiresAt: now() + ttlMs,
      completed: false,
      bytes: recordBytes,
    })
    totalBytes += recordBytes
    return { ...result, challenge: token }
  }

  const continuationKey = (request, rootScope) => digestJson([
    request.phase,
    requestSessionKey(request),
    fileIdentity(request.file),
    request.digest || null,
    rootScope,
    directoryStructureIdentity(request.file) || null,
    Array.isArray(request.directorySamples)
      ? digestJson(request.directorySamples.map((sample) => [sample && sample.path, sample && sample.size, sample && sample.digest]))
      : null,
  ])

  const secureMetadata = async (request) => {
    if (Object.hasOwn(request, 'excludedWorkspacePaths') || Object.hasOwn(request, 'excludedCandidates')) {
      throw new HttpError(400, 'raw locate path exclusions are not accepted')
    }
    if (Object.hasOwn(request, 'excludeCurrentWorkspace') && request.excludeCurrentWorkspace !== true) {
      throw new HttpError(400, 'invalid current-workspace exclusion')
    }
    const hasSession = Object.hasOwn(request, 'sessionId')
    const currentWorkspacePath = hasSession ? await resolveBaseDirFn(ctx, request.sessionId, true) : undefined
    const excludeCurrent = request.excludeCurrentWorkspace === true && currentWorkspacePath !== undefined
    const key = requestSessionKey(request)
    prune()
    let retry
    if (Object.hasOwn(request, 'retryChallenge')) {
      if (typeof request.retryChallenge !== 'string' || request.retryChallenge === '') {
        throw new HttpError(400, 'invalid locate retry challenge')
      }
      retry = challenges.get(request.retryChallenge)
      if (!retry || retry.expiresAt <= now()) throw new HttpError(410, 'locate retry challenge expired')
      if (retry.sessionId !== key) throw new HttpError(403, 'locate retry session mismatch')
      if (retry.fileIdentity !== fileIdentity(request.file)) throw new HttpError(409, 'locate retry metadata changed')
      if (!retry.completed || retry.result?.status !== 'not-found'
        || retry.excludedWorkspacePaths.length !== 0) {
        throw new HttpError(409, 'locate retry challenge is not eligible')
      }
    }
    if (excludeCurrent && !retry) throw new HttpError(400, 'current workspace exclusion requires a retry challenge')
    const baseline = retry ? await readTrustedRoots(currentWorkspacePath, [], hasSession) : undefined
    if (retry) {
      if (retry.workspaceScope !== await workspaceKey(currentWorkspacePath)
        || retry.rootScope !== baseline.scope) {
        throw new HttpError(409, 'locate retry search roots changed')
      }
    }
    if (activeCount(key) >= maxChallengesPerSession) {
      throw new HttpError(429, 'too many active locate challenges for this session')
    }
    const excludedPaths = excludeCurrent ? [currentWorkspacePath] : []
    const excludedCandidates = retry ? [...retry.candidates] : []
    const trusted = excludeCurrent
      ? await readTrustedRoots(currentWorkspacePath, excludedPaths, hasSession)
      : baseline || await readTrustedRoots(currentWorkspacePath, excludedPaths, hasSession)
    const trustedRequest = {
      phase: 'metadata',
      file: request.file,
      workspacePaths: trusted.paths,
      currentWorkspacePath: trusted.currentTrusted ? currentWorkspacePath : undefined,
      excludedCandidates,
    }
    const result = await runLocate(request, () => locateFn(trustedRequest))
    const afterWorkspacePath = hasSession ? await resolveBaseDirFn(ctx, request.sessionId, true) : undefined
    const after = await readTrustedRoots(afterWorkspacePath, excludedPaths, hasSession)
    if (after.scope !== trusted.scope) throw new HttpError(409, 'locate search roots changed')
    const afterKey = await workspaceKey(afterWorkspacePath)
    const phase = nextPhase(result)
    return phase ? issue(request, result, phase, undefined, afterKey, after.scope, excludedPaths) : result
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
    const hasSession = sessionKey !== 'global'
    const currentWorkspacePath = hasSession
      ? await resolveBaseDirFn(ctx, request.sessionId, true) : undefined
    if (hasSession && await workspaceKey(currentWorkspacePath) !== record.workspaceScope) {
      throw new HttpError(409, 'locate session workspace changed')
    }
    const trusted = await readTrustedRoots(currentWorkspacePath, record.excludedWorkspacePaths, hasSession)
    if (trusted.scope !== record.rootScope) throw new HttpError(409, 'locate search roots changed')
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
    const key = continuationKey(request, record.rootScope)
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
      const trustedRequest = {
        ...request,
        candidates: record.candidates,
        workspacePaths: trusted.paths,
        currentWorkspacePath: trusted.currentTrusted ? currentWorkspacePath : undefined,
      }
      const rawResult = await runLocate(request, () => locateFn(trustedRequest))
      const afterWorkspacePath = hasSession
        ? await resolveBaseDirFn(ctx, request.sessionId, true) : undefined
      if (hasSession && await workspaceKey(afterWorkspacePath) !== record.workspaceScope) {
        throw new HttpError(409, 'locate session workspace changed')
      }
      const after = await readTrustedRoots(afterWorkspacePath, record.excludedWorkspacePaths, hasSession)
      if (after.scope !== record.rootScope) throw new HttpError(409, 'locate search roots changed')
      if (rawResult && rawResult.status === 'error') {
        record.inFlight = undefined
        record.requestKey = undefined
        return rawResult
      }
      const phase = nextPhase(rawResult)
      const result = phase
        ? issue(request, rawResult, phase, request.challenge, record.workspaceScope, after.scope, record.excludedWorkspacePaths)
        : rawResult?.status === 'not-found'
          ? { ...rawResult, retryChallenge: request.challenge }
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
    return request.phase === 'metadata' ? secureMetadata(request) : secureContinuation(request)
  }
}
