import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, normalize } from 'node:path'

import { readNodeDirectoryStructure } from '../src/locate/directory-node.js'
import { fullFingerprint, sampleFingerprint, sampleRanges } from '../src/locate/fingerprint.js'
import { locate } from '../src/locate/locator.js'
import { activeIsolatedTasks, runIsolatedTask } from '../src/locate/isolate.js'
import {
  activePlatformSearchProcesses,
  executePlatformCommandForTest,
  indexedSearch,
  platformAdapterForTest,
} from '../src/platform/index.js'
import { SAMPLE_BYTES, SMALL_FILE_BYTES } from '../src/locate/protocol.js'

async function fixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-' + label + '-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}






test('isolated filesystem timeout terminates a process holding a real directory handle', async (t) => {
  const root = await fixture(t, 'isolated-timeout')
  const held = join(root, 'held')
  await mkdir(held)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      runIsolatedTask('hold-directory', { path: held }, { timeoutMs: 100 }),
      error => error && error.status === 503,
    )
    assert.equal(activeIsolatedTasks(), 0)
  }
  await rm(held, { recursive: true })
})



test('isolated filesystem task concurrency is capped and fully released', async (t) => {
  const root = await fixture(t, 'isolated-concurrency')
  const held = join(root, 'held')
  await mkdir(held)
  const running = Array.from({ length: 4 }, () => runIsolatedTask('hold-directory', { path: held }, { timeoutMs: 300 }))
  assert.equal(activeIsolatedTasks(), 4)
  await assert.rejects(
    runIsolatedTask('hold-directory', { path: held }, { timeoutMs: 300 }),
    error => error && error.status === 429,
  )
  const results = await Promise.allSettled(running)
  assert.equal(results.every(result => result.status === 'rejected' && result.reason.status === 503), true)
  assert.equal(activeIsolatedTasks(), 0)
  await rm(held, { recursive: true })
})



test('unconfirmed isolated worker termination retains its slot until close', async (t) => {
  const root = await fixture(t, 'isolated-kill-failure')
  const held = join(root, 'held')
  await mkdir(held)
  const pending = runIsolatedTask('hold-directory', { path: held }, {
    timeoutMs: 30,
    closeWatchdogMs: 30,
    killProcess: (child) => {
      setTimeout(() => child.kill('SIGKILL'), 120)
      return false
    },
  })
  await assert.rejects(pending, error => error && error.status === 503)
  assert.equal(activeIsolatedTasks(), 1)
  await waitFor(() => activeIsolatedTasks() === 0)
  await rm(held, { recursive: true })
})

test('platform index parsing preserves trailing spaces and candidate bounds', async () => {
  const name = 'name-with-space '
  const runtime = {
    platform: 'linux',
    commandExists: async () => true,
    exec: async () => Array.from({ length: 150 }, (_, index) => '/tmp/' + index + '/' + name).join('\n'),
  }
  const candidates = await indexedSearch(name, 'file', runtime)
  assert.equal(candidates.length, 100)
  assert.equal(candidates[0].endsWith(name), true)
})



test('Windows PowerShell fallback indexes directories with -Directory', async () => {
  let script = ''
  const runtime = {
    platform: 'win32',
    home: 'C:/Users/Test',
    powershellPath: join(tmpdir(), 'powershell.exe'),
    windowsDrives: async () => [],
    commandExists: async () => true,
    exec: async (_command, args) => {
      script = args.at(-1)
      return 'C:/Users/Test/target-directory'
    },
  }
  const candidates = await indexedSearch('target-directory', 'directory', runtime)
  assert.deepEqual(candidates, ['C:/Users/Test/target-directory'])
  assert.match(script, /-Directory/)
  assert.doesNotMatch(script, /-File/)
})



test('platform search waits for close and retains an unconfirmed process slot', async () => {
  const pending = executePlatformCommandForTest(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 30,
    closeWatchdogMs: 30,
    killProcess: (child) => {
      setTimeout(() => child.kill('SIGKILL'), 120)
      return false
    },
  })
  await assert.rejects(pending, error => error && error.status === 503)
  assert.equal(activePlatformSearchProcesses(), 1)
  await waitFor(() => activePlatformSearchProcesses() === 0)
})



test('platform output cap kills and reaps the producer before resolving', async () => {
  const output = await executePlatformCommandForTest(process.execPath, [
    '-e',
    "for(let i=0;i<150;i++) console.log('line-'+i); setInterval(() => {}, 1000)",
  ])
  assert.equal(output.split('\n').length, 100)
  assert.equal(activePlatformSearchProcesses(), 0)
})

test('native index arguments preserve option boundaries and empty providers fall back', async () => {
  let linuxArgs
  await indexedSearch('--help', 'file', {
    platform: 'linux',
    linuxCommands: ['/usr/bin/plocate'],
    commandExists: async () => true,
    exec: async (_command, args) => { linuxArgs = args; return '' },
  })
  assert.deepEqual(linuxArgs.slice(-2), ['--', '--help'])
  await assert.rejects(indexedSearch('file.txt', 'file', {
    platform: 'linux',
    linuxCommands: ['/usr/bin/plocate'],
    commandExists: async () => true,
    exec: async () => { throw Object.assign(new Error('busy'), { status: 429 }) },
  }), error => error && error.status === 429)

  const commands = []
  const runtime = {
    platform: 'win32',
    home: 'C:/Users/Test',
    everythingCommands: [join(tmpdir(), 'es.exe')],
    powershellPath: join(tmpdir(), 'powershell.exe'),
    windowsDrives: async () => [],
    commandExists: async () => true,
    exec: async (command) => {
      commands.push(command)
      return command.endsWith('es.exe') ? '' : 'C:/Users/Test/target.txt'
    },
  }
  assert.deepEqual(await indexedSearch('target.txt', 'file', runtime), ['C:/Users/Test/target.txt'])
  assert.equal(commands.length, 2)
  commands.length = 0
  await indexedSearch('--help', 'file', runtime)
  assert.equal(commands.some(command => command.endsWith('es.exe')), false)
})

test('platform host rejects bare commands and uses an absolute PowerShell path', async () => {
  await assert.rejects(
    executePlatformCommandForTest('powershell.exe', []),
    error => error && error.status === 500,
  )
  if (process.platform === 'win32') assert.equal(isAbsolute(platformAdapterForTest.powershellPath), true)
  assert.equal(platformAdapterForTest.everythingCommands.every(isAbsolute), true)
  const childCwd = await executePlatformCommandForTest(process.execPath, ['-e', 'console.log(process.cwd())'])
  const expectedCwd = process.platform === 'win32' ? (process.env.SystemRoot || process.env.WINDIR) : '/'
  assert.equal(normalize(childCwd).toUpperCase(), normalize(expectedCwd).toUpperCase())
})

test('real Windows PowerShell fallback finds a directory', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t, 'powershell-directory')
  const name = "indexed';Write-Output NOT_EXECUTED;'-" + process.pid + '-' + Date.now()
  const target = join(root, name)
  await mkdir(target)
  const runtime = {
    ...platformAdapterForTest,
    home: root,
    everythingCommands: [],
    windowsDrives: async () => [],
  }
  const candidates = await indexedSearch(name, 'directory', runtime)
  assert.equal(candidates.some(path => basename(path) === name), true)
})

test('sample ranges cover small and large file boundaries', () => {
  assert.deepEqual(sampleRanges(0), [{ start: 0, length: 0 }])
  assert.deepEqual(sampleRanges(SAMPLE_BYTES * 3), [{ start: 0, length: SAMPLE_BYTES * 3 }])
  assert.equal(sampleRanges(SAMPLE_BYTES * 3 + 1).length, 3)
  assert.throws(() => sampleRanges(-1), /non-negative safe integer/)
})

test('unique metadata candidates are verified before success', async (t) => {
  const root = await fixture(t, 'unique')
  const fileName = 'unique-' + process.pid + '-' + Date.now() + '.txt'
  const filePath = join(root, fileName)
  await writeFile(filePath, 'verified')

  const metadata = await locate({
    phase: 'metadata',
    file: { kind: 'file', name: fileName, size: 8, lastModified: 0 },
    currentWorkspacePath: root,
    workspacePaths: [root],
  })
  assert.equal(metadata.status, 'sample-required')
  assert.deepEqual(metadata.candidates, [normalize(filePath)])

  const digest = await sampleFingerprint(filePath, 8)
  const verified = await locate({
    phase: 'sample',
    file: { kind: 'file', name: fileName, size: 8, lastModified: 0 },
    candidates: metadata.candidates,
    digest,
  })
  assert.deepEqual(verified, { status: 'found', path: normalize(filePath) })
})

test('unique directories require a structure digest', async (t) => {
  const root = await fixture(t, 'directory')
  const name = 'dir-' + process.pid + '-' + Date.now()
  const directory = join(root, name)
  await mkdir(directory)
  await writeFile(join(directory, 'child.txt'), 'content')

  const metadata = await locate({
    phase: 'metadata',
    file: { kind: 'directory', name },
    currentWorkspacePath: root,
    workspacePaths: [root],
  })
  assert.equal(metadata.status, 'directory-structure-required')

  const structure = await readNodeDirectoryStructure(directory)
  const verified = await locate({
    phase: 'directory-structure',
    file: { kind: 'directory', name, structure },
    candidates: metadata.candidates,
  })
  assert.deepEqual(verified, { status: 'found', path: normalize(directory) })
})

test('wrong current-workspace copy does not hide the original', async (t) => {
  const root = await fixture(t, 'priority')
  const current = join(root, 'current')
  const other = join(root, 'other')
  await mkdir(current)
  await mkdir(other)
  const name = 'same-' + process.pid + '-' + Date.now() + '.txt'
  const wrong = join(current, name)
  const original = join(other, name)
  await writeFile(wrong, 'WRONG')
  await writeFile(original, 'RIGHT')

  const metadata = await locate({
    phase: 'metadata',
    file: { kind: 'file', name, size: 5, lastModified: 0 },
    currentWorkspacePath: current,
    workspacePaths: [current, other],
  })
  assert.equal(metadata.status, 'sample-required')
  assert.equal(metadata.candidates.length, 2)

  const digest = await sampleFingerprint(original, 5)
  const verified = await locate({
    phase: 'sample',
    file: { kind: 'file', name, size: 5, lastModified: 0 },
    candidates: metadata.candidates,
    digest,
  })
  assert.deepEqual(verified, { status: 'found', path: normalize(original) })
})



test('failed direct candidates can be excluded to reveal a nested original', async (t) => {
  const root = await fixture(t, 'excluded-candidate')
  const wrongRoot = join(root, 'wrong')
  const realRoot = join(root, 'real')
  const nested = join(realRoot, 'nested')
  await mkdir(wrongRoot)
  await mkdir(realRoot)
  await mkdir(nested)
  const name = 'excluded-' + process.pid + '-' + Date.now() + '.txt'
  const wrong = join(wrongRoot, name)
  const original = join(nested, name)
  await writeFile(wrong, 'wrong')
  await writeFile(original, 'right')
  const result = await locate({
    phase: 'metadata',
    file: { kind: 'file', name, size: 5, lastModified: 0 },
    currentWorkspacePath: wrongRoot,
    workspacePaths: [wrongRoot, realRoot],
    excludedCandidates: [wrong],
  })
  assert.equal(result.status, 'sample-required')
  assert.equal(result.candidates.includes(normalize(original)), true)
  assert.equal(result.candidates.includes(normalize(wrong)), false)
})

test('sample collisions use full hashing only within the safe size limit', async (t) => {
  const root = await fixture(t, 'collision')
  const one = join(root, 'one')
  const two = join(root, 'two')
  await mkdir(one)
  await mkdir(two)
  const name = 'collision.bin'
  const size = 1024 * 1024
  const first = Buffer.alloc(size, 65)
  const second = Buffer.from(first)
  second[100000] = 66
  const firstPath = join(one, name)
  const secondPath = join(two, name)
  await writeFile(firstPath, first)
  await writeFile(secondPath, second)

  const sample = await sampleFingerprint(firstPath, size)
  const sampled = await locate({
    phase: 'sample',
    file: { kind: 'file', name, size, lastModified: 0 },
    candidates: [firstPath, secondPath],
    digest: sample,
  })
  assert.deepEqual(sampled, { status: 'full-required', candidates: [firstPath, secondPath].map(normalize) })

  const full = await fullFingerprint(firstPath)
  const verified = await locate({
    phase: 'full',
    file: { kind: 'file', name, size, lastModified: 0 },
    candidates: sampled.candidates,
    digest: full,
  })
  assert.deepEqual(verified, { status: 'found', path: normalize(firstPath) })

  const largeSize = SMALL_FILE_BYTES + 1
  const largeOne = join(one, 'large.bin')
  const largeTwo = join(two, 'large.bin')
  for (const path of [largeOne, largeTwo]) {
    const handle = await open(path, 'w')
    await handle.truncate(largeSize)
    await handle.close()
  }
  const largeSample = await sampleFingerprint(largeOne, largeSize)
  const largeResult = await locate({
    phase: 'sample',
    file: { kind: 'file', name: 'large.bin', size: largeSize, lastModified: 0 },
    candidates: [largeOne, largeTwo],
    digest: largeSample,
  })
  assert.equal(largeResult.status, 'choose')
  const blockedFull = await locate({
    phase: 'full',
    file: { kind: 'file', name: 'large.bin', size: largeSize, lastModified: 0 },
    candidates: [largeOne],
    digest: '0'.repeat(64),
  })
  assert.equal(blockedFull.status, 'error')
})

test('directory content samples disambiguate identical structures', async (t) => {
  const root = await fixture(t, 'directory-content')
  const one = join(root, 'one')
  const two = join(root, 'two')
  const name = 'shared-directory'
  const first = join(one, name)
  const second = join(two, name)
  await mkdir(one)
  await mkdir(two)
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, 'child.txt'), 'RIGHT')
  await writeFile(join(second, 'child.txt'), 'WRONG')

  const structure = await readNodeDirectoryStructure(first)
  const structured = await locate({
    phase: 'directory-structure',
    file: { kind: 'directory', name, structure },
    candidates: [first, second],
  })
  assert.equal(structured.status, 'directory-content-required')

  const digest = await sampleFingerprint(join(first, 'child.txt'), 5)
  const verified = await locate({
    phase: 'directory-content',
    file: { kind: 'directory', name },
    candidates: structured.candidates,
    directorySamples: [{ path: 'child.txt', size: 5, digest }],
  })
  assert.deepEqual(verified, { status: 'found', path: normalize(first) })
})

test('locator rejects link candidates before reading fingerprints', async (t) => {
  const root = await fixture(t, 'link-candidate')
  const target = join(root, 'target.txt')
  const link = join(root, 'dropped-link.txt')
  await writeFile(target, 'linked')
  try { await symlink(target, link, 'file') } catch (error) { t.skip('file symlinks unavailable: ' + error.code); return }
  const result = await locate({
    phase: 'sample',
    file: { kind: 'file', name: 'dropped-link.txt', size: 6, lastModified: 0 },
    candidates: [link],
    digest: await sampleFingerprint(target, 6),
  })
  assert.deepEqual(result, { status: 'not-found' })
})

test('full fingerprint phase falls back to choice above eight candidates', async (t) => {
  const root = await fixture(t, 'full-budget')
  const candidates = []
  for (let index = 0; index < 9; index += 1) {
    const directory = join(root, String(index))
    await mkdir(directory)
    const path = join(directory, 'same.txt')
    await writeFile(path, 'same')
    candidates.push(path)
  }
  const result = await locate({
    phase: 'full',
    file: { kind: 'file', name: 'same.txt', size: 4, lastModified: 0 },
    candidates,
    digest: await fullFingerprint(candidates[0]),
  })
  assert.equal(result.status, 'choose')
  assert.equal(result.candidates.length, 9)
})

test('truncated directory fingerprints never auto-select a candidate', async (t) => {
  const root = await fixture(t, 'truncated-directory')
  const directory = join(root, 'same-dir')
  await mkdir(directory)
  const result = await locate({
    phase: 'directory-structure',
    file: { kind: 'directory', name: 'same-dir', structure: { entries: [], truncated: true } },
    candidates: [directory],
  })
  assert.deepEqual(result, { status: 'choose', candidates: [normalize(directory)] })
})

test('malformed protocol fields return explicit errors', async (t) => {
  const root = await fixture(t, 'invalid')
  const path = join(root, 'valid.txt')
  await writeFile(path, 'x')
  const file = { kind: 'file', name: 'valid.txt', size: 1, lastModified: 0 }

  const tooMany = await locate({ phase: 'sample', file, candidates: Array(101).fill(path), digest: '0'.repeat(64) })
  assert.equal(tooMany.status, 'error')
  const badDigest = await locate({ phase: 'sample', file, candidates: [path], digest: 'not-a-digest' })
  assert.equal(badDigest.status, 'error')
  const uppercaseDigest = await locate({ phase: 'sample', file, candidates: [path], digest: 'A'.repeat(64) })
  assert.equal(uppercaseDigest.status, 'error')
  const invalidSize = await locate({ phase: 'metadata', file: { ...file, size: -1 }, workspacePaths: [root] })
  assert.equal(invalidSize.status, 'error')
  const pathLikeName = await locate({ phase: 'metadata', file: { ...file, name: '../valid.txt' }, workspacePaths: [root] })
  assert.equal(pathLikeName.status, 'error')
  const wrongName = await locate({ phase: 'sample', file: { ...file, name: 'other.txt' }, candidates: [path], digest: '0'.repeat(64) })
  assert.equal(wrongName.status, 'not-found')

  const directory = join(root, 'directory')
  await mkdir(directory)
  const invalidStructure = await locate({
    phase: 'directory-structure',
    file: { kind: 'directory', name: 'directory', structure: { entries: [{ path: '../escape', kind: 'file', size: 1 }], truncated: false } },
    candidates: [directory],
  })
  assert.equal(invalidStructure.status, 'error')
  const missingSampleSize = await locate({
    phase: 'directory-content',
    file: { kind: 'directory', name: 'directory' },
    candidates: [directory],
    directorySamples: [{ path: 'x', digest: '0'.repeat(64) }],
  })
  assert.equal(missingSampleSize.status, 'error')
  const tooManySamples = await locate({
    phase: 'directory-content',
    file: { kind: 'directory', name: 'directory' },
    candidates: [directory],
    directorySamples: Array(25).fill({ path: 'x', size: 0, digest: '0'.repeat(64) }),
  })
  assert.equal(tooManySamples.status, 'error')
})
