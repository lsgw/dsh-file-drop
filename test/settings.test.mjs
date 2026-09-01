import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_FILE_DROP_SETTINGS,
  MIB_BYTES,
  createSettingsStore,
  quotaFromSettings,
  validateFileDropSettings,
  validateFileDropSettingsPatch,
} from '../settings.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('settings require the latest complete disk schema and validate atomic patches', () => {
  assert.throws(() => validateFileDropSettings({ mode: 'upload' }), /complete latest settings/)
  assert.throws(() => validateFileDropSettings({
    mode: 'upload', uploadQuotaMiB: 0, uploadQuotaEntries: 10000,
  }), /quota MiB/)
  assert.throws(() => validateFileDropSettings({
    mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 100001,
  }), /quota entries/)
  assert.deepEqual(validateFileDropSettingsPatch({ mode: 'locate' }), { mode: 'locate' })
  assert.deepEqual(validateFileDropSettingsPatch({ uploadQuotaMiB: 12, uploadQuotaEntries: 34 }), {
    uploadQuotaEntries: 34,
    uploadQuotaMiB: 12,
  })
  assert.throws(() => validateFileDropSettingsPatch({}), /settings patch/)
  assert.throws(() => validateFileDropSettingsPatch({ uploadQuotaMiB: 12 }), /settings patch/)
  assert.throws(() => validateFileDropSettingsPatch({
    mode: 'locate', uploadQuotaMiB: 12, uploadQuotaEntries: 34,
  }), /settings patch/)
  assert.throws(() => validateFileDropSettingsPatch({ obsolete: true }), /settings patch/)
})

test('settings store persists atomic patches and fails closed on corrupt disk data', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'nested', 'settings.json')
  const store = createSettingsStore(path)
  assert.deepEqual(store.read(), DEFAULT_FILE_DROP_SETTINGS)
  const saved = store.write({ mode: 'upload', uploadQuotaMiB: 12345, uploadQuotaEntries: 6789 })
  assert.deepEqual(store.update({ mode: 'locate' }), { ...saved, mode: 'locate' })
  assert.deepEqual(store.update({ uploadQuotaMiB: 42, uploadQuotaEntries: 43 }), {
    mode: 'locate', uploadQuotaMiB: 42, uploadQuotaEntries: 43,
  })
  assert.deepEqual(quotaFromSettings(saved), {
    maxBytes: 12345 * MIB_BYTES,
    maxEntries: 6789,
  })
  await writeFile(path, '{', 'utf8')
  assert.throws(() => store.read(), SyntaxError)
  await writeFile(path, JSON.stringify({ mode: 'locate' }), 'utf8')
  assert.throws(() => store.read(), /complete latest settings/)
})
