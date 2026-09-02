import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isolatedChildOptions } from '../platform/index.js'

const RUNNER_PATH = fileURLToPath(new URL('./isolate-runner.js', import.meta.url))
const MAX_ACTIVE_TASKS = 4
const MAX_INPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const DEFAULT_CLOSE_WATCHDOG_MS = 1000
let activeTasks = 0

function taskError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}


export function activeIsolatedTasks() {
  return activeTasks
}

export async function runIsolatedTask(task, payload, options = {}) {
  if (activeTasks >= MAX_ACTIVE_TASKS) throw taskError(429, 'too many isolated filesystem operations')
  const input = Buffer.from(JSON.stringify({ task, payload }), 'utf8')
  if (input.length > MAX_INPUT_BYTES) throw taskError(413, 'isolated filesystem request is too large')
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs || 5000, 30000))
  const closeWatchdogMs = Math.max(10, Math.min(options.closeWatchdogMs || DEFAULT_CLOSE_WATCHDOG_MS, 5000))
  const maxOutputBytes = Math.max(1024, Math.min(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES))
  activeTasks += 1

  return new Promise((resolveResult, rejectResult) => {
    let child
    let released = false
    let settled = false
    let timer
    let closeWatchdog
    let termination
    let spawnError
    const chunks = []
    let outputBytes = 0

    const release = () => {
      if (released) return
      released = true
      activeTasks -= 1
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
        reject(taskError(503, 'isolated filesystem worker termination was not confirmed'))
        // Fail closed: retain this slot until a future close event confirms cleanup.
      }, closeWatchdogMs)
    }
    const terminate = (status, message) => {
      if (termination) return
      termination = { status, message }
      let killed = false
      try {
        killed = options.killProcess ? options.killProcess(child) : child.kill('SIGKILL')
      } catch (error) {
        termination.killError = error
      }
      if (!killed && !termination.killError) {
        termination.killError = taskError(503, 'isolated filesystem worker could not be terminated')
      }
      beginCloseWatchdog()
    }

    try {
      child = spawn(process.execPath, [RUNNER_PATH], {
        ...isolatedChildOptions(RUNNER_PATH),
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch (error) {
      release()
      reject(taskError(503, error.message))
      return
    }

    timer = setTimeout(() => terminate(503, 'isolated filesystem operation timed out'), timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (termination) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        terminate(413, 'isolated filesystem result is too large')
        return
      }
      chunks.push(chunk)
    })
    child.once('error', (error) => {
      spawnError = error
      beginCloseWatchdog()
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(closeWatchdog)
      release()
      if (settled) return
      if (termination) {
        reject(taskError(termination.status, termination.message))
        return
      }
      if (spawnError) {
        reject(taskError(503, spawnError.message))
        return
      }
      let result
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        const status = code === 0 ? 500 : 503
        const message = code === 0
          ? 'isolated filesystem operation returned invalid data'
          : 'isolated filesystem worker exited unexpectedly'
        reject(taskError(status, message))
        return
      }
      if (code !== 0 || !result || result.ok !== true) {
        const status = result?.error?.status
        reject(taskError(
          Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
          result?.error?.message || 'isolated filesystem operation failed',
        ))
        return
      }
      resolve(result.value)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
