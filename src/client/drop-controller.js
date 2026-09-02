function chooseDropAction(mode, options = {}) {
  if (options.directoryCount > 0) return { type: mode === 'locate' ? 'locate-directories' : 'upload-directories' }
  if (options.fileCount > 0) return { type: mode === 'locate' ? 'locate-files' : 'upload-files' }
  return { type: 'none' }
}

export { chooseDropAction }
