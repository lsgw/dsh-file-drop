export {
  DEFAULT_SETTINGS, MAX_ROOT_DIRECTORIES, MAX_TOP_LEVEL_FILES, MAX_UPLOAD_QUOTA_ENTRIES,
  MAX_UPLOAD_QUOTA_MIB, MIB_BYTES, MODE_READ_ERROR_MESSAGE, QUOTA_ERROR_MESSAGE,
} from '../shared/contract.js'
export {
  adoptSettings, beginModeChange, clearUserUploadRoot, currentMode, currentSettings, initializeSettings,
  modeRevision, openModeChannel, operationController, readUserUploadUsage, refreshModeForAction,
  refreshSettings, subscribeSettings, uploadChunked, uploadFileChunks, writeSettings,
} from './api.js'
export {
  authorizeExternalSearchRoot, currentExternalSearchRoots, openExternalSearchRootChannel,
  readExternalSearchRoots, revokeExternalSearchRoot, subscribeExternalSearchRoots,
} from './search-roots.js'
export {
  abortableDelay, getDirectoryEntries, getDroppedEntries,
  readEntryAll, shouldHandleDataTransfer,
} from './drop-data.js'
export { formatSize } from './format.js'
export { processDirectoryUpload, processFilesUpload } from './upload-strategy.js'
export { processDirectoryLocate, processFilesLocate } from './locate-strategy.js'
export {
  claimedDropEvents, chooseDropOwner, currentSessionMatches, currentSessionWorkspacePath,
  dropOwners, normalizeSessionId, retryWorkspaceContext, selectDropOwner,
} from './session.js'
export { chooseDropAction } from './drop-controller.js'
export { composerStatusStore, statusStore } from './status.js'

import {
  beginModeChange, clearUserUploadRoot, readUserUploadUsage, refreshModeForAction, refreshSettings,
  subscribeSettings, uploadChunked, uploadFileChunks, writeSettings,
} from './api.js'
import {
  authorizeExternalSearchRoot, currentExternalSearchRoots, openExternalSearchRootChannel,
  readExternalSearchRoots, revokeExternalSearchRoot, subscribeExternalSearchRoots, validExternalSearchRoots,
} from './search-roots.js'
import { getDirectoryEntries, getDroppedEntries, readEntryAll, shouldHandleDataTransfer } from './drop-data.js'
import { chooseDropAction } from './drop-controller.js'
import { processDirectoryUpload, processFilesUpload } from './upload-strategy.js'
import { chooseDropOwner, retryWorkspaceContext } from './session.js'
import { statusStore } from './status.js'

export const clientTestApi = Object.freeze({
  uploadChunked,
  uploadFileChunks,
  processFilesUpload,
  processDirectoryUpload,
  readEntryAll,
  statusStore,
  chooseDropOwner,
  chooseDropAction,
  refreshSettings,
  readExternalSearchRoots,
  authorizeExternalSearchRoot,
  revokeExternalSearchRoot,
  currentExternalSearchRoots,
  openExternalSearchRootChannel,
  subscribeExternalSearchRoots,
  validExternalSearchRoots,
  refreshModeForAction,
  beginModeChange,
  readUserUploadUsage,
  clearUserUploadRoot,
  writeSettings,
  getDirectoryEntries,
  getDroppedEntries,
  retryWorkspaceContext,
  shouldHandleDataTransfer,
})
