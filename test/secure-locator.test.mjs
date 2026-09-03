import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HttpError } from '../src/host/safety.js'
import { createSecureLocator } from '../src/locate/secure-locator.js'
import { sampleFingerprint } from '../src/locate/fingerprint.js'

async function rejectsStatus(promise, status) {
  await assert.rejects(promise, (error) => error instanceof HttpError && error.status === status)
}

function harness(options = {}) {
  const calls = []
  let token = 0
  const locateFn = async (request) => {
    calls.push(structuredClone(request))
    if (request.file.kind === 'directory') {
      if (request.phase === 'metadata') return { status: 'directory-structure-required', candidates: ['C:/trusted/dir'] }
      if (request.phase === 'directory-structure') return { status: 'directory-content-required', candidates: ['C:/trusted/dir'], paths: ['a.txt'] }
      if (request.phase === 'directory-content') return { status: 'found', path: 'C:/trusted/dir' }
    }
    if (request.phase === 'metadata') return { status: 'sample-required', candidates: ['C:/trusted/file.txt'] }
    if (request.phase === 'sample') return { status: 'full-required', candidates: ['C:/trusted/file.txt'] }
    if (request.phase === 'full') return { status: 'found', path: 'C:/trusted/file.txt' }
    return { status: 'error' }
  }
  const secure = createSecureLocator(options.ctx || {}, {
    locateFn,
    resolveBaseDirFn: (_ctx, sessionId) => sessionId === 'session-1' ? 'C:/trusted' : (() => { throw new HttpError(404, 'session not found') })(),
    tokenFactory: () => 'token-' + (++token),
    ...options,
  })
  return { secure, calls }
}

const file = { kind: 'file', name: 'file.txt', size: 1024, lastModified: 7 }



test('secure locator integrates with real locator and current Session header', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-secure-real-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'secure-real-unique.txt')
  await writeFile(path, 'secure-real-content')
  const info = await stat(path)
  const ctx = {
    sessions: {
      get: (id) => id === 'session-real' ? { header: { cwd: root } } : undefined,
      list: () => [{ header: { cwd: root } }],
    },
  }
  let token = 0
  const secure = createSecureLocator(ctx, { tokenFactory: () => 'real-token-' + (++token) })
  const file = { kind: 'file', name: 'secure-real-unique.txt', size: info.size, lastModified: info.mtimeMs }
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-real', file })
  assert.equal(metadata.status, 'sample-required')
  assert.ok(metadata.candidates.includes(path))
  const found = await secure({
    protocolVersion: 2,
    phase: 'sample',
    sessionId: 'session-real',
    file,
    digest: await sampleFingerprint(path, info.size),
    challenge: metadata.challenge,
  })
  assert.equal(found.status, 'found')
  assert.equal(found.path, path)
})

test('v2 metadata replaces client roots and issues one-time challenges', async () => {
  const { secure, calls } = harness()
  const metadata = await secure({
    protocolVersion: 2,
    phase: 'metadata',
    sessionId: 'session-1',
    file,
    currentWorkspacePath: 'D:/attacker',
    workspacePaths: ['D:/attacker'],
  })
  assert.equal(metadata.challenge, 'token-1')
  assert.deepEqual(calls[0].workspacePaths, ['C:/trusted'])
  assert.equal(calls[0].currentWorkspacePath, 'C:/trusted')

  const sampled = await secure({
    protocolVersion: 2,
    phase: 'sample',
    sessionId: 'session-1',
    file,
    candidates: ['D:/attacker/file.txt'],
    digest: '0'.repeat(64),
    challenge: metadata.challenge,
  })
  assert.equal(sampled.challenge, 'token-2')
  assert.deepEqual(calls[1].candidates, ['C:/trusted/file.txt'])
  const replayed = await secure({
    protocolVersion: 2,
    phase: 'sample',
    sessionId: 'session-1',
    file,
    candidates: [],
    digest: '0'.repeat(64),
    challenge: metadata.challenge,
  })
  assert.deepEqual(replayed, sampled)

  const found = await secure({
    protocolVersion: 2,
    phase: 'full',
    sessionId: 'session-1',
    file,
    candidates: ['D:/attacker/file.txt'],
    digest: '1'.repeat(64),
    challenge: sampled.challenge,
  })
  assert.deepEqual(found, { status: 'found', path: 'C:/trusted/file.txt' })
  assert.deepEqual(calls[2].candidates, ['C:/trusted/file.txt'])
})



test('v2 retry can exclude current root while retaining other trusted live roots', async () => {
  const ctx = {
    sessions: {
      list: () => [
        { header: { cwd: 'C:/trusted' } },
        { header: { cwd: 'D:/other-workspace' } },
      ],
    },
  }
  const calls = []
  const locateFn = async (request) => {
    calls.push(structuredClone(request))
    if (calls.length === 1) return { status: 'sample-required', candidates: ['C:/trusted/file.txt'] }
    return { status: 'not-found' }
  }
  const { secure } = harness({ ctx, locateFn })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  const sampled = await secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  })
  await secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludeCurrentWorkspace: true, retryChallenge: sampled.retryChallenge,
  })
  assert.deepEqual(calls[2].workspacePaths, ['D:/other-workspace'])
  assert.equal(calls[2].currentWorkspacePath, undefined)
})

test('metadata rejects raw client path exclusions', async () => {
  const { secure, calls } = harness()
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludedWorkspacePaths: ['\\\\server\\share'],
  }), 400)
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludedCandidates: ['C:/outside/file.txt'],
  }), 400)
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludeCurrentWorkspace: true,
  }), 400)
  assert.equal(calls.length, 0)
})

test('retry metadata exclusions come only from a completed server challenge', async () => {
  const calls = []
  const locateFn = async (request) => {
    calls.push(structuredClone(request))
    if (request.phase === 'metadata' && calls.length === 1) {
      return { status: 'sample-required', candidates: ['C:/trusted/wrong.txt'] }
    }
    return { status: 'not-found' }
  }
  const { secure } = harness({ locateFn })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  const sampled = await secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  })
  assert.equal(sampled.status, 'not-found')
  assert.equal(sampled.retryChallenge, metadata.challenge)
  await secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludeCurrentWorkspace: true, retryChallenge: sampled.retryChallenge,
  })
  assert.deepEqual(calls[2].excludedCandidates, ['C:/trusted/wrong.txt'])
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    retryChallenge: 'missing-token',
  }), 410)
})

test('retry challenge is invalidated when an external root is revoked', async () => {
  let external = {
    epoch: 1,
    roots: [{
      id: '11111111-1111-4111-8111-111111111111',
      generation: '22222222-2222-4222-8222-222222222222',
      identity: 'inode:1:2',
      path: 'D:/external',
    }],
  }
  let calls = 0
  const locateFn = async () => {
    calls += 1
    return calls === 1
      ? { status: 'sample-required', candidates: ['D:/external/file.txt'] }
      : { status: 'not-found' }
  }
  const { secure } = harness({ locateFn, getExternalSearchRoots: async () => external })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  const sampled = await secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  })
  external = { epoch: 2, roots: [] }
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file,
    excludeCurrentWorkspace: true, retryChallenge: sampled.retryChallenge,
  }), 409)
  assert.equal(calls, 2)
})

test('challenge binds phase, session and immutable metadata', async () => {
  const phaseHarness = harness()
  const first = await phaseHarness.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await rejectsStatus(phaseHarness.secure({
    protocolVersion: 2, phase: 'full', sessionId: 'session-1', file, challenge: first.challenge,
  }), 409)
  assert.equal((await phaseHarness.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, digest: '0'.repeat(64), challenge: first.challenge,
  })).status, 'full-required')

  const sessionHarness = harness()
  const second = await sessionHarness.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await rejectsStatus(sessionHarness.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-2', file, challenge: second.challenge,
  }), 403)
  assert.equal((await sessionHarness.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, digest: '0'.repeat(64), challenge: second.challenge,
  })).status, 'full-required')

  const metadataHarness = harness()
  const third = await metadataHarness.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await rejectsStatus(metadataHarness.secure({
    protocolVersion: 2,
    phase: 'sample',
    sessionId: 'session-1',
    file: { ...file, size: file.size + 1 },
    challenge: third.challenge,
  }), 409)
  assert.equal((await metadataHarness.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, digest: '0'.repeat(64), challenge: third.challenge,
  })).status, 'full-required')
})



test('global challenges reject explicit empty session values', async () => {
  const { secure } = harness()
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', file })
  await rejectsStatus(secure({
    protocolVersion: 2,
    phase: 'sample',
    sessionId: null,
    file,
    digest: '0'.repeat(64),
    challenge: metadata.challenge,
  }), 400)
  assert.equal((await secure({
    protocolVersion: 2,
    phase: 'sample',
    file,
    digest: '0'.repeat(64),
    challenge: metadata.challenge,
  })).status, 'full-required')
})

test('directory challenge binds the server-issued sample path set', async () => {
  const { secure, calls } = harness()
  const directory = { kind: 'directory', name: 'dir' }
  const structure = { entries: [] }
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file: directory })
  const structured = await secure({
    protocolVersion: 2,
    phase: 'directory-structure',
    sessionId: 'session-1',
    file: { ...directory, structure },
    candidates: [],
    challenge: metadata.challenge,
  })
  assert.equal(structured.challenge, 'token-2')
  assert.deepEqual(calls[1].candidates, ['C:/trusted/dir'])

  await rejectsStatus(secure({
    protocolVersion: 2,
    phase: 'directory-content',
    sessionId: 'session-1',
    file: { ...directory, structure },
    candidates: [],
    directorySamples: [{ path: 'other.txt', size: 0, digest: '0'.repeat(64) }],
    challenge: structured.challenge,
  }), 409)
  await rejectsStatus(secure({
    protocolVersion: 2,
    phase: 'directory-content',
    sessionId: 'session-1',
    file: { ...directory, structure: { entries: [{ path: 'changed' }] } },
    directorySamples: [{ path: 'a.txt', size: 1, digest: '0'.repeat(64) }],
    challenge: structured.challenge,
  }), 409)
  const found = await secure({
    protocolVersion: 2,
    phase: 'directory-content',
    sessionId: 'session-1',
    file: { ...directory, structure },
    directorySamples: [{ path: 'a.txt', size: 1, digest: '0'.repeat(64) }],
    challenge: structured.challenge,
  })
  assert.equal(found.status, 'found')
})







test('metadata challenges ignore premature directory structure fields', async () => {
  const { secure } = harness()
  const directory = { kind: 'directory', name: 'dir' }
  const metadata = await secure({
    protocolVersion: 2,
    phase: 'metadata',
    sessionId: 'session-1',
    file: { ...directory, structure: { entries: [{ path: 'attacker' }] } },
  })
  const structured = await secure({
    protocolVersion: 2,
    phase: 'directory-structure',
    sessionId: 'session-1',
    file: { ...directory, structure: { entries: [], truncated: false } },
    challenge: metadata.challenge,
  })
  assert.equal(structured.status, 'directory-content-required')
})

test('large directory structures are represented by fixed-size challenge digests', async () => {
  const { secure } = harness()
  const directory = { kind: 'directory', name: 'large-dir' }
  const structure = { entries: [], padding: 'x'.repeat(3 * 1024 * 1024) }
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file: directory })
  const structured = await secure({
    protocolVersion: 2,
    phase: 'directory-structure',
    sessionId: 'session-1',
    file: { ...directory, structure },
    challenge: metadata.challenge,
  })
  assert.equal(typeof structured.challenge, 'string')
  assert.equal((await secure({
    protocolVersion: 2,
    phase: 'directory-content',
    sessionId: 'session-1',
    file: { ...directory, structure: { ...structure, padding: structure.padding + 'y' } },
    directorySamples: [{ path: 'a.txt', size: 1, digest: '0'.repeat(64) }],
    challenge: structured.challenge,
  })).status, 'found')
})



test('directory challenges reject semantic structure changes but remain retryable', async () => {
  const { secure } = harness()
  const directory = { kind: 'directory', name: 'dir' }
  const structure = { entries: [{ path: 'a.txt', kind: 'file', size: 1 }], truncated: false }
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file: directory })
  const structured = await secure({
    protocolVersion: 2, phase: 'directory-structure', sessionId: 'session-1',
    file: { ...directory, structure }, challenge: metadata.challenge,
  })
  const request = {
    protocolVersion: 2, phase: 'directory-content', sessionId: 'session-1',
    directorySamples: [{ path: 'a.txt', size: 1, digest: '0'.repeat(64) }],
    challenge: structured.challenge,
  }
  await rejectsStatus(secure({
    ...request,
    file: { ...directory, structure: { ...structure, entries: [{ path: 'a.txt', kind: 'file', size: 2 }] } },
  }), 409)
  assert.equal((await secure({ ...request, file: { ...directory, structure } })).status, 'found')
})

test('challenge byte budgets reject oversized retained candidate sets', async () => {
  const locateFn = async () => ({ status: 'sample-required', candidates: ['C:/' + 'x'.repeat(2048)] })
  const { secure } = harness({ locateFn, maxRecordBytes: 512 })
  await rejectsStatus(secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file }), 429)
})

test('challenge quotas reject new metadata without evicting active work', async () => {
  const perSession = harness({ maxChallengesPerSession: 1 })
  const first = await perSession.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await rejectsStatus(perSession.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file }), 429)
  assert.equal((await perSession.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, digest: '0'.repeat(64), challenge: first.challenge,
  })).status, 'full-required')

  const global = harness({ maxChallenges: 1, maxChallengesPerSession: 10 })
  const globalFirst = await global.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await rejectsStatus(global.secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file }), 429)
  assert.equal((await global.secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, digest: '0'.repeat(64), challenge: globalFirst.challenge,
  })).status, 'full-required')
})



test('capacity failures preserve the current continuation challenge for retry', async () => {
  const locateFn = async (request) => request.phase === 'metadata'
    ? { status: 'sample-required', candidates: ['C:/short/file.txt'] }
    : { status: 'full-required', candidates: ['C:/' + 'x'.repeat(1000)] }
  const { secure } = harness({
    locateFn,
    maxTotalBytes: 900,
    maxSessionBytes: 5000,
    maxRecordBytes: 5000,
    maxChallengesPerSession: 10,
  })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await secure({ protocolVersion: 2, phase: 'metadata', file })
  const continuation = {
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  }
  await rejectsStatus(secure(continuation), 429)
  await rejectsStatus(secure(continuation), 429)
})

test('transient locator failures retain the challenge for retry', async () => {
  let failSample = true
  const locateFn = async (request) => {
    if (request.phase === 'metadata') return { status: 'sample-required', candidates: ['C:/trusted/file.txt'] }
    if (request.phase === 'sample' && failSample) { failSample = false; throw new Error('temporary I/O failure') }
    return { status: 'found', path: 'C:/trusted/file.txt' }
  }
  const { secure } = harness({ locateFn })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  const sampleRequest = {
    protocolVersion: 2,
    phase: 'sample',
    sessionId: 'session-1',
    file,
    digest: '0'.repeat(64),
    challenge: metadata.challenge,
  }
  await assert.rejects(secure(sampleRequest), new RegExp('temporary I/O failure'))
  assert.equal((await secure(sampleRequest)).status, 'found')
})



test('locator error results do not consume a challenge', async () => {
  const locateFn = async (request) => {
    if (request.phase === 'metadata') return { status: 'sample-required', candidates: ['C:/trusted/file.txt'] }
    if (request.digest === 'bad') return { status: 'error', message: 'invalid digest' }
    return { status: 'found', path: 'C:/trusted/file.txt' }
  }
  const { secure } = harness({ locateFn })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  const base = { protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, challenge: metadata.challenge }
  assert.equal((await secure({ ...base, digest: 'bad' })).status, 'error')
  assert.equal((await secure({ ...base, digest: '0'.repeat(64) })).status, 'found')
})

test('locate concurrency gate rejects excess work without consuming capacity', async () => {
  let release
  let markStarted
  const pending = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { markStarted = resolve })
  const locateFn = async () => { markStarted(); return pending }
  const { secure } = harness({ locateFn, maxConcurrentLocates: 1, maxConcurrentLocatesPerSession: 1 })
  const first = secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  await started
  await rejectsStatus(secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file }), 429)
  release({ status: 'not-found' })
  assert.equal((await first).status, 'not-found')
  assert.equal((await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })).status, 'not-found')
})

test('continuations reject a removed or rebound session workspace', async () => {
  let workspace = 'C:/trusted'
  const { secure } = harness({
    resolveBaseDirFn: () => workspace === undefined
      ? (() => { throw new HttpError(404, 'session not found') })()
      : workspace,
  })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  workspace = 'D:/rebound'
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  }), 409)
  workspace = undefined
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file,
    digest: '0'.repeat(64), challenge: metadata.challenge,
  }), 404)
})

test('authorized external roots participate in secure file locating', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-secure-external-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  await mkdir(workspace)
  await mkdir(external)
  const path = join(external, 'outside.txt')
  await writeFile(path, 'outside-content')
  const info = await stat(path)
  const store = (await import('../src/host/search-roots.js')).createSearchRootStore(join(root, 'roots.json'))
  const authorized = await store.authorize(external)
  const canonicalPath = join(authorized.roots[0].path, 'outside.txt')
  const ctx = {
    sessions: {
      get: (id) => id === 'session-external' ? { header: { cwd: workspace } } : undefined,
      list: () => [{ header: { cwd: workspace } }],
    },
  }
  const secure = createSecureLocator(ctx, { getExternalSearchRoots: () => store.trusted() })
  const file = { kind: 'file', name: 'outside.txt', size: info.size, lastModified: info.mtimeMs }
  const metadata = await secure({
    protocolVersion: 2, phase: 'metadata', sessionId: 'session-external', file,
    workspacePaths: ['C:/attacker'], currentWorkspacePath: 'C:/attacker',
  })
  assert.equal(metadata.status, 'sample-required')
  assert.deepEqual(metadata.candidates, [canonicalPath])
  const found = await secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-external', file,
    digest: await sampleFingerprint(canonicalPath, info.size), challenge: metadata.challenge,
  })
  assert.deepEqual(found, { status: 'found', path: canonicalPath })
  await writeFile(join(workspace, 'outside.txt'), 'outside-content')
  const globalMetadata = await secure({ protocolVersion: 2, phase: 'metadata', file })
  assert.deepEqual(globalMetadata.candidates, [canonicalPath])
  const globalFound = await secure({
    protocolVersion: 2, phase: 'sample', file,
    digest: await sampleFingerprint(canonicalPath, info.size), challenge: globalMetadata.challenge,
  })
  assert.deepEqual(globalFound, { status: 'found', path: canonicalPath })
  assert.equal(authorized.roots.length, 1)
})

test('revoking an external root invalidates its locate challenge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-secure-revoke-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  await mkdir(workspace)
  await mkdir(external)
  const path = join(external, 'revoked.txt')
  await writeFile(path, 'revoked-content')
  const info = await stat(path)
  const module = await import('../src/host/search-roots.js')
  const store = module.createSearchRootStore(join(root, 'roots.json'))
  const added = await store.authorize(external)
  const ctx = {
    sessions: {
      get: () => ({ header: { cwd: workspace } }),
      list: () => [{ header: { cwd: workspace } }],
    },
  }
  const secure = createSecureLocator(ctx, { getExternalSearchRoots: () => store.trusted() })
  const file = { kind: 'file', name: 'revoked.txt', size: info.size, lastModified: info.mtimeMs }
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-revoke', file })
  await store.revoke(added.roots[0].id)
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-revoke', file,
    digest: await sampleFingerprint(path, info.size), challenge: metadata.challenge,
  }), 409)
})

test('expired challenges and unsupported protocol requests are rejected', async () => {
  let clock = 100
  const { secure, calls } = harness({ now: () => clock, ttlMs: 10 })
  const metadata = await secure({ protocolVersion: 2, phase: 'metadata', sessionId: 'session-1', file })
  clock = 111
  await rejectsStatus(secure({
    protocolVersion: 2, phase: 'sample', sessionId: 'session-1', file, challenge: metadata.challenge,
  }), 410)

  await rejectsStatus(secure({ protocolVersion: 1, phase: 'sample', file, candidates: ['D:/unsupported'], digest: '0'.repeat(64) }), 426)
})
