import { homedir, platform } from 'node:os'
import { dirname } from 'node:path'
import { activePlatformSearchProcesses, pathString, PLATFORM_MAX_CANDIDATES } from './common.js'
import { createDarwinAdapter, searchDarwin } from './darwin.js'
import { createLinuxAdapter, linuxSearchRoots, searchLinux } from './linux.js'
import { createWindowsAdapter, searchWindows, windowsSearchRoots } from './windows.js'

export { PLATFORM_MAX_CANDIDATES, activePlatformSearchProcesses }

function createFallbackAdapter(options = {}) {
  const home = options.home || homedir()
  return Object.freeze({
    platform: options.platform || 'unknown',
    home,
    powershellPath: undefined,
    everythingCommands: Object.freeze([]),
    linuxCommands: Object.freeze([]),
    commandExists: async () => false,
    exec: async () => '',
    windowsDrives: async () => [],
    pathKey: value => pathString(value),
    isolatedChildOptions: runnerPath => ({
      cwd: dirname(runnerPath),
      env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
      windowsHide: true,
    }),
    indexedSearch: async () => [],
    broadSearchRoots: async () => [],
  })
}

export function createPlatformAdapter(platformName, options = {}) {
  if (platformName === 'win32') return createWindowsAdapter(options)
  if (platformName === 'linux') return createLinuxAdapter(options)
  if (platformName === 'darwin') return createDarwinAdapter(options)
  return createFallbackAdapter({ ...options, platform: platformName })
}

const hostAdapter = createPlatformAdapter(platform())
export const platformAdapterForTest = hostAdapter

export function platformPathKey(value) {
  return hostAdapter.pathKey(value)
}

export function isolatedChildOptions(runnerPath) {
  return hostAdapter.isolatedChildOptions(runnerPath)
}

export function executePlatformCommandForTest(command, args, options = {}) {
  return hostAdapter.exec(command, args, options)
}

export async function indexedSearch(name, kind = 'file', runtime = hostAdapter) {
  if (runtime === hostAdapter) return hostAdapter.indexedSearch(name, kind)
  if (runtime.platform === 'darwin') return searchDarwin(name, runtime)
  if (runtime.platform === 'linux') return searchLinux(name, runtime)
  if (runtime.platform === 'win32') return searchWindows(name, kind, runtime)
  return []
}

export async function broadSearchRoots(runtime = hostAdapter) {
  if (runtime === hostAdapter) return hostAdapter.broadSearchRoots()
  if (runtime.platform === 'linux') return linuxSearchRoots(runtime)
  if (runtime.platform === 'win32') return windowsSearchRoots(runtime)
  return []
}
