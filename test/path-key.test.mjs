import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { pathKey } from '../src/shared/node-path.js'

test('path keys use native Node normalization and Unicode normalization', () => {
  const decomposed = pathKey(join(tmpdir(), 'e\u0301'))
  const composed = pathKey(join(tmpdir(), 'é'))
  assert.equal(decomposed, composed)
  assert.equal(pathKey(resolve('.')), pathKey(resolve('.')))
})

test('path key case behavior follows the host filesystem', () => {
  const upper = pathKey(join(tmpdir(), 'CaseProbe'))
  const lower = pathKey(join(tmpdir(), 'caseprobe'))
  assert.equal(upper === lower, process.platform === 'win32')
})

test('path keys reject missing values', () => {
  assert.throws(() => pathKey(undefined), TypeError)
  assert.throws(() => pathKey(''), TypeError)
})
