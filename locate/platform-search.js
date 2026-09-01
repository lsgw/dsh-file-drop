// dsh-file-drop / locate engine - OS file index and bounded search roots.
import { spawn } from 'node:child_process'
import { access, constants, readdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

const COMMAND_TIMEOUT_MS = 3000
const COMMAND_CLOSE_WATCHDOG_MS = 1000
const MAX_ACTIVE_SEARCH_PROCESSES = 4
export const PLATFORM_MAX_CANDIDATES = 100
let activeSearchProcesses = 0

function validAbsolutePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value)) return false
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(value)
  return true
}

function commandError(status, message, resourceFailure = false) {
  const error = new Error(message)
  error.status = status
  if (resourceFailure) error.resourceFailure = true
  return error
}

function throwResourceFailure(error) {
  if (error?.status === 429 || error?.resourceFailure === true) throw error
}

const hostPlatform = platform()
const hostHome = homedir()
const configuredSystemRoot = process.env.SystemRoot || process.env.WINDIR
const systemRoot = hostPlatform === 'win32' && validAbsolutePath(configuredSystemRoot)
  ? resolve(configuredSystemRoot)
  : undefined
const system32 = systemRoot && join(systemRoot, 'System32')
const powershellPath = system32 && join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const configuredEverything = process.env.DSH_FILE_DROP_EVERYTHING_CLI
const everythingCommands = Object.freeze(
  validAbsolutePath(configuredEverything) && basename(configuredEverything).toLowerCase() === 'es.exe'
    ? [resolve(configuredEverything)]
    : [],
)
const safeCwd = hostPlatform === 'win32' ? systemRoot : '/'
const safeEnv = hostPlatform === 'win32'
  ? {
    SystemRoot: systemRoot || '',
    WINDIR: systemRoot || '',
    ComSpec: system32 ? join(system32, 'cmd.exe') : '',
    PATH: system32 || '',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: system32 ? join(system32, 'WindowsPowerShell', 'v1.0', 'Modules') : '',
    TEMP: systemRoot ? join(systemRoot, 'Temp') : '',
    TMP: systemRoot ? join(systemRoot, 'Temp') : '',
    USERPROFILE: hostHome,
  }
  : { PATH: '/usr/bin:/bin', HOME: hostHome, LANG: 'C.UTF-8' }

function powershellArgs(script) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script,
  ]
}

export function executePlatformCommandForTest(command, args, options = {}) {
  if (!validAbsolutePath(command)) return Promise.reject(commandError(500, 'search command path is not trusted'))
  if (!validAbsolutePath(safeCwd)) return Promise.reject(commandError(500, 'search command working directory is unavailable'))
  if (activeSearchProcesses >= MAX_ACTIVE_SEARCH_PROCESSES) {
    return Promise.reject(commandError(429, 'too many platform search processes', true))
  }
  activeSearchProcesses += 1
  return new Promise((resolveResult, rejectResult) => {
    let child
    let released = false
    let settled = false
    let timer
    let closeWatchdog
    let termination
    let spawnError
    const output = []
    let pending = ''
    let bytes = 0

    const release = () => {
      if (released) return
      released = true
      activeSearchProcesses -= 1
    }
    const resolve = (value) => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    const reject = (error) => {
      if (settled) return
      settled = true
      rejectResult(error)
    }
    const beginCloseWatchdog = () => {
      if (closeWatchdog) return
      closeWatchdog = setTimeout(() => {
        reject(commandError(503, 'platform search process termination was not confirmed', true))
        // Keep the process slot occupied until a future close event confirms cleanup.
      }, Math.max(10, Math.min(options.closeWatchdogMs || COMMAND_CLOSE_WATCHDOG_MS, 5000)))
    }
    const terminate = (error) => {
      if (termination) return
      termination = { error }
      let killed = false
      try { killed = options.killProcess ? options.killProcess(child) : child.kill('SIGKILL') } catch (killError) { termination.error ||= commandError(503, killError.message, true) }
      if (!killed && !termination.error) termination.error = commandError(503, 'platform search process could not be terminated', true)
      beginCloseWatchdog()
    }
    const pushLine = (line) => {
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line !== '') output.push(line)
      if (output.length >= PLATFORM_MAX_CANDIDATES) terminate(undefined)
    }

    try {
      child = spawn(command, [...args], {
        cwd: safeCwd,
        env: safeEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      release()
      reject(commandError(503, error.message))
      return
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (termination) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      pending += chunk
      let newline
      while (!termination && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        pushLine(line)
      }
      if (!termination && (bytes > 1024 * 1024 || pending.length > 32768)) terminate(undefined)
    })
    child.once('error', (error) => {
      spawnError = error
      beginCloseWatchdog()
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(closeWatchdog)
      release()
      if (!termination && pending !== '' && output.length < PLATFORM_MAX_CANDIDATES) {
        if (pending.endsWith('\r')) pending = pending.slice(0, -1)
        if (pending !== '') output.push(pending)
      }
      if (settled) return
      const spawnFailure = spawnError && commandError(503, spawnError.message, true)
      const error = termination?.error || spawnFailure || (code === 0 ? undefined : commandError(503, 'search command exited with ' + code))
      if (error && output.length === 0) reject(error)
      else resolve(output.join('\n'))
    })
    timer = setTimeout(
      () => terminate(commandError(503, 'search command timed out')),
      Math.max(1, Math.min(options.timeoutMs || COMMAND_TIMEOUT_MS, 30000)),
    )
  })
}

const host = {
  platform: hostPlatform,
  home: hostHome,
  powershellPath,
  everythingCommands,
  linuxCommands: Object.freeze(['/usr/bin/plocate', '/usr/bin/locate']),
  async commandExists(command) {
    if (!validAbsolutePath(command)) return false
    try { await access(command, constants.X_OK); return true } catch { return false }
  },
  exec: (command, args) => executePlatformCommandForTest(command, args),
  async windowsDrives() {
    if (!this.powershellPath || !await this.commandExists(this.powershellPath)) return []
    try {
      const output = await this.exec(this.powershellPath, powershellArgs(
        '[System.IO.DriveInfo]::GetDrives() | Where-Object {$_.DriveType -eq "Fixed" -and $_.IsReady} | ForEach-Object {$_.RootDirectory.FullName}'
      ))
      return lines(output)
    } catch {
      return []
    }
  },
}
Object.freeze(host)

export const platformSearchHostForTest = host
export function activePlatformSearchProcesses() { return activeSearchProcesses }

function lines(value) {
  return value.split('\n')
    .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter(line => line !== '')
    .slice(0, PLATFORM_MAX_CANDIDATES)
}

async function macSearch(name, runtime) {
  if (runtime.commandExists && !await runtime.commandExists('/usr/bin/mdfind')) return []
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  try { return lines(await runtime.exec('/usr/bin/mdfind', [`kMDItemFSName == "${escaped}"c`])) }
  catch (error) { throwResourceFailure(error); return [] }
}

async function linuxSearch(name, runtime) {
  for (const command of runtime.linuxCommands || ['/usr/bin/plocate', '/usr/bin/locate']) {
    if (!await runtime.commandExists(command)) continue
    try {
      const paths = lines(await runtime.exec(command, [
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

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

async function windowsSearch(name, kind, runtime) {
  if (!name.startsWith('-')) {
    for (const command of runtime.everythingCommands || []) {
      if (!validAbsolutePath(command) || !await runtime.commandExists(command)) continue
      try {
        const paths = lines(await runtime.exec(command, [
          '-n', String(PLATFORM_MAX_CANDIDATES), '-whole-filename', name,
        ]))
        if (paths.length > 0) return paths
      } catch (error) {
        throwResourceFailure(error)
        // Try the next explicitly configured provider or PowerShell.
      }
    }
  }
  const command = runtime.powershellPath
  if (!validAbsolutePath(command) || !await runtime.commandExists(command)) return []
  const roots = [runtime.home, ...await runtime.windowsDrives()]
  const script = [
    `$name=${powershellLiteral(name)}`,
    `$filter=[WildcardPattern]::Escape($name)`,
    `$roots=@(${roots.map(powershellLiteral).join(',')}) | Select-Object -Unique`,
    `$roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter $filter ${kind === 'directory' ? '-Directory' : '-File'} -Recurse -Force -ErrorAction SilentlyContinue } | Select-Object -First ${String(PLATFORM_MAX_CANDIDATES)} -ExpandProperty FullName`,
  ].join('; ')
  try { return lines(await runtime.exec(command, powershellArgs(script))) }
  catch (error) { throwResourceFailure(error); return [] }
}

export async function indexedSearch(name, kind = 'file', runtime = host) {
  if (typeof kind === 'object') { runtime = kind; kind = 'file' }
  if (runtime.platform === 'darwin') return macSearch(name, runtime)
  if (runtime.platform === 'linux') return linuxSearch(name, runtime)
  if (runtime.platform === 'win32') return windowsSearch(name, kind, runtime)
  return []
}

export async function broadSearchRoots(runtime = host) {
  if (runtime.platform === 'linux') {
    const roots = [runtime.home]
    for (const parent of ['/mnt', '/media']) {
      try {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(join(parent, entry.name))
        }
      } catch {
        // Optional mount parent absent or unreadable.
      }
    }
    return roots
  }
  if (runtime.platform === 'win32') return [runtime.home, ...await runtime.windowsDrives()]
  return []
}
