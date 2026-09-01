import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const COMMAND_TIMEOUT_MS = 8000
const COMMAND_CLOSE_WATCHDOG_MS = 1000
const MAX_ACTIVE_SEARCH_PROCESSES = 4
export const PLATFORM_MAX_CANDIDATES = 100
let activeSearchProcesses = 0

export function pathString(value) {
  if (typeof value !== 'string') throw new TypeError('path must be a string')
  return value
}

export function trustedAbsolutePath(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && isAbsolute(value)
}

export function commandError(status, message, resourceFailure = false) {
  const error = new Error(message)
  error.status = status
  if (resourceFailure) error.resourceFailure = true
  return error
}

export function throwResourceFailure(error) {
  if (error?.status === 429 || error?.resourceFailure === true) throw error
}

export function outputLines(value) {
  return value.split('\n')
    .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter(line => line !== '')
    .slice(0, PLATFORM_MAX_CANDIDATES)
}

export async function executableExists(command, isTrusted = trustedAbsolutePath) {
  if (!isTrusted(command)) return false
  try { await access(command, constants.X_OK); return true } catch { return false }
}

export function executeBoundedCommand(command, args, runtime, options = {}) {
  const isTrusted = runtime?.isTrustedExecutable || trustedAbsolutePath
  if (!isTrusted(command)) return Promise.reject(commandError(500, 'search command path is not trusted'))
  if (!trustedAbsolutePath(runtime?.cwd)) return Promise.reject(commandError(500, 'search command working directory is unavailable'))
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
      try { killed = options.killProcess ? options.killProcess(child) : child.kill('SIGKILL') }
      catch (killError) { termination.error ||= commandError(503, killError.message, true) }
      if (!killed && !termination.error) {
        termination.error = commandError(503, 'platform search process could not be terminated', true)
      }
      beginCloseWatchdog()
    }
    const pushLine = (line) => {
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line !== '') output.push(line)
      if (output.length >= PLATFORM_MAX_CANDIDATES) terminate(undefined)
    }

    try {
      child = spawn(command, [...args], {
        cwd: runtime.cwd,
        env: runtime.env,
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
      const error = termination?.error || spawnFailure
        || (code === 0 ? undefined : commandError(503, 'search command exited with ' + code))
      if (error && output.length === 0) reject(error)
      else resolve(output.join('\n'))
    })
    timer = setTimeout(
      () => terminate(commandError(503, 'search command timed out')),
      Math.max(1, Math.min(options.timeoutMs || COMMAND_TIMEOUT_MS, 30000)),
    )
  })
}

export function activePlatformSearchProcesses() {
  return activeSearchProcesses
}
