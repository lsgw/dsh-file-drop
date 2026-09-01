import { opendir } from 'node:fs/promises'

const MAX_INPUT_BYTES = 1024 * 1024

async function readRequest() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_INPUT_BYTES) throw Object.assign(new Error('isolated filesystem request is too large'), { status: 413 })
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function run(task, payload) {
  if (task === 'recursive-candidates') {
    const { runRecursiveCandidateScan } = await import('./locator.js')
    return runRecursiveCandidateScan(payload.item, payload.roots, {
      visited: payload.visited || 0,
      deadline: payload.deadline,
    })
  }
  if (task === 'directory-structure') {
    const { readNodeDirectoryStructure } = await import('./directory-node.js')
    const { directoryStructureDigest, selectDirectorySamplePaths } = await import('./directory.js')
    const structure = await readNodeDirectoryStructure(payload.path, { budget: { deadline: payload.deadline } })
    return { digest: directoryStructureDigest(structure), paths: selectDirectorySamplePaths(structure.entries) }
  }
  if (task === 'directory-content') {
    const { nodeDirectoryContentDigestLocal } = await import('./directory-node.js')
    return nodeDirectoryContentDigestLocal(payload.path, payload.paths, { budget: { deadline: payload.deadline } })
  }
  if (task === 'measure-drop-root') {
    const { measureDropRootLocal } = await import('../host-safety.js')
    return measureDropRootLocal(payload.baseDir)
  }
  if (task === 'hold-directory') {
    await opendir(payload.path)
    await new Promise(() => {})
  }
  throw Object.assign(new Error('unknown isolated filesystem task'), { status: 400 })
}

try {
  const request = await readRequest()
  const value = await run(request.task, request.payload || {})
  process.stdout.write(JSON.stringify({ ok: true, value }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { status: Number.isInteger(error?.status) ? error.status : 500, message: String(error?.message || error) },
  }))
  process.exitCode = 1
}
