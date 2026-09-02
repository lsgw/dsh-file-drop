import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createPlatformAdapter } from '../src/platform/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('platform adapters preserve path identity and isolated child contracts', () => {
  const windows = createPlatformAdapter('win32', {
    home: 'C:\\Users\\tester',
    environment: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp' },
    commandExists: async () => false,
  })
  const linux = createPlatformAdapter('linux', { home: '/home/tester', commandExists: async () => false })
  const darwin = createPlatformAdapter('darwin', { home: '/Users/tester', commandExists: async () => false })

  assert.equal(windows.pathKey('C:\\Temp\\File.txt'), 'C:\\TEMP\\FILE.TXT')
  assert.equal(darwin.pathKey('/Users/Test/File.txt'), '/USERS/TEST/FILE.TXT')
  assert.equal(linux.pathKey('/home/Test/File.txt'), '/home/Test/File.txt')
  for (const adapter of [windows, linux, darwin]) {
    assert.throws(() => adapter.pathKey(undefined), TypeError)
  }
  assert.equal(windows.isolatedChildOptions('C:\\plugin\\runner.js').cwd, 'C:\\plugin')
  assert.equal(linux.isolatedChildOptions('/plugin/runner.js').cwd, '/plugin')
  assert.equal(darwin.isolatedChildOptions('/plugin/runner.js').cwd, '/plugin')
})

test('each adapter invokes only its injected native index provider', async () => {
  const calls = []
  const linux = createPlatformAdapter('linux', {
    home: '/home/tester',
    linuxCommands: ['/usr/bin/plocate'],
    commandExists: async () => true,
    exec: async (command, args) => {
      calls.push({ platform: 'linux', command, args })
      return '/home/tester/report.txt\n/home/tester/report.txt.bak\n'
    },
  })
  const darwin = createPlatformAdapter('darwin', {
    home: '/Users/tester',
    commandExists: async () => true,
    exec: async (command, args) => {
      calls.push({ platform: 'darwin', command, args })
      return '/Users/tester/report.txt\n'
    },
  })
  const windows = createPlatformAdapter('win32', {
    home: 'C:\\Users\\tester',
    environment: { SystemRoot: 'C:\\Windows' },
    everythingCommands: ['D:\\Everything\\es.exe'],
    commandExists: async () => true,
    windowsDrives: async () => ['C:\\'],
    exec: async (command, args) => {
      calls.push({ platform: 'win32', command, args })
      return 'C:\\Users\\tester\\report.txt\n'
    },
  })

  assert.deepEqual(await linux.indexedSearch('report.txt'), ['/home/tester/report.txt'])
  assert.deepEqual(await darwin.indexedSearch('report.txt'), ['/Users/tester/report.txt'])
  assert.deepEqual(await windows.indexedSearch('report.txt'), ['C:\\Users\\tester\\report.txt'])
  assert.equal(calls[0].command, '/usr/bin/plocate')
  assert.equal(calls[1].command, '/usr/bin/mdfind')
  assert.equal(calls[2].command, 'D:\\Everything\\es.exe')
  assert.ok(calls[0].args.includes('--'))
  assert.equal(calls[2].args.at(-1), 'report.txt')
})

test('production core delegates all runtime platform behavior to platform adapters', async () => {
  const coreFiles = [
    'client.js',
    'index.js',
    'src/host/safety.js',
    'src/host/upload-manager.js',
    'src/locate/isolate.js',
    'src/locate/locator.js',
    'src/locate/protocol.js',
    'src/locate/secure-locator.js',
  ]
  const forbidden = [
    [/\b(?:process|navigator)\.platform\b/, 'runtime platform branch'],
    [/\b(?:PowerShell|powershell\.exe|plocate|mdfind|DriveInfo)\b/, 'native index command'],
    [/\b(?:SystemRoot|WINDIR|PATHEXT|PSModulePath)\b/, 'platform child environment'],
  ]
  for (const relative of coreFiles) {
    const source = await readFile(join(root, relative), 'utf8')
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(source, pattern, relative + ' contains ' + label)
    }
  }
})
