import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_SETTINGS, LOCATE_MODE_ERROR_CODE, LOCATE_MODE_ERROR_MESSAGE,
  MAX_UPLOAD_QUOTA_ENTRIES, MAX_UPLOAD_QUOTA_MIB, MIB_BYTES,
  QUOTA_ERROR_CODE, QUOTA_ERROR_MESSAGE,
} from '../shared/contract.js'

export {
  LOCATE_MODE_ERROR_CODE, LOCATE_MODE_ERROR_MESSAGE, MAX_UPLOAD_QUOTA_ENTRIES,
  MAX_UPLOAD_QUOTA_MIB, MIB_BYTES, QUOTA_ERROR_CODE, QUOTA_ERROR_MESSAGE,
}
export const DEFAULT_UPLOAD_QUOTA_MIB = DEFAULT_SETTINGS.uploadQuotaMiB
export const DEFAULT_UPLOAD_QUOTA_ENTRIES = DEFAULT_SETTINGS.uploadQuotaEntries
export const DEFAULT_UPLOAD_QUOTA_BYTES = DEFAULT_UPLOAD_QUOTA_MIB * MIB_BYTES
export const MAX_UPLOAD_QUOTA_BYTES = MAX_UPLOAD_QUOTA_MIB * MIB_BYTES
export const DEFAULT_FILE_DROP_SETTINGS = DEFAULT_SETTINGS

class SettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsError'
    this.status = 400
  }
}

function validInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

export function validateFileDropSettings(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new SettingsError('invalid file-drop settings')
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'mode,uploadQuotaEntries,uploadQuotaMiB') throw new SettingsError('complete latest settings are required')
  if (value.mode !== 'upload' && value.mode !== 'locate') throw new SettingsError('invalid file-drop mode')
  if (!validInteger(value.uploadQuotaMiB, MAX_UPLOAD_QUOTA_MIB)) throw new SettingsError('invalid upload quota MiB')
  if (!validInteger(value.uploadQuotaEntries, MAX_UPLOAD_QUOTA_ENTRIES)) throw new SettingsError('invalid upload quota entries')
  return {
    mode: value.mode,
    uploadQuotaMiB: value.uploadQuotaMiB,
    uploadQuotaEntries: value.uploadQuotaEntries,
  }
}

export function quotaFromSettings(settings) {
  return {
    maxBytes: settings.uploadQuotaMiB * MIB_BYTES,
    maxEntries: settings.uploadQuotaEntries,
  }
}

export function validateFileDropSettingsPatch(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new SettingsError('invalid file-drop settings patch')
  const keys = Object.keys(value).sort()
  const signature = keys.join(',')
  if (signature !== 'mode' && signature !== 'uploadQuotaEntries,uploadQuotaMiB') {
    throw new SettingsError('invalid file-drop settings patch')
  }
  if (Object.hasOwn(value, 'mode') && value.mode !== 'upload' && value.mode !== 'locate') {
    throw new SettingsError('invalid file-drop mode')
  }
  if (Object.hasOwn(value, 'uploadQuotaMiB') && !validInteger(value.uploadQuotaMiB, MAX_UPLOAD_QUOTA_MIB)) {
    throw new SettingsError('invalid upload quota MiB')
  }
  if (Object.hasOwn(value, 'uploadQuotaEntries') && !validInteger(value.uploadQuotaEntries, MAX_UPLOAD_QUOTA_ENTRIES)) {
    throw new SettingsError('invalid upload quota entries')
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

export function createSettingsStore(filePath) {
  if (typeof filePath !== 'string' || filePath === '') throw new TypeError('settings file path is required')
  const read = () => {
    try {
      return validateFileDropSettings(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULT_FILE_DROP_SETTINGS }
      throw error
    }
  }
  const write = (value) => {
    const settings = validateFileDropSettings(value)
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    writeFileSync(filePath, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 })
    return settings
  }
  return Object.freeze({
    read,
    write,
    update(value) {
      const patch = validateFileDropSettingsPatch(value)
      return write({ ...read(), ...patch })
    },
  })
}
