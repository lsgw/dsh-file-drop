function chooseDropAction(mode, options = {}) {
  const shellPaths = options.shellPaths || []
  const extractedPaths = options.extractedPaths || []
  if (mode === 'locate') {
    const paths = shellPaths.length > 0 ? shellPaths : extractedPaths
    if (paths.length > 0) return { type: 'insert-paths', paths }
    if (options.directoryCount > 0) return { type: 'locate-directories' }
    if (options.fileCount > 0) return { type: 'locate-files' }
  } else {
    if (options.directoryCount > 0) return { type: 'upload-directories' }
    if (options.fileCount > 0) return { type: 'upload-files' }
  }
  return { type: 'none' }
}

export { chooseDropAction }
