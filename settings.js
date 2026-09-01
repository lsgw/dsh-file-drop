import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MIB_BYTES = 1024 * 1024
export const DEFAULT_UPLOAD_QUOTA_MIB = 10000
export const DEFAULT_UPLOAD_QUOTA_ENTRIES = 10000
export const MAX_UPLOAD_QUOTA_MIB = 1024 * 1024
export const MAX_UPLOAD_QUOTA_ENTRIES = 100000
export const DEFAULT_UPLOAD_QUOTA_BYTES = DEFAULT_UPLOAD_QUOTA_MIB * MIB_BYTES
export const MAX_UPLOAD_QUOTA_BYTES = MAX_UPLOAD_QUOTA_MIB * MIB_BYTES
export const QUOTA_ERROR_CODE = 'quota_exceeded'
export const QUOTA_ERROR_MESSAGE = '已达上传配额，需清理 .dsh-drops'
export const LOCATE_MODE_ERROR_CODE = 'locate_mode'
export const LOCATE_MODE_ERROR_MESSAGE = '当前为定位模式，未上传'

export const DEFAULT_FILE_DROP_SETTINGS = Object.freeze({
  mode: 'upload',
  uploadQuotaMiB: DEFAULT_UPLOAD_QUOTA_MIB,
  uploadQuotaEntries: DEFAULT_UPLOAD_QUOTA_ENTRIES,
})

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
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(settings), 'utf8')
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
