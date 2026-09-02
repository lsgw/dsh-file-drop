import { homedir } from 'node:os'
import { posix } from 'node:path'
import {
  executableExists,
  pathString,
  executeBoundedCommand,
  outputLines,
  throwResourceFailure,
} from './common.js'

const MDFIND = '/usr/bin/mdfind'

function trustedPosixExecutable(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && posix.isAbsolute(value)
}

export async function searchDarwin(name, runtime) {
  if (runtime.commandExists && !await runtime.commandExists(MDFIND)) return []
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  try { return outputLines(await runtime.exec(MDFIND, ['kMDItemFSName == "' + escaped + '"c'])) }
  catch (error) { throwResourceFailure(error); return [] }
}

export function createDarwinAdapter(options = {}) {
  const home = options.home || homedir()
  const environment = Object.freeze({ PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' })
  const commandRuntime = { cwd: '/', env: environment, isTrustedExecutable: trustedPosixExecutable }
  const exec = options.exec || ((command, args, commandOptions) => executeBoundedCommand(command, args, commandRuntime, commandOptions))
  const commandExists = options.commandExists || (command => executableExists(command, trustedPosixExecutable))
  let adapter
  adapter = {
    platform: 'darwin',
    home,
    powershellPath: undefined,
    everythingCommands: Object.freeze([]),
    linuxCommands: Object.freeze([]),
    commandExists,
    exec,
    windowsDrives: async () => [],
    // Preserve the existing macOS case-folding contract used by locks and challenges.
    pathKey: value => pathString(value).toUpperCase(),
    isolatedChildOptions: runnerPath => ({
      cwd: posix.dirname(runnerPath),
      env: environment,
      windowsHide: true,
    }),
    indexedSearch: name => searchDarwin(name, adapter),
    broadSearchRoots: async () => [],
  }
  return Object.freeze(adapter)
}
