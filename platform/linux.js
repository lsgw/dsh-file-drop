import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import {
  PLATFORM_MAX_CANDIDATES,
  executableExists,
  pathString,
  executeBoundedCommand,
  outputLines,
  throwResourceFailure,
} from './common.js'

const DEFAULT_COMMANDS = Object.freeze(['/usr/bin/plocate', '/usr/bin/locate'])

function trustedPosixExecutable(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && posix.isAbsolute(value)
}

export async function searchLinux(name, runtime) {
  for (const command of runtime.linuxCommands || DEFAULT_COMMANDS) {
    if (!await runtime.commandExists(command)) continue
    try {
      const paths = outputLines(await runtime.exec(command, [
        '--basename', '--limit', String(PLATFORM_MAX_CANDIDATES * 4), '--', name,
      ])).filter(path => path.split('/').at(-1) === name).slice(0, PLATFORM_MAX_CANDIDATES)
      if (paths.length > 0) return paths
    } catch (error) {
      throwResourceFailure(error)
      // Try the next trusted system index.
    }
  }
  return []
}

export async function linuxSearchRoots(runtime) {
  const roots = [runtime.home]
  for (const parent of ['/mnt', '/media']) {
    try {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(posix.join(parent, entry.name))
      }
    } catch {
      // Optional mount parent absent or unreadable.
    }
  }
  return roots
}

export function createLinuxAdapter(options = {}) {
  const home = options.home || homedir()
  const environment = Object.freeze({ PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' })
  const commandRuntime = { cwd: '/', env: environment, isTrustedExecutable: trustedPosixExecutable }
  const exec = options.exec || ((command, args, commandOptions) => executeBoundedCommand(command, args, commandRuntime, commandOptions))
  const commandExists = options.commandExists || (command => executableExists(command, trustedPosixExecutable))
  let adapter
  adapter = {
    platform: 'linux',
    home,
    powershellPath: undefined,
    everythingCommands: Object.freeze([]),
    linuxCommands: Object.freeze(options.linuxCommands || DEFAULT_COMMANDS),
    commandExists,
    exec,
    windowsDrives: async () => [],
    pathKey: value => pathString(value),
    isolatedChildOptions: runnerPath => ({
      cwd: posix.dirname(runnerPath),
      env: environment,
      windowsHide: true,
    }),
    indexedSearch: name => searchLinux(name, adapter),
    broadSearchRoots: () => linuxSearchRoots(adapter),
  }
  return Object.freeze(adapter)
}
