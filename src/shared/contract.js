export const PLUGIN_ID = 'dsh-file-drop'
export const API_PATH = '/api/dsh-file-drop'
export const UPLOAD_PATH = API_PATH + '/upload'
export const SETTINGS_PATH = API_PATH + '/settings'
export const SEARCH_ROOTS_PATH = API_PATH + '/search-roots'
export const FILE_DROP_ROUTE = '/file-drop/locate'

export const MAX_TOP_LEVEL_FILES = 500
export const MAX_DIRECTORY_ENTRIES = 10000
export const MAX_ROOT_DIRECTORIES = 32
export const MAX_EXTERNAL_SEARCH_ROOTS = 16
export const MAX_EXTERNAL_SEARCH_ROOT_PATH_LENGTH = 32768
export const MAX_UPLOAD_QUOTA_MIB = 1024 * 1024
export const MAX_UPLOAD_QUOTA_ENTRIES = 100000
export const MIB_BYTES = 1024 * 1024
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'upload', uploadQuotaMiB: 10000, uploadQuotaEntries: 10000 })
export const FAIL_CLOSED_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, mode: 'locate' })

export const QUOTA_ERROR_CODE = 'quota_exceeded'
export const QUOTA_ERROR_MESSAGE = '已达上传配额，需清理 .dsh-drops'
export const LOCATE_MODE_ERROR_CODE = 'locate_mode'
export const LOCATE_MODE_ERROR_MESSAGE = '当前为定位模式，未上传'
export const MODE_READ_ERROR_MESSAGE = '无法确认当前拖拽模式，未上传'

export const UPLOAD_PROTOCOL_VERSION = 3
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const MAX_NEGOTIATED_CHUNK_BYTES = UPLOAD_CHUNK_BYTES
export const MAX_UPLOAD_MANIFEST_BYTES = 48 * 1024 * 1024
export const MAX_UPLOAD_CONTROL_BYTES = 1024 * 1024

export const LOCATE_PROTOCOL_VERSION = 2
export const LOCATE_MAX_REQUEST_BYTES = 16 * 1024 * 1024
export const LOCATE_MAX_STRUCTURE_BYTES = 12 * 1024 * 1024
export const LOCATE_SAMPLE_BYTES = 64 * 1024
export const LOCATE_FULL_MAX_BYTES = 8 * 1024 * 1024
export const LOCATE_MAX_DEPTH = 32
export const LOCATE_MAX_ENTRIES = 10000
