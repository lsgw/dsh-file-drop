import { homedir } from 'node:os'
import { win32 } from 'node:path'
import {
  PLATFORM_MAX_CANDIDATES,
  pathString,
  executableExists,
  executeBoundedCommand,
  outputLines,
  throwResourceFailure,
} from './common.js'

export function trustedWindowsExecutable(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && /^[A-Za-z]:[\\/]/.test(value)
}

function powershellArgs(script) {
  return [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script,
  ]
}

function powershellLiteral(value) {
  return "'" + value.replaceAll("'", "''") + "'"
}

export async function searchWindows(name, kind, runtime) {
  if (!name.startsWith('-')) {
    for (const command of runtime.everythingCommands || []) {
      if (!trustedWindowsExecutable(command) || !await runtime.commandExists(command)) continue
      try {
        const paths = outputLines(await runtime.exec(command, [
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
  if (!trustedWindowsExecutable(command) || !await runtime.commandExists(command)) return []
  const roots = [runtime.home, ...await runtime.windowsDrives()]
  const script = [
    '$name=' + powershellLiteral(name),
    '$filter=[WildcardPattern]::Escape($name)',
    '$roots=@(' + roots.map(powershellLiteral).join(',') + ') | Select-Object -Unique',
    '$roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter $filter '
      + (kind === 'directory' ? '-Directory' : '-File')
      + ' -Recurse -Force -ErrorAction SilentlyContinue } | Select-Object -First '
      + String(PLATFORM_MAX_CANDIDATES) + ' -ExpandProperty FullName',
  ].join('; ')
  try { return outputLines(await runtime.exec(command, powershellArgs(script))) }
  catch (error) { throwResourceFailure(error); return [] }
}

export async function windowsSearchRoots(runtime) {
  return [runtime.home, ...await runtime.windowsDrives()]
}

export function createWindowsAdapter(options = {}) {
  const environment = options.environment || process.env
  const home = options.home || homedir()
  const configuredSystemRoot = environment.SystemRoot || environment.WINDIR
  const systemRoot = trustedWindowsExecutable(configuredSystemRoot) ? win32.resolve(configuredSystemRoot) : undefined
  const system32 = systemRoot && win32.join(systemRoot, 'System32')
  const powershellPath = options.powershellPath === undefined
    ? system32 && win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : options.powershellPath
  const configuredEverything = options.everythingCli === undefined
    ? environment.DSH_FILE_DROP_EVERYTHING_CLI
    : options.everythingCli
  const everythingCommands = Object.freeze(options.everythingCommands || (
    trustedWindowsExecutable(configuredEverything) && win32.basename(configuredEverything).toLowerCase() === 'es.exe'
      ? [win32.resolve(configuredEverything)]
      : []
  ))
  const searchEnvironment = Object.freeze({
    SystemRoot: systemRoot || '',
    WINDIR: systemRoot || '',
    ComSpec: system32 ? win32.join(system32, 'cmd.exe') : '',
    PATH: system32 || '',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: system32 ? win32.join(system32, 'WindowsPowerShell', 'v1.0', 'Modules') : '',
    TEMP: systemRoot ? win32.join(systemRoot, 'Temp') : '',
    TMP: systemRoot ? win32.join(systemRoot, 'Temp') : '',
    USERPROFILE: home,
  })
  const commandRuntime = {
    cwd: systemRoot,
    env: searchEnvironment,
    isTrustedExecutable: trustedWindowsExecutable,
  }
  const exec = options.exec || ((command, args, commandOptions) => executeBoundedCommand(command, args, commandRuntime, commandOptions))
  const commandExists = options.commandExists || (command => executableExists(command, trustedWindowsExecutable))
  let adapter
  const windowsDrives = options.windowsDrives || (async () => {
    if (!powershellPath || !await commandExists(powershellPath)) return []
    try {
      const output = await exec(powershellPath, powershellArgs(
        '[System.IO.DriveInfo]::GetDrives() | Where-Object {$_.DriveType -eq "Fixed" -and $_.IsReady} | ForEach-Object {$_.RootDirectory.FullName}'
      ))
      return outputLines(output)
    } catch {
      return []
    }
  })
  adapter = {
    platform: 'win32',
    home,
    powershellPath,
    everythingCommands,
    linuxCommands: Object.freeze([]),
    commandExists,
    exec,
    windowsDrives,
    pathKey: value => pathString(value).toUpperCase(),
    isolatedChildOptions: runnerPath => ({
      cwd: win32.dirname(runnerPath),
      env: {
        SystemRoot: systemRoot || '',
        WINDIR: systemRoot || '',
        PATH: win32.dirname(process.execPath),
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        TEMP: environment.TEMP || '',
        TMP: environment.TMP || '',
        USERPROFILE: home,
      },
      windowsHide: true,
    }),
    indexedSearch: (name, kind = 'file') => searchWindows(name, kind, adapter),
    broadSearchRoots: () => windowsSearchRoots(adapter),
  }
  return Object.freeze(adapter)
}
